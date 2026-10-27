"""Build an offline sidebar preview from public geometry and fictional rows.

No Registry is opened and no private state or live application is accessed.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
TEMPLATE = PLUGIN / 'previews' / 'sidebar-preview.template.html'
TARGET = PLUGIN / 'previews' / 'sidebar-preview.html'


def _data_url(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        raise ValueError('侧栏预览素材缺失或不是普通文件：' + path.name)
    return 'data:image/png;base64,' + base64.b64encode(path.read_bytes()).decode('ascii')


def build_sidebar_preview() -> Path:
    """Embed only the shipped sidebar source and public geometric artwork."""
    source = (PLUGIN / 'runtime' / 'sidebar.js').read_text(encoding='utf-8')
    if '</script' in source.lower():
        raise ValueError('侧栏脚本包含意外的结束标签。')
    art = PLUGIN / 'assets' / 'holo' / 'demo'
    character, background = _data_url(art / 'character.png'), _data_url(art / 'background.png')
    items = [
        {'roleId': role_id, 'name': name, 'role': role, 'bindings': [{'kind': 'title', 'key': title}],
         'characterDataUrl': character, 'backgroundDataUrl': background}
        for role_id, name, role, title in [
            ('reviewer', 'Reviewer', '示例 · 内容核对', 'Review queue'),
            ('maker', 'Maker', '示例 · 原型制作', 'Build room'),
            ('planner', 'Planner', '示例 · 计划整理', 'Planning'),
        ]
    ]
    template = TEMPLATE.read_text(encoding='utf-8')
    for placeholder in ['/* __SIDEBAR_CARDS__ */', '/* __SIDEBAR_PREVIEW_ITEMS__ */']:
        if template.count(placeholder) != 1:
            raise ValueError('侧栏预览模板占位符不符。')
    payload = json.dumps(items, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')
    html = template.replace('/* __SIDEBAR_CARDS__ */', source).replace('/* __SIDEBAR_PREVIEW_ITEMS__ */', payload)
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(html, encoding='utf-8')
    return TARGET


build_preview = build_sidebar_preview

if __name__ == '__main__':
    print('已生成独立侧栏预览：' + str(build_sidebar_preview()))
