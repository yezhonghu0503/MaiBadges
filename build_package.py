"""Build the public, self-contained UI and a portable, allowlisted archive.

No app is opened and no user state, registry, or login item is accessed.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import runpy
import zipfile

ROOT = Path(__file__).resolve().parent
PLUGIN = ROOT / 'plugins/work-badges'
VERSION = '0.7.0'
PUBLIC_ASSETS = {'demo.png', 'brand.png', 'maibadges.png', 'maibadges.icns', 'BricolageGrotesque.ttf', 'demo.svg', 'brand.svg', 'maibadges.svg', 'ASSET_PROVENANCE.json'}
DEMO_FILES = {'manifest.json', 'character.png', 'background.png', 'ui.png', 'ui-live.png',
              'structure.png', 'contour-alpha.png', 'character.svg', 'background.svg', 'ui.svg',
              'ui-live.svg', 'structure.svg', 'contour-alpha.svg'}
ROOT_FILES = {'setup.py', 'build_package.py', 'validate.py', 'BUILD.json', 'VALIDATION.json',
              'LICENSE', '.gitignore', 'README.md', 'README.en.md', 'UPGRADE.md',
              'SECURITY.md', 'PRIVACY.md', 'CONTRIBUTING.md', 'CHANGELOG.md',
              'ASSETS_LICENSE.md', 'THIRD_PARTY_NOTICES.md', 'requirements-dev.txt',
              'INSTALL.md', 'DESIGN.md', 'PRODUCT.md', 'OPEN_SOURCE.md'}


def portable_mcp():
    """The distributed service uses the user's Python and its public default state."""
    return {'mcpServers': {'work_badges': {'type': 'stdio', 'command': 'python3',
            'args': ['${PLUGIN_ROOT}/backend/main.py'], 'cwd': '${PLUGIN_ROOT}'}}}


def distributable(path):
    """Reject local records even when a future file is accidentally copied here."""
    parts = path.relative_to(ROOT).parts
    if (not path.is_file() or path.is_symlink()
            or any(part in ('__pycache__', '.tmp', '.pytest_cache', '.git')
                   or part.startswith(('.setup-test-', '.bundle-test-', '.backend-test-')) for part in parts)
            or path.suffix in ('.pyc', '.sqlite3', '.log') or path.name.endswith(('-wal', '-shm'))):
        return False
    if len(parts) == 1:
        return parts[0] in ROOT_FILES
    if parts[0] in ('tests', '.github', 'tools'):
        return path.suffix in ('.py', '.mjs', '.js', '.yml', '.yaml', '.md')
    if parts[0] == 'docs':
        return path.suffix in ('.md', '.png', '.webp')
    if parts[:2] != ('plugins', 'work-badges') or len(parts) < 3:
        return False
    plugin_parts = parts[2:]
    if len(plugin_parts) == 1:
        return plugin_parts[0] in ('plugin.json', 'mcp.json', 'README.md', 'INSTALL.md', 'UPGRADE.md')
    section = plugin_parts[0]
    if section == 'assets':
        return ((len(plugin_parts) == 2 and plugin_parts[1] in PUBLIC_ASSETS)
                or (len(plugin_parts) == 4 and plugin_parts[1:3] == ('holo', 'demo')
                    and plugin_parts[3] in DEMO_FILES))
    if section == 'licenses':
        return len(plugin_parts) == 2 and plugin_parts[1] in ('Bricolage-OFL.txt', 'Holo-Card-MIT.txt')
    if section in ('backend', 'loader', 'runtime', 'ui', 'tests'):
        return path.suffix in ('.py', '.js', '.mjs', '.html')
    if section == 'previews':
        return len(plugin_parts) == 2 and plugin_parts[1] in (
            'manager-preview.html', 'holo-badge-preview.html', 'badge-preview.template.html')
    return section == 'skills' and path.suffix == '.md'


def build(archive=False):
    brand_path = PLUGIN / 'assets/brand.png'
    brand = 'data:image/png;base64,' + base64.b64encode(brand_path.read_bytes()).decode() if brand_path.is_file() else ''
    runtime_template = PLUGIN / 'runtime/renderer.template.js'
    engine_path = PLUGIN / 'runtime/holo-engine.js'
    engine = engine_path.read_text(encoding='utf-8') if engine_path.is_file() else ''
    if runtime_template.is_file():
        runtime = runtime_template.read_text(encoding='utf-8')
        if runtime.count('/* __HOLO_ENGINE__ */') != 1:
            raise ValueError('工牌材质入口占位符不符。')
        (PLUGIN / 'runtime/renderer.js').write_text(
            runtime.replace('/* __HOLO_ENGINE__ */', engine).replace('__BRAND_AVATAR_DATA__', brand), encoding='utf-8')
    template = (PLUGIN / 'ui/manager.template.html').read_text(encoding='utf-8')
    script = (PLUGIN / 'ui/manager.js').read_text(encoding='utf-8')
    if template.count('__FONT_DATA__') != 1 or template.count('/* __MANAGER_JS__ */') != 1:
        raise ValueError('管理页模板占位符不符。')
    if '</script' in script.lower():
        raise ValueError('内嵌脚本包含意外的结束标签。')
    font = 'data:font/ttf;base64,' + base64.b64encode((PLUGIN / 'assets/BricolageGrotesque.ttf').read_bytes()).decode()
    html = template.replace('__FONT_DATA__', font).replace('__BRAND_AVATAR_DATA__', brand).replace(
        '/* __MANAGER_JS__ */', '(() => {\n' + engine + '\n' + script + '\n})();')
    (PLUGIN / 'ui/manager.html').write_text(html, encoding='utf-8')
    for filename, entry in [('build_preview.py', 'build_preview'), ('build_badge_preview.py', 'build_badge_preview')]:
        builder = PLUGIN / 'ui' / filename
        if builder.is_file():
            runpy.run_path(str(builder))[entry]()
    # Hash every public plugin file except mcp.json, whose portable content is
    # substituted in the ZIP without changing the prepared local source file.
    files = [path for path in sorted(PLUGIN.rglob('*')) if distributable(path) and path != PLUGIN / 'mcp.json']
    metadata = {'name': 'MaiBadges', 'version': VERSION, 'clientTested': False,
                'installedByAgent': False, 'installationScope': 'offline-build-only',
                'sha256': {path.relative_to(PLUGIN).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                           for path in files}}
    (ROOT / 'BUILD.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if not archive:
        return None
    destination = ROOT.parent / f'MaiBadges-{VERSION}.zip'
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as output:
        for path in sorted(ROOT.rglob('*')):
            if not distributable(path):
                continue
            name = ROOT.name + '/' + path.relative_to(ROOT).as_posix()
            if path == PLUGIN / 'mcp.json':
                output.writestr(name, json.dumps(portable_mcp(), ensure_ascii=False, indent=2) + '\n')
            else:
                output.write(path, name)
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', action='store_true')
    result = build(parser.parse_args().archive)
    print('已构建 MaiBadges。' + (f' 安装包：{result}' if result else ''))
