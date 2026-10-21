#!/usr/bin/env python3
"""MaiBadges 工牌本地插件控制器；只有显式调用子命令时才执行操作。"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone


LABEL = "com.maibadges.loader"
OWNER_KEY = "MAI_WORK_BADGES_OWNER"
OWNER_VALUE = "maibadges/v1"
DEFAULT_PORT = 9347
PLUGIN_ROOT = Path(__file__).resolve().parents[1]
MAIN_PATH = PLUGIN_ROOT / "loader" / "main.py"


class ControlError(RuntimeError):
    """An actionable failure suitable for the command-line interface."""


def absolute_path(value: str | Path) -> Path:
    return Path(value).expanduser().resolve()


def validate_port(value: str | int) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError("端口必须是 1024–65535 的整数。") from error
    if not 1024 <= port <= 65535:
        raise argparse.ArgumentTypeError("端口必须是 1024–65535 的整数。")
    return port


def atomic_write(path: Path, data: bytes) -> None:
    """Write a private file beside its final path, then replace atomically."""
    temporary = None
    try:
        descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        temporary = Path(name)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


class Controller:
    def __init__(self, state_dir: str | Path | None = None, port: int = DEFAULT_PORT,
                 *, home: Path | None = None, main_path: Path | None = None):
        self.home = absolute_path(home if home is not None else Path.home())
        self.state_dir = absolute_path(state_dir if state_dir is not None else
                                       self.home / "Library/Application Support/MaiBadges")
        self.port = validate_port(port)
        self.main_path = absolute_path(main_path if main_path is not None else MAIN_PATH)
        self.plugin_root = self.main_path.parent.parent
        self.python = absolute_path(sys.executable)
        self.agent_path = self.home / "Library/LaunchAgents" / f"{LABEL}.plist"

    @property
    def domain(self) -> str:
        return f"gui/{os.getuid()}"

    @property
    def service(self) -> str:
        return f"{self.domain}/{LABEL}"

    @property
    def arguments(self) -> list[str]:
        return [str(self.python), str(self.main_path), "watch", "--state-dir",
                str(self.state_dir), "--port", str(self.port)]

    def _require_main(self) -> None:
        if not self.main_path.is_file():
            raise ControlError(f"找不到主服务文件：{self.main_path}。请保留完整插件包。")

    def _require_config(self) -> None:
        path = self.state_dir / "config.json"
        try:
            if path.is_symlink() or path.stat().st_size > 16384:
                raise ValueError("设置文件归属或大小无效")
            config = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(config, dict) or type(config.get("schema")) is not int or config["schema"] != 1:
                raise ValueError("设置格式无效")
            if type(config.get("port")) is not int or config["port"] != self.port:
                raise ValueError("设置端口与启动端口不一致")
            if not isinstance(config.get("scope"), str) or str(uuid.UUID(config["scope"])) != config["scope"]:
                raise ValueError("位置作用域无效")
            target = config.get("target")
            if (not isinstance(target, dict) or target.get("url") != "app://-/index.html"
                    or not all(isinstance(target.get(key), str) and target[key]
                               for key in ("preferredId", "titleHint"))):
                raise ValueError("主窗口选择无效")
        except (OSError, ValueError) as error:
            raise ControlError("请先运行 loader/main.py enroll 选择聊天主窗口，并确认端口与本次命令一致；尚未启动服务或安装登录项。") from error

    def _ensure_state(self) -> None:
        self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)

    def _read_agent(self) -> dict | None:
        if self.agent_path.is_symlink():
            raise ControlError(f"登录项路径是符号链接，未改动：{self.agent_path}")
        try:
            with self.agent_path.open("rb") as stream:
                value = plistlib.load(stream)
        except FileNotFoundError:
            return None
        except (OSError, ValueError, plistlib.InvalidFileException) as error:
            raise ControlError(f"无法确认现有登录项归属，未改动：{self.agent_path}") from error
        if not isinstance(value, dict):
            raise ControlError(f"现有登录项格式不符，未改动：{self.agent_path}")
        return value

    def _owned(self, document: dict) -> bool:
        arguments = document.get("ProgramArguments")
        environment = document.get("EnvironmentVariables")
        return (document.get("Label") == LABEL
                and isinstance(environment, dict)
                and environment.get(OWNER_KEY) == OWNER_VALUE
                and isinstance(arguments, list) and len(arguments) >= 3
                and arguments[1] == str(self.main_path) and arguments[2] == "watch")

    def _require_owned(self, document: dict) -> None:
        if not self._owned(document):
            raise ControlError(f"同名登录项不属于本插件包，未覆盖或删除：{self.agent_path}")

    @staticmethod
    def _argument(document: dict, name: str) -> str | None:
        arguments = document.get("ProgramArguments", [])
        try:
            return arguments[arguments.index(name) + 1]
        except (ValueError, IndexError, TypeError, AttributeError):
            return None

    @staticmethod
    def _run(arguments: list[str]) -> subprocess.CompletedProcess:
        try:
            return subprocess.run(arguments, check=False, capture_output=True,
                                  text=True, timeout=20)
        except FileNotFoundError as error:
            raise ControlError(f"找不到系统命令 {arguments[0]}；这些控制命令仅适用于 macOS。") from error
        except subprocess.TimeoutExpired as error:
            raise ControlError(f"系统命令 {arguments[0]} 超时，未重复执行。") from error

    @staticmethod
    def _detail(result: subprocess.CompletedProcess) -> str:
        return (result.stderr or result.stdout or f"退出码 {result.returncode}").strip()[:600]

    @staticmethod
    def _absent(result: subprocess.CompletedProcess) -> bool:
        message = (result.stderr or "").lower()
        return result.returncode in (3, 113) or "could not find service" in message or "no such process" in message

    def _bootout(self) -> None:
        result = self._run(["launchctl", "bootout", self.service])
        if result.returncode == 0 or self._absent(result):
            return
        # Some macOS releases report generic bootstrap errors for unloaded jobs.
        # Confirm an absent job before treating such an error as idempotent success.
        probe = self._run(["launchctl", "print", self.service])
        if probe.returncode != 0 and self._absent(probe):
            return
        raise ControlError(f"未能卸载本插件的当前登录会话：{self._detail(result)}")

    def status(self) -> dict:
        """Read files only; do not infer process liveness from a saved PID."""
        state_path = self.state_dir / "status.json"
        snapshot = None
        note = "尚无本地状态记录。"
        if state_path.is_symlink():
            note = "状态文件是符号链接，未读取。"
        else:
            try:
                if state_path.stat().st_size > 65536:
                    raise ValueError("状态文件超过 64 KiB")
                snapshot = json.loads(state_path.read_text(encoding="utf-8"))
                if not isinstance(snapshot, dict):
                    raise ValueError("状态内容不是对象")
                note = "这是本地文件快照；未探测进程、浏览器或调试端口。"
            except FileNotFoundError:
                pass
            except (OSError, ValueError) as error:
                snapshot = None
                note = f"状态文件暂不可读：{error}"
        try:
            agent = self._read_agent()
            login = "未安装" if agent is None else ("已配置" if self._owned(agent) else "存在非自有同名项")
        except ControlError:
            login = "现有登录项归属无法确认"
        return {"state_dir": str(self.state_dir), "snapshot": snapshot,
                "login": login, "note": note}

    def start(self) -> str:
        self._require_main()
        self._require_config()
        self._ensure_state()
        output_path = self.state_dir / "service.stdout.log"
        error_path = self.state_dir / "service.stderr.log"
        # main.py obtains its flock before clearing an old stop.request.
        # The controller must not remove it while a previous watcher is stopping.
        output_fd = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            error_fd = os.open(error_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                with os.fdopen(output_fd, "ab", buffering=0) as output, os.fdopen(error_fd, "ab", buffering=0) as errors:
                    output_fd = error_fd = None
                    subprocess.Popen(self.arguments, stdin=subprocess.DEVNULL, stdout=output,
                                     stderr=errors, start_new_session=True, close_fds=True,
                                     cwd=str(self.plugin_root))
            finally:
                if error_fd is not None:
                    os.close(error_fd)
        finally:
            if output_fd is not None:
                os.close(output_fd)
        return f"已提交后台启动请求；主服务会自行防止重复运行。\n状态目录：{self.state_dir}"

    def stop(self) -> str:
        agent = self._read_agent()
        paused_login = False
        if agent is not None and self._owned(agent):
            if self._argument(agent, "--state-dir") == str(self.state_dir):
                self._bootout()
                paused_login = True
        self._ensure_state()
        request = {"requested_at": datetime.now(timezone.utc).isoformat()}
        atomic_write(self.state_dir / "stop.request",
                     (json.dumps(request) + "\n").encode("utf-8"))
        message = "已写入停止请求；未读取 PID，也未向进程发送 kill 信号。"
        if paused_login:
            message += "\n已暂停本插件的当前登录会话；登录项仍保留，下次登录会再启动。彻底停用自启请运行 disable-login。"
        return message

    def _agent_document(self) -> dict:
        return {"Label": LABEL, "ProgramArguments": self.arguments,
                "WorkingDirectory": str(self.plugin_root), "RunAtLoad": True,
                "KeepAlive": True, "ThrottleInterval": 15, "ProcessType": "Background",
                "EnvironmentVariables": {OWNER_KEY: OWNER_VALUE},
                "StandardOutPath": str(self.state_dir / "service.stdout.log"),
                "StandardErrorPath": str(self.state_dir / "service.stderr.log")}

    def _wait_for_watch_to_stop(self, timeout: float = 15) -> None:
        """Transition an existing own watcher without reading or signaling a PID."""
        lock_path = self.state_dir / "run.lock"
        if lock_path.is_symlink():
            raise ControlError("run.lock 是符号链接，未启动登录自启服务。")
        try:
            stream = lock_path.open("r+")
        except FileNotFoundError:
            return
        with stream:
            deadline = time.monotonic() + timeout
            requested = False
            while True:
                try:
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    if not requested:
                        atomic_write(self.state_dir / "stop.request", b"login-transition\n")
                        requested = True
                    if time.monotonic() >= deadline:
                        raise ControlError("已请求停止现有加载器，但 15 秒内未释放自有锁；尚未启动登录自启服务，请稍后重试。")
                    time.sleep(0.1)
                else:
                    fcntl.flock(stream, fcntl.LOCK_UN)
                    return

    def _write_agent(self, document: dict, old: dict | None) -> None:
        data = plistlib.dumps(document, fmt=plistlib.FMT_XML, sort_keys=True)
        self.agent_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if old is not None:
            current = self._read_agent()
            if current is None:
                return self._write_agent(document, None)
            self._require_owned(current)
            if current != document:
                atomic_write(self.agent_path, data)
            return
        # Exclusive creation avoids replacing an unrelated file appearing after
        # the ownership check. Updates above only replace verified own files.
        try:
            descriptor = os.open(self.agent_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            current = self._read_agent()
            if current is None:
                raise ControlError("登录项在写入时发生变化，请重新检查后再运行。")
            self._require_owned(current)
            return self._write_agent(document, current)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())

    def enable_login(self) -> str:
        self._require_main()
        old = self._read_agent()
        if old is not None:
            self._require_owned(old)
        self._require_config()
        self._ensure_state()
        document = self._agent_document()
        # Unload our KeepAlive job before asking a temporary watcher to stop;
        # otherwise launchd could race this transition by restarting it.
        if old is not None:
            self._bootout()
        self._wait_for_watch_to_stop()
        self._write_agent(document, old)
        bootstrap = self._run(["launchctl", "bootstrap", self.domain, str(self.agent_path)])
        kickstart = self._run(["launchctl", "kickstart", self.service])
        if kickstart.returncode != 0:
            details = self._detail(kickstart if bootstrap.returncode == 0 else bootstrap)
            raise ControlError(f"自有登录项已保存，但本次启动未确认成功：{details}\n可用 disable-login 移除该登录项。")
        return f"已启用本插件登录自启，并提交启动请求。\n登录项：{self.agent_path}\n状态目录：{self.state_dir}"

    def disable_login(self) -> str:
        old = self._read_agent()
        if old is None:
            return "未安装本插件的登录项，无需移除。"
        self._require_owned(old)
        self._bootout()
        current = self._read_agent()
        if current is not None:
            self._require_owned(current)
            self.agent_path.unlink()
        return "已停用本插件登录自启，并删除自有登录项；卡片设置与日志仍保留。"

    def start_chatgpt(self) -> str:
        result = self._run(["open", "-b", "com.openai.codex", "--args",
                            "--remote-debugging-address=127.0.0.1",
                            f"--remote-debugging-port={self.port}"])
        if result.returncode != 0:
            raise ControlError(f"ChatGPT 启动请求失败：{self._detail(result)}")
        return (f"已向 ChatGPT 提交本机调试启动请求（127.0.0.1:{self.port}）。"
                "\n未退出或强制重启现有应用；已运行的实例可能不会采用新参数。")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="管理 MaiBadges 工牌本地插件；只在明确执行子命令时更改文件或调用 macOS 命令。")
    commands = result.add_subparsers(dest="command", required=True)
    descriptions = {
        "status": "仅查看本地状态文件，不连接应用或调试端口。",
        "start": "后台启动 watch；主服务自行处理防双实例锁。",
        "stop": "停止当前 watch；保留登录自启配置，下次登录仍会启动。",
        "enable-login": "启用当前用户登录自启，并启动服务。",
        "disable-login": "卸载当前会话的自有服务，并删除自有登录项。",
        "start-chatgpt": "向 ChatGPT 提交本机调试启动请求，不退出或重启已有实例。",
    }
    for command, description in descriptions.items():
        child = commands.add_parser(command, help=description, description=description)
        if command != "start-chatgpt":
            child.add_argument("--state-dir", metavar="ABS", help="状态目录；默认 ~/Library/Application Support/MaiBadges。")
        if command in ("start", "enable-login", "start-chatgpt"):
            child.add_argument("--port", type=validate_port, default=DEFAULT_PORT,
                               help=f"本机调试端口，默认 {DEFAULT_PORT}。")
        if command == "status":
            child.add_argument("--json", action="store_true", help="输出本地文件快照 JSON。")
    return result


def main(argv: list[str] | None = None) -> int:
    arguments = parser().parse_args(argv)
    try:
        controller = Controller(getattr(arguments, "state_dir", None), getattr(arguments, "port", DEFAULT_PORT))
        if arguments.command == "status":
            status = controller.status()
            if arguments.json:
                print(json.dumps(status, ensure_ascii=False, indent=2))
            else:
                print(f"状态目录：{status['state_dir']}\n登录自启：{status['login']}\n{status['note']}")
                if status["snapshot"] is not None:
                    print(json.dumps(status["snapshot"], ensure_ascii=False, indent=2))
        else:
            action = getattr(controller, arguments.command.replace("-", "_"))
            print(action())
        return 0
    except (ControlError, OSError, argparse.ArgumentTypeError) as error:
        print(f"未完成：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
