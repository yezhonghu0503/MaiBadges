"""Small stdlib MCP stdio transport. It never starts a loader or an app."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional, TextIO

from .registry import Registry, RegistryError, ValidationError
from .holo_assets import display_layers


RESOURCE_URI = "ui://work-badges/manager-v0.7.0.html"
RESOURCE_MIME = "text/html;profile=mcp-app"
UI_PATH = Path(__file__).resolve().parent.parent / "ui" / "manager.html"
PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
MAX_REQUEST_CHARS = 8 * 1024 * 1024

SNAPSHOT_SCHEMA = {
    "type": "object",
    "properties": {
        "version": {"type": "integer", "minimum": 1},
        "roles": {"type": "array", "items": {"type": "object"}},
        "bindings": {"type": "array", "items": {"type": "object"}},
        "contexts": {"type": "array", "items": {"type": "object"}},
    },
    "required": ["version", "roles", "bindings", "contexts"],
    "additionalProperties": False,
}
PROFILE_SCHEMA = {
    "type": "object",
    "properties": {
        **{field: {"type": "string"} for field in ("id", "name", "chineseName", "role", "bio", "serial", "approval", "avatarDataUrl")},
        "duties": {"type": "array", "maxItems": 30, "items": {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 2}},
        "clearAvatar": {"type": "boolean"},
    },
    "additionalProperties": False,
}
EXPECTED_VERSION = {"type": "integer", "minimum": 1}


class RpcError(Exception):
    def __init__(self, code: int, message: str):
        self.code = code
        self.message = message


def _schema(properties: Optional[Dict[str, Any]] = None, required: Optional[list] = None) -> Dict[str, Any]:
    return {"type": "object", "properties": properties or {}, "required": required or [], "additionalProperties": False}


def tool_descriptors() -> list:
    tools = []
    definitions = (
        ("open", "MaiBadges", "打开工牌库，编辑角色资料并管理明确的聊天绑定。", _schema(), True),
        ("snapshot", "读取工牌资料", "读取角色、绑定和最近 15 秒内观测到的窗口元数据。", _schema(), True),
        ("save", "保存工牌资料", "新增或编辑一张工牌。使用最新 expectedVersion，发生冲突后重新加载，不自动覆盖。",
         _schema({"profile": PROFILE_SCHEMA, "expectedVersion": EXPECTED_VERSION}, ["profile", "expectedVersion"]), False),
        ("enable", "启用或停用工牌", "改变角色启用状态，保留其资料和绑定。",
         _schema({"roleId": {"type": "string"}, "enabled": {"type": "boolean"}, "expectedVersion": EXPECTED_VERSION}, ["roleId", "enabled", "expectedVersion"]), False),
        ("bind", "绑定聊天和工牌", "仅保存用户明确指定的会话标识或完整标题。同名标题不能区分项目；替换已有绑定须显式 replace=true。",
         _schema({"roleId": {"type": "string"}, "kind": {"type": "string", "enum": ["thread", "title"]}, "key": {"type": "string"},
                  "label": {"type": "string"}, "replace": {"type": "boolean", "default": False}, "expectedVersion": EXPECTED_VERSION},
                 ["roleId", "kind", "key", "label", "expectedVersion"]), False),
        ("unbind", "解除聊天绑定", "移除一条明确指定的绑定，不删除角色。",
         _schema({"bindingId": {"type": "string"}, "expectedVersion": EXPECTED_VERSION}, ["bindingId", "expectedVersion"]), False),
        ("avatar", "读取工牌头像", "按头像标识读取本地头像，图像数据只交给工牌界面。",
         _schema({"imageId": {"type": "string"}}, ["imageId"]), True),
    )
    for name, title, description, input_schema, read_only in definitions:
        descriptor = {
            "name": "work_badges_" + name,
            "title": title,
            "description": description,
            "inputSchema": input_schema,
            "outputSchema": ({"type": "object", "properties": {"imageId": {"type": "string"}}, "required": ["imageId"], "additionalProperties": False}
                             if name == "avatar" else SNAPSHOT_SCHEMA),
            "annotations": {"readOnlyHint": read_only, "destructiveHint": name in ("save", "bind", "unbind"), "openWorldHint": False},
        }
        if name == "open":
            descriptor["_meta"] = {
                "ui": {"resourceUri": RESOURCE_URI, "visibility": ["model", "app"]},
                "openai/outputTemplate": RESOURCE_URI,
                "openai/ui": {"entrypoints": [{"type": "global"}, {"type": "thread"}]},
            }
        tools.append(descriptor)
    return tools


def _tool_error(error: RegistryError) -> Dict[str, Any]:
    return {"content": [{"type": "text", "text": error.message}], "isError": True,
            "_meta": {"error": {"code": error.code, "reload": error.reload}}}


def _snapshot_result(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    return {"structuredContent": snapshot, "content": [{"type": "text", "text": "工牌资料已读取，当前版本 %s。" % snapshot["version"]}]}


class Server:
    def __init__(self, registry: Registry):
        self.registry = registry
        self.initialized = False

    def call_tool(self, name: str, arguments: Any) -> Dict[str, Any]:
        descriptor = next((tool for tool in tool_descriptors() if tool["name"] == name), None)
        if descriptor is None:
            raise RpcError(-32602, "没有找到指定的工牌工具。")
        try:
            if not isinstance(arguments, dict):
                raise ValidationError("工具参数必须是对象。")
            schema = descriptor["inputSchema"]
            if set(arguments) - set(schema["properties"]) or any(field not in arguments for field in schema["required"]):
                raise ValidationError("工具参数缺失或包含不支持的字段。")
            if name in ("work_badges_open", "work_badges_snapshot"):
                return _snapshot_result(self.registry.snapshot())
            if name == "work_badges_save":
                snapshot = self.registry.upsert_role(arguments["profile"], arguments["expectedVersion"])
            elif name == "work_badges_enable":
                snapshot = self.registry.set_enabled(arguments["roleId"], arguments["enabled"], arguments["expectedVersion"])
            elif name == "work_badges_bind":
                snapshot = self.registry.bind(arguments["roleId"], arguments["kind"], arguments["key"], arguments["label"], arguments["expectedVersion"], arguments.get("replace", False))
            elif name == "work_badges_unbind":
                snapshot = self.registry.unbind(arguments["bindingId"], arguments["expectedVersion"])
            else:
                image_id = arguments["imageId"]
                if not isinstance(image_id, str):
                    raise ValidationError("头像标识必须是文本。")
                original = self.registry.avatar_data(image_id)
                return {"structuredContent": {"imageId": image_id}, "content": [{"type": "text", "text": "头像数据已交给工牌界面。"}],
                        "_meta": {"avatarDataUrl": original,
                                  **display_layers(image_id if original else None)}}
            return _snapshot_result(snapshot)
        except RegistryError as error:
            return _tool_error(error)
        except Exception:
            # Do not expose SQLite messages, filesystem paths, or exception text to the model/UI.
            return _tool_error(RegistryError("工牌服务暂时无法完成请求，请检查本地资料后重试。"))

    def dispatch(self, method: str, params: Any) -> Dict[str, Any]:
        if not isinstance(params, dict):
            raise RpcError(-32602, "请求参数必须是对象。")
        if method == "initialize":
            requested = params.get("protocolVersion")
            if not isinstance(requested, str):
                raise RpcError(-32602, "缺少 MCP 协议版本。")
            self.initialized = True
            return {"protocolVersion": requested if requested in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
                    "serverInfo": {"name": "work-badges", "version": "0.7.0", "title": "MaiBadges"},
                    "capabilities": {"tools": {}, "resources": {}},
                    "instructions": "只管理工牌和用户明确指定的聊天绑定，不会连接、启动或控制桌面应用。资料修改必须使用最新 expectedVersion。"}
        if method == "ping":
            return {}
        if not self.initialized:
            raise RpcError(-32002, "请先初始化 MCP 连接。")
        if method == "tools/list":
            return {"tools": tool_descriptors()}
        if method == "tools/call":
            if not isinstance(params.get("name"), str):
                raise RpcError(-32602, "缺少工具名称。")
            return self.call_tool(params["name"], params.get("arguments", {}))
        if method == "resources/list":
            return {"resources": [{"uri": RESOURCE_URI, "name": "work-badges-manager", "title": "MaiBadges", "mimeType": RESOURCE_MIME}]}
        if method == "resources/templates/list":
            return {"resourceTemplates": []}
        if method == "resources/read":
            if params.get("uri") != RESOURCE_URI:
                raise RpcError(-32602, "不支持读取这个资源。")
            try:
                html = UI_PATH.read_text(encoding="utf-8")
            except (OSError, UnicodeError):
                raise RpcError(-32603, "工牌界面资源尚未准备完成。") from None
            return {"contents": [{"uri": RESOURCE_URI, "mimeType": RESOURCE_MIME, "text": html,
                                  "_meta": {"ui": {"prefersBorder": False, "csp": {"connectDomains": [], "resourceDomains": []}},
                                            "openai/ui": {"availableDisplayModes": ["inline", "fullscreen"], "preferredDisplayMode": "fullscreen"}}}]}
        raise RpcError(-32601, "不支持这个 MCP 方法。")

    def handle(self, message: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "无效的 JSON-RPC 请求。"}}
        request_id = message.get("id")
        has_id = "id" in message
        method = message.get("method")
        if not isinstance(method, str):
            if "result" in message or "error" in message:
                return None
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32600, "message": "缺少请求方法。"}}
        if not has_id:
            # Initialization/cancellation/progress notifications require no response.
            return None
        if isinstance(request_id, bool) or not isinstance(request_id, (str, int)):
            return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "无效的请求标识。"}}
        try:
            result = self.dispatch(method, message.get("params", {}))
            return {"jsonrpc": "2.0", "id": request_id, "result": result}
        except RpcError as error:
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": error.code, "message": error.message}}
        except Exception:
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32603, "message": "工牌服务暂时无法完成请求。"}}


def serve(inp: TextIO, out: TextIO, registry: Registry) -> None:
    """Serve newline-delimited JSON-RPC until EOF; safe to exercise with StringIO."""
    server = Server(registry)
    while True:
        line = inp.readline(MAX_REQUEST_CHARS + 1)
        if not line:
            return
        if len(line) > MAX_REQUEST_CHARS:
            while line and not line.endswith("\n"):
                line = inp.readline(MAX_REQUEST_CHARS + 1)
            response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "请求数据过大。"}}
        elif not line.strip():
            continue
        else:
            try:
                message = json.loads(line)
            except (ValueError, UnicodeError, RecursionError):
                response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "无法解析 JSON 请求。"}}
            else:
                response = server.handle(message)
        if response is not None:
            out.write(json.dumps(response, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
            out.flush()
