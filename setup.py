"""Manual package setup. Merely importing this file changes nothing.

prepare registers one repo-local marketplace entry and creates user-owned launchers.
It never opens ChatGPT, probes a port, starts a service or installs a login item.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import sys
import tempfile

PACKAGE = Path(__file__).resolve().parent
DEFAULT_PROJECT = PACKAGE
DEFAULT_STATE = Path.home() / 'Library/Application Support/MaiBadges'
DEFAULT_APPLICATIONS = Path.home() / 'Applications'
LAUNCHER_DISPLAY_NAME = 'MaiBadges'
LAUNCHER_NAME = LAUNCHER_DISPLAY_NAME + '.app'
LEGACY_LAUNCHER_NAME = 'MaiBadges Legacy.app'
LAUNCHER_ID = 'com.maibadges.launcher'
LAUNCHER_BUNDLE_VERSION = '3'
LAUNCHER_ICON_NAME = 'MaiBadges.icns'
OWNER = 'maibadges-local-package/1'
RUNTIME_FILES = ('loader/main.py', 'loader/control.py', 'loader/transport.py', 'loader/probe.js',
                 'backend/__init__.py', 'backend/main.py', 'backend/registry.py', 'backend/mcp_server.py', 'backend/holo_assets.py', 'backend/sidebar_assets.py',
                 'runtime/renderer.js', 'runtime/sidebar.js', 'ui/manager.html', 'assets/demo.png', 'assets/brand.png',
                 'assets/BricolageGrotesque.ttf', 'licenses/Bricolage-OFL.txt', 'licenses/Holo-Card-MIT.txt')
TEAM_LAYER_FILES = ('manifest.json', 'character.png', 'background.png', 'ui.png',
                    'ui-live.png', 'structure.png', 'contour-alpha.png')
RUNTIME_FILES += tuple('assets/holo/demo/' + name for name in TEAM_LAYER_FILES)

def atomic_write(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def read_catalog(path):
    if path.is_symlink():
        raise ValueError('marketplace.json 是符号链接，未修改。')
    if not path.exists():
        return {'name': 'maibadges-local', 'interface': {'displayName': 'MaiBadges Local'}, 'plugins': []}
    if path.stat().st_size > 1024 * 1024:
        raise ValueError('已有插件目录过大，未修改。')
    catalog = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(catalog, dict) or not isinstance(catalog.get('name'), str) or not catalog['name']:
        raise ValueError('已有 marketplace.json 格式不受支持，未修改。')
    if not isinstance(catalog.get('plugins'), list) or not all(isinstance(entry, dict) for entry in catalog['plugins']):
        raise ValueError('已有插件列表无效，未修改。')
    return catalog


def backup(path):
    if not path.exists():
        return None
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    destination = path.with_name('marketplace.before-work-badges-' + stamp + '.json')
    atomic_write(destination, path.read_bytes())
    return destination


def register(project, package):
    plugin = (package / 'plugins/work-badges').resolve()
    try:
        relative = './' + plugin.relative_to(project.resolve()).as_posix()
    except ValueError as error:
        raise ValueError('插件包必须放在你指定的项目目录内。') from error
    path = project / '.agents/plugins/marketplace.json'
    catalog = read_catalog(path)
    existing = [entry for entry in catalog['plugins'] if entry.get('name') == 'work-badges']
    if len(existing) > 1 or existing and existing[0].get('source') != {'source': 'local', 'path': relative}:
        raise ValueError('已有同名 work-badges 指向其他来源，未覆盖。')
    if not existing:
        catalog['plugins'].append({'name': 'work-badges', 'source': {'source': 'local', 'path': relative},
             'interface': {'displayName': 'MaiBadges'}, 'policy': {'installation': 'AVAILABLE', 'authentication': 'ON_INSTALL'},
             'category': 'Productivity'})
        backup(path)
        atomic_write(path, json_bytes(catalog))
    return path, catalog['name']


def launcher_script(python, plugin, state_dir, quiet=False):
    control = plugin / 'loader/control.py'
    base = [str(python), str(control)]
    command = lambda args: ' '.join(shlex.quote(value) for value in args)
    lines = ['#!/bin/sh', 'set -eu']
    if quiet:
        lines.append('exec >> ' + shlex.quote(str(state_dir / 'launcher.log')) + ' 2>&1')
    lines.append(command(base + ['start-chatgpt', '--port', '9347']))
    lines.append('if [ -f ' + shlex.quote(str(state_dir / 'config.json')) + ' ]; then')
    lines.append('  ' + command(base + ['start', '--state-dir', str(state_dir), '--port', '9347']))
    lines.extend(['else', "  echo 'ChatGPT 已请求启动；首次使用请按说明运行 enroll 选择主窗口。'", 'fi'])
    return ('\n'.join(lines) + '\n').encode()


def launcher_icon_bytes(package):
    """Read only the bundled icon, independently of the installed runtime."""
    source = package / 'plugins/work-badges/assets/maibadges.icns'
    if any(path.is_symlink() for path in (source.parent, source)):
        raise ValueError('启动器图标路径是符号链接，请重新解压完整安装包。')
    if not source.is_file() or not 8 <= source.stat().st_size <= 16 * 1024 * 1024:
        raise ValueError('缺少有效的启动器图标，请重新解压完整安装包。')
    data = source.read_bytes()
    if data[:4] != b'icns' or int.from_bytes(data[4:8], 'big') != len(data):
        raise ValueError('启动器图标格式无效，请重新解压完整安装包。')
    return data


def validate_launcher_paths(launcher):
    """Reject linked or non-regular destinations before writing bundle files."""
    directories = (launcher, launcher / 'Contents', launcher / 'Contents/MacOS',
                   launcher / 'Contents/Resources')
    files = (launcher / 'Contents/Info.plist', launcher / 'Contents/MacOS/WorkBadgeLauncher',
             launcher / 'Contents/Resources' / LAUNCHER_ICON_NAME)
    if any(path.is_symlink() for path in directories + files):
        raise ValueError('专用启动器内部路径是符号链接，未修改启动器。')
    if any(path.exists() and not path.is_dir() for path in directories):
        raise ValueError('专用启动器目录路径不是文件夹，未修改启动器。')
    if any(path.exists() and not path.is_file() for path in files):
        raise ValueError('专用启动器文件路径不安全，未修改启动器。')


def write_launcher_icon(launcher, data):
    validate_launcher_paths(launcher)
    atomic_write(launcher / 'Contents/Resources' / LAUNCHER_ICON_NAME, data, 0o644)


def refresh_launcher_icon(state_dir, data):
    """Refresh a verified wrapper without replacing runtime, data or launchers."""
    launcher = owned_launcher(state_dir)
    info_path = launcher / 'Contents/Info.plist'
    info = plistlib.loads(info_path.read_bytes())
    info.update(CFBundleName=LAUNCHER_DISPLAY_NAME, CFBundleDisplayName=LAUNCHER_DISPLAY_NAME,
                CFBundleVersion=LAUNCHER_BUNDLE_VERSION, CFBundleIconFile=LAUNCHER_ICON_NAME)
    write_launcher_icon(launcher, data)
    atomic_write(info_path, plistlib.dumps(info))
    # Directory timestamps prompt Finder to re-read this app's own bundle.
    os.utime(launcher / 'Contents', None)
    os.utime(launcher, None)
    return launcher


@contextmanager
def install_lock(state_dir):
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state_dir/'run.lock').open('a') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError('加载器正在运行，请先用 control.py stop 停止，再重新准备。') from error
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def install_runtime(plugin, state_dir):
    runtime=state_dir/'runtime'
    marker=runtime/'.mai-owner.json'
    if runtime.is_symlink():
        raise ValueError('runtime 路径是符号链接，未覆盖。')
    if runtime.exists():
        try:
            record=json.loads(marker.read_text(encoding='utf-8'))
        except (OSError, ValueError) as error:
            raise ValueError('runtime 不是本包创建的，未覆盖。') from error
        if not isinstance(record,dict) or record.get('owner')!=OWNER:
            raise ValueError('runtime 归属不同，未覆盖。')
    stage=Path(tempfile.mkdtemp(prefix='.runtime-stage-',dir=state_dir))
    previous=None
    try:
        for relative in RUNTIME_FILES:
            destination=stage/relative
            destination.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(plugin/relative,destination)
            destination.chmod(0o600)
        atomic_write(stage/'.mai-owner.json',json_bytes({'owner':OWNER,'source':str(plugin)}))
        if runtime.exists():
            previous=Path(tempfile.mkdtemp(prefix='.runtime-previous-',dir=state_dir))
            previous.rmdir()
            runtime.rename(previous)
        try:
            stage.rename(runtime)
        except OSError:
            if previous is not None:
                previous.rename(runtime)
                previous=None
            raise
        return runtime
    finally:
        if stage.exists():
            shutil.rmtree(stage)
        if previous is not None and previous.exists():
            shutil.rmtree(previous)


def prepare(project, state_dir, package=PACKAGE, python=Path(sys.executable)):
    project, state_dir, package = project.resolve(), state_dir.resolve(), package.resolve()
    plugin = package / 'plugins/work-badges'
    if not all((plugin / relative).is_file() for relative in RUNTIME_FILES):
        raise ValueError('包不完整；请先从项目内 build_package.py 重新构建。')
    icon_data = launcher_icon_bytes(package)
    # Validate the catalog before replacing any runtime files.
    plugin.relative_to(project)
    read_catalog(project / '.agents/plugins/marketplace.json')
    mcp_path = plugin / 'mcp.json'
    if mcp_path.is_symlink():
        raise ValueError('mcp.json 是符号链接，未修改。')
    mcp = json.loads(mcp_path.read_text(encoding='utf-8'))
    server = mcp['mcpServers']['work_badges']
    arguments = server.get('args')
    if (not isinstance(arguments, list) or arguments[:1] != ['${PLUGIN_ROOT}/backend/main.py']
            or len(arguments) not in (1, 3)
            or len(arguments) == 3 and arguments[1] != '--state-dir'
            or server.get('cwd') != '${PLUGIN_ROOT}'):
        raise ValueError('本地服务入口不符，请重新构建插件包。')
    launcher = state_dir / LAUNCHER_NAME
    info_path = launcher / 'Contents/Info.plist'
    validate_launcher_paths(launcher)
    if launcher.exists():
        try:
            info = plistlib.loads(info_path.read_bytes())
        except (OSError, ValueError, plistlib.InvalidFileException) as error:
            raise ValueError('目标启动器不是本包创建的，未覆盖。') from error
        if not isinstance(info, dict) or info.get('MaiBadgesOwner') != OWNER or info.get('MaiBadgesRuntimePath') != str(state_dir/'runtime'):
            raise ValueError('目标启动器归属不同，未覆盖。')
        owned_launcher(state_dir)
    command_path = state_dir / '启动ChatGPT与工牌.command'
    if command_path.is_symlink() or command_path.exists() and b'MaiBadgesLauncher' not in command_path.read_bytes()[:100]:
        raise ValueError('同名 command 文件不是本包创建的，未覆盖。')
    with install_lock(state_dir):
        runtime=install_runtime(plugin,state_dir)
        # The app may not inherit the shell PATH. Pin the Python used by the user.
        server['command'] = str(python.resolve())
        server['args'] = ['${PLUGIN_ROOT}/backend/main.py', '--state-dir', str(state_dir)]
        atomic_write(mcp_path, json_bytes(mcp))
        catalog_path, name = register(project, package)
        sys.path.insert(0, str(runtime))
        try:
            from backend.registry import Registry
            with Registry(state_dir, seed_dir=runtime / 'assets'):
                pass
        finally:
            sys.path.pop(0)
    info = {'CFBundleIdentifier': LAUNCHER_ID, 'CFBundleName': LAUNCHER_DISPLAY_NAME,
            'CFBundleDisplayName': LAUNCHER_DISPLAY_NAME, 'CFBundleExecutable': 'WorkBadgeLauncher',
            'CFBundlePackageType': 'APPL', 'CFBundleVersion': LAUNCHER_BUNDLE_VERSION,
            'CFBundleIconFile': LAUNCHER_ICON_NAME, 'LSUIElement': True,
            'MaiBadgesOwner': OWNER, 'MaiBadgesRuntimePath': str(runtime)}
    write_launcher_icon(launcher, icon_data)
    atomic_write(info_path, plistlib.dumps(info))
    script = launcher_script(python.resolve(), runtime, state_dir, quiet=True)
    atomic_write(launcher / 'Contents/MacOS/WorkBadgeLauncher', script, 0o700)
    visible = launcher_script(python.resolve(), runtime, state_dir).replace(b'set -eu\n', b'# MaiBadgesLauncher\nset -eu\n', 1)
    atomic_write(command_path, visible, 0o700)
    atomic_write(state_dir / 'installation.json', json_bytes({'owner': OWNER, 'package': str(package),
                  'project': str(project), 'marketplace': str(catalog_path), 'marketplaceName': name,
                  'python': str(python.resolve()), 'launcher': str(launcher), 'runtime':str(runtime)}))
    print('准备完成：已保留/建立多角色资料库。尚未启动应用、加载器或登录项。')
    print('项目插件目录：' + str(catalog_path))
    print('插件来源名称：' + name)
    print('专用启动器：' + str(launcher))
    print('备用启动文件：' + str(command_path))
    return {'marketplace': catalog_path, 'launcher': launcher, 'command': command_path}


def unregister(project, package=PACKAGE):
    path = project / '.agents/plugins/marketplace.json'
    if not path.exists():
        print('项目内没有插件目录，无需移除。')
        return
    catalog = read_catalog(path)
    relative = './' + (package / 'plugins/work-badges').resolve().relative_to(project.resolve()).as_posix()
    own = lambda item: item.get('name') == 'work-badges' and item.get('source') == {'source': 'local', 'path': relative}
    remaining = [item for item in catalog['plugins'] if not own(item)]
    if len(remaining) != len(catalog['plugins']):
        backup(path)
        catalog['plugins'] = remaining
        atomic_write(path, json_bytes(catalog))
    print('已移除本包对应的项目目录项；其他插件条目和备份保留。')


def remove_launchers(state_dir, package=PACKAGE):
    state_dir = state_dir.expanduser().resolve()
    launchers = []
    for name in (LAUNCHER_NAME, LEGACY_LAUNCHER_NAME):
        launcher = state_dir / name
        if launcher.exists() or launcher.is_symlink():
            if launcher.is_symlink():
                raise ValueError('启动器是符号链接，未删除。')
            launchers.append(owned_launcher(state_dir, name))
    command = state_dir / '启动ChatGPT与工牌.command'
    if command.exists() or command.is_symlink():
        if command.is_symlink() or b'MaiBadgesLauncher' not in command.read_bytes()[:100]:
            raise ValueError('command 文件归属不同，未删除。')
    for launcher in launchers:
        shutil.rmtree(launcher)
    if command.exists():
        command.unlink()
    print('已移除专用启动器；工牌、绑定、位置和日志保留。')


def owned_launcher(state_dir, name=LAUNCHER_NAME):
    """Validate the prepared wrapper without launching it or following app links."""
    state_dir = state_dir.expanduser().resolve()
    launcher = state_dir / name
    info_path = launcher / 'Contents/Info.plist'
    executable = launcher / 'Contents/MacOS/WorkBadgeLauncher'
    if launcher.is_symlink() or not launcher.is_dir():
        raise ValueError('没有本包准备的专用启动器，请先运行 prepare。')
    validate_launcher_paths(launcher)
    try:
        info = plistlib.loads(info_path.read_bytes())
    except (OSError, ValueError, plistlib.InvalidFileException) as error:
        raise ValueError('专用启动器归属无法验证，请先运行 prepare。') from error
    expected = {'MaiBadgesOwner': OWNER,
                'MaiBadgesRuntimePath': str(state_dir / 'runtime'),
                'CFBundleIdentifier': LAUNCHER_ID,
                'CFBundleExecutable': 'WorkBadgeLauncher',
                'CFBundlePackageType': 'APPL'}
    if (not isinstance(info, dict) or any(info.get(key) != value for key, value in expected.items())
            or not executable.is_file() or not os.access(executable, os.X_OK)):
        raise ValueError('专用启动器归属不同或不完整，未修改应用入口。')
    return launcher


def ensure_named_launcher(state_dir):
    """Copy an owned legacy wrapper without replacing its still-useful old path."""
    state_dir = state_dir.expanduser().resolve()
    launcher = state_dir / LAUNCHER_NAME
    if launcher.exists() or launcher.is_symlink():
        return owned_launcher(state_dir)
    legacy = owned_launcher(state_dir, LEGACY_LAUNCHER_NAME)
    # Exclusive directory creation refuses even an empty foreign app or symlink.
    launcher.mkdir(mode=0o700)
    try:
        shutil.copytree(legacy, launcher, symlinks=True, dirs_exist_ok=True)
        info_path = launcher / 'Contents/Info.plist'
        info = plistlib.loads(info_path.read_bytes())
        info['CFBundleName'] = LAUNCHER_DISPLAY_NAME
        info['CFBundleDisplayName'] = LAUNCHER_DISPLAY_NAME
        info['CFBundleVersion'] = LAUNCHER_BUNDLE_VERSION
        atomic_write(info_path, plistlib.dumps(info))
        return owned_launcher(state_dir)
    except BaseException:
        shutil.rmtree(launcher)
        raise


def launcher_link_path(applications_dir):
    applications_dir = applications_dir.expanduser().resolve()
    return applications_dir / LAUNCHER_NAME


def same_launcher_link(path, launcher):
    if not path.is_symlink():
        return False
    try:
        destination = Path(os.readlink(path))
        if not destination.is_absolute():
            destination = path.parent / destination
        return destination.resolve() == launcher
    except (OSError, RuntimeError):
        return False


def install_launcher(state_dir, applications_dir=DEFAULT_APPLICATIONS, package=PACKAGE):
    """Add a user application entry; preserve every unrelated file or link."""
    state_dir = state_dir.expanduser().resolve()
    launcher = state_dir / LAUNCHER_NAME
    destination = launcher_link_path(applications_dir)
    if destination == launcher:
        raise ValueError('应用目录不能与启动器存放目录相同，请使用 ~/Applications。')
    exists = destination.is_symlink()
    if exists:
        if not same_launcher_link(destination, launcher):
            raise ValueError('应用目录已有指向其他位置的同名链接，未覆盖。')
    elif destination.exists():
        raise ValueError('应用目录已有同名文件或应用，未覆盖。')
    icon_data = launcher_icon_bytes(package)
    ensure_named_launcher(state_dir)
    launcher = refresh_launcher_icon(state_dir, icon_data)
    destination.parent.mkdir(parents=True, exist_ok=True)
    # symlink_to refuses an entry created by another process in the meantime.
    if not exists:
        destination.symlink_to(launcher, target_is_directory=True)
    legacy_link = destination.with_name(LEGACY_LAUNCHER_NAME)
    legacy = state_dir / LEGACY_LAUNCHER_NAME
    if same_launcher_link(legacy_link, legacy):
        try:
            owned_launcher(state_dir, LEGACY_LAUNCHER_NAME)
        except ValueError:
            pass  # A same-named foreign legacy wrapper never authorizes deletion.
        else:
            legacy_link.unlink()
    print(('应用入口已存在：' if exists else '已创建应用入口：') + str(destination))
    print('在访达中定位：open -R ' + shlex.quote(str(destination)))
    print('已刷新 MaiBadges 图标；若 Dock 仍显示旧图标，请将旧入口拖出 Dock，再从访达拖入。')
    print('此命令只更新启动入口和图标；工牌样式与管理页的完整更新请运行 prepare，再用 check-install 核对。')
    print('可在访达中打开它，或将它拖到 Dock；尚未启动应用或修改 Dock。')
    return destination


def check_install(state_dir, package=PACKAGE):
    """Compare owned installed files only; never infer the running app's version."""
    state_dir, package = state_dir.expanduser().resolve(), package.resolve()
    plugin = package / 'plugins/work-badges'
    manifest = json.loads((plugin / 'plugin.json').read_text(encoding='utf-8'))
    version = manifest.get('version')
    if not isinstance(version, str):
        raise ValueError('源包版本信息无效，请核对完整安装包。')
    runtime = state_dir / 'runtime'
    if runtime.is_symlink():
        raise ValueError('runtime 路径是符号链接，未读取。')
    installed = runtime.exists()
    if installed:
        marker = runtime / '.mai-owner.json'
        if marker.is_symlink() or not marker.is_file() or marker.stat().st_size > 65536:
            raise ValueError('无法确认运行时归属，未读取。')
        owner = json.loads(marker.read_text(encoding='utf-8'))
        if not isinstance(owner, dict) or owner.get('owner') != OWNER:
            raise ValueError('运行时不是本包准备的，未读取。')
    files = {}
    for name in RUNTIME_FILES:
        source, target = plugin / name, runtime / name
        if source.is_symlink() or not source.is_file():
            raise ValueError('源包文件缺失或使用符号链接：' + name)
        if installed and ((runtime / Path(name).parts[0]).is_symlink() or target.is_symlink()):
            raise ValueError('已安装文件使用符号链接，未读取：' + name)
        files[name] = bool(installed and target.is_file()
                           and hashlib.sha256(source.read_bytes()).digest() == hashlib.sha256(target.read_bytes()).digest())
    current = all(files.values())
    print('源包版本：' + version)
    for title, name in (('工牌样式', 'runtime/renderer.js'), ('管理页', 'ui/manager.html'), ('加载器', 'loader/main.py')):
        print(title + '：' + ('已安装文件与源包一致' if files[name] else '待完整更新'))
    print('完整运行时：' + ('文件全部一致' if current else '存在缺失或旧文件，请运行 prepare'))
    print('这是本地文件比对，不代表当前窗口已重载；更新后仍须 Cmd+Q 完全退出，再从 MaiBadges 打开。')
    return {'sourceVersion': version, 'runtimePresent': installed, 'runtimeFilesCurrent': current, 'files': files}


def uninstall_launcher(state_dir, applications_dir=DEFAULT_APPLICATIONS):
    """Remove only a link to this state's verified, owned app wrapper."""
    state_dir = state_dir.expanduser().resolve()
    destination = launcher_link_path(applications_dir)
    remove = []
    if destination.is_symlink():
        if not same_launcher_link(destination, state_dir / LAUNCHER_NAME):
            raise ValueError('应用目录中的同名链接指向其他位置，未删除。')
        owned_launcher(state_dir)
        remove.append(destination)
    elif destination.exists():
        raise ValueError('应用目录中的同名项目不是软链，未删除。')
    legacy_link = destination.with_name(LEGACY_LAUNCHER_NAME)
    if same_launcher_link(legacy_link, state_dir / LEGACY_LAUNCHER_NAME):
        owned_launcher(state_dir, LEGACY_LAUNCHER_NAME)
        remove.append(legacy_link)
    if not remove:
        print('应用目录没有本包入口，无需移除。')
        return
    for link in remove:
        link.unlink()
    print('已移除本包的应用入口；专用启动器、官方应用和工牌资料保留。')


def cli(argv=None):
    parser = argparse.ArgumentParser(description='MaiBadges 本地插件安装准备，只在你手动运行时写入自己的项目目录和启动器。')
    parser.add_argument('command', nargs='?', default='prepare', choices=('prepare', 'remove-marketplace', 'remove-launchers',
                                                                         'install-launcher', 'uninstall-launcher', 'check-install'))
    parser.add_argument('--project-dir', type=Path, default=DEFAULT_PROJECT)
    parser.add_argument('--state-dir', type=Path, default=DEFAULT_STATE)
    parser.add_argument('--applications-dir', type=Path, default=DEFAULT_APPLICATIONS,
                        help='专用启动器的应用入口目录，默认 ~/Applications；仅用于 install/uninstall-launcher。')
    args = parser.parse_args(argv)
    try:
        project, state_dir = args.project_dir.expanduser().resolve(), args.state_dir.expanduser().resolve()
        if args.command == 'prepare':
            prepare(project, state_dir)
        elif args.command == 'remove-marketplace':
            unregister(project)
        elif args.command == 'install-launcher':
            install_launcher(state_dir, args.applications_dir, PACKAGE)
        elif args.command == 'uninstall-launcher':
            uninstall_launcher(state_dir, args.applications_dir)
        elif args.command == 'check-install':
            return 0 if check_install(state_dir, PACKAGE)['runtimeFilesCurrent'] else 3
        else:
            remove_launchers(state_dir)
        return 0
    except (OSError, ValueError, TypeError) as error:
        print('未完成：' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(cli())
