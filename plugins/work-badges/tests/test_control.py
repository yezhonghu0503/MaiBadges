"""Controller contracts using temporary files and mocked subprocesses only."""

import contextlib
import errno
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest import mock


CONTROL_PATH = Path(__file__).resolve().parents[1] / "loader/control.py"
SPEC = importlib.util.spec_from_file_location("work_badges_control_contract", CONTROL_PATH)
control = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(control)


def completed(code=0, stderr="", stdout=""):
    return subprocess.CompletedProcess([], code, stdout, stderr)


class ControllerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary_base = Path(__file__).resolve().parent / ".tmp"
        cls.temporary_base.mkdir(parents=True, exist_ok=True)
        cls.temporary_parent = Path(tempfile.mkdtemp(prefix="control-suite-", dir=cls.temporary_base))

    @classmethod
    def tearDownClass(cls):
        cls.temporary_parent.rmdir()
        try:
            cls.temporary_base.rmdir()
        except OSError as error:
            if error.errno not in (errno.ENOTEMPTY, errno.EEXIST, errno.ENOENT):
                raise

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="control-", dir=self.temporary_parent)
        self.addCleanup(self.directory.cleanup)
        self.patches = contextlib.ExitStack()
        self.addCleanup(self.patches.close)
        self.root = Path(self.directory.name).resolve()
        self.home = self.root / "home"
        self.main_path = self.root / "plugin/loader/main.py"
        self.main_path.parent.mkdir(parents=True)
        self.main_path.write_text("# mock watch entrypoint\n", encoding="utf-8")
        self.controller = control.Controller(home=self.home, main_path=self.main_path)
        # Unexpected system/process calls fail rather than reaching macOS.
        self.run = self.patches.enter_context(mock.patch.object(control.subprocess, "run", return_value=completed()))
        self.popen = self.patches.enter_context(mock.patch.object(control.subprocess, "Popen"))
        self.kill = self.patches.enter_context(mock.patch.object(control.os, "kill", side_effect=AssertionError("No PID signaling is allowed")))

    def install_own_file(self):
        self.controller.agent_path.parent.mkdir(parents=True, exist_ok=True)
        self.controller.agent_path.write_bytes(plistlib.dumps(self.controller._agent_document()))

    def install_foreign_file(self):
        self.controller.agent_path.parent.mkdir(parents=True, exist_ok=True)
        data = {"Label": control.LABEL, "ProgramArguments": ["/unrelated/program"]}
        self.controller.agent_path.write_bytes(plistlib.dumps(data))
        return self.controller.agent_path.read_bytes()

    def valid_config(self, controller=None):
        controller = controller or self.controller
        controller.state_dir.mkdir(parents=True, exist_ok=True)
        config = {"schema": 1, "port": controller.port, "scope": "86c36ad8-3e65-4efb-a523-13ab3882e2b8",
                  "target": {"url": "app://-/index.html", "preferredId": "chosen-main-window", "titleHint": "ChatGPT"}}
        (controller.state_dir / "config.json").write_text(json.dumps(config))
        return config

    def test_import_does_not_execute_commands_or_create_user_directories(self):
        with mock.patch.object(Path, "mkdir", side_effect=AssertionError("No import-time directories")), \
             mock.patch.object(subprocess, "run", side_effect=AssertionError("No import-time commands")), \
             mock.patch.object(subprocess, "Popen", side_effect=AssertionError("No import-time process")):
            spec = importlib.util.spec_from_file_location("work_badges_control_import_only", CONTROL_PATH)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        self.assertEqual(module.MAIN_PATH, CONTROL_PATH.parent / "main.py")
        self.assertFalse(self.home.exists())

    def test_status_reads_files_only_and_creates_nothing(self):
        status = self.controller.status()
        self.assertIsNone(status["snapshot"])
        self.assertFalse(self.home.exists())
        self.run.assert_not_called()
        self.popen.assert_not_called()

    def test_status_returns_saved_snapshot_without_trusting_pid(self):
        self.controller.state_dir.mkdir(parents=True)
        saved = {"status": "waiting", "last_update": "2026-10-20T01:00:00Z", "pid": 999999999}
        (self.controller.state_dir / "status.json").write_text(json.dumps(saved))
        self.assertEqual(self.controller.status()["snapshot"], saved)
        self.run.assert_not_called()
        self.kill.assert_not_called()

    def test_status_ignores_malformed_oversized_and_symlinked_files(self):
        self.controller.state_dir.mkdir(parents=True)
        path = self.controller.state_dir / "status.json"
        for content in ("{broken", "[]", "a" * 65537):
            path.write_text(content)
            self.assertIsNone(self.controller.status()["snapshot"])
        path.unlink()
        path.symlink_to(self.main_path)
        self.assertIsNone(self.controller.status()["snapshot"])
        self.run.assert_not_called()

    def test_start_passes_absolute_arguments_and_log_streams_without_a_shell(self):
        self.valid_config()
        self.controller.start()
        arguments, options = self.popen.call_args
        self.assertEqual(arguments, (self.controller.arguments,))
        self.assertTrue(Path(arguments[0][0]).is_absolute())
        self.assertEqual(arguments[0][1], str(self.main_path))
        self.assertEqual(arguments[0][2:], ["watch", "--state-dir", str(self.controller.state_dir), "--port", "9347"])
        self.assertTrue(options["start_new_session"])
        self.assertTrue(options["close_fds"])
        self.assertNotIn("shell", options)
        self.assertTrue(options["stdout"].closed)
        self.assertTrue(options["stderr"].closed)
        self.assertEqual((self.controller.state_dir / "service.stdout.log").stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.controller.state_dir / "service.stderr.log").stat().st_mode & 0o777, 0o600)
        self.run.assert_not_called()

    def test_start_preserves_pending_stop_request_until_watch_obtains_lock(self):
        self.valid_config()
        request = self.controller.state_dir / "stop.request"
        request.write_text("keep pending stop")
        self.controller.start()
        self.assertEqual(request.read_text(), "keep pending stop")

    def test_start_has_no_pid_dependency_and_duplicate_defense_belongs_to_watch(self):
        self.valid_config()
        self.controller.start()
        self.controller.start()
        self.assertEqual(self.popen.call_count, 2)
        self.assertFalse((self.controller.state_dir / "pid").exists())
        self.kill.assert_not_called()

    def test_missing_main_is_reported_before_user_directory_creation(self):
        self.main_path.unlink()
        with self.assertRaisesRegex(control.ControlError, "主服务文件"):
            self.controller.start()
        self.assertFalse(self.home.exists())
        self.popen.assert_not_called()

    def test_stop_atomically_writes_request_without_process_signals(self):
        self.controller.stop()
        request = self.controller.state_dir / "stop.request"
        self.assertIn("requested_at", json.loads(request.read_text()))
        self.assertEqual(list(self.controller.state_dir.glob(".stop.request.*")), [])
        self.assertEqual(request.stat().st_mode & 0o777, 0o600)
        self.run.assert_not_called()
        self.popen.assert_not_called()
        self.kill.assert_not_called()

    def test_stop_unloads_matching_own_agent_but_preserves_login_plist(self):
        self.install_own_file()
        message = self.controller.stop()
        self.assertIn("下次登录", message)
        self.assertTrue(self.controller.agent_path.exists())
        self.run.assert_called_once_with(["launchctl", "bootout", self.controller.service],
                                         check=False, capture_output=True, text=True, timeout=20)
        self.assertTrue((self.controller.state_dir / "stop.request").exists())
        self.kill.assert_not_called()

    def test_stop_does_not_unload_other_state_directory_or_foreign_agent(self):
        self.install_own_file()
        own = self.controller._agent_document()
        own["ProgramArguments"][4] = str(self.root / "other-state")
        self.controller.agent_path.write_bytes(plistlib.dumps(own))
        self.controller.stop()
        self.run.assert_not_called()
        before = self.install_foreign_file()
        self.controller.stop()
        self.assertEqual(self.controller.agent_path.read_bytes(), before)
        self.run.assert_not_called()

    def test_enable_login_plist_binds_the_same_absolute_state_and_python(self):
        self.valid_config()
        self.controller.enable_login()
        with self.controller.agent_path.open("rb") as stream:
            document = plistlib.load(stream)
        self.assertEqual(document["Label"], control.LABEL)
        self.assertEqual(document["ProgramArguments"], self.controller.arguments)
        self.assertTrue(document["RunAtLoad"])
        self.assertTrue(document["KeepAlive"])
        self.assertEqual(document["ThrottleInterval"], 15)
        self.assertEqual(document["EnvironmentVariables"][control.OWNER_KEY], control.OWNER_VALUE)
        self.assertEqual(Path(document["StandardOutPath"]).parent, self.controller.state_dir)
        self.assertEqual(Path(document["StandardErrorPath"]).parent, self.controller.state_dir)
        self.assertEqual([call.args[0] for call in self.run.call_args_list], [
            ["launchctl", "bootstrap", self.controller.domain, str(self.controller.agent_path)],
            ["launchctl", "kickstart", self.controller.service]])

    def test_enable_login_is_idempotent_when_job_is_already_bootstrapped(self):
        self.valid_config()
        self.controller.enable_login()
        before = self.controller.agent_path.read_bytes()
        self.run.reset_mock()
        self.run.side_effect = [completed(), completed(), completed()]
        self.controller.enable_login()
        self.assertEqual(self.controller.agent_path.read_bytes(), before)
        self.assertEqual(self.run.call_count, 3)
        self.assertEqual([call.args[0][1] for call in self.run.call_args_list], ["bootout", "bootstrap", "kickstart"])
        self.assertTrue(all("-k" not in call.args[0] for call in self.run.call_args_list))

    def test_enable_refuses_foreign_same_label_without_overwriting_or_commands(self):
        before = self.install_foreign_file()
        with self.assertRaisesRegex(control.ControlError, "不属于本插件包"):
            self.controller.enable_login()
        self.assertEqual(self.controller.agent_path.read_bytes(), before)
        self.assertFalse(self.controller.state_dir.exists())
        self.run.assert_not_called()

    def test_enable_and_disable_refuse_symlinked_agent_path(self):
        self.controller.agent_path.parent.mkdir(parents=True)
        self.controller.agent_path.symlink_to(self.main_path)
        for action in (self.controller.enable_login, self.controller.disable_login):
            with self.assertRaisesRegex(control.ControlError, "符号链接"):
                action()
        self.assertEqual(self.main_path.read_text(), "# mock watch entrypoint\n")
        self.run.assert_not_called()

    def test_changed_owned_configuration_is_unloaded_before_rebootstrap(self):
        self.install_own_file()
        changed = control.Controller(state_dir=self.root / "new-state", home=self.home, main_path=self.main_path)
        self.valid_config(changed)
        changed.enable_login()
        self.assertEqual([call.args[0][1] for call in self.run.call_args_list], ["bootout", "bootstrap", "kickstart"])
        with changed.agent_path.open("rb") as stream:
            self.assertEqual(plistlib.load(stream)["ProgramArguments"][4], str(changed.state_dir))

    def test_disable_login_removes_only_owned_plist_and_is_repeatable(self):
        self.install_own_file()
        unrelated = self.controller.agent_path.parent / "unrelated.plist"
        unrelated.write_text("keep")
        self.controller.disable_login()
        self.controller.disable_login()
        self.assertFalse(self.controller.agent_path.exists())
        self.assertEqual(unrelated.read_text(), "keep")
        self.assertEqual(self.run.call_count, 1)
        self.kill.assert_not_called()

    def test_disable_refuses_foreign_plist(self):
        before = self.install_foreign_file()
        with self.assertRaisesRegex(control.ControlError, "不属于本插件包"):
            self.controller.disable_login()
        self.assertEqual(self.controller.agent_path.read_bytes(), before)
        self.run.assert_not_called()

    def test_bootout_missing_service_is_success_and_other_failures_preserve_plist(self):
        self.install_own_file()
        self.run.return_value = completed(113, "Could not find service")
        self.controller.disable_login()
        self.assertFalse(self.controller.agent_path.exists())
        self.install_own_file()
        self.run.side_effect = [completed(5, "I/O error"), completed(0, stdout="service exists")]
        with self.assertRaisesRegex(control.ControlError, "未能卸载"):
            self.controller.disable_login()
        self.assertTrue(self.controller.agent_path.exists())

    def test_start_chatgpt_only_submits_one_explicit_loopback_launch_request(self):
        self.controller.start_chatgpt()
        self.run.assert_called_once_with(["open", "-b", "com.openai.codex", "--args",
                                          "--remote-debugging-address=127.0.0.1",
                                          "--remote-debugging-port=9347"],
                                         check=False, capture_output=True, text=True, timeout=20)
        self.assertFalse(self.home.exists())
        self.popen.assert_not_called()
        self.kill.assert_not_called()

    def test_command_failure_and_invalid_ports_are_clear(self):
        self.run.return_value = completed(1, "request failed")
        with self.assertRaisesRegex(control.ControlError, "启动请求失败"):
            self.controller.start_chatgpt()
        for port in (0, 1023, 65536, "word"):
            with self.assertRaises(Exception):
                control.Controller(port=port, home=self.home, main_path=self.main_path)

    def test_start_and_enable_require_valid_enrollment_before_process_or_login_mutations(self):
        for action in (self.controller.start, self.controller.enable_login):
            with self.assertRaisesRegex(control.ControlError, "enroll"):
                action()
        self.assertFalse(self.home.exists())
        config = self.valid_config()
        path = self.controller.state_dir / "config.json"
        invalid = ["{broken", "[]", "x" * 16385,
                   json.dumps({**config, "schema": 2}),
                   json.dumps({**config, "port": 9348}),
                   json.dumps({**config, "scope": "target-id-is-not-a-scope"}),
                   json.dumps({**config, "target": {"url": "https://example.invalid", "preferredId": "x", "titleHint": "x"}})]
        for content in invalid:
            path.write_text(content)
            for action in (self.controller.start, self.controller.enable_login):
                with self.assertRaisesRegex(control.ControlError, "enroll"):
                    action()
        self.assertFalse(self.controller.agent_path.exists())
        self.run.assert_not_called()
        self.popen.assert_not_called()

    def test_login_transition_uses_only_own_lock_and_graceful_request(self):
        self.valid_config()
        (self.controller.state_dir / "run.lock").write_text("")
        with mock.patch.object(control.fcntl, "flock", side_effect=[BlockingIOError(), None, None]) as flock, \
             mock.patch.object(control.time, "monotonic", side_effect=[0, 0.1]), \
             mock.patch.object(control.time, "sleep") as sleep:
            self.controller.enable_login()
        self.assertEqual(flock.call_count, 3)
        self.assertEqual(flock.call_args_list[0].args[1], control.fcntl.LOCK_EX | control.fcntl.LOCK_NB)
        self.assertEqual(flock.call_args_list[-1].args[1], control.fcntl.LOCK_UN)
        self.assertEqual((self.controller.state_dir / "stop.request").read_bytes(), b"login-transition\n")
        sleep.assert_called_once_with(0.1)
        self.kill.assert_not_called()
        self.assertTrue(self.controller.agent_path.exists())

    def test_login_transition_timeout_does_not_bootstrap_or_write_agent(self):
        self.valid_config()
        (self.controller.state_dir / "run.lock").write_text("")
        with mock.patch.object(control.fcntl, "flock", side_effect=BlockingIOError()), \
             mock.patch.object(control.time, "monotonic", side_effect=[0, 16]):
            with self.assertRaisesRegex(control.ControlError, "15 秒"):
                self.controller.enable_login()
        self.assertTrue((self.controller.state_dir / "stop.request").exists())
        self.assertFalse(self.controller.agent_path.exists())
        self.run.assert_not_called()
        self.kill.assert_not_called()

    def test_login_transition_does_not_overwrite_or_follow_symlinked_lock(self):
        self.valid_config()
        (self.controller.state_dir / "run.lock").symlink_to(self.main_path)
        with self.assertRaisesRegex(control.ControlError, "符号链接"):
            self.controller.enable_login()
        self.assertFalse(self.controller.agent_path.exists())
        self.assertFalse((self.controller.state_dir / "stop.request").exists())
        self.run.assert_not_called()

    def test_all_help_is_available_without_executing_actions(self):
        for arguments in (["--help"], *([command, "--help"] for command in (
                "status", "start", "stop", "enable-login", "disable-login", "start-chatgpt"))):
            with contextlib.redirect_stdout(io.StringIO()) as stream:
                with self.assertRaises(SystemExit) as stopped:
                    control.main(arguments)
                self.assertEqual(stopped.exception.code, 0)
                self.assertIn("MaiBadges 工牌" if len(arguments) == 1 else "--help", stream.getvalue())
        self.run.assert_not_called()
        self.popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
