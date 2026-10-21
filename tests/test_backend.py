"""Offline behavior tests. Temporary state stays inside the backend test boundary."""

import base64
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid
from datetime import datetime, timezone


PLUGIN_ROOT = Path(__file__).resolve().parents[1] / "plugins" / "work-badges"
sys.path.insert(0, str(PLUGIN_ROOT))

from backend.registry import Registry, ValidationError, ConflictError, BindingConflictError, NotFoundError, MAX_AVATAR_BYTES
from backend import mcp_server
from backend.mcp_server import RESOURCE_URI, RESOURCE_MIME, Server, serve, tool_descriptors


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
PNG_URL = "data:image/png;base64," + base64.b64encode(PNG).decode("ascii")


def by_id(snapshot, role_id):
    return next(role for role in snapshot["roles"] if role["id"] == role_id)


class RegistryFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix=".backend-test-", dir=str(PLUGIN_ROOT / "backend"))
        self.root = Path(self.temporary.name)
        self.seed = self.root / "seed"
        self.seed.mkdir()
        (self.seed / "demo.png").write_bytes(PNG)
        self.registry = Registry(self.root / "state", seed_dir=self.seed)

    def tearDown(self):
        self.registry.close()
        self.temporary.cleanup()


class RegistryTests(RegistryFixture):
    def test_seed_has_generic_content_shared_demo_and_no_bindings(self):
        snapshot = self.registry.snapshot()
        self.assertEqual([role["name"] for role in snapshot["roles"]], ["Alex", "Blair", "Casey", "Drew", "Ellis"])
        self.assertEqual([role["id"] for role in snapshot["roles"]], ["max", "maxie", "milo", "matthew", "maxin"])
        self.assertEqual(snapshot["bindings"], [])
        self.assertEqual(snapshot["contexts"], [])
        self.assertGreaterEqual(snapshot["version"], 1)
        for role in snapshot["roles"]:
            self.assertTrue(role["enabled"])
            self.assertEqual(role["chineseName"], "")
            self.assertTrue(role["duties"])
            self.assertEqual(self.registry.avatar_data(role["imageId"]), PNG_URL)
        self.assertEqual(len({role["imageId"] for role in snapshot["roles"]}), 1)

    def test_existing_database_is_not_reseeded_or_overwritten(self):
        version = self.registry.snapshot()["version"]
        saved = self.registry.upsert_role({"id": "max", "bio": "已确认的项目职责"}, version)
        self.registry.close()
        self.registry = Registry(self.root / "state", seed_dir=self.seed)
        self.assertEqual(self.registry.snapshot(), saved)

    def test_create_edit_and_keep_existing_avatar_when_no_avatar_requested(self):
        initial = self.registry.snapshot()
        created = self.registry.upsert_role({"name": "Nora", "role": "项目助理", "duties": [["核对", "核对交付清单"]]}, initial["version"])
        role = created["roles"][-1]
        self.assertTrue(role["id"].startswith("role-"))
        self.assertEqual(role["bio"], "")
        updated = self.registry.upsert_role({"id": "milo", "bio": "已确认的新简介"}, created["version"])
        self.assertEqual(by_id(updated, "milo")["imageId"], by_id(initial, "milo")["imageId"])
        self.assertEqual(updated["version"], initial["version"] + 2)

    def test_bad_profile_cannot_change_enabled_or_avatar_by_internal_id(self):
        initial = self.registry.snapshot()
        for profile in ({"id": "max", "enabled": False}, {"id": "max", "imageId": "abc"},
                        {"id": "max", "name": ""}, {"id": "max", "duties": [["missing description"]]},
                        {"name": "Nora", "unknown": "ignored?"}):
            with self.subTest(profile=profile):
                with self.assertRaises(ValidationError):
                    self.registry.upsert_role(profile, initial["version"])
        self.assertEqual(self.registry.snapshot(), initial)

    def test_stale_writer_cannot_overwrite_another_window(self):
        initial = self.registry.snapshot()
        other = Registry(self.root / "state")
        try:
            saved = other.upsert_role({"id": "max", "bio": "来自另一个窗口"}, initial["version"])
            before_files = set(self.registry.assets_dir.iterdir())
            with self.assertRaises(ConflictError):
                self.registry.upsert_role({"id": "max", "bio": "旧版本覆盖", "avatarDataUrl": PNG_URL}, initial["version"])
            self.assertEqual(self.registry.snapshot(), saved)
            self.assertEqual(set(self.registry.assets_dir.iterdir()), before_files)
        finally:
            other.close()

    def test_expected_version_is_required_and_not_a_boolean(self):
        for version in (None, True, "1", 0, -1):
            with self.subTest(version=version):
                with self.assertRaises(ValidationError):
                    self.registry.set_enabled("max", False, version)

    def test_full_title_is_exact_and_max_does_not_match_maxie(self):
        version = self.registry.snapshot()["version"]
        saved = self.registry.bind("max", "title", "Max（运营总监）", "明确填写", version)
        self.assertEqual(self.registry.resolve({"title": "Max（运营总监）"})["id"], "max")
        for title in ("Max", "Maxie（资深分析师）", "Maxin（视觉设计师）", "x Max（运营总监）", "Max（运营总监） "):
            self.assertIsNone(self.registry.resolve({"title": title}))
        self.assertEqual(len(saved["bindings"]), 1)

    def test_thread_binding_has_priority_and_disabled_thread_does_not_fall_back(self):
        saved = self.registry.bind("max", "title", "同名标题", "标题后备", self.registry.snapshot()["version"])
        saved = self.registry.bind("milo", "thread", "conversation-A", "精确会话", saved["version"])
        context = {"title": "同名标题", "threadKey": "conversation-A"}
        self.assertEqual(self.registry.resolve(context)["id"], "milo")
        old_milo = by_id(saved, "milo")
        saved = self.registry.set_enabled("milo", False, saved["version"])
        self.assertIsNone(self.registry.resolve(context))
        self.assertEqual(len(saved["bindings"]), 2)
        self.assertEqual(by_id(saved, "milo")["duties"], old_milo["duties"])
        self.assertEqual(by_id(saved, "milo")["imageId"], old_milo["imageId"])
        self.assertEqual(self.registry.resolve({"title": "同名标题", "threadKey": "other"})["id"], "max")

    def test_rebinding_requires_explicit_replace_and_conflict_rolls_back(self):
        saved = self.registry.bind("max", "thread", "conversation-A", "原绑定", self.registry.snapshot()["version"])
        with self.assertRaises(BindingConflictError):
            self.registry.bind("maxie", "thread", "conversation-A", "请求替换", saved["version"])
        self.assertEqual(self.registry.snapshot(), saved)
        replaced = self.registry.bind("maxie", "thread", "conversation-A", "已明确替换", saved["version"], replace=True)
        self.assertEqual(len(replaced["bindings"]), 1)
        self.assertEqual(replaced["bindings"][0]["roleId"], "maxie")
        self.assertEqual(replaced["bindings"][0]["id"], saved["bindings"][0]["id"])
        removed = self.registry.unbind(replaced["bindings"][0]["id"], replaced["version"])
        self.assertEqual(removed["bindings"], [])
        self.assertIsNone(self.registry.resolve({"threadKey": "conversation-A"}))

    def test_context_drops_body_and_expires_without_changing_profile_version(self):
        class UnreadableBody:
            def __str__(self):
                raise AssertionError("body must not be inspected")

        initial = self.registry.snapshot()["version"]
        now = time.time()
        context = {"windowId": "window-A", "title": "Milo（互动运营）", "threadKey": None,
                   "contextKey": "window-A:chat-A", "seenAt": now, "url": "codex://threads/chat-A", "body": UnreadableBody(), "messages": ["private"]}
        self.registry.record_context(context)
        snapshot = self.registry.snapshot()
        self.assertEqual(snapshot["version"], initial)
        self.assertEqual(set(snapshot["contexts"][0]), {"windowId", "title", "threadKey", "contextKey", "seenAt", "url"})
        self.assertNotIn("private", json.dumps(snapshot))
        with patch("backend.registry.time.time", return_value=now + 16):
            self.assertEqual(self.registry.snapshot()["contexts"], [])
        self.assertEqual(self.registry.snapshot()["version"], initial)

    def test_context_supports_iso_and_milliseconds_but_rejects_nonfinite_time(self):
        for i, timestamp in enumerate((time.time() * 1000, datetime.now(timezone.utc).isoformat())):
            self.registry.record_context({"windowId": "window-A", "contextKey": "context-%s" % i, "title": "完整标题", "seenAt": timestamp})
        self.assertEqual(len(self.registry.snapshot()["contexts"]), 2)
        with self.assertRaises(ValidationError):
            self.registry.record_context({"windowId": "window-A", "contextKey": "bad", "seenAt": float("nan")})

    def test_prefs_are_scoped_merge_per_role_and_identical_save_does_not_write(self):
        initial_version = self.registry.snapshot()["version"]
        scope, other_scope = str(uuid.uuid4()), str(uuid.uuid4())
        self.assertEqual(self.registry.prefs_get(scope), {"layout": {"width": 266}, "roles": {}})
        self.registry.prefs_save(scope, "milo", {"x": 100, "y": 0}, {"flipped": True})
        self.registry.prefs_save(scope, "max", {"width": 300}, {"collapsed": True})
        expected = {"layout": {"x": 100, "y": 0, "width": 300}, "roles": {
            "milo": {"flipped": True, "collapsed": False}, "max": {"flipped": False, "collapsed": True}}}
        self.assertEqual(self.registry.prefs_get(scope), expected)
        self.assertEqual(self.registry.prefs_get(other_scope)["roles"], {})
        changes = self.registry.connection.total_changes
        self.registry.prefs_save(scope, "max", {"width": 300}, {"collapsed": True})
        self.assertEqual(self.registry.connection.total_changes, changes)
        self.assertEqual(self.registry.snapshot()["version"], initial_version)

    def test_invalid_prefs_fail_without_partial_layout_save(self):
        scope = str(uuid.uuid4())
        before = self.registry.prefs_get(scope)
        for layout, card in (({"x": None}, {}), ({"width": float("inf")}, {}), ({"x": True}, {}),
                             ({"width": 250}, {"collapsed": "yes"}), ({"left": 5}, {})):
            with self.subTest(layout=layout, card=card):
                with self.assertRaises(ValidationError):
                    self.registry.prefs_save(scope, "milo", layout, card)
        self.assertEqual(self.registry.prefs_get(scope), before)

    def test_avatar_round_trip_clear_and_path_inputs_do_not_read_files(self):
        initial = self.registry.snapshot()
        saved = self.registry.upsert_role({"id": "max", "avatarDataUrl": PNG_URL}, initial["version"])
        image_id = by_id(saved, "max")["imageId"]
        self.assertEqual(self.registry.avatar_data(image_id), PNG_URL)
        self.assertEqual(self.registry.avatar_data("../../some-file"), "")
        self.assertEqual(self.registry.avatar_data("f" * 64), "")
        cleared = self.registry.upsert_role({"id": "max", "clearAvatar": True}, saved["version"])
        self.assertIsNone(by_id(cleared, "max")["imageId"])

    def test_invalid_avatar_is_not_saved_or_exposed(self):
        initial = self.registry.snapshot()
        for image in ("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "data:image/png;base64,bm90LWFuLWltYWdl",
                      "data:image/jpeg;base64," + base64.b64encode(PNG).decode("ascii"),
                      "data:image/png;base64,%%%", "data:image/png;base64," + base64.b64encode(PNG + b"x" * MAX_AVATAR_BYTES).decode("ascii")):
            with self.subTest(image=image[:60]):
                with self.assertRaises(ValidationError):
                    self.registry.upsert_role({"id": "max", "avatarDataUrl": image}, initial["version"])
        self.assertEqual(self.registry.snapshot(), initial)

    def test_missing_role_error_does_not_change_revision(self):
        initial = self.registry.snapshot()
        with self.assertRaises(NotFoundError):
            self.registry.set_enabled("missing-role", False, initial["version"])
        self.assertEqual(self.registry.snapshot(), initial)


class McpTests(RegistryFixture):
    def protocol(self, messages):
        source = "\n".join(json.dumps(message, ensure_ascii=False) for message in messages) + "\n"
        output = io.StringIO()
        serve(io.StringIO(source), output, self.registry)
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def test_stdio_lifecycle_notifications_and_tool_discovery(self):
        responses = self.protocol([
            {"jsonrpc": "2.0", "id": 0, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "offline-test", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "work_badges_open", "arguments": {}}},
        ])
        self.assertEqual(len(responses), 4)
        self.assertEqual(responses[0]["error"]["code"], -32002)
        self.assertEqual(responses[1]["result"]["protocolVersion"], "2025-06-18")
        self.assertEqual(responses[1]["result"]["serverInfo"]["version"], "0.7.0")
        tools = responses[2]["result"]["tools"]
        self.assertEqual({tool["name"] for tool in tools}, {"work_badges_" + name for name in ("open", "snapshot", "save", "enable", "bind", "unbind", "avatar")})
        opener = next(tool for tool in tools if tool["name"] == "work_badges_open")
        self.assertEqual(opener["_meta"]["ui"]["resourceUri"], RESOURCE_URI)
        self.assertEqual(opener["_meta"]["openai/ui"]["entrypoints"], [{"type": "global"}, {"type": "thread"}])
        self.assertEqual(responses[3]["result"]["structuredContent"], self.registry.snapshot())

    def test_conflict_result_has_safe_reload_metadata(self):
        server = Server(self.registry)
        initial = self.registry.snapshot()["version"]
        saved = server.call_tool("work_badges_enable", {"roleId": "max", "enabled": False, "expectedVersion": initial})
        self.assertEqual(saved["structuredContent"]["version"], initial + 1)
        failed = server.call_tool("work_badges_enable", {"roleId": "milo", "enabled": False, "expectedVersion": initial})
        self.assertTrue(failed["isError"])
        self.assertEqual(failed["_meta"]["error"], {"code": "version_conflict", "reload": True})
        self.assertIn("重新加载", failed["content"][0]["text"])
        self.assertNotIn("structuredContent", failed)

    def test_avatar_data_is_private_metadata_and_not_model_content(self):
        server = Server(self.registry)
        image_id = by_id(self.registry.snapshot(), "milo")["imageId"]
        result = server.call_tool("work_badges_avatar", {"imageId": image_id})
        self.assertEqual(result["structuredContent"], {"imageId": image_id})
        self.assertEqual(result["_meta"]["avatarDataUrl"], PNG_URL)
        self.assertNotIn("base64", json.dumps(result["content"]))
        self.assertNotIn("base64", json.dumps(result["structuredContent"]))

    def test_resources_read_only_exact_manager_uri(self):
        server = Server(self.registry)
        server.dispatch("initialize", {"protocolVersion": "unknown-client-version"})
        manager = self.root / "manager.html"
        manager.write_text("<!doctype html><title>离线工牌</title>")
        with patch.object(mcp_server, "UI_PATH", manager):
            result = server.dispatch("resources/read", {"uri": RESOURCE_URI})
            self.assertEqual(result["contents"][0]["mimeType"], RESOURCE_MIME)
            self.assertIn("离线工牌", result["contents"][0]["text"])
            for uri in ("file:///etc/passwd", "ui://work-badges/../../anything", RESOURCE_URI + "?path=/etc/passwd"):
                with self.subTest(uri=uri):
                    response = server.handle({"jsonrpc": "2.0", "id": 7, "method": "resources/read", "params": {"uri": uri}})
                    self.assertEqual(response["error"]["code"], -32602)

    def test_malformed_json_does_not_break_next_request(self):
        output = io.StringIO()
        serve(io.StringIO("bad json\n" + json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}) + "\n"), output, self.registry)
        responses = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(responses[0]["error"]["code"], -32700)
        self.assertEqual(responses[1]["result"], {})

    def test_invalid_tool_inputs_and_internal_failures_return_safe_messages(self):
        server = Server(self.registry)
        failed = server.call_tool("work_badges_save", {"profile": {}, "expectedVersion": True})
        self.assertTrue(failed["isError"])
        failed = server.call_tool("work_badges_snapshot", {"unexpected": True})
        self.assertTrue(failed["isError"])
        with patch.object(self.registry, "snapshot", side_effect=RuntimeError("sensitive /internal/private.sqlite")):
            failed = server.call_tool("work_badges_snapshot", {})
        self.assertTrue(failed["isError"])
        self.assertNotIn("sensitive", json.dumps(failed))
        self.assertNotIn("private.sqlite", json.dumps(failed))

    def test_entrypoint_subprocess_writes_only_json_rpc_to_stdout(self):
        messages = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}},
                    {"jsonrpc": "2.0", "method": "notifications/initialized"},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "work_badges_snapshot", "arguments": {}}}]
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        result = subprocess.run([sys.executable, str(PLUGIN_ROOT / "backend/main.py"), "--state-dir", str(self.root / "subprocess-state"), "--seed-dir", str(self.seed)],
                                input="\n".join(json.dumps(message) for message in messages) + "\n", text=True, capture_output=True, timeout=10, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([message["id"] for message in output], [1, 2])
        self.assertEqual(len(output[-1]["result"]["structuredContent"]["roles"]), 5)
        self.assertEqual(result.stderr, "")

    def test_import_never_creates_state_or_opens_sqlite(self):
        source = ("import sys; sys.dont_write_bytecode=True; sys.path.insert(0, %r); " % str(PLUGIN_ROOT)) + "\n" + "\n".join([
            "from unittest.mock import patch",
            "with patch('pathlib.Path.mkdir') as mkdir, patch('sqlite3.connect') as connect:",
            "    import backend.registry",
            "    import backend.mcp_server",
            "    import backend.main",
            "    mkdir.assert_not_called()",
            "    connect.assert_not_called()",
        ])
        result = subprocess.run([sys.executable, "-c", source], text=True, capture_output=True, timeout=10,
                                env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
