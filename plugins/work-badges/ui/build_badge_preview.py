"""Build an isolated, self-contained preview of the shipped floating renderer.

This module never creates or opens a Registry. Sample profiles and packaged
artwork are read from source files; no live bindings or private state are loaded.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
from pathlib import Path

UI = Path(__file__).resolve().parent
PLUGIN = UI.parent
TEMPLATE = PLUGIN / 'previews' / 'badge-preview.template.html'
TARGET = PLUGIN / 'previews' / 'holo-badge-preview.html'


def _source_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError('无法读取预览的默认资料。')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _data_url(path: Path, mime: str) -> str:
    if path.is_symlink() or not path.is_file():
        raise ValueError('预览素材缺失或不是普通文件：' + path.name)
    return 'data:' + mime + ';base64,' + base64.b64encode(path.read_bytes()).decode('ascii')


def sample_data() -> dict:
    """Read portable, image-specific samples shared by both product previews."""
    registry = _source_module('_badge_preview_seed_registry', PLUGIN / 'backend' / 'registry.py')
    holo = _source_module('_badge_preview_holo_assets', PLUGIN / 'backend' / 'holo_assets.py')
    profiles = registry.Registry._seed_roles()
    avatar_path = PLUGIN / 'assets' / 'demo.png'
    original = _data_url(avatar_path, 'image/png')
    image_id = hashlib.sha256(avatar_path.read_bytes()).hexdigest()
    for role in profiles:
        role['imageId'] = image_id
    layers = holo.display_layers(image_id)
    return {
        'profiles': profiles,
        'avatarDataUrl': original,
        'foregroundDataUrl': layers.get('foregroundDataUrl', ''),
        'contourDataUrl': layers.get('contourDataUrl', ''),
        'fontDataUrl': _data_url(PLUGIN / 'assets' / 'BricolageGrotesque.ttf', 'font/ttf'),
        'miloSourceId': image_id,
        'holoAssets': layers.get('holoAssets', {}),
        'avatars': {image_id: {'avatarDataUrl': original, **layers}},
    }


def build_badge_preview() -> Path:
    """Embed current runtime, packaged assets and labeled default sample data."""
    payload = sample_data()
    runtime = (PLUGIN / 'runtime' / 'renderer.js').read_text(encoding='utf-8')
    template = TEMPLATE.read_text(encoding='utf-8')
    serialized = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')
    if '</script' in runtime.lower():
        raise ValueError('工牌运行脚本包含意外的结束标签。')
    if template.count('/* __BADGE_RUNTIME_JS__ */') != 1 or template.count('/* __BADGE_PREVIEW_DATA__ */') != 1:
        raise ValueError('工牌预览模板占位符不符。')
    html = template.replace('/* __BADGE_RUNTIME_JS__ */', runtime).replace('/* __BADGE_PREVIEW_DATA__ */', serialized)
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(html, encoding='utf-8')
    return TARGET


# Consistent entry point with the existing manager preview builder.
build_preview = build_badge_preview

if __name__ == '__main__':
    print('已生成独立工牌预览：' + str(build_badge_preview()))
