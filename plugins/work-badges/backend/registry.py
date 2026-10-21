"""SQLite source of truth for badges. No network or desktop integration."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import struct
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple


MAX_AVATAR_BYTES = 3 * 1024 * 1024
CONTEXT_TTL_SECONDS = 15
DEFAULT_LAYOUT = {"width": 266}
TEXT_LIMITS = {
    "name": 80, "chineseName": 80, "role": 160,
    "bio": 4000, "serial": 80, "approval": 2000,
}
PROFILE_FIELDS = set(TEXT_LIMITS) | {"duties"}
PROFILE_INPUT_FIELDS = PROFILE_FIELDS | {"id", "avatarDataUrl", "clearAvatar"}
MIME_EXTENSIONS = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}


class RegistryError(Exception):
    code = "registry_error"
    reload = False

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class ValidationError(RegistryError):
    code = "validation_error"


class ConflictError(RegistryError):
    code = "version_conflict"
    reload = True

    def __init__(self):
        super().__init__("资料已被其他窗口更新，请重新加载后再保存。")


class NotFoundError(RegistryError):
    code = "not_found"


class BindingConflictError(RegistryError):
    code = "binding_conflict"

    def __init__(self):
        super().__init__("此聊天已绑定其他工牌，请确认替换后再保存。")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _text(value: Any, field: str, limit: int, required: bool = False) -> str:
    if not isinstance(value, str) or len(value) > limit or "\x00" in value:
        raise ValidationError("%s 必须是长度不超过 %s 的文本。" % (field, limit))
    if required and not value.strip():
        raise ValidationError("%s 不能为空。" % field)
    return value


def _role_id(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,79}", value):
        raise ValidationError("工牌标识无效。")
    return value


def _validate_image(data: bytes, mime: str) -> None:
    if not data or len(data) > MAX_AVATAR_BYTES:
        raise ValidationError("头像大小必须在 3 MiB 以内。")
    valid = False
    if mime == "image/png":
        valid = len(data) >= 33 and data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR"
        if valid:
            width, height = struct.unpack(">II", data[16:24])
            valid = 0 < width <= 32768 and 0 < height <= 32768
    elif mime == "image/jpeg":
        valid = len(data) >= 4 and data[:3] == b"\xff\xd8\xff" and data[-2:] == b"\xff\xd9"
    elif mime == "image/webp":
        valid = (len(data) >= 20 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
                 and data[12:16] in (b"VP8 ", b"VP8L", b"VP8X")
                 and struct.unpack("<I", data[4:8])[0] + 8 == len(data))
    if not valid:
        raise ValidationError("头像必须是真实的 PNG、JPEG 或 WebP 文件，且格式与内容一致。")


def _decode_avatar(value: Any) -> Tuple[bytes, str]:
    if not isinstance(value, str) or len(value) > ((MAX_AVATAR_BYTES + 2) // 3) * 4 + 64:
        raise ValidationError("头像大小必须在 3 MiB 以内。")
    match = re.fullmatch(r"data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})", value)
    if not match:
        raise ValidationError("头像必须是 PNG、JPEG 或 WebP 的 base64 数据。")
    try:
        data = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError):
        raise ValidationError("头像数据无效。") from None
    _validate_image(data, match.group(1))
    return data, match.group(1)


def _seen_timestamp(value: Any) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return value / 1000 if value > 100000000000 else float(value)
    if isinstance(value, str) and len(value) <= 80:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.replace(tzinfo=timezone.utc).timestamp() if parsed.tzinfo is None else parsed.timestamp()
        except (ValueError, OverflowError):
            pass
    raise ValidationError("窗口记录的时间无效。")


class Registry:
    """Explicit construction creates state; all profile writes compare one revision."""

    def __init__(self, state_dir: Path, seed_dir: Optional[Path] = None):
        self.state_dir = Path(state_dir).expanduser()
        self.assets_dir = self.state_dir / "assets"
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.assets_dir.mkdir(exist_ok=True)
        self.db_path = self.state_dir / "registry.sqlite3"
        self._lock = threading.RLock()
        self.connection = sqlite3.connect(str(self.db_path), timeout=5, isolation_level=None, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys=ON")
        self.connection.execute("PRAGMA busy_timeout=5000")
        self.connection.execute("PRAGMA journal_mode=WAL")
        try:
            self._initialize(Path(seed_dir) if seed_dir is not None else None)
        except Exception:
            self.connection.close()
            raise

    def close(self) -> None:
        with self._lock:
            self.connection.close()

    def __enter__(self) -> "Registry":
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()

    def _initialize(self, seed_dir: Optional[Path]) -> None:
        with self._lock:
            self.connection.execute("BEGIN IMMEDIATE")
            try:
                for statement in (
                    "CREATE TABLE IF NOT EXISTS meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, filename TEXT NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS bindings (id TEXT PRIMARY KEY, role_id TEXT NOT NULL REFERENCES roles(id), kind TEXT NOT NULL CHECK(kind IN ('thread','title')), key TEXT NOT NULL, label TEXT NOT NULL, UNIQUE(kind,key))",
                    "CREATE TABLE IF NOT EXISTS contexts (context_key TEXT PRIMARY KEY, data TEXT NOT NULL, seen_timestamp REAL NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS prefs (scope TEXT PRIMARY KEY, data TEXT NOT NULL)",
                ):
                    self.connection.execute(statement)
                if self.connection.execute("SELECT 1 FROM meta WHERE singleton=1").fetchone() is None:
                    self.connection.execute("INSERT INTO meta(singleton,version) VALUES(1,1)")
                    for role in self._seed_roles():
                        if seed_dir is not None:
                            seed = seed_dir / "demo.png"
                            if seed.is_file():
                                data = seed.read_bytes()
                                _validate_image(data, "image/png")
                                role["imageId"] = self._store_image(data, "image/png")
                        self.connection.execute("INSERT INTO roles(id,data) VALUES(?,?)", (role["id"], _json(role)))
                self.connection.commit()
            except Exception:
                self.connection.rollback()
                raise

    @staticmethod
    def _seed_roles() -> List[Dict[str, Any]]:
        roles = []
        samples = (("max", "Alex", "项目协调"), ("maxie", "Blair", "研究分析"),
                   ("milo", "Casey", "协作执行"), ("matthew", "Drew", "发布助理"),
                   ("maxin", "Ellis", "视觉设计"))
        for index, (role_id, name, job) in enumerate(samples, 1):
            profile = {field: "" for field in TEXT_LIMITS}
            profile.update({"id": role_id, "name": name, "role": job,
                            "bio": "通用示例角色，可替换为你自己的资料。",
                            "serial": f"DEMO · {index:03d}",
                            "duties": [["整理", "整理项目资料与明确的待办事项。"],
                                       ["协作", "按你的授权完成工作并记录进展。"]],
                            "approval": "请根据自己的项目设置职责与操作授权。",
                            "enabled": True, "imageId": None})
            roles.append(profile)
        return roles

    def _version(self) -> int:
        return int(self.connection.execute("SELECT version FROM meta WHERE singleton=1").fetchone()[0])

    def _snapshot(self) -> Dict[str, Any]:
        return {
            "version": self._version(),
            "roles": [json.loads(row[0]) for row in self.connection.execute("SELECT data FROM roles ORDER BY rowid")],
            "bindings": [{"id": row["id"], "roleId": row["role_id"], "kind": row["kind"], "key": row["key"], "label": row["label"]}
                         for row in self.connection.execute("SELECT * FROM bindings ORDER BY rowid")],
            "contexts": [json.loads(row[0]) for row in self.connection.execute(
                "SELECT data FROM contexts WHERE seen_timestamp >= ? AND seen_timestamp <= ? ORDER BY seen_timestamp DESC",
                (time.time() - CONTEXT_TTL_SECONDS, time.time() + 60))],
        }

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            self.connection.execute("BEGIN")
            try:
                result = self._snapshot()
                self.connection.commit()
                return result
            except Exception:
                self.connection.rollback()
                raise

    def _mutate(self, expected_version: Any, action: Callable[[], bool]) -> Dict[str, Any]:
        if not isinstance(expected_version, int) or isinstance(expected_version, bool) or expected_version < 1:
            raise ValidationError("请提供当前资料版本。")
        with self._lock:
            self.connection.execute("BEGIN IMMEDIATE")
            try:
                if self._version() != expected_version:
                    raise ConflictError()
                if action():
                    self.connection.execute("UPDATE meta SET version=version+1 WHERE singleton=1")
                result = self._snapshot()
                self.connection.commit()
                return result
            except Exception:
                self.connection.rollback()
                raise

    def _role(self, role_id: str) -> Dict[str, Any]:
        row = self.connection.execute("SELECT data FROM roles WHERE id=?", (role_id,)).fetchone()
        if row is None:
            raise NotFoundError("没有找到这张工牌，请重新加载。")
        return json.loads(row[0])

    def _store_image(self, data: bytes, mime: str) -> str:
        image_id = hashlib.sha256(data).hexdigest()
        filename = image_id + MIME_EXTENSIONS[mime]
        destination = self.assets_dir / filename
        if not destination.exists():
            fd, temporary = tempfile.mkstemp(prefix=".avatar-", dir=str(self.assets_dir))
            try:
                with os.fdopen(fd, "wb") as handle:
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, destination)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        elif (destination.is_symlink() or destination.stat().st_size > MAX_AVATAR_BYTES
              or hashlib.sha256(destination.read_bytes()).hexdigest() != image_id):
            raise ValidationError("本地头像文件不一致，请检查工牌资料目录。")
        self.connection.execute("INSERT OR IGNORE INTO images(id,mime,filename) VALUES(?,?,?)", (image_id, mime, filename))
        return image_id

    def upsert_role(self, profile: Dict[str, Any], expected_version: int) -> Dict[str, Any]:
        if not isinstance(profile, dict) or set(profile) - PROFILE_INPUT_FIELDS:
            raise ValidationError("工牌资料包含不支持的字段。")
        role_id = _role_id(profile["id"]) if profile.get("id") is not None else "role-" + uuid.uuid4().hex
        clear = profile.get("clearAvatar", False)
        if not isinstance(clear, bool):
            raise ValidationError("清除头像选项必须为布尔值。")
        avatar = _decode_avatar(profile["avatarDataUrl"]) if "avatarDataUrl" in profile else None
        if clear and avatar is not None:
            raise ValidationError("不能同时上传和清除头像。")

        def action() -> bool:
            row = self.connection.execute("SELECT data FROM roles WHERE id=?", (role_id,)).fetchone()
            previous = json.loads(row[0]) if row else None
            value = dict(previous) if previous else {field: "" for field in TEXT_LIMITS}
            if previous is None:
                value.update({"id": role_id, "duties": [], "enabled": True, "imageId": None})
            for field, limit in TEXT_LIMITS.items():
                if field in profile:
                    value[field] = _text(profile[field], field, limit, required=field == "name")
            if not value.get("name", "").strip():
                raise ValidationError("工牌姓名不能为空。")
            if "duties" in profile:
                duties = profile["duties"]
                if not isinstance(duties, list) or len(duties) > 30:
                    raise ValidationError("职责必须是最多 30 项的列表。")
                result = []
                for item in duties:
                    if not isinstance(item, (list, tuple)) or len(item) != 2:
                        raise ValidationError("每项职责需要标题和说明。")
                    result.append([_text(item[0], "职责标题", 160), _text(item[1], "职责说明", 4000)])
                value["duties"] = result
            if avatar is not None:
                value["imageId"] = self._store_image(*avatar)
            elif clear:
                value["imageId"] = None
            if value == previous:
                return False
            self.connection.execute("INSERT INTO roles(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", (role_id, _json(value)))
            return True

        return self._mutate(expected_version, action)

    def set_enabled(self, role_id: str, enabled: bool, expected_version: int) -> Dict[str, Any]:
        role_id = _role_id(role_id)
        if not isinstance(enabled, bool):
            raise ValidationError("启用状态必须为布尔值。")

        def action() -> bool:
            role = self._role(role_id)
            if role["enabled"] == enabled:
                return False
            role["enabled"] = enabled
            self.connection.execute("UPDATE roles SET data=? WHERE id=?", (_json(role), role_id))
            return True

        return self._mutate(expected_version, action)

    def bind(self, role_id: str, kind: str, key: str, label: str, expected_version: int, replace: bool = False) -> Dict[str, Any]:
        role_id = _role_id(role_id)
        if kind not in ("thread", "title"):
            raise ValidationError("绑定类型只能是 thread 或 title。")
        key = _text(key, "聊天标识", 2048, required=True)
        label = _text(label, "绑定备注", 1024)
        if not isinstance(replace, bool):
            raise ValidationError("替换选项必须为布尔值。")

        def action() -> bool:
            self._role(role_id)
            old = self.connection.execute("SELECT * FROM bindings WHERE kind=? AND key=?", (kind, key)).fetchone()
            if old is not None:
                if old["role_id"] != role_id and not replace:
                    raise BindingConflictError()
                if old["role_id"] == role_id and old["label"] == label:
                    return False
                self.connection.execute("UPDATE bindings SET role_id=?,label=? WHERE id=?", (role_id, label, old["id"]))
            else:
                self.connection.execute("INSERT INTO bindings(id,role_id,kind,key,label) VALUES(?,?,?,?,?)",
                                        ("binding-" + uuid.uuid4().hex, role_id, kind, key, label))
            return True

        return self._mutate(expected_version, action)

    def unbind(self, binding_id: str, expected_version: int) -> Dict[str, Any]:
        binding_id = _text(binding_id, "绑定标识", 128, required=True)

        def action() -> bool:
            cursor = self.connection.execute("DELETE FROM bindings WHERE id=?", (binding_id,))
            if cursor.rowcount == 0:
                raise NotFoundError("没有找到这条绑定，请重新加载。")
            return True

        return self._mutate(expected_version, action)

    def record_context(self, context: Dict[str, Any]) -> None:
        if not isinstance(context, dict):
            raise ValidationError("窗口记录无效。")
        # Read only these fields. Unknown fields, including body/messages, are discarded.
        value = {
            "windowId": _text(context.get("windowId"), "窗口标识", 512, required=True),
            "title": _text(context.get("title", ""), "聊天完整标题", 1024),
            "threadKey": context.get("threadKey"),
            "contextKey": _text(context.get("contextKey"), "上下文标识", 2048, required=True),
            "seenAt": context.get("seenAt", datetime.now(timezone.utc).isoformat()),
            "url": _text(context.get("url", ""), "窗口地址", 4096),
        }
        if value["threadKey"] is not None:
            value["threadKey"] = _text(value["threadKey"], "会话标识", 2048, required=True)
        timestamp = _seen_timestamp(value["seenAt"])
        serialized = _json(value)
        with self._lock:
            self.connection.execute("BEGIN IMMEDIATE")
            try:
                old = self.connection.execute("SELECT data FROM contexts WHERE context_key=?", (value["contextKey"],)).fetchone()
                if old is None or old[0] != serialized:
                    self.connection.execute("INSERT INTO contexts(context_key,data,seen_timestamp) VALUES(?,?,?) ON CONFLICT(context_key) DO UPDATE SET data=excluded.data,seen_timestamp=excluded.seen_timestamp",
                                            (value["contextKey"], serialized, timestamp))
                self.connection.commit()
            except Exception:
                self.connection.rollback()
                raise

    def resolve(self, context: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not isinstance(context, dict):
            return None
        thread_key = context.get("threadKey")
        title = context.get("title")
        thread_key = thread_key if isinstance(thread_key, str) and thread_key else None
        title = title if isinstance(title, str) and title else None
        with self._lock:
            # One read statement keeps the precedence decision consistent during other writers' commits.
            row = self.connection.execute(
                "SELECT r.data FROM bindings b JOIN roles r ON r.id=b.role_id "
                "WHERE (b.kind='thread' AND b.key=?) OR (b.kind='title' AND b.key=?) "
                "ORDER BY CASE b.kind WHEN 'thread' THEN 0 ELSE 1 END LIMIT 1", (thread_key, title)).fetchone()
            if row is not None:
                role = json.loads(row[0])
                return role if role["enabled"] else None
        return None

    def avatar_data(self, image_id: Any) -> str:
        if not isinstance(image_id, str) or not re.fullmatch(r"[a-f0-9]{64}", image_id):
            return ""
        with self._lock:
            row = self.connection.execute("SELECT mime,filename FROM images WHERE id=?", (image_id,)).fetchone()
            if row is None or row["mime"] not in MIME_EXTENSIONS:
                return ""
            filename = image_id + MIME_EXTENSIONS[row["mime"]]
            if row["filename"] != filename:
                return ""
            asset = self.assets_dir / filename
            try:
                if asset.is_symlink() or not asset.resolve().is_relative_to(self.assets_dir.resolve()):
                    return ""
                with asset.open("rb") as handle:
                    data = handle.read(MAX_AVATAR_BYTES + 1)
                if len(data) > MAX_AVATAR_BYTES or hashlib.sha256(data).hexdigest() != image_id:
                    return ""
                return "data:%s;base64,%s" % (row["mime"], base64.b64encode(data).decode("ascii"))
            except OSError:
                return ""

    def prefs_get(self, scope: str) -> Dict[str, Any]:
        scope = _text(scope, "显示设置范围", 200, required=True)
        with self._lock:
            row = self.connection.execute("SELECT data FROM prefs WHERE scope=?", (scope,)).fetchone()
            return json.loads(row[0]) if row else {"layout": dict(DEFAULT_LAYOUT), "roles": {}}

    def prefs_save(self, scope: str, role_id: Optional[str], layout: Optional[Dict[str, Any]], card_state: Optional[Dict[str, Any]]) -> None:
        scope = _text(scope, "显示设置范围", 200, required=True)
        layout = {} if layout is None else layout
        card_state = {} if card_state is None else card_state
        if not isinstance(layout, dict) or set(layout) - {"x", "y", "width"}:
            raise ValidationError("工牌位置设置无效。")
        for key, value in layout.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValidationError("工牌位置和宽度必须是有限数字。")
            if key == "width" and not 0 < value <= 4096:
                raise ValidationError("工牌宽度无效。")
        if not isinstance(card_state, dict) or set(card_state) - {"flipped", "collapsed"} or any(not isinstance(value, bool) for value in card_state.values()):
            raise ValidationError("翻面和收起设置必须为布尔值。")
        if card_state and role_id is None:
            raise ValidationError("保存卡片状态需要工牌标识。")
        if role_id is not None:
            role_id = _role_id(role_id)
        with self._lock:
            self.connection.execute("BEGIN IMMEDIATE")
            try:
                if role_id is not None:
                    self._role(role_id)
                old = self.connection.execute("SELECT data FROM prefs WHERE scope=?", (scope,)).fetchone()
                value = json.loads(old[0]) if old else {"layout": dict(DEFAULT_LAYOUT), "roles": {}}
                previous = _json(value)
                value["layout"].update(layout)
                if card_state:
                    state = value["roles"].setdefault(role_id, {"flipped": False, "collapsed": False})
                    state.update(card_state)
                serialized = _json(value)
                if serialized != previous:
                    self.connection.execute("INSERT INTO prefs(scope,data) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data", (scope, serialized))
                self.connection.commit()
            except Exception:
                self.connection.rollback()
                raise
