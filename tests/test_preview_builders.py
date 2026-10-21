"""Public previews are static and never open private project roles or a Registry."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / 'plugins/work-badges'
spec = importlib.util.spec_from_file_location('badge_preview_builder', PLUGIN / 'ui/build_badge_preview.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class PreviewBuilderTests(unittest.TestCase):
    def isolated_plugin(self, root):
        plugin = root / 'plugins/work-badges'
        assets, backend = plugin / 'assets', plugin / 'backend'
        assets.mkdir(parents=True); backend.mkdir()
        (assets / 'demo.png').write_bytes(b'public-demo-source')
        (assets / 'BricolageGrotesque.ttf').write_bytes(b'public-font')
        (backend / 'registry.py').write_text('class Registry:\n    def __init__(self, *args, **kwargs):\n        raise AssertionError("Preview opened a live Registry")\n    @staticmethod\n    def _seed_roles():\n        return [{"id": key, "name": name} for key,name in\n                [("max","Alex"),("maxie","Blair"),("milo","Casey"),("matthew","Drew"),("maxin","Ellis")]]\n')
        (backend / 'holo_assets.py').write_text('def display_layers(image_id):\n    return {"foregroundDataUrl": image_id + ":foreground", "contourDataUrl": image_id + ":contour",\n            "holoAssets": {key: image_id + ":" + key for key in ("character","background","ui","structure")}}\n')
        return plugin

    def test_sample_data_uses_only_public_source_and_no_live_registry(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plugin = self.isolated_plugin(root)
            private = root / '角色资料/Max'
            private.mkdir(parents=True)
            (private / 'profile-v1.json').write_text(json.dumps({'name': 'PRIVATE_NAME', 'chatBinding': [{'key': 'PRIVATE_TITLE'}]}))
            (plugin / 'assets/team-profiles.json').write_text(json.dumps({'profiles': [{'id': 'max', 'name': 'PRIVATE_NAME'}]}))
            with patch.object(builder, 'PLUGIN', plugin):
                sample = builder.sample_data()
            source_id = hashlib.sha256(b'public-demo-source').hexdigest()
            self.assertEqual([row['name'] for row in sample['profiles']], ['Alex','Blair','Casey','Drew','Ellis'])
            self.assertEqual({row['imageId'] for row in sample['profiles']}, {source_id})
            self.assertEqual(set(sample['avatars']), {source_id})
            self.assertNotIn('PRIVATE_', json.dumps(sample))
            self.assertFalse(list(root.rglob('registry.sqlite3')))

    def test_shipped_preview_matches_exact_generic_demo_and_four_material_planes(self):
        original_source = builder._source_module
        def safe_source(name, path):
            module = original_source(name, path)
            if path.name == 'registry.py':
                module.Registry.__init__ = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('No live Registry'))
            return module
        with patch.object(builder, '_source_module', safe_source):
            sample = builder.sample_data()
        raw_avatar = (PLUGIN / 'assets/demo.png').read_bytes()
        source_id = hashlib.sha256(raw_avatar).hexdigest()
        self.assertEqual(len(sample['profiles']), 5)
        self.assertEqual(set(sample['avatars']), {source_id})
        self.assertEqual({row['imageId'] for row in sample['profiles']}, {source_id})
        self.assertEqual(base64.b64decode(sample['avatars'][source_id]['avatarDataUrl'].split(',',1)[1]), raw_avatar)
        material = PLUGIN / 'assets/holo/demo'
        manifest = json.loads((material / 'manifest.json').read_text())
        self.assertEqual(set(sample['holoAssets']), {'character','background','ui','structure'})
        for key, encoded in sample['holoAssets'].items():
            self.assertEqual(base64.b64decode(encoded.split(',',1)[1]), (material / manifest['files'][key]).read_bytes())
        for profile in sample['profiles']:
            for field in ('chatBinding','bindings','contextKey','threadId','updatedAt'):
                self.assertNotIn(field, profile)

    def test_missing_or_linked_demo_fails_without_reading_other_images(self):
        with tempfile.TemporaryDirectory() as temporary:
            plugin = self.isolated_plugin(Path(temporary))
            demo = plugin / 'assets/demo.png'
            demo.rename(plugin / 'assets/private.png')
            with patch.object(builder, 'PLUGIN', plugin), self.assertRaises(ValueError):
                builder.sample_data()
            demo.symlink_to(plugin / 'assets/private.png')
            with patch.object(builder, 'PLUGIN', plugin), self.assertRaises(ValueError):
                builder.sample_data()


if __name__ == '__main__':
    unittest.main()
