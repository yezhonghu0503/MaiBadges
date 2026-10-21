"""Public demo layers stay content-addressed, bounded, and independent of user state."""
import base64
import hashlib
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import zlib

PLUGIN = Path(__file__).resolve().parents[1] / 'plugins/work-badges'
sys.path.insert(0, str(PLUGIN))
from backend.holo_assets import DEMO_SOURCE_ID, MILO_SOURCE_ID, foreground_data, contour_data, display_layers, material_assets
from backend.registry import Registry
from backend.mcp_server import Server


class HoloAssetTests(unittest.TestCase):
    @staticmethod
    def png(width=2, height=2, color=(30, 90, 160, 255)):
        def chunk(kind, payload):
            return (struct.pack('>I', len(payload)) + kind + payload
                    + struct.pack('>I', zlib.crc32(kind + payload) & 0xffffffff))
        rows = b''.join(b'\x00' + bytes(color) * width for _ in range(height))
        return (b'\x89PNG\r\n\x1a\n'
                + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))

    def make_bundle(self, root, name, source_id, color=(30, 90, 160, 255)):
        folder = root / name
        folder.mkdir()
        files = {kind: kind + '.png' for kind in
                 ('foreground', 'contour', 'character', 'background', 'ui', 'structure')}
        hashes = {}
        for filename in files.values():
            raw = self.png(color=color)
            (folder / filename).write_bytes(raw)
            hashes[filename] = hashlib.sha256(raw).hexdigest()
        manifest = {'sourceImageId': source_id, 'files': files, 'sha256': hashes}
        (folder / 'manifest.json').write_text(json.dumps(manifest))
        return folder, manifest


    def test_public_avatar_has_one_exact_content_identity(self):
        original = (PLUGIN / 'assets/demo.png').read_bytes()
        self.assertEqual(hashlib.sha256(original).hexdigest(), DEMO_SOURCE_ID)
        self.assertEqual(MILO_SOURCE_ID, DEMO_SOURCE_ID, 'Legacy protocol alias must refer only to public demo')
        manifest = json.loads((PLUGIN / 'assets/holo/demo/manifest.json').read_text())
        self.assertEqual(manifest['sourceImageId'], DEMO_SOURCE_ID)
        for get in (foreground_data, contour_data):
            self.assertTrue(get(DEMO_SOURCE_ID).startswith('data:image/png;base64,'))
            for unknown in (None, 'demo', 'max', 'a' * 64, '../demo.png', {}):
                self.assertEqual(get(unknown), '')

    def test_material_planes_are_aligned_rgba_and_hash_verified(self):
        folder = PLUGIN / 'assets/holo/demo'
        manifest = json.loads((folder / 'manifest.json').read_text())
        packet = display_layers(DEMO_SOURCE_ID)
        self.assertEqual(set(packet['holoAssets']), {'character', 'background', 'ui', 'structure'})
        dimensions = set()
        for kind in ('foreground', 'contour', 'character', 'background', 'ui', 'structure'):
            encoded = packet['foregroundDataUrl'] if kind == 'foreground' else packet['contourDataUrl'] if kind == 'contour' else packet['holoAssets'][kind]
            raw = base64.b64decode(encoded.split(',', 1)[1])
            name = manifest['files'][kind]
            self.assertEqual(raw, (folder / name).read_bytes())
            self.assertEqual(hashlib.sha256(raw).hexdigest(), manifest['sha256'][name])
            self.assertEqual(raw[25], 6)
            dimensions.add(struct.unpack('>II', raw[16:24]))
            self.assertLess(len(raw), 3 * 1024 * 1024)
        self.assertEqual(len(dimensions), 1)
        self.assertEqual(list(dimensions)[0], tuple(manifest['sourceDimensions']))
        self.assertEqual(material_assets('f' * 64), {})

    def test_sparse_glow_alpha_does_not_light_flat_interiors(self):
        from PIL import Image
        folder = PLUGIN / 'assets/holo/demo'
        with Image.open(folder / 'structure.png') as structure, Image.open(folder / 'character.png') as character:
            self.assertEqual(structure.mode, 'RGBA')
            self.assertEqual(structure.size, character.size)
            lines, subject = structure.getchannel('A').histogram(), character.getchannel('A').histogram()
        total = sum(lines)
        self.assertGreater(total - lines[0], 0)
        self.assertGreater(lines[0] / total, .90)
        self.assertLess(total - lines[0], (total - subject[0]) * .25)
        self.assertLess(sum(a*n for a,n in enumerate(lines)), sum(a*n for a,n in enumerate(subject)) * .25)

    def test_different_encoding_cannot_borrow_prepared_layers(self):
        from PIL import Image
        output = io.BytesIO()
        with Image.open(PLUGIN / 'assets/demo.png') as image:
            image.save(output, format='PNG', compress_level=0)
        other = hashlib.sha256(output.getvalue()).hexdigest()
        self.assertNotEqual(other, DEMO_SOURCE_ID)
        self.assertFalse(any(display_layers(other).values()))

    def test_bad_oversized_and_missing_optional_assets_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            assets = Path(temporary)
            folder, manifest = self.make_bundle(assets, 'demo', 'b' * 64)
            for content in (b'bad data', b'\x89PNG\r\n\x1a\n' + b'x' * (3 * 1024 * 1024)):
                (folder / 'foreground.png').write_bytes(content)
                self.assertFalse(any(display_layers('b' * 64, assets).values()))
            self.assertEqual(material_assets(DEMO_SOURCE_ID, assets), {})
            self.assertFalse(any(display_layers(DEMO_SOURCE_ID, assets / 'missing').values()))

    def test_loader_packet_stays_within_transport_limit(self):
        with tempfile.TemporaryDirectory() as folder:
            with Registry(Path(folder) / 'state', seed_dir=PLUGIN / 'assets') as registry:
                role = registry.snapshot()['roles'][0]
                argument = {'role': role, 'avatarDataUrl': registry.avatar_data(DEMO_SOURCE_ID),
                            'holoAssets': material_assets(DEMO_SOURCE_ID),
                            'fontDataUrl': 'data:font/ttf;base64,' + base64.b64encode((PLUGIN / 'assets/BricolageGrotesque.ttf').read_bytes()).decode()}
                message = {'id': 1, 'method': 'Runtime.evaluate', 'params': {'expression': 'api.show(' + json.dumps(argument) + ')'}}
                self.assertLess(len(json.dumps(message).encode()), 8 * 1024 * 1024)

    def test_mcp_keeps_original_avatar_and_never_mutates_registry(self):
        with tempfile.TemporaryDirectory() as folder:
            with Registry(Path(folder) / 'state', seed_dir=PLUGIN / 'assets') as registry:
                before = registry.snapshot()
                original = registry.avatar_data(DEMO_SOURCE_ID)
                result = Server(registry).call_tool('work_badges_avatar', {'imageId': DEMO_SOURCE_ID})
                self.assertEqual(base64.b64decode(original.split(',')[1]), (PLUGIN / 'assets/demo.png').read_bytes())
                self.assertEqual(result['_meta']['avatarDataUrl'], original)
                self.assertTrue(result['_meta']['foregroundDataUrl'])
                self.assertTrue(result['_meta']['contourDataUrl'])
                self.assertEqual(set(result['_meta']['holoAssets']), {'character', 'background', 'ui', 'structure'})
                self.assertEqual(registry.snapshot(), before)
                (registry.assets_dir / (DEMO_SOURCE_ID + '.png')).unlink()
                absent = Server(registry).call_tool('work_badges_avatar', {'imageId': DEMO_SOURCE_ID})['_meta']
                self.assertFalse(any(absent.values()))

    def test_multiple_bundles_follow_source_hash_and_never_role_name(self):
        with tempfile.TemporaryDirectory(prefix='.backend-test-holo-', dir=Path(__file__).parent) as folder:
            assets = Path(folder)
            max_id, other_id = 'a' * 64, 'b' * 64
            self.make_bundle(assets, 'max', max_id)
            self.make_bundle(assets, 'someone-else', other_id, color=(190, 70, 30, 255))
            max_layers = display_layers(max_id, assets)
            other_layers = display_layers(other_id, assets)
            self.assertTrue(max_layers['foregroundDataUrl'])
            self.assertEqual(set(max_layers['holoAssets']), {'character', 'background', 'ui', 'structure'})
            self.assertNotEqual(max_layers, other_layers)
            for unknown in ('max', 'someone-else', 'c' * 64, None, {}):
                self.assertFalse(any(display_layers(unknown, assets).values()))

    def test_prepared_material_is_atomic_hash_verified_and_canvas_aligned(self):
        with tempfile.TemporaryDirectory(prefix='.backend-test-holo-', dir=Path(__file__).parent) as folder:
            assets = Path(folder)
            source_id = 'a' * 64
            root, manifest = self.make_bundle(assets, 'max', source_id)
            background = root / 'background.png'
            original = background.read_bytes()
            self.assertTrue(material_assets(source_id, assets))
            # Same process, same image identifier: a local asset change must not
            # reuse an earlier successful cached byte payload.
            background.write_bytes(original + b'changed')
            self.assertEqual(material_assets(source_id, assets), {})
            raw = self.png(width=3)
            background.write_bytes(raw)
            manifest['sha256']['background.png'] = hashlib.sha256(raw).hexdigest()
            (root / 'manifest.json').write_text(json.dumps(manifest))
            self.assertEqual(material_assets(source_id, assets), {})
            background.write_bytes(original)
            manifest['sha256']['background.png'] = hashlib.sha256(original).hexdigest()
            (root / 'manifest.json').write_text(json.dumps(manifest))
            self.assertTrue(material_assets(source_id, assets))
            (root / 'foreground.png').write_bytes(b'invalid foreground')
            self.assertFalse(any(display_layers(source_id, assets).values()))

    def test_new_manifest_cannot_escape_its_folder_or_follow_symlinks(self):
        with tempfile.TemporaryDirectory(prefix='.backend-test-holo-', dir=Path(__file__).parent) as folder:
            assets = Path(folder)
            source_id = 'a' * 64
            root, manifest = self.make_bundle(assets, 'max', source_id)
            outside = assets / 'outside.png'
            outside.write_bytes(self.png())
            digest = hashlib.sha256(outside.read_bytes()).hexdigest()
            for filename in ('../outside.png', str(outside.resolve()), 'linked.png', 'linked/character.png'):
                with self.subTest(filename=filename):
                    manifest['files']['character'] = filename
                    manifest['sha256'][filename] = digest
                    (root / 'manifest.json').write_text(json.dumps(manifest))
                    if filename == 'linked.png':
                        (root / filename).symlink_to(outside)
                    elif filename.startswith('linked/'):
                        (root / 'linked').symlink_to(root, target_is_directory=True)
                    self.assertEqual(material_assets(source_id, assets), {})

    def test_duplicate_source_manifests_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix='.backend-test-holo-', dir=Path(__file__).parent) as folder:
            assets = Path(folder)
            source_id = 'a' * 64
            self.make_bundle(assets, 'max', source_id)
            self.make_bundle(assets, 'duplicate', source_id, color=(190, 70, 30, 255))
            self.assertFalse(any(display_layers(source_id, assets).values()))


if __name__ == '__main__':
    unittest.main()
