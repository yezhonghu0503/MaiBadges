"""Installation tests use a fake project/state inside the package, never the home."""
import copy
import importlib.util
import contextlib
import io
import json
from pathlib import Path
import plistlib
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
import fcntl

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('work_badges_setup', ROOT / 'setup.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
sys.path.insert(0, str(ROOT / 'plugins/work-badges'))
from backend.registry import Registry


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='.setup-test-', dir=str(ROOT / 'tests'))
        self.folder = Path(self.temp.name)
        self.project = self.folder / '项目 with spaces'
        self.package = self.project / 'MaiBadges'
        self.state = self.folder / 'fake-home/state with spaces'
        self.package.mkdir(parents=True)
        shutil.copytree(ROOT / 'plugins/work-badges', self.package / 'plugins/work-badges',
                        ignore=shutil.ignore_patterns('__pycache__', 'tests', '.backend-test-*'))
        # Tiny isolated ICNS container fixture; never read the real package icon.
        self.icon_source = self.package / 'plugins/work-badges/assets/maibadges.icns'
        self.icon_data = b'icns' + (20).to_bytes(4, 'big') + b'test' + (12).to_bytes(4, 'big') + b'data'
        self.icon_source.write_bytes(self.icon_data)

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self):
        # If setup ever grows a subprocess/network side effect, fail the contract.
        with patch('subprocess.run', side_effect=AssertionError('no system command')), \
             patch('subprocess.Popen', side_effect=AssertionError('no launch')), \
             patch('socket.create_connection', side_effect=AssertionError('no network')):
            return setup.prepare(self.project, self.state, self.package)

    def test_default_project_is_package_parent_and_source_stays_within_project(self):
        self.assertEqual(setup.DEFAULT_PROJECT, ROOT)
        self.assertEqual(setup.DEFAULT_STATE.name, 'MaiBadges')
        self.assertEqual(setup.LAUNCHER_ID, 'com.maibadges.launcher')
        self.assertEqual(setup.LAUNCHER_NAME, 'MaiBadges.app')
        self.prepare()
        catalog=json.loads((self.project/'.agents/plugins/marketplace.json').read_text())
        own=next(entry for entry in catalog['plugins'] if entry['name']=='work-badges')
        self.assertEqual(own['source'],{'source':'local','path':'./MaiBadges/plugins/work-badges'})

    def test_check_install_reports_absent_runtime_without_creating_files(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            status = setup.check_install(self.state, self.package)
        self.assertFalse(status['runtimePresent'])
        self.assertFalse(status['runtimeFilesCurrent'])
        self.assertFalse(self.state.exists())
        self.assertIn('工牌样式：待完整更新', output.getvalue())

    def test_check_install_compares_files_without_process_network_or_database_actions(self):
        self.prepare()
        before = {str(p.relative_to(self.state)): p.read_bytes() for p in self.state.rglob('*') if p.is_file()}
        with patch('subprocess.run', side_effect=AssertionError('no system command')), \
             patch('subprocess.Popen', side_effect=AssertionError('no launch')), \
             patch('socket.create_connection', side_effect=AssertionError('no network')), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            status = setup.check_install(self.state, self.package)
        self.assertTrue(status['runtimeFilesCurrent'])
        self.assertTrue(all(status['files'].values()))
        self.assertIn('不代表当前窗口已重载', output.getvalue())
        self.assertEqual(before, {str(p.relative_to(self.state)): p.read_bytes() for p in self.state.rglob('*') if p.is_file()})

    def test_check_install_detects_old_renderer_and_missing_manager_independently(self):
        self.prepare()
        (self.state / 'runtime/runtime/renderer.js').write_text('/* old renderer */')
        with contextlib.redirect_stdout(io.StringIO()):
            status = setup.check_install(self.state, self.package)
        self.assertFalse(status['files']['runtime/renderer.js'])
        self.assertTrue(status['files']['ui/manager.html'])
        (self.state / 'runtime/ui/manager.html').unlink()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertFalse(setup.check_install(self.state, self.package)['files']['ui/manager.html'])

    def test_check_install_refuses_foreign_runtime_and_linked_files(self):
        self.prepare()
        marker = self.state / 'runtime/.mai-owner.json'
        original = marker.read_bytes()
        marker.write_text('{"owner":"foreign"}')
        with self.assertRaisesRegex(ValueError, '不是本包'):
            setup.check_install(self.state, self.package)
        marker.write_bytes(original)
        target = self.state / 'runtime/runtime/renderer.js'
        target.unlink(); target.symlink_to(self.package / 'plugins/work-badges/runtime/renderer.js')
        with self.assertRaisesRegex(ValueError, '符号链接'):
            setup.check_install(self.state, self.package)

    def test_prepares_five_roles_portable_plugin_and_launchers_without_launching(self):
        result = self.prepare()
        with Registry(self.state) as registry:
            self.assertEqual(len(registry.snapshot()['roles']), 5)
            self.assertEqual(registry.snapshot()['bindings'], [])
        mcp=json.loads((self.package / 'plugins/work-badges/mcp.json').read_text())['mcpServers']['work_badges']
        self.assertEqual(mcp['command'],str(Path(sys.executable).resolve()))
        self.assertEqual(mcp['args'],['${PLUGIN_ROOT}/backend/main.py','--state-dir',str(self.state.resolve())])
        info=plistlib.loads((result['launcher']/'Contents/Info.plist').read_bytes())
        self.assertEqual(result['launcher'].name, 'MaiBadges.app')
        self.assertEqual(info['CFBundleName'],'MaiBadges')
        self.assertEqual(info['CFBundleDisplayName'],'MaiBadges')
        self.assertEqual(info['CFBundleVersion'],'3')
        self.assertEqual(info['CFBundleIconFile'], 'MaiBadges.icns')
        self.assertEqual((result['launcher'] / 'Contents/Resources/MaiBadges.icns').read_bytes(), self.icon_data)
        self.assertTrue((self.state/'runtime/ui/manager.html').is_file())
        self.assertFalse((self.state/'config.json').exists())

    def test_upgrade_keeps_roles_bindings_and_position(self):
        self.prepare()
        with Registry(self.state) as registry:
            snap=registry.upsert_role({'id':'max','bio':'用户保存的资料'},registry.snapshot()['version'])
            registry.bind('max','title','Max（运营总监）','测试',snap['version'])
            registry.prefs_save('86c36ad8-3e65-4efb-a523-13ab3882e2b8','max',{'x':600,'y':250,'width':266},{'flipped':True,'collapsed':False})
        self.prepare()
        with Registry(self.state) as registry:
            self.assertEqual(registry.resolve({'title':'Max（运营总监）'})['bio'],'用户保存的资料')
            self.assertTrue(registry.prefs_get('86c36ad8-3e65-4efb-a523-13ab3882e2b8')['roles']['max']['flipped'])

    def test_upgrade_adds_sidebar_runtime_without_changing_custom_avatar_or_binding(self):
        import base64
        self.prepare()
        avatar = 'data:image/png;base64,' + base64.b64encode(
            (self.package / 'plugins/work-badges/assets/brand.png').read_bytes()).decode('ascii')
        with Registry(self.state) as registry:
            saved = registry.upsert_role({'id': 'upgrade-example', 'name': 'Nova',
                'role': 'Example operator', 'avatarDataUrl': avatar}, registry.snapshot()['version'])
            registry.bind('upgrade-example', 'title', 'Upgrade example', 'Upgrade example', saved['version'])
            before = registry.snapshot()
            image_id = next(role['imageId'] for role in before['roles'] if role['id'] == 'upgrade-example')
            before_avatar = registry.avatar_data(image_id)
        # The old public runtime did not ship either sidebar component.
        for relative in ('backend/sidebar_assets.py', 'runtime/sidebar.js'):
            (self.state / 'runtime' / relative).unlink()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertFalse(setup.check_install(self.state, self.package)['runtimeFilesCurrent'])
        self.prepare()
        with Registry(self.state) as registry:
            self.assertEqual(registry.snapshot(), before)
            self.assertEqual(registry.avatar_data(image_id), before_avatar)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(setup.check_install(self.state, self.package)['runtimeFilesCurrent'])

    def test_existing_catalog_fields_and_other_plugins_are_preserved(self):
        path=self.project/'.agents/plugins/marketplace.json';path.parent.mkdir(parents=True)
        previous={'name':'my-catalog','custom':{'keep':True},'plugins':[{'name':'other','source':{'source':'local','path':'./other'}}]}
        path.write_text(json.dumps(previous))
        self.prepare();catalog=json.loads(path.read_text())
        self.assertEqual(catalog['name'],'my-catalog');self.assertEqual(catalog['custom'],{'keep':True})
        self.assertEqual(catalog['plugins'][0],previous['plugins'][0])
        self.assertEqual(len(list(path.parent.glob('marketplace.before-work-badges-*.json'))),1)

    def test_register_is_idempotent_and_unregistration_removes_only_own_entry(self):
        self.prepare();self.prepare()
        path=self.project/'.agents/plugins/marketplace.json'
        self.assertEqual(len(json.loads(path.read_text())['plugins']),1)
        setup.unregister(self.project,self.package)
        self.assertEqual(json.loads(path.read_text())['plugins'],[])
        self.assertTrue((self.state/'registry.sqlite3').exists())

    def test_foreign_runtime_is_not_replaced(self):
        (self.state/'runtime').mkdir(parents=True);(self.state/'runtime/keep').write_text('foreign')
        with self.assertRaisesRegex(ValueError,'不是本包'):
            self.prepare()
        self.assertEqual((self.state/'runtime/keep').read_text(),'foreign')

    def test_foreign_launcher_is_not_replaced(self):
        (self.state/setup.LAUNCHER_NAME).mkdir(parents=True)
        with self.assertRaisesRegex(ValueError,'不是本包'):
            self.prepare()

    def test_runtime_replacement_requires_stopped_loader(self):
        self.state.mkdir(parents=True)
        with (self.state/'run.lock').open('a') as stream:
            fcntl.flock(stream,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaisesRegex(ValueError,'加载器正在运行'):
                self.prepare()

    def test_foreign_mcp_entry_and_catalog_symlink_are_refused(self):
        mcp=self.package/'plugins/work-badges/mcp.json';original=mcp.read_text()
        mcp.write_text(json.dumps({'mcpServers':{'work_badges':{'args':['bad'],'cwd':'${PLUGIN_ROOT}'}}}))
        with self.assertRaisesRegex(ValueError,'入口不符'): self.prepare()
        mcp.write_text(original)
        path=self.project/'.agents/plugins/marketplace.json';path.parent.mkdir(parents=True);target=self.folder/'catalog.json';target.write_text('{}');path.symlink_to(target)
        with self.assertRaisesRegex(ValueError,'符号链接'): self.prepare()

    def test_owned_launcher_removal_keeps_registry_and_runtime(self):
        self.prepare();setup.remove_launchers(self.state,self.package)
        self.assertFalse((self.state/setup.LAUNCHER_NAME).exists())
        self.assertTrue((self.state/'registry.sqlite3').exists())
        self.assertTrue((self.state/'runtime/loader/main.py').exists())

    def test_application_entry_is_idempotent_and_does_not_launch_or_touch_official_app(self):
        self.prepare()
        apps=self.folder/'fake-home/Applications'
        official=apps/'ChatGPT.app';official.mkdir(parents=True)
        marker=official/'keep';marker.write_text('official application')
        with patch('subprocess.run', side_effect=AssertionError('no system command')), \
             patch('subprocess.Popen', side_effect=AssertionError('no launch')), \
             patch('socket.create_connection', side_effect=AssertionError('no network')):
            link=setup.install_launcher(self.state,apps,self.package)
            identity=link.lstat().st_ino
            self.assertEqual(setup.install_launcher(self.state,apps,self.package),link)
            self.assertEqual(link.lstat().st_ino,identity)
        self.assertTrue(link.is_symlink())
        self.assertEqual(link.resolve(),self.state/setup.LAUNCHER_NAME)
        self.assertEqual(marker.read_text(),'official application')
        self.assertEqual(setup.DEFAULT_APPLICATIONS,Path.home()/'Applications')

    def test_application_entry_refuses_foreign_files_directories_and_links(self):
        self.prepare()
        for kind in ('file','directory','link','broken-link','loop-link'):
            with self.subTest(kind=kind):
                apps=self.folder/('apps-'+kind);apps.mkdir()
                target=apps/setup.LAUNCHER_NAME
                if kind=='file':target.write_text('keep')
                elif kind=='directory':target.mkdir()
                elif kind=='loop-link':target.symlink_to(target)
                else:target.symlink_to(self.folder/('other-'+kind))
                before=target.lstat()
                with self.assertRaisesRegex(ValueError,'未覆盖'):
                    setup.install_launcher(self.state,apps,self.package)
                with self.assertRaisesRegex(ValueError,'未删除'):
                    setup.uninstall_launcher(self.state,apps)
                self.assertEqual(target.lstat().st_ino,before.st_ino)

    def test_application_entry_requires_owned_complete_prepared_wrapper(self):
        apps=self.folder/'Applications'
        with self.assertRaisesRegex(ValueError,'prepare'):
            setup.install_launcher(self.state,apps,self.package)
        self.assertFalse(apps.exists())
        result=self.prepare()
        info_path=result['launcher']/'Contents/Info.plist'
        info=plistlib.loads(info_path.read_bytes());info['MaiBadgesOwner']='other'
        info_path.write_bytes(plistlib.dumps(info))
        with self.assertRaisesRegex(ValueError,'归属不同'):
            setup.install_launcher(self.state,apps,self.package)
        self.assertFalse(apps.exists())

    def test_uninstall_application_entry_checks_ownership_and_keeps_data(self):
        result=self.prepare();apps=self.folder/'Applications'
        link=setup.install_launcher(self.state,apps,self.package)
        info_path=result['launcher']/'Contents/Info.plist'
        original=info_path.read_bytes()
        info=plistlib.loads(original);info['MaiBadgesRuntimePath']='/another/runtime'
        info_path.write_bytes(plistlib.dumps(info))
        with self.assertRaisesRegex(ValueError,'归属不同'):
            setup.uninstall_launcher(self.state,apps)
        self.assertTrue(link.is_symlink())
        info_path.write_bytes(original)
        setup.uninstall_launcher(self.state,apps)
        self.assertFalse(link.is_symlink())
        self.assertTrue(result['launcher'].is_dir())
        self.assertTrue((self.state/'registry.sqlite3').exists())
        setup.uninstall_launcher(self.state,apps)

    def test_relative_owned_link_is_idempotent_and_removable(self):
        self.prepare();apps=self.state/'Applications';apps.mkdir()
        link=apps/setup.LAUNCHER_NAME
        link.symlink_to(Path('..')/setup.LAUNCHER_NAME)
        self.assertEqual(setup.install_launcher(self.state,apps,self.package),link)
        setup.uninstall_launcher(self.state,apps)
        self.assertFalse(link.is_symlink())

    def test_removed_or_linked_wrapper_does_not_authorize_application_entry_removal(self):
        result=self.prepare();apps=self.folder/'Applications'
        link=setup.install_launcher(self.state,apps,self.package)
        real=self.state/'Moved.app';result['launcher'].rename(real)
        with self.assertRaisesRegex(ValueError,'prepare'):
            setup.uninstall_launcher(self.state,apps)
        result['launcher'].symlink_to(real)
        with self.assertRaisesRegex(ValueError,'未删除'):
            setup.uninstall_launcher(self.state,apps)
        self.assertTrue(link.is_symlink())
        self.assertTrue(real.is_dir())

    def test_application_entry_cli_uses_only_explicit_test_directories(self):
        self.prepare();apps=self.folder/'CLI Applications'
        options=['--state-dir',str(self.state),'--applications-dir',str(apps)]
        with patch.object(setup, 'PACKAGE', self.package):
            self.assertEqual(setup.cli(['install-launcher']+options),0)
        self.assertTrue((apps/setup.LAUNCHER_NAME).is_symlink())
        self.assertEqual(setup.cli(['uninstall-launcher']+options),0)
        self.assertFalse((apps/setup.LAUNCHER_NAME).is_symlink())

    def test_application_entry_never_replaces_its_source_directory(self):
        result=self.prepare()
        with self.assertRaisesRegex(ValueError,'不能与启动器'):
            setup.install_launcher(self.state,self.state,self.package)
        self.assertTrue(result['launcher'].is_dir())

    def test_prepare_upgrade_keeps_existing_application_link(self):
        self.prepare();apps=self.folder/'Applications'
        link=setup.install_launcher(self.state,apps,self.package);identity=link.lstat().st_ino
        self.prepare()
        self.assertEqual(link.lstat().st_ino,identity)
        self.assertEqual(setup.install_launcher(self.state,apps,self.package),link)
        self.assertTrue((link/'Contents/MacOS/WorkBadgeLauncher').is_file())

    def legacy_launcher(self):
        """Model an already-prepared 0.3.0 wrapper without executing it."""
        result = self.prepare()
        legacy = self.state / setup.LEGACY_LAUNCHER_NAME
        result['launcher'].rename(legacy)
        info_path = legacy / 'Contents/Info.plist'
        info = plistlib.loads(info_path.read_bytes())
        info.update(CFBundleName='ChatGPT · 工牌', CFBundleDisplayName='ChatGPT · 工牌', CFBundleVersion='1')
        info_path.write_bytes(plistlib.dumps(info))
        return legacy

    def test_old_install_migrates_without_prepare_stop_or_data_changes(self):
        legacy = self.legacy_launcher()
        apps = self.folder / 'Applications'
        apps.mkdir()
        old_link = apps / setup.LEGACY_LAUNCHER_NAME
        old_link.symlink_to(legacy)
        (self.state / 'config.json').write_text('{"scopeId":"preserve"}')
        (self.state / 'status.json').write_text('{"state":"mounted"}')
        keep_paths = [self.state / name for name in ('registry.sqlite3', 'config.json', 'status.json', 'installation.json')]
        keep_paths += list((self.state / 'runtime').rglob('*'))
        keep_paths += list(legacy.rglob('*'))
        before = {path: path.read_bytes() for path in keep_paths if path.is_file()}
        with (self.state / 'run.lock').open('a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch('subprocess.run', side_effect=AssertionError('no system command')), \
                 patch('subprocess.Popen', side_effect=AssertionError('no launch')), \
                 patch('socket.create_connection', side_effect=AssertionError('no network')):
                link = setup.install_launcher(self.state, apps, self.package)
        self.assertEqual(link.name, 'MaiBadges.app')
        self.assertEqual(link.resolve(), self.state / setup.LAUNCHER_NAME)
        self.assertFalse(old_link.is_symlink())
        self.assertTrue(legacy.is_dir())
        self.assertEqual({path: path.read_bytes() for path in before}, before)
        new_info = plistlib.loads((link / 'Contents/Info.plist').read_bytes())
        self.assertEqual(new_info['CFBundleName'], 'MaiBadges')
        self.assertEqual(new_info['CFBundleDisplayName'], 'MaiBadges')
        self.assertEqual(new_info['CFBundleIdentifier'], setup.LAUNCHER_ID)
        self.assertEqual(new_info['CFBundleVersion'], '3')
        self.assertEqual((link / 'Contents/MacOS/WorkBadgeLauncher').read_bytes(),
                         (legacy / 'Contents/MacOS/WorkBadgeLauncher').read_bytes())
        identity = link.lstat().st_ino
        self.assertEqual(setup.install_launcher(self.state, apps, self.package).lstat().st_ino, identity)

    def test_migration_preserves_foreign_old_application_entries(self):
        legacy = self.legacy_launcher()
        for kind in ('file', 'directory', 'link', 'broken-link'):
            with self.subTest(kind=kind):
                apps = self.folder / ('legacy-apps-' + kind)
                apps.mkdir()
                old = apps / setup.LEGACY_LAUNCHER_NAME
                if kind == 'file':
                    old.write_text('foreign')
                elif kind == 'directory':
                    old.mkdir()
                else:
                    target = self.folder / ('foreign-' + kind)
                    if kind == 'link':
                        target.mkdir()
                    old.symlink_to(target)
                identity = old.lstat().st_ino
                link = setup.install_launcher(self.state, apps, self.package)
                self.assertEqual(old.lstat().st_ino, identity)
                self.assertTrue(link.is_symlink())
        self.assertTrue(legacy.is_dir())

    def test_migration_refuses_foreign_new_destination_before_creating_wrapper(self):
        self.legacy_launcher()
        apps = self.folder / 'Applications'
        apps.mkdir()
        foreign = apps / setup.LAUNCHER_NAME
        foreign.mkdir()
        (foreign / 'keep').write_text('foreign')
        with self.assertRaisesRegex(ValueError, '未覆盖'):
            setup.install_launcher(self.state, apps, self.package)
        self.assertFalse((self.state / setup.LAUNCHER_NAME).exists())
        self.assertEqual((foreign / 'keep').read_text(), 'foreign')

    def test_migration_refuses_foreign_or_linked_old_wrapper(self):
        legacy = self.legacy_launcher()
        info_path = legacy / 'Contents/Info.plist'
        info = plistlib.loads(info_path.read_bytes())
        info['MaiBadgesOwner'] = 'foreign'
        info_path.write_bytes(plistlib.dumps(info))
        apps = self.folder / 'Applications'
        with self.assertRaisesRegex(ValueError, '归属不同'):
            setup.install_launcher(self.state, apps, self.package)
        self.assertFalse(apps.exists())
        self.assertFalse((self.state / setup.LAUNCHER_NAME).exists())
        moved = self.state / 'moved-legacy.app'
        legacy.rename(moved)
        legacy.symlink_to(moved)
        with self.assertRaisesRegex(ValueError, 'prepare'):
            setup.install_launcher(self.state, apps, self.package)
        self.assertTrue(legacy.is_symlink())

    def test_canonical_install_does_not_remove_link_to_foreign_old_wrapper(self):
        self.prepare()
        legacy = self.state / setup.LEGACY_LAUNCHER_NAME
        legacy.mkdir()
        apps = self.folder / 'Applications'
        apps.mkdir()
        old = apps / setup.LEGACY_LAUNCHER_NAME
        old.symlink_to(legacy)
        setup.install_launcher(self.state, apps, self.package)
        self.assertTrue(old.is_symlink())
        self.assertTrue(legacy.is_dir())

    def test_uninstall_legacy_application_link_keeps_wrapper_and_data(self):
        legacy = self.legacy_launcher()
        apps = self.folder / 'Applications'
        apps.mkdir()
        old = apps / setup.LEGACY_LAUNCHER_NAME
        old.symlink_to(legacy)
        setup.uninstall_launcher(self.state, apps)
        self.assertFalse(old.is_symlink())
        self.assertTrue(legacy.is_dir())
        self.assertTrue((self.state / 'registry.sqlite3').exists())

    def test_remove_launchers_removes_both_owned_names_only(self):
        legacy = self.legacy_launcher()
        setup.install_launcher(self.state, self.folder / 'Applications', self.package)
        (self.state / 'keep.txt').write_text('unrelated')
        setup.remove_launchers(self.state)
        self.assertFalse(legacy.exists())
        self.assertFalse((self.state / setup.LAUNCHER_NAME).exists())
        self.assertEqual((self.state / 'keep.txt').read_text(), 'unrelated')
        self.assertTrue((self.state / 'registry.sqlite3').exists())
        self.assertTrue((self.state / 'runtime').is_dir())

    def test_install_output_gives_quoted_manual_finder_location(self):
        self.prepare()
        apps = self.folder / "Applications with user's spaces"
        with patch('builtins.print') as output:
            destination = setup.install_launcher(self.state, apps, self.package)
        rendered = '\n'.join(str(call.args[0]) for call in output.call_args_list)
        self.assertIn('open -R ' + setup.shlex.quote(str(destination)), rendered)
        self.assertIn('MaiBadges.app', rendered)
        self.assertIn('若 Dock 仍显示旧图标', rendered)

    def test_launcher_only_refresh_adds_icon_to_old_wrapper_while_loader_lock_is_held(self):
        result = self.prepare()
        launcher = result['launcher']
        info_path = launcher / 'Contents/Info.plist'
        info = plistlib.loads(info_path.read_bytes())
        info.pop('CFBundleIconFile')
        info.update(CFBundleVersion='2', UnrelatedLauncherSetting='preserve')
        info_path.write_bytes(plistlib.dumps(info))
        icon = launcher / 'Contents/Resources/MaiBadges.icns'
        icon.unlink()
        unrelated = launcher / 'Contents/Resources/other-resource.txt'
        unrelated.write_text('keep this resource')
        (self.state / 'config.json').write_text('{"scopeId":"preserve"}')
        keep_paths = [path for path in self.state.rglob('*') if path.is_file()
                      and launcher not in path.parents]
        keep_paths.extend((launcher / 'Contents/MacOS/WorkBadgeLauncher', unrelated))
        before = {path: path.read_bytes() for path in keep_paths}
        setup.os.utime(launcher, (1, 1))
        with (self.state / 'run.lock').open('a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch('subprocess.run', side_effect=AssertionError('no system command')), \
                 patch('subprocess.Popen', side_effect=AssertionError('no launch')), \
                 patch('socket.create_connection', side_effect=AssertionError('no network')):
                link = setup.install_launcher(self.state, self.folder / 'Applications', self.package)
        self.assertEqual(icon.read_bytes(), self.icon_data)
        self.assertEqual({path: path.read_bytes() for path in before}, before)
        current_info = plistlib.loads(info_path.read_bytes())
        self.assertEqual(current_info['UnrelatedLauncherSetting'], 'preserve')
        self.assertEqual(current_info['CFBundleIconFile'], 'MaiBadges.icns')
        self.assertEqual(current_info['CFBundleVersion'], '3')
        self.assertGreater(launcher.stat().st_mtime, 1)
        self.assertEqual(link.resolve(), launcher)

    def test_repeated_install_updates_icon_at_same_owned_application(self):
        result = self.prepare()
        apps = self.folder / 'Applications'
        link = setup.install_launcher(self.state, apps, self.package)
        identity = link.lstat().st_ino
        new_icon = self.icon_data[:-4] + b'next'
        self.icon_source.write_bytes(new_icon)
        setup.install_launcher(self.state, apps, self.package)
        self.assertEqual(link.lstat().st_ino, identity)
        icon = result['launcher'] / 'Contents/Resources/MaiBadges.icns'
        self.assertEqual(icon.read_bytes(), new_icon)

    def test_icon_refresh_refuses_linked_bundle_paths_without_touching_targets(self):
        result = self.prepare()
        for index, relative in enumerate(('Contents/Resources', 'Contents/Resources/MaiBadges.icns',
                                           'Contents/Info.plist', 'Contents/MacOS/WorkBadgeLauncher',
                                           'Contents/MacOS', 'Contents')):
            with self.subTest(path=relative):
                destination = result['launcher'] / relative
                moved = self.folder / ('bundle-target-' + str(index))
                destination.rename(moved)
                original = {path.relative_to(moved): path.read_bytes() for path in moved.rglob('*')
                            if path.is_file()} if moved.is_dir() else moved.read_bytes()
                destination.symlink_to(moved, target_is_directory=moved.is_dir())
                try:
                    with self.assertRaisesRegex(ValueError, '符号链接'):
                        setup.install_launcher(self.state, self.folder / 'Applications', self.package)
                    self.assertFalse((self.folder / 'Applications').exists())
                    current = {path.relative_to(moved): path.read_bytes() for path in moved.rglob('*')
                               if path.is_file()} if moved.is_dir() else moved.read_bytes()
                    self.assertEqual(current, original)
                finally:
                    destination.unlink()
                    moved.rename(destination)

    def test_prepare_refuses_linked_icon_destination_before_runtime_replacement(self):
        result = self.prepare()
        icon = result['launcher'] / 'Contents/Resources/MaiBadges.icns'
        target = self.folder / 'other-icon.icns'
        target.write_bytes(b'keep')
        icon.unlink()
        icon.symlink_to(target)
        runtime_main = self.state / 'runtime/backend/main.py'
        identity = runtime_main.stat().st_ino
        with self.assertRaisesRegex(ValueError, '符号链接'):
            self.prepare()
        self.assertEqual(target.read_bytes(), b'keep')
        self.assertEqual(runtime_main.stat().st_ino, identity)

    def test_icon_refresh_rejects_unsafe_non_regular_destinations(self):
        result = self.prepare()
        icon = result['launcher'] / 'Contents/Resources/MaiBadges.icns'
        icon.unlink()
        icon.mkdir()
        (icon / 'keep').write_text('keep')
        with self.assertRaisesRegex(ValueError, '不安全'):
            setup.install_launcher(self.state, self.folder / 'Applications', self.package)
        self.assertEqual((icon / 'keep').read_text(), 'keep')

    def test_missing_invalid_or_linked_source_icon_does_not_modify_existing_wrapper(self):
        result = self.prepare()
        info_path = result['launcher'] / 'Contents/Info.plist'
        original_info = info_path.read_bytes()
        icon_path = result['launcher'] / 'Contents/Resources/MaiBadges.icns'
        original_icon = icon_path.read_bytes()
        source_target = self.folder / 'external.icns'
        source_target.write_bytes(self.icon_data)
        for kind in ('missing', 'bad-magic', 'bad-length', 'link'):
            with self.subTest(kind=kind):
                if self.icon_source.exists() or self.icon_source.is_symlink():
                    self.icon_source.unlink()
                if kind == 'bad-magic':
                    self.icon_source.write_bytes(b'nope' + self.icon_data[4:])
                elif kind == 'bad-length':
                    self.icon_source.write_bytes(self.icon_data + b'x')
                elif kind == 'link':
                    self.icon_source.symlink_to(source_target)
                with self.assertRaises(ValueError):
                    setup.install_launcher(self.state, self.folder / 'Applications', self.package)
                self.assertEqual(info_path.read_bytes(), original_info)
                self.assertEqual(icon_path.read_bytes(), original_icon)
                self.assertFalse((self.folder / 'Applications').exists())


if __name__=='__main__':
    unittest.main()
