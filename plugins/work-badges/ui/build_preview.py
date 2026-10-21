"""Generate a standalone, read-only manager preview from the real UI sources."""
from __future__ import annotations

import base64
import json
from pathlib import Path
import runpy

UI = Path(__file__).resolve().parent
PLUGIN = UI.parent


def build_preview() -> Path:
    template = (UI / 'manager.template.html').read_text(encoding='utf-8')
    script = (UI / 'manager.js').read_text(encoding='utf-8')
    fixture = (UI / 'preview-fixture.js').read_text(encoding='utf-8')
    if template.count('__FONT_DATA__') != 1 or template.count('/* __MANAGER_JS__ */') != 1:
        raise ValueError('管理页模板占位符不符。')
    # Preview requests must never reach a real embedding host, including on reconnect.
    if script.count('createBridge(window)') != 2:
        raise ValueError('管理页桥接入口已变更，请检查只读预览的隔离方式。')
    script = script.replace('createBridge(window)', 'createBridge(window.WorkBadgePreviewSurface)')
    font = 'data:font/ttf;base64,' + base64.b64encode((PLUGIN / 'assets/BricolageGrotesque.ttf').read_bytes()).decode()
    sample = runpy.run_path(str(UI / 'build_badge_preview.py'))['sample_data']()
    sample.pop('fontDataUrl', None)  # The manager template already embeds its font.
    serialized = json.dumps(sample, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')
    if fixture.count('/* __PREVIEW_SAMPLE_DATA__ */ null') != 1:
        raise ValueError('管理页示例资料占位符不符。')
    fixture = fixture.replace('/* __PREVIEW_SAMPLE_DATA__ */ null', serialized)
    engine=(PLUGIN/'runtime/holo-engine.js').read_text(encoding='utf-8')
    script='(() => {\n'+engine+'\n'+script+'\n})();'
    if '</script' in (fixture + script).lower():
        raise ValueError('预览脚本包含意外的结束标签。')
    banner = ('<div class="preview-banner" role="note"><div>'
              '<strong>界面预览 · 不写入资料库</strong><p>示例资料，可切换角色与翻面；保存和绑定不会写入。</p></div>'
              '<div class="preview-theme-controls" role="group" aria-label="预览主题">'
              '<button id="preview-theme-light" type="button" aria-pressed="true">浅色</button>'
              '<button id="preview-theme-dark" type="button" aria-pressed="false">深色</button></div></div>')
    brand='data:image/png;base64,'+base64.b64encode((PLUGIN/'assets/brand.png').read_bytes()).decode()
    html = template.replace('__FONT_DATA__', font).replace('__BRAND_AVATAR_DATA__',brand).replace('/* __MANAGER_JS__ */', fixture+'\n'+script)
    html = html.replace('<body>', '<body>\n'+banner).replace('<title>MaiBadges</title>', '<title>MaiBadges · 界面预览</title>')
    target = PLUGIN / 'previews/manager-preview.html'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(html, encoding='utf-8')
    return target


if __name__ == '__main__':
    print('已生成只读管理页预览：'+str(build_preview()))
