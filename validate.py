"""Offline verification only. Never enrolls, launches an app, or installs a service."""
from __future__ import annotations

from datetime import datetime, timezone
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
PLUGIN = ROOT / 'plugins/work-badges'


def run(command, input=None):
    result = subprocess.run(command, cwd=ROOT, input=input, text=True, capture_output=True,
                            timeout=90, env={**__import__('os').environ, 'PYTHONDONTWRITEBYTECODE':'1'})
    output=result.stdout+'\n'+result.stderr
    if result.returncode:
        print(output[-12000:])
        raise RuntimeError('离线验证失败：'+str(command[-1]))
    return output


def main():
    from build_package import build, VERSION
    build()
    report={'version':VERSION,'validatedAt':datetime.now(timezone.utc).isoformat(),
            'mode':'offline-only','connectedToChatGPT':False,'installedByAgent':False,
            'liveClientVerified':False,'visualRenderingVerified':False,
            'checks':[]}
    for path in ROOT.rglob('*.py'):
        if any(part in ('__pycache__','.tmp') or part.startswith('.setup-test-') for part in path.relative_to(ROOT).parts): continue
        compile(path.read_text(encoding='utf-8'),str(path),'exec')
    report['checks'].append({'name':'python syntax','passed':True})
    node=shutil.which('node')
    if not node: raise RuntimeError('开发验证需要 Node.js；用户安装运行只需 Python 3.9+。')
    syntax_count=0
    for path in [PLUGIN/'ui/manager.js',PLUGIN/'runtime/renderer.js',PLUGIN/'runtime/sidebar.js',PLUGIN/'runtime/holo-engine.js',PLUGIN/'loader/probe.js',PLUGIN/'ui/preview-fixture.js']:
        run([node,'--check',str(path)])
        syntax_count+=1
    html=(PLUGIN/'ui/manager.html').read_text(encoding='utf-8')
    assert '__FONT_DATA__' not in html and '__MANAGER_JS__' not in html
    assert len(re.findall(r'<script>',html))==1 and 'https://' not in html
    inline=html.split('<script>',1)[1].split('</script>',1)[0]
    run([node,'--check'],input=inline)
    syntax_count+=1
    preview=(PLUGIN/'previews/manager-preview.html').read_text(encoding='utf-8')
    assert '界面预览 · 不写入资料库' in preview
    assert '__PREVIEW_AVATAR_DATA__' not in preview and 'createBridge(window)' not in preview
    assert len(re.findall(r'<script>',preview))==1
    run([node,'--check'],input=preview.split('<script>',1)[1].split('</script>',1)[0])
    syntax_count+=1
    badge_preview=(PLUGIN/'previews/holo-badge-preview.html').read_text(encoding='utf-8')
    assert '不读取或修改真实资料' in badge_preview
    assert '__BADGE_RUNTIME_JS__' not in badge_preview and '__BADGE_PREVIEW_DATA__' not in badge_preview
    badge_scripts=re.findall(r'<script data-badge-(?:runtime|preview)>\s*(.*?)</script>',badge_preview,re.S)
    assert len(badge_scripts)==2 and (PLUGIN/'runtime/renderer.js').read_text().strip()==badge_scripts[0].strip()
    for inline_script in badge_scripts:
        run([node,'--check'],input=inline_script)
        syntax_count+=1
    sidebar_preview=(PLUGIN/'previews/sidebar-preview.html').read_text(encoding='utf-8')
    assert 'sidebar' in sidebar_preview and '__SIDEBAR_' not in sidebar_preview
    sidebar_scripts=re.findall(r'<script[^>]*>\s*(.*?)</script>',sidebar_preview,re.S)
    assert sidebar_scripts
    for inline_script in sidebar_scripts:
        run([node,'--check'],input=inline_script)
        syntax_count+=1
    report['checks'].append({'name':'JavaScript syntax (including built UI and read-only preview)','count':syntax_count,'passed':True})
    python_count=0
    for directory in [ROOT/'tests',PLUGIN/'tests',PLUGIN/'loader/tests']:
        output=run([sys.executable,'-m','unittest','discover','-s',str(directory),'-p','test_*.py'])
        count=int(re.search(r'Ran (\d+) tests?',output).group(1));python_count+=count
        report['checks'].append({'name':str(directory.relative_to(ROOT)),'count':count,'passed':True})
    node_count=0
    for path in [ROOT/'tests/check-manager.mjs',PLUGIN/'tests/check-renderer.mjs',PLUGIN/'tests/check-sidebar.mjs',ROOT/'tests/check-holo-engine.mjs']:
        command=[node,'--test','--test-reporter=tap',str(path)] if path.name=='check-holo-engine.mjs' else [node,str(path)]
        output=run(command)
        count=len(re.findall(r'^ok \d+ - ',output,re.M));node_count+=count
        assert count>0
        report['checks'].append({'name':str(path.relative_to(ROOT)),'count':count,'passed':True})
    # Real built HTML is served by the actual MCP implementation, within a project temp directory.
    sys.path.insert(0,str(PLUGIN))
    from backend.registry import Registry
    from backend.mcp_server import Server,RESOURCE_URI
    import tempfile
    with tempfile.TemporaryDirectory(prefix='.bundle-test-',dir=ROOT/'tests') as folder:
        with Registry(Path(folder)/'state',seed_dir=PLUGIN/'assets') as registry:
            server=Server(registry);server.dispatch('initialize',{'protocolVersion':'2025-11-25'})
            resource=server.dispatch('resources/read',{'uri':RESOURCE_URI})['contents'][0]
            assert resource['text']==html and resource['mimeType']=='text/html;profile=mcp-app'
            assert len(registry.snapshot()['roles'])==5 and not registry.snapshot()['bindings']
            milo=next(role for role in registry.snapshot()['roles'] if role['id']=='milo')
            assert registry.avatar_data(milo['imageId']).startswith('data:image/png;base64,')
    report['checks'].append({'name':'built manager + MCP resource + real seed avatar','passed':True})
    plugin=json.loads((PLUGIN/'plugin.json').read_text());mcp=json.loads((PLUGIN/'mcp.json').read_text())
    assert plugin['version']==VERSION and plugin['name']=='work-badges'
    assert mcp['mcpServers']['work_badges']['args'][0]=='${PLUGIN_ROOT}/backend/main.py'
    assert mcp['mcpServers']['work_badges']['cwd']=='${PLUGIN_ROOT}'
    report['checks'].append({'name':'plugin metadata and stdio entry','passed':True})
    from setup import launcher_icon_bytes
    icon=launcher_icon_bytes(ROOT)
    assert icon[:4]==b'icns' and int.from_bytes(icon[4:8],'big')==len(icon)
    assert (PLUGIN/'assets/maibadges.png').read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
    report['checks'].append({'name':'production launcher ICNS and PNG assets','passed':True})
    from backend.holo_assets import DEMO_SOURCE_ID, display_layers
    demo_manifest=json.loads((PLUGIN/'assets/holo/demo/manifest.json').read_text())
    assert demo_manifest['sourceImageId']==DEMO_SOURCE_ID
    material=display_layers(DEMO_SOURCE_ID)
    assert material['foregroundDataUrl'] and material['contourDataUrl']
    assert set(material['holoAssets'])=={'character','background','ui','structure'}
    assert (PLUGIN/'licenses/Holo-Card-MIT.txt').is_file()
    from build_package import distributable
    for path in (PLUGIN/'assets').rglob('*'):
        if path.is_file(): assert distributable(path), 'Non-public asset: '+str(path.relative_to(ROOT))
    assert not (PLUGIN/'previews/holo-skill-viewer.html').exists()
    report['checks'].append({'name':'exact generic demo identity, aligned material, allowlisted public assets','passed':True})
    report['pythonTests']=python_count;report['nodeContracts']=node_count;report['passed']=True
    (ROOT/'VALIDATION.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(f'通过：{python_count} 项 Python 测试、{node_count} 项 Node 合同、{syntax_count} 份 JS 语法检查及最终管理页资源集成。')
    print('本脚本仅执行离线检查；不启动或修改 ChatGPT，也不验证特定客户端版本。')


if __name__=='__main__':
    try: main()
    except (RuntimeError,AssertionError,OSError,ValueError) as error:
        print(str(error) or '离线验证失败。',file=sys.stderr);raise SystemExit(1)
