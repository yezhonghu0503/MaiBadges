"""A prepared local package must still produce a portable, private-state-free ZIP."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_package


class PackageTests(unittest.TestCase):
    def test_archive_omits_private_role_sources_and_runtime_but_keeps_public_artwork(self):
        with tempfile.TemporaryDirectory(prefix='.bundle-test-privacy-', dir=Path(__file__).parent) as folder:
            root = Path(folder) / 'package'
            plugin = root / 'plugins/work-badges'
            files = {
                'plugins/work-badges/ui/manager.template.html': '<style>__FONT_DATA__</style><script>/* __MANAGER_JS__ */</script>',
                'plugins/work-badges/ui/manager.js': '/* fixture */',
                'plugins/work-badges/runtime/renderer.js': '/* fixture */',
                'plugins/work-badges/loader/probe.js': '/* fixture */',
                'plugins/work-badges/assets/BricolageGrotesque.ttf': 'fixture font',
                'plugins/work-badges/assets/demo.png': 'public demo',
                'plugins/work-badges/assets/max.png': 'private legacy persona',
                'plugins/work-badges/assets/holo/demo/background.png': 'public background',
                'plugins/work-badges/assets/holo/max/background.png': 'private legacy background',
                '角色资料/Max/profile-before-v1.json': '{"chatBinding":[{"key":"private chat before"}]}',
                '角色资料/Max/profile-v1.json': '{"chatBinding":[{"key":"private active chat"}]}',
                '角色资料/Max/max-avatar-v1.jpg': 'private local original',
                'art/max-source/private-prompt.json': 'private generation history',
                '.impeccable/review/private-preview.jpg': 'private browser proof',
                'runtime/registry.sqlite3': 'private database',
                'runtime/registry.sqlite3-wal': 'private database WAL',
                'runtime/loader.log': 'private live log',
            }
            for name, value in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(value, encoding='utf-8')
            with patch.object(build_package, 'ROOT', root), patch.object(build_package, 'PLUGIN', plugin):
                archive = build_package.build(archive=True)
            with zipfile.ZipFile(archive) as output:
                names = set(output.namelist())
                self.assertIn('package/plugins/work-badges/assets/demo.png', names)
                self.assertNotIn('package/plugins/work-badges/assets/max.png', names)
                self.assertNotIn('package/plugins/work-badges/assets/holo/max/background.png', names)
                self.assertIn('package/plugins/work-badges/assets/holo/demo/background.png', names)
                self.assertFalse(any(name.startswith(('package/角色资料/', 'package/art/', 'package/.impeccable/')) for name in names))
                self.assertFalse(any(name.endswith(('.sqlite3', '-wal', '-shm', '.log')) for name in names))
                self.assertFalse(any(b'private active chat' in output.read(name) for name in names))
            for name, original in files.items():
                self.assertEqual((root / name).read_text(encoding='utf-8'), original,
                                 'Packaging must not delete or rewrite local role/runtime records')

    def test_archive_normalizes_local_config_without_changing_source(self):
        with tempfile.TemporaryDirectory(prefix='.bundle-test-package-', dir=Path(__file__).parent) as folder:
            root = Path(folder) / 'package'
            plugin = root / 'plugins/work-badges'
            content = {
                'ui/manager.template.html': "<style>__FONT_DATA__</style><script>/* __MANAGER_JS__ */</script>",
                'ui/manager.js': 'console.log("fixture");',
                'runtime/renderer.js': '/* fixture */', 'loader/probe.js': '/* fixture */',
                'assets/BricolageGrotesque.ttf': 'fixture font', 'assets/demo.png': 'fixture image',
                'mcp.json': json.dumps({'private': '/Users/test-only/private-state'}),
            }
            for name, value in content.items():
                path = plugin / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(value, encoding='utf-8')
            for name in ('MIGRATION.json', 'RELEASE.json', '.DS_Store', '迁移记录/old.json',
                         '__pycache__/cache.pyc', 'state.sqlite3', 'state.sqlite3-wal', 'service.log'):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('private fixture', encoding='utf-8')
            (root / 'README.md').write_text('shareable', encoding='utf-8')
            (root / 'unrelated-link').symlink_to(root / 'README.md')
            original = (plugin / 'mcp.json').read_bytes()
            with patch.object(build_package, 'ROOT', root), patch.object(build_package, 'PLUGIN', plugin):
                archive = build_package.build(archive=True)
            self.assertEqual((plugin / 'mcp.json').read_bytes(), original)
            with zipfile.ZipFile(archive) as output:
                self.assertIsNone(output.testzip())
                names = output.namelist()
                self.assertIn('package/README.md', names)
                self.assertFalse(any('迁移记录' in name or name.endswith(('.log', '.pyc', '-wal'))
                                     or Path(name).name in ('MIGRATION.json', 'RELEASE.json', '.DS_Store',
                                                           'state.sqlite3', 'unrelated-link') for name in names))
                mcp = json.loads(output.read('package/plugins/work-badges/mcp.json'))
                self.assertEqual(mcp, build_package.portable_mcp())
                self.assertNotIn(b'/Users/', output.read('package/plugins/work-badges/mcp.json'))
                self.assertNotIn(b'__MANAGER_JS__', output.read('package/plugins/work-badges/ui/manager.html'))


if __name__ == '__main__':
    unittest.main()
