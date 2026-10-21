/* Original work-badge renderer. Import defines an API only; it never reads chats. */
(() => {
  'use strict';
  /* __HOLO_ENGINE__ */
  const BUILD = '0.7.0';
  const BRAND_AVATAR = '__BRAND_AVATAR_DATA__';
  const BRAND = 'mai-work-badges/2';
  const GLOBAL = 'MaiWorkBadgeRuntime';
  const incumbent = window[GLOBAL];
  if (incumbent) {
    if (incumbent.brand === BRAND && incumbent.version === 2) return;
    throw new Error('Work badge runtime global is already in use.');
  }
  const DEFAULT = Object.freeze({width:266});
  const DEFAULT_HOLO_MATERIAL=Object.freeze({power:1.3,depth:1.75,contourBrightness:.15});
  // Asset-authored tuning only: keep the authored demo preset in sync with the
  // other product surface. Role names and user-provided options never select it.
  const HOLO_MATERIAL_PRESETS=Object.freeze({
    'bad02c86952324615efafffa529bcd2249529066dded16c645d61978c4667cb2':Object.freeze({power:.35,depth:1.5,contourBrightness:0,foregroundFoil:0,subjectGlow:0})
  });
  function holoMaterialPreset(imageId){return Object.hasOwn(HOLO_MATERIAL_PRESETS,imageId)?HOLO_MATERIAL_PRESETS[imageId]:DEFAULT_HOLO_MATERIAL;}

  const IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
  const LAYER_IMAGE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
  const HOLO_PROPERTIES = ['--rx','--ry','--px','--py','--fg-x','--fg-y','--bg-x','--bg-y','--foil-angle','--foil-shift','--holo-color','--view-x','--view-y'];
  const FONT = /^data:font\/(?:ttf|otf|woff|woff2);base64,[A-Za-z0-9+/]+={0,2}$/;
  const RESOURCE_FIELDS=['avatarDataUrl','foregroundDataUrl','contourDataUrl','holoAssets'];
  const ASSET_CACHE_LIMIT=6,ASSET_CACHE_BYTES=32*1024*1024,UI_CACHE_LIMIT=6;
  const CSS = `
    :host{font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#233d30;color-scheme:light;-webkit-font-smoothing:antialiased}
    *,*::before,*::after{box-sizing:border-box}[hidden]{display:none!important}button{font:inherit;color:inherit;touch-action:manipulation;-webkit-tap-highlight-color:transparent}button:focus-visible{outline:2px solid #b77a2d;outline-offset:3px}::selection{background:#d7a14d;color:#233d30}
    svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;flex:none}
    .panel{position:absolute;pointer-events:auto;max-height:calc(100vh - 24px);overflow:visible;container-type:inline-size}
    .card-header{position:relative;z-index:2;flex:0 0 46px;height:46px;display:flex;align-items:center;gap:0;min-height:46px;padding:6px 8px 5px 13px;border-radius:16px 16px 0 0;background:#f8eed9}.drag{flex:1;min-width:0;align-self:stretch;display:flex;align-items:center;gap:6px;padding:0;border:0;border-radius:5px;background:transparent;text-align:left;font-size:11px;line-height:16px;font-weight:600;cursor:grab;touch-action:none;user-select:none}.drag[data-dragging]{cursor:grabbing}.brand-mark{display:flex;flex:none}.brand-mark svg{width:15px;height:15px}.brand-avatar{display:block;width:24px;height:24px;object-fit:contain;border-radius:50%;user-select:none;-webkit-user-drag:none}.brand-caption{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mini-profile{display:none;align-items:center;gap:8px;min-width:0}.control{display:grid;place-items:center;flex:none;width:30px;height:32px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer}.control:hover{background:rgb(35 61 48 / 8%);color:var(--ink)}.control:active{background:rgb(35 61 48 / 13%)}.drag:focus-visible,.control:focus-visible{outline-offset:-2px}
    .shell{position:relative;perspective:1100px;--paper:#f4f0e5;--ink:#233d30;--muted:#5c695b;--rule:#d5d7c8;--gold:#d7a14d}.stage{position:relative;aspect-ratio:266/372;max-height:var(--available-height,calc(100vh - 24px));transform-style:preserve-3d;transform:rotateX(var(--rx,0deg)) rotateY(var(--ry,0deg));transition:none}.shell[data-hover] .stage{will-change:transform}.rotator{position:absolute;inset:0;transform-style:preserve-3d;transition:transform 420ms cubic-bezier(.2,.75,.25,1)}.shell[data-back] .rotator{transform:rotateY(180deg)}
    .face{position:absolute;inset:0;width:100%;height:100%;display:flex;flex-direction:column;text-align:left;padding:0;border:0;background:var(--paper);border-radius:16px;overflow:hidden;box-shadow:0 12px 28px rgb(0 0 0 / 20%);backface-visibility:hidden;-webkit-backface-visibility:hidden}.back-face{transform:rotateY(180deg)}.flip-surface{position:relative;display:flex;flex:1;flex-direction:column;min-height:0;width:100%;padding:0;border:0;text-align:left;background:transparent;cursor:pointer}.flip-surface:disabled{color:var(--ink);opacity:1;cursor:default}.flip-surface:focus-visible{outline-offset:-3px}.face::before,.face::after{content:'';position:absolute;inset:0;z-index:5;border-radius:inherit;padding:1px;pointer-events:none;mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);mask-composite:exclude;-webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);-webkit-mask-composite:xor}.face::before{background:linear-gradient(145deg,#d7c795 2%,#dcead9 22%,#a9c8bf 45%,#dac4db 68%,#c4b789 100%)}.face::after{background:conic-gradient(from var(--foil-angle,125deg) at var(--px,50%) var(--py,30%),#e3c38b,#d7f1e8,#9dbed8,#e0b4d2,#e9d49a,#e3c38b);opacity:.28;transition:opacity 180ms}.shell[data-hover]:not([data-back]) .face::after{opacity:.9}.shell[data-back] .face::after{opacity:0}
    .photo{position:relative;isolation:isolate;display:flex;align-items:flex-end;justify-content:center;flex:0 0 38%;min-height:0;background:#f8eed9;overflow:hidden}.scene{position:absolute;inset:-12px;z-index:0;pointer-events:none;background:radial-gradient(ellipse at 18% 25%,#fffae8 0,transparent 54%),radial-gradient(ellipse at 85% 82%,#d3dec8 0,transparent 58%),linear-gradient(135deg,#ede1bd,#f8eed9 52%,#dbe4d6);transform:translate(var(--bg-x,0px),var(--bg-y,0px));transition:none}.avatar{position:relative;z-index:1;display:flex;align-items:flex-end;justify-content:center;width:100%;height:100%;transform:translate(var(--fg-x,0px),var(--fg-y,0px));transition:none}.portrait{user-select:none;-webkit-user-drag:none;display:block;width:auto;height:100%;max-width:100%;object-fit:contain}.photo:not([data-layered]) .avatar{transform:none}.photo:not([data-layered]) .portrait{width:100%;height:100%;object-fit:cover;object-position:center top}.initial{display:grid;place-items:center;align-self:center;width:100%;height:100%;font-family:'MaiWorkBadgesDisplay',sans-serif;font-size:clamp(60px,34cqw,96px);font-weight:550;color:#45634c}.foil{position:absolute;inset:0;z-index:3;pointer-events:none;background:linear-gradient(var(--foil-angle,125deg),transparent 10%,#7da8ce 25%,#d0b3d9 37%,#efca8c 48%,#b4ddbf 60%,#8cbdd3 73%,transparent 88%);background-size:220% 220%;background-position:var(--foil-shift,50%) 50%;mix-blend-mode:soft-light;opacity:.25;transition:opacity 180ms}.foil::after{content:'';position:absolute;inset:0;background:linear-gradient(115deg,transparent 18%,rgb(255 255 255 / 8%) 36%,rgb(255 255 255 / 80%) 47%,transparent 60%),radial-gradient(ellipse at var(--px,50%) var(--py,30%),rgb(255 255 255 / 65%),transparent 63%);background-size:220% 160%;background-position:var(--foil-shift,50%) 50%;mix-blend-mode:screen}.shell[data-hover]:not([data-back]) .foil{opacity:.68}.contour{position:absolute;inset:0;pointer-events:none;mask-size:contain;mask-position:center bottom;mask-repeat:no-repeat;mask-mode:luminance;-webkit-mask-size:contain;-webkit-mask-position:center bottom;-webkit-mask-repeat:no-repeat;background:linear-gradient(var(--foil-angle,125deg),transparent 12%,var(--holo-color,#d6e8cf) 43%,#fff9df 55%,transparent 77%);opacity:0;transition:opacity 180ms}.shell[data-hover]:not([data-back]) .contour{opacity:.5}

    .loading{position:absolute;z-index:4;left:12px;right:12px;bottom:8px;display:flex;align-items:center;justify-content:center;gap:6px;padding:5px 8px;border-radius:6px;background:rgb(248 238 217 / 94%);color:#455b4b;font-size:10px;line-height:14px;pointer-events:none}.loading-dot{width:4px;height:4px;flex:none;border-radius:50%;background:currentColor;animation:mai-badge-loading 900ms ease-in-out infinite alternate}.shell[data-loading-paused] .loading-dot{animation-play-state:paused}@keyframes mai-badge-loading{from{opacity:.35}to{opacity:1}}@media(prefers-reduced-motion:reduce){.loading-dot{animation:none;opacity:.7}}
    .body{position:relative;z-index:4;background:var(--paper);flex:1;display:flex;flex-direction:column;min-height:0;padding:14px 17px 13px}.body>*{flex-shrink:0}.body,.back-content{overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#79816e var(--paper)}.names{display:flex;align-items:baseline;gap:9px;line-height:1;min-width:0}.english{font-family:'MaiWorkBadgesDisplay',sans-serif;font-size:clamp(31px,15cqw,42px);font-weight:650;letter-spacing:-.035em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.chinese{font-size:15px;font-weight:600;white-space:nowrap;letter-spacing:.04em;flex:none}.role{display:block;margin-top:7px;font-size:12px;font-weight:600;line-height:1.4;overflow-wrap:anywhere}.bio{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;margin-top:12px;font-size:12px;line-height:1.8;white-space:pre-line;color:var(--muted)}
    .footer{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:auto;padding-top:10px;border-top:1px solid var(--rule);font-size:11px;line-height:14px;color:var(--muted);font-variant-numeric:tabular-nums}.signature{display:flex;align-items:center;gap:5px;white-space:nowrap}.signature::before{content:'';height:4px;width:4px;border-radius:50%;background:var(--gold);flex:none}.serial{font-family:'MaiWorkBadgesDisplay',sans-serif;letter-spacing:.04em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.turn-hint{display:flex;align-items:center;gap:4px;white-space:nowrap}.turn-hint svg{width:13px;height:13px}.front .turn-hint{display:none}.shell[data-hover] .front .serial,.front:focus-visible .serial{display:none}.shell[data-hover] .front .turn-hint,.front:focus-visible .turn-hint{display:flex}
    .collapse svg{transform:rotate(180deg)}.back-content{position:relative;z-index:4;background:var(--paper);height:100%;width:100%;display:flex;flex-direction:column;padding:10px 18px 15px}.back-heading{display:flex;align-items:baseline;gap:8px;flex:none}.back-heading .english{font-size:30px}.back-heading .chinese{font-size:13px}.duties{display:flex;flex-direction:column;margin-top:14px;gap:13px;flex:none}.duty,.duty-title,.duty-copy{display:block}.duty-title{font-size:12px;line-height:1.5;font-weight:600}.duty-copy{color:var(--muted);font-size:12px;line-height:1.75;margin-top:3px;overflow-wrap:anywhere}.approval{font-size:11px;line-height:1.6;color:var(--muted);display:block;margin-top:auto;padding-top:10px;flex:none;overflow-wrap:anywhere}.back .footer{margin-top:10px;flex:none}
    .shell[data-collapsed]{background:var(--paper);border-radius:12px;box-shadow:0 8px 20px rgb(0 0 0 / 18%)}.shell[data-collapsed] .card-header{position:relative;height:64px;min-height:64px;margin-bottom:0;padding:8px 8px 8px 12px;border-radius:12px;background:var(--paper)}.shell[data-collapsed] .brand-mark,.shell[data-collapsed] .brand-caption{display:none}.shell[data-collapsed] .mini-profile{display:flex}.mini-avatar{display:grid;place-items:center;width:38px;height:40px;overflow:hidden;border-radius:8px;background:#f8eed9;flex:none}.mini-avatar .portrait{width:38px;height:40px;object-fit:cover;transform:none}.mini-avatar .initial{font-size:25px;margin:0;width:38px;height:40px}.mini-identity{display:flex;flex-direction:column;gap:4px;min-width:0}.mini-name{font-family:'MaiWorkBadgesDisplay',sans-serif;font-weight:650;font-size:19px;line-height:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mini-role{font-size:11px;line-height:1.3;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .recovery{width:98px;max-width:calc(100vw - 24px);overflow:visible;container-type:normal}.restore{display:flex;align-items:center;gap:6px;min-height:32px;padding:6px 10px;border:0;border-radius:9px;background:#f4f0e5;color:#455b4b;font-size:11px;line-height:16px;white-space:nowrap;box-shadow:0 5px 15px rgb(0 0 0 / 16%);cursor:pointer}.restore svg{width:14px;height:14px}.restore:hover{background:#eae6d9;color:#233d30}.restore:active{background:#dfdfd0}
    @container(max-width:234px){.body{padding:11px 14px}.bio{margin-top:8px}.duties{gap:9px;margin-top:10px}.back-content{padding:7px 14px 12px}.card-header{padding-left:11px}.brand-caption{font-size:10px}.role{font-size:11px;margin-top:5px}.footer{padding-top:8px}.back .footer{margin-top:7px}}
    @media(prefers-reduced-motion:reduce){.stage,.rotator,.back-face{transform:none!important;transition:none!important}.scene,.avatar{transform:none!important;transition:none!important}.foil,.contour,.face::after{display:none}.face[aria-hidden=true]{visibility:hidden}}

    .flip-surface{user-select:none;touch-action:pan-y}.flip-surface[data-inspecting]{cursor:grabbing}
    .holo-canvas{display:none;position:absolute;width:160%;height:160%;max-width:none;left:-30%;top:-30%;pointer-events:none;z-index:0}
    .front-face[data-material=webgl]{overflow:visible;background:transparent}
    .front-face[data-material=webgl] .holo-canvas{display:block}
    .front-face[data-material=webgl]::before,.front-face[data-material=webgl]::after{display:none}
    .front-face[data-material=webgl] .card-header{z-index:7;background:transparent;color:#fff6d8;text-shadow:0 1px 3px rgb(0 0 0 / 65%)}
    .front-face[data-material=webgl] .control{color:#fff6d8;background:rgb(22 48 37 / 30%)}
    .front-face[data-material=webgl] .photo{visibility:hidden;flex-basis:56%}
    .front-face[data-material=webgl] .front{position:relative}
    .front-face[data-material=webgl] .body{position:absolute;left:12px;right:12px;bottom:12px;height:42%;padding:10px 7px 8px;background:rgb(255 246 216 / 94%);border-radius:8px;transform:translate(calc(var(--view-x,0) * 24.5cqw),calc(var(--view-y,0) * -34.26cqw))}
    .front-face[data-material=webgl] .body .english{font-size:clamp(28px,13cqw,36px)}
    .front-face[data-material=webgl] .body .chinese{font-size:13px}
    .front-face[data-material=webgl] .body .role{font-size:11px;line-height:1.4;margin-top:4px}
    .front-face[data-material=webgl] .body .bio{font-size:11px;line-height:1.65;margin-top:7px;-webkit-line-clamp:2}
    .front-face[data-material=webgl] .body .footer{font-size:10px;line-height:12px;padding-top:6px}
    .front-face[data-material=webgl][data-subject-protected] .body{background:#fff6d8}
    @media(prefers-reduced-motion:reduce){.front-face[data-material=webgl] .body{transform:none!important}}
    @media(hover:none){.front .serial{display:none}.front .turn-hint{display:flex}}
  `;
  let ui=null, recovery=null, restoreTarget=null, contextKey=null, roleId=null, roleSignature=null;
  let layout={...DEFAULT}, cardState={flipped:false,collapsed:false};
  let stale=false, failed=false, error=null, removed=false, frame=null, tiltFrame=null, tiltState=null, drag=null;
  let watchers=null, titleObserver=null, headObserver=null, titleNode=null, lastTitle=null;
  let fontDataUrl='', font=null, fontToken=0, fontRequested=false;
  const assetCache=new Map(),readyCards=new Map();
  let assetBytes=0,assetCacheMiss=false,assetCacheHit=false,uiCacheHit=false;
  const dismissedContexts=new Set();
  const dismissalKey=(context,role)=>JSON.stringify([context,role]);

  function node(tag,className,text) {
    const element=document.createElement(tag);
    if(className)element.className=className;
    if(text!==undefined)element.textContent=text;
    return element;
  }
  function icon(path) {
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
    const line=document.createElementNS('http://www.w3.org/2000/svg','path');line.setAttribute('d',path);svg.append(line);return svg;
  }
  function button(className,label,path) {
    const element=node('button',className);element.type='button';element.setAttribute('aria-label',label);element.title=label;
    if(path)element.append(icon(path));return element;
  }
  function bounded(value,max,optional=false) {
    if(optional&&(value===undefined||value===null))return '';
    if(typeof value!=='string'||Array.from(value).length>max||value.includes('\0')||(!optional&&!value.trim()))throw new TypeError('invalid-profile');
    return value;
  }
  function cleanRole(input) {
    if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('invalid-profile');
    const duties=input.duties??[];
    if(!Array.isArray(duties)||duties.length>30||typeof input.enabled!=='boolean'||typeof input.id!=='string'||!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(input.id))throw new TypeError('invalid-profile');
    const imageId=input.imageId??null;if(imageId!==null&&(typeof imageId!=='string'||!/^[a-f0-9]{64}$/.test(imageId)))throw new TypeError('invalid-profile');
    return {id:input.id,name:bounded(input.name,80),chineseName:bounded(input.chineseName,80,true),
      role:bounded(input.role,160,true),bio:bounded(input.bio,4000,true),serial:bounded(input.serial,80,true),
      approval:bounded(input.approval,2000,true),enabled:input.enabled,imageId,
      duties:duties.map(row=>{if(!Array.isArray(row)||row.length!==2)throw new TypeError('invalid-profile');return [bounded(row[0],160,true),bounded(row[1],4000,true)];})};
  }
  function cleanLayout(input={}) {
    if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('invalid-layout');
    const clean={};
    for(const key of ['x','y','width'])if(input[key]!==undefined){
      if(!Number.isFinite(input[key])||Math.abs(input[key])>1000000)throw new TypeError('invalid-layout');
      clean[key]=key==='width'?Math.max(200,Math.min(320,input[key])):input[key];
    }
    return clean;
  }
  function cleanState(input={}) {
    if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('invalid-card-state');
    const clean={};for(const key of ['flipped','collapsed'])if(input[key]!==undefined){if(typeof input[key]!=='boolean')throw new TypeError('invalid-card-state');clean[key]=input[key];}return clean;
  }
  function cleanContext(value) {return bounded(value,2048);}
  function asset(value,pattern,max,code) {
    if(value==='')return '';
    if(typeof value!=='string'||value.length>max||!pattern.test(value))throw new TypeError(code);
    return value;
  }
  function viewport() {
    const visual=window.visualViewport;
    const width=visual&&Number.isFinite(visual.width)?visual.width:window.innerWidth;
    const height=visual&&Number.isFinite(visual.height)?visual.height:window.innerHeight;
    if(!Number.isFinite(width)||!Number.isFinite(height)||width<224||height<96)throw new Error('viewport-too-small');
    return {width,height,left:visual?.offsetLeft||0,top:visual?.offsetTop||0};
  }
  function clampPosition(measured=true) {
    const area=viewport(),margin=12,width=Math.min(layout.width??266,area.width-margin*2);
    const height=Math.min((measured&&ui?ui.panel.getBoundingClientRect().height:0)||(cardState.collapsed?64:width*372/266),area.height-margin*2);
    layout={x:Math.min(Math.max(layout.x??area.left+area.width-width-36,area.left+margin),area.left+area.width-width-margin),
      y:Math.min(Math.max(layout.y??area.top+378,area.top+margin),Math.max(area.top+margin,area.top+area.height-height-margin)),width};
  }
  function paintPosition() {
    if(!ui&&!recovery)return;
    const availableHeight=Math.max(0,viewport().height-24)+'px';
    if(ui){ui.panel.style.width=layout.width+'px';ui.panel.style.setProperty('--available-height',availableHeight);}clampPosition();
    const panel=ui?.panel||recovery.panel;
    panel.style.left=layout.x+'px';panel.style.top=layout.y+'px';
    panel.style.maxHeight=availableHeight;
  }
  function emit(name) {
    window.dispatchEvent(new CustomEvent(name,{detail:status()}));
  }
  function schedulePosition() {
    if((!ui&&!recovery)||frame!==null)return;
    frame=requestAnimationFrame(()=>{frame=null;if(!ui&&!recovery)return;try{paintPosition();}catch{fail('viewport-too-small');}});
  }
  function resetTilt() {
    if(tiltFrame!==null)cancelAnimationFrame(tiltFrame);tiltFrame=null;tiltState=null;
    if(!ui)return;ui.cancelInspect?.();ui.shell.removeAttribute('data-hover');
    for(const prop of HOLO_PROPERTIES)ui.stage.style.removeProperty(prop);
    ui.material?.setView({x:0,y:0,pointerX:.5,pointerY:.5,active:false});
  }
  function paintTilt(instance,state) {
    const rx=state.x,ry=state.y,viewX=Math.sin(ry*Math.PI/180)*.65,viewY=Math.sin(rx*Math.PI/180)*.65;
    const phase=(state.pointerX*.62+state.pointerY*.36+viewX*1.9+viewY*.8)*2.2;
    const spectrum=[0,.33,.67].map(offset=>Math.round((.52+.48*Math.cos(2*Math.PI*(phase+offset)))*255));
    const values={'--rx':`${rx}deg`,'--ry':`${ry}deg`,'--px':`${state.pointerX*100}%`,'--py':`${state.pointerY*100}%`,
      '--fg-x':`${viewX*28}px`,'--fg-y':`${-viewY*28}px`,'--bg-x':`${-viewX*70}px`,'--bg-y':`${viewY*70}px`,
      '--foil-angle':`${125+viewX*360-viewY*120}deg`,'--foil-shift':`${50+(viewX*1.9+viewY*.8)*180}%`,
      '--holo-color':`rgb(${spectrum.join(' ')})`,'--view-x':String(viewX),'--view-y':String(viewY)};
    for(const [property,value] of Object.entries(values))instance.stage.style.setProperty(property,value);
    instance.shell.toggleAttribute('data-hover',state.active);
    if(!cardState.flipped&&!document.hidden)instance.material?.setView({x:rx,y:ry,pointerX:state.pointerX,pointerY:state.pointerY,active:state.active});
  }
  function followTilt(instance,x,y,pointerX=.5,pointerY=.5,active=true) {
    if(ui!==instance||drag||cardState.collapsed)return;
    if(!tiltState||tiltState.instance!==instance)tiltState={instance,x:0,y:0,vx:0,vy:0,targetX:0,targetY:0,pointerX:.5,pointerY:.5,active:false,lastTime:null};
    Object.assign(tiltState,{targetX:x,targetY:y,pointerX,pointerY,active});
    if(tiltFrame!==null)return;
    const tick=time=>{
      tiltFrame=null;const state=tiltState;
      if(!state||state.instance!==instance||ui!==instance)return;
      // A damped spring gives the foil a little material weight. It only runs
      // while following input or returning; a still card owns no animation loop.
      const dt=state.lastTime===null?1/60:Math.min(.034,Math.max(.001,((Number.isFinite(time)?time:state.lastTime+1000/60)-state.lastTime)/1000));
      state.lastTime=Number.isFinite(time)?time:(state.lastTime??0)+1000/60;
      for(const [position,velocity,target]of [['x','vx','targetX'],['y','vy','targetY']]){
        state[velocity]+=(300*(state[target]-state[position])-28*state[velocity])*dt;
        state[position]+=state[velocity]*dt;
      }
      const settled=Math.abs(state.targetX-state.x)<.008&&Math.abs(state.targetY-state.y)<.008&&Math.abs(state.vx)<.025&&Math.abs(state.vy)<.025;
      if(settled){state.x=state.targetX;state.y=state.targetY;state.vx=state.vy=0;state.lastTime=null;}
      paintTilt(instance,state);
      if(settled){if(!state.active)resetTilt();return;}
      tiltFrame=requestAnimationFrame(tick);
    };
    tiltFrame=requestAnimationFrame(tick);
  }
  function finishDrag() {
    if(!drag)return;const previous=drag;drag=null;
    previous.handle.removeAttribute('data-dragging');
    try{if(previous.handle.hasPointerCapture(previous.pointer))previous.handle.releasePointerCapture(previous.pointer);}catch{}
  }
  function canRetain(instance) {
    return Boolean(instance&&!instance.disposed&&instance.assetKey&&
      assetCache.get(instance.assetKey)?.imageId===instance.profile.imageId&&
      (instance.materialState==='webgl'||instance.materialState==='css'&&instance.imagesPending===0));
  }
  function destroyInstance(instance) {
    if(!instance||instance.disposed)return;
    instance.disposed=true;
    if(readyCards.get(instance.signature)===instance)readyCards.delete(instance.signature);
    instance.events.abort();instance.material?.dispose();instance.material=null;
    instance.resize.disconnect();instance.layer.remove();
  }
  function pruneReady(limit=UI_CACHE_LIMIT) {
    while(readyCards.size>limit)destroyInstance(readyCards.values().next().value);
  }
  function discardAssets(key) {
    const entry=assetCache.get(key);if(entry){assetBytes-=entry.bytes;assetCache.delete(key);}
    for(const instance of [...readyCards.values()])if(instance.assetKey===key)destroyInstance(instance);
    if(ui?.assetKey===key)removeUI();
  }
  function cacheAssets(key,entry) {
    const previous=assetCache.get(key);
    const same=previous&&previous.imageId===entry.imageId&&previous.avatar===entry.avatar&&previous.foreground===entry.foreground&&previous.contour===entry.contour&&
      ['character','background','ui','structure'].every(name=>previous.holoAssets?.[name]===entry.holoAssets?.[name]);
    if(previous&&!same)discardAssets(key);
    else if(previous){assetBytes-=previous.bytes;assetCache.delete(key);}
    const strings=new Set([entry.avatar,entry.foreground,entry.contour,...Object.values(entry.holoAssets||{})]);
    entry.bytes=[...strings].reduce((sum,value)=>sum+value.length*2,0);
    if(entry.bytes>ASSET_CACHE_BYTES)return;
    assetCache.set(key,entry);assetBytes+=entry.bytes;
    while(assetCache.size>ASSET_CACHE_LIMIT||assetBytes>ASSET_CACHE_BYTES){
      // The currently visible portrait keeps its backing resources. A large
      // incoming bundle can remain uncached without blanking the current card.
      const oldest=[...assetCache.keys()].find(candidate=>candidate!==ui?.assetKey);
      if(oldest===undefined)break;discardAssets(oldest);
    }
  }
  function purgeRole(id,exceptSignature=null) {
    for(const instance of [...readyCards.values()])if(instance.profile.id===id&&instance.signature!==exceptSignature)destroyInstance(instance);
    if(ui?.profile.id===id&&ui.signature!==exceptSignature)removeUI();
  }
  function removeUI(park=false) {
    finishDrag();resetTilt();if(frame!==null)cancelAnimationFrame(frame);frame=null;
    const previous=ui;ui=null;
    if(previous){
      previous.resize.disconnect();previous.layer.remove();previous.syncLoading();
      if(park&&canRetain(previous)){previous.needsRedraw=true;readyCards.delete(previous.signature);readyCards.set(previous.signature,previous);pruneReady();}
      else destroyInstance(previous);
    }
    roleSignature=null;
  }
  function removeRecovery() {const previous=recovery;recovery=null;if(previous){previous.events.abort();previous.layer.remove();}}
  // A restore target is valid only until the host explicitly hides or replaces
  // this context. Dismissal memory alone never grants permission to render it.
  function clearRestore() {restoreTarget=null;removeRecovery();}
  function fail(code) {clearRestore();purgeRole(roleId);removeUI();failed=true;error=code;emit('mai-work-badges-state');return status();}
  function markStale(reason) {
    if(removed)return;clearRestore();removeUI(true);stale=true;
    emit('mai-work-badges-context-stale');
  }
  function watchMetadata() {
    if(watchers)return;
    watchers=new AbortController();lastTitle=document.title;
    function attachTitle() {
      titleObserver?.disconnect();titleNode=document.head?.querySelector('title')||null;
      if(titleNode)titleObserver.observe(titleNode,{childList:true,characterData:true,subtree:true});
    }
    const changed=()=>{const next=document.title;if(next!==lastTitle){lastTitle=next;markStale('title-changed');}};
    titleObserver=new MutationObserver(changed);
    headObserver=new MutationObserver(records=>{
      if(records.some(record=>[...record.addedNodes,...record.removedNodes].some(item=>item.nodeName==='TITLE'))){attachTitle();changed();}
    });
    attachTitle();if(document.head)headObserver.observe(document.head,{childList:true});
    window.addEventListener('popstate',()=>markStale('navigation'),{signal:watchers.signal});
    window.addEventListener('hashchange',()=>markStale('navigation'),{signal:watchers.signal});
    window.addEventListener('resize',()=>{if(ui||recovery){try{clampPosition();schedulePosition();}catch{fail('viewport-too-small');}}},{signal:watchers.signal});
    window.addEventListener('blur',()=>{finishDrag();resetTilt();},{signal:watchers.signal});
    document.addEventListener('visibilitychange',()=>{
      if(document.hidden){finishDrag();resetTilt();if(ui)ui.needsRedraw=true;}
      else if(ui)syncCard(false);
      ui?.syncLoading();
    },{signal:watchers.signal});
    for(const event of ['resize','scroll'])window.visualViewport?.addEventListener(event,()=>{if(ui||recovery){try{clampPosition();schedulePosition();}catch{fail('viewport-too-small');}}},{signal:watchers.signal});
  }
  function loadFont() {
    if(!fontDataUrl||fontRequested||typeof FontFace!=='function')return;
    fontRequested=true;const token=++fontToken;
    try{
      new FontFace('MaiWorkBadgesDisplay',`url(${fontDataUrl})`,{weight:'200 800'}).load().then(loaded=>{
        if(removed||token!==fontToken)return;font=loaded;document.fonts.add(loaded);
      }).catch(()=>{});
    }catch{} // Font is optional; system fallback keeps the card operable.
  }
  function syncCard(focus=false) {
    if(!ui)return;
    if(cardState.collapsed||ui.shell.getAttribute('data-collapsed')!==null)resetTilt();
    ui.shell.toggleAttribute('data-back',cardState.flipped);ui.shell.toggleAttribute('data-collapsed',cardState.collapsed);
    ui.syncLoading();
    ui.stage.hidden=cardState.collapsed;ui.compact.header.hidden=!cardState.collapsed;
    ui.compact.header.inert=!cardState.collapsed;ui.compact.header.setAttribute('aria-hidden',String(!cardState.collapsed));
    for(const control of ui.compact.controls)control.disabled=!cardState.collapsed;
    for(const [backSide,face,flip,header] of [[false,ui.frontFace,ui.front,ui.headers[0]],[true,ui.backFace,ui.back,ui.headers[1]]]){
      const inactive=cardState.collapsed||backSide!==cardState.flipped;
      face.inert=inactive;face.setAttribute('aria-hidden',String(inactive));flip.disabled=inactive;flip.setAttribute('aria-hidden',String(inactive));
      for(const control of header.controls)control.disabled=inactive;
      header.collapse.setAttribute('aria-expanded',String(!cardState.collapsed));
    }
    if(cardState.flipped||cardState.collapsed||document.hidden)ui.needsRedraw=true;
    else if(ui.material){
      const drawn=ui.material.setView({x:tiltState?.x??0,y:tiltState?.y??0,active:tiltState?.active??false});
      // Detached/hidden WebGL canvases need a fresh presentation even when the
      // quantized view has not changed (preserveDrawingBuffer is false).
      if(ui.needsRedraw){if(drawn!==true)ui.material?.draw?.();ui.needsRedraw=false;}
    }
    if(focus)(cardState.collapsed?ui.compact.mini:cardState.flipped?ui.back:ui.front).focus({preventScroll:true});
    clampPosition(false);schedulePosition();
  }
  function makeLayer() {
    const layer=node('div');layer.setAttribute('data-mai-work-badges','');
    Object.assign(layer.style,{all:'initial',position:'fixed',inset:'0',overflow:'clip',pointerEvents:'none',zIndex:'1000',isolation:'isolate',direction:'ltr',fontFamily:"-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif",fontSize:'14px',lineHeight:'normal',color:'#233d30',colorScheme:'light'});
    const root=layer.attachShadow({mode:'open'}),style=node('style');style.textContent=CSS;
    root.append(style);return {layer,root};
  }
  function makeRecovery(focus=false) {
    removeRecovery();if(!restoreTarget||failed||stale||removed)return;
    const {layer,root}=makeLayer(),panel=node('section','panel recovery');panel.setAttribute('aria-label','已关闭工牌');
    const restoreButton=button('restore','显示本会话工牌','M12 5v14M5 12h14');restoreButton.append(node('span','','显示工牌'));
    const events=new AbortController();
    for(const type of ['pointerdown','pointerup','click','dblclick'])panel.addEventListener(type,event=>event.stopPropagation(),{signal:events.signal});
    restoreButton.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();restore();},{signal:events.signal});
    panel.append(restoreButton);root.append(panel);recovery={layer,root,panel,events};document.body.append(layer);paintPosition();
    if(getComputedStyle(layer).position!=='fixed'||getComputedStyle(layer).pointerEvents!=='none'||getComputedStyle(panel).position!=='absolute')throw new Error('style-blocked');
    if(focus)restoreButton.focus({preventScroll:true});
  }
  function makeUI(profile,avatarDataUrl,foregroundDataUrl,contourDataUrl,holoAssets) {
    const {layer,root}=makeLayer();
    const panel=node('section','panel');panel.setAttribute('aria-label',`${profile.name} 身份卡`);
    const shell=node('section','shell'),stage=node('div','stage'),rotator=node('div','rotator');
    const frontFace=node('div','face front-face'),backFace=node('div','face back-face');
    const canvas=holoAssets?node('canvas','holo-canvas'):null;
    if(canvas){canvas.setAttribute('aria-hidden','true');frontFace.toggleAttribute('data-subject-protected',holoMaterialPreset(profile.imageId).foregroundFoil===0);frontFace.append(canvas);}
    const front=button('flip-surface front',`${profile.name} ${profile.chineseName}，${profile.role}。点击查看职责`);
    const back=button('flip-surface back',`${profile.name} 的日常职责。点击返回工牌`);
    const photo=node('span','photo');
    const imageEvents=[];
    function avatar(className,source=avatarDataUrl) {
      const container=node('span',className);
      if(source){const image=node('img','portrait');image.alt='';image.draggable=false;image.decoding='async';imageEvents.push({image,source});container.append(image);}
      else container.append(node('span','initial',Array.from(profile.name.trim())[0].toLocaleUpperCase()));
      return container;
    }
    // Colored foreground, scenery and DOM identity are independent planes. A
    // full opaque avatar is never duplicated as a pretend repaired background.
    const portrait=avatar('avatar',foregroundDataUrl||avatarDataUrl);
    if(foregroundDataUrl||!avatarDataUrl){
      photo.setAttribute('data-layered','');photo.append(node('span','scene'));
    }
    if(foregroundDataUrl&&contourDataUrl){
      const contour=node('span','contour');contour.setAttribute('aria-hidden','true');
      contour.style.setProperty('mask-image',`url(${contourDataUrl})`);contour.style.setProperty('-webkit-mask-image',`url(${contourDataUrl})`);
      // The supplied aligned line asset is already clipped to foreground alpha.
      // No blur or drop-shadow can leak contour emission into scenery or text.
      portrait.append(contour);
    }
    const foil=node('span','foil');foil.setAttribute('aria-hidden','true');photo.append(portrait,foil);
    const loading=node('span','loading');loading.setAttribute('role','status');loading.setAttribute('aria-live','polite');loading.hidden=true;
    const loadingDot=node('span','loading-dot');loadingDot.setAttribute('aria-hidden','true');loading.append(loadingDot,node('span','','正在加载工牌'));photo.append(loading,foil);
    const body=node('span','body'),names=node('span','names');
    names.append(node('span','english',profile.name),node('span','chinese',profile.chineseName));
    const bio=node('span','bio',profile.bio);bio.id='work-badge-bio';bio.title=profile.bio;
    function footer(backSide=false) {
      const element=node('span','footer');element.append(node('span',backSide?'serial':'signature',backSide?profile.serial:'AI 运营搭档'));
      if(!backSide)element.append(node('span','serial',profile.serial));
      const hint=node('span','turn-hint',backSide?'返回工牌':'查看职责');hint.append(icon('M4 10a8 8 0 1 1 1 8M4 4v6h6'));element.append(hint);return element;
    }
    body.append(names,node('span','role',profile.role),bio,footer());front.append(photo,body);front.setAttribute('aria-describedby',bio.id);
    const backContent=node('span','back-content'),heading=node('span','back-heading');heading.append(node('span','english',profile.name),node('span','chinese','的职责'));
    const duties=node('span','duties');duties.id='work-badge-duties';
    for(const [title,text] of profile.duties){const row=node('span','duty');row.append(node('span','duty-title',title),node('span','duty-copy',text));duties.append(row);}
    const approval=node('span','approval',profile.approval);approval.id='work-badge-approval';approval.hidden=!profile.approval;
    backContent.append(heading,duties,approval,footer(true));back.append(backContent);back.setAttribute('aria-describedby',`${duties.id} ${approval.id}`);
    stage.id='work-badge-stage';
    function makeHeader(compact=false) {
      const header=node('header',compact?'card-header compact-header':'card-header');
      const handle=button('drag',`拖动 ${profile.name} 工牌；方向键移动，Shift 加速`);
      if(compact){
        const identity=node('span','mini-identity');identity.append(node('span','mini-name',profile.name),node('span','mini-role',profile.role));
        const miniProfile=node('span','mini-profile');miniProfile.append(avatar('mini-avatar'),identity);handle.append(miniProfile);
      }else{
        const brand=node('span','brand-mark'),brandImage=node('img','brand-avatar');brandImage.src=BRAND_AVATAR;brandImage.alt='';brandImage.draggable=false;brand.append(brandImage);
        handle.append(brand,node('span','brand-caption','MaiBadges'));
      }
      const toggle=button(compact?'control mini':'control collapse',compact?`展开 ${profile.name} 身份卡`:'收起身份卡','m8 10 4 4 4-4');
      toggle.setAttribute('aria-expanded',String(!compact));toggle.setAttribute('aria-controls',stage.id);
      const close=button('control close',`关闭本会话的 ${profile.name} 工牌`,'m6 6 12 12M18 6 6 18');
      header.append(handle,toggle,close);
      return {header,handle,close,controls:[handle,toggle,close],...(compact?{mini:toggle}:{collapse:toggle})};
    }
    // Header controls belong to each non-button face. The native flip target is
    // their sibling, keeping a complete card plane without nested buttons.
    const headers=[makeHeader(),makeHeader()],compact=makeHeader(true);
    frontFace.append(headers[0].header,front);backFace.append(headers[1].header,back);
    rotator.append(frontFace,backFace);stage.append(rotator);shell.append(stage,compact.header);panel.append(shell);root.append(panel);
    const events=new AbortController(),eventOptions={signal:events.signal};
    const instance={layer,root,panel,shell,stage,frontFace,backFace,front,back,headers,compact,events,profile,resize:null,material:null,materialState:holoAssets?'loading':'css',imagesPending:imageEvents.length,disposed:false,materialStarted:false,needsRedraw:false};
    instance.syncLoading=()=>{
      const paused=ui!==instance||document.hidden||cardState.flipped||cardState.collapsed;
      const pending=instance.materialState==='loading'||['css','fallback'].includes(instance.materialState)&&instance.imagesPending>0;
      shell.toggleAttribute('data-loading-paused',paused);loading.hidden=paused||!pending;
    };
    instance.startMaterial=()=>{
      if(instance.materialStarted)return;instance.materialStarted=true;
      if(!canvas){instance.syncLoading();return;}
      if(typeof canvas.getContext!=='function'){instance.materialState='fallback';instance.syncLoading();return;}
      const fallback=()=>{
        if(instance.disposed)return;
        if(ui!==instance){destroyInstance(instance);return;}
        instance.materialState='fallback';frontFace.removeAttribute('data-material');instance.material?.dispose();instance.material=null;instance.syncLoading();
      };
      createBadgeHoloRenderer(canvas,holoAssets,{width:800,...holoMaterialPreset(profile.imageId),signal:events.signal,onLost:fallback}).then(material=>{
        if(ui!==instance||events.signal.aborted){material.dispose();return;}
        instance.material=material;instance.materialState='webgl';frontFace.setAttribute('data-material','webgl');
        instance.syncLoading();
        if(cardState.flipped||cardState.collapsed||document.hidden)instance.needsRedraw=true;
        else material.setView({x:tiltState?.instance===instance?tiltState.x:0,y:tiltState?.instance===instance?tiltState.y:0,active:false});
        emit('mai-work-badges-state');
      }).catch(()=>{fallback();});
    };
    function changeState(changes){
      cardState={...cardState,...changes};
      try{syncCard(true);emit('mai-work-badges-state');}catch{fail('viewport-too-small');}
    }
    let inspect=null,suppressedClickUntil=0;
    function flip(value,event){
      if(event.detail!==0&&Date.now()<suppressedClickUntil){event.preventDefault();event.stopPropagation();suppressedClickUntil=0;return;}
      changeState({flipped:value});
    }
    front.addEventListener('click',event=>{if(front.disabled||ui!==instance)return;event.stopPropagation();flip(true,event);},eventOptions);
    back.addEventListener('click',event=>{if(back.disabled||ui!==instance)return;event.stopPropagation();flip(false,event);},eventOptions);
    shell.addEventListener('keydown',event=>{if(ui===instance&&event.key==='Escape'&&cardState.flipped&&!cardState.collapsed){event.preventDefault();event.stopPropagation();changeState({flipped:false});}},eventOptions);
    for(const type of ['pointerdown','pointerup','click','dblclick'])panel.addEventListener(type,event=>event.stopPropagation(),eventOptions);
    for(const controls of [...headers,compact]){
      const {handle,close,collapse,mini}=controls;
      collapse?.addEventListener('click',event=>{if(collapse.disabled||ui!==instance)return;event.stopPropagation();changeState({collapsed:true});},eventOptions);
      mini?.addEventListener('click',event=>{if(mini.disabled||ui!==instance)return;event.stopPropagation();changeState({collapsed:false});},eventOptions);
      handle.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();},eventOptions);
      handle.addEventListener('pointerdown',event=>{
        if(handle.disabled||ui!==instance||event.button!==0||drag)return;event.preventDefault();event.stopPropagation();handle.focus({preventScroll:true});
        resetTilt();try{handle.setPointerCapture(event.pointerId);}catch{return;}
        drag={pointer:event.pointerId,clientX:event.clientX,clientY:event.clientY,x:layout.x,y:layout.y,handle};handle.setAttribute('data-dragging','');
      },eventOptions);
      handle.addEventListener('pointermove',event=>{
        if(!drag||drag.handle!==handle||event.pointerId!==drag.pointer)return;event.preventDefault();event.stopPropagation();
        layout={...layout,x:drag.x+event.clientX-drag.clientX,y:drag.y+event.clientY-drag.clientY};
        try{clampPosition();schedulePosition();}catch{fail('viewport-too-small');}
      },eventOptions);
      for(const type of ['pointerup','pointercancel','lostpointercapture'])handle.addEventListener(type,event=>{if(drag&&drag.handle===handle&&event.pointerId===drag.pointer){finishDrag();schedulePosition();}},eventOptions);
      handle.addEventListener('keydown',event=>{
        if(handle.disabled||ui!==instance)return;
        const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];if(!delta)return;
        event.preventDefault();event.stopPropagation();const step=event.shiftKey?20:4;
        layout={...layout,x:layout.x+delta[0]*step,y:layout.y+delta[1]*step};try{clampPosition();schedulePosition();}catch{fail('viewport-too-small');}
      },eventOptions);
      close.addEventListener('click',event=>{if(close.disabled||ui!==instance)return;event.preventDefault();event.stopPropagation();dismissedContexts.add(dismissalKey(contextKey,roleId));removeUI(true);try{makeRecovery(true);emit('mai-work-badges-state');}catch(problem){fail(problem.message==='style-blocked'?'style-blocked':'viewport-too-small');}},eventOptions);
    }
    const motion=matchMedia('(prefers-reduced-motion: reduce)');motion.addEventListener('change',()=>{if(ui===instance)resetTilt();},eventOptions);
    function pointerFollow(event,checkInside=false) {
      const bounds=shell.getBoundingClientRect();if(!bounds.width||!bounds.height)return;
      const px=Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width)),py=Math.max(0,Math.min(1,(event.clientY-bounds.top)/bounds.height));
      const inside=event.clientX>=bounds.left&&event.clientX<=bounds.right&&event.clientY>=bounds.top&&event.clientY<=bounds.bottom;
      const active=!checkInside||inside;
      followTilt(instance,active?-(py-.5)*28:0,active?(px-.5)*36:0,px,py,active);
    }
    function releaseInspection() {
      if(!inspect)return;const previous=inspect;inspect=null;
      previous.surface.removeAttribute('data-inspecting');
      try{if(previous.surface.hasPointerCapture(previous.pointer))previous.surface.releasePointerCapture(previous.pointer);}catch{}
    }
    instance.cancelInspect=releaseInspection;
    // Card-body press/drag inspects its material. The header's separate capture
    // still moves the overlay; a genuine drag cannot fall through into a flip.
    for(const surface of [front,back]){
      surface.addEventListener('pointerdown',event=>{
        if(surface.disabled||ui!==instance||motion.matches||drag||inspect||event.pointerType!=='mouse'||event.button!==0)return;
        suppressedClickUntil=0;
        try{surface.setPointerCapture(event.pointerId);}catch{return;}
        inspect={surface,pointer:event.pointerId,startX:event.clientX,startY:event.clientY,x:tiltState?.x||0,y:tiltState?.y||0,moved:false};
      },eventOptions);
      surface.addEventListener('pointermove',event=>{
        if(!inspect||inspect.surface!==surface||inspect.pointer!==event.pointerId)return;
        const dx=event.clientX-inspect.startX,dy=event.clientY-inspect.startY;
        if(!inspect.moved&&Math.hypot(dx,dy)<=6)return;
        inspect.moved=true;surface.setAttribute('data-inspecting','');event.preventDefault();event.stopPropagation();
        const bounds=shell.getBoundingClientRect(),px=Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width)),py=Math.max(0,Math.min(1,(event.clientY-bounds.top)/bounds.height));
        followTilt(instance,Math.max(-22,Math.min(22,inspect.x-dy*.18)),Math.max(-28,Math.min(28,inspect.y+dx*.24)),px,py,true);
      },eventOptions);
      for(const type of ['pointerup','pointercancel','lostpointercapture'])surface.addEventListener(type,event=>{
        if(!inspect||inspect.surface!==surface||inspect.pointer!==event.pointerId)return;
        const moved=inspect.moved;releaseInspection();if(moved)suppressedClickUntil=Date.now()+600;
        if(type==='pointerup'&&Number.isFinite(event.clientX)&&Number.isFinite(event.clientY))pointerFollow(event,true);
        else followTilt(instance,0,0,.5,.5,false);
      },eventOptions);
    }
    shell.addEventListener('pointermove',event=>{
      if(event.pointerType!=='mouse'||motion.matches||cardState.collapsed||drag||inspect||ui!==instance)return;
      // Stable, untransformed shell geometry avoids feedback at tilted edges.
      // The inner rotator owns flip; this controller never edits its transform.
      pointerFollow(event);
    },eventOptions);
    shell.addEventListener('pointerleave',()=>{if(!inspect&&!motion.matches)followTilt(instance,0,0,.5,.5,false);},eventOptions);
    shell.addEventListener('pointercancel',()=>{if(ui===instance)resetTilt();},eventOptions);
    instance.resize=new ResizeObserver(()=>{if(ui!==instance)return;if(!layer.isConnected){removeUI();return;}try{clampPosition();schedulePosition();}catch{fail('viewport-too-small');}});
    for(const {image,source} of imageEvents){
      let settled=false;const ready=()=>{if(settled)return;settled=true;instance.imagesPending--;instance.syncLoading();};
      image.addEventListener('load',ready,eventOptions);
      image.addEventListener('error',()=>{if(ui===instance)fail('portrait-load-failed');else destroyInstance(instance);},eventOptions);image.src=source;
      if(image.complete&&image.naturalWidth>0)ready();
    }
    return instance;
  }
  function status() {
    if(ui&&!ui.layer.isConnected)removeUI();if(recovery&&!recovery.layer.isConnected)removeRecovery();
    const snapshot={x:layout.x??Math.max(12,(window.innerWidth||1024)-(layout.width??266)-36),y:layout.y??378,width:layout.width??266};
    return {brand:BRAND,version:2,build:BUILD,assetCacheVersion:1,assetCacheMiss,assetCacheHit,uiCacheHit,cacheStats:{entries:assetCache.size,bytes:assetBytes,retainedUI:readyCards.size+(canRetain(ui)?1:0)},material:ui?.materialState??'none',mounted:Boolean(ui),restorable:Boolean(recovery),roleId,contextKey,layout:snapshot,cardState:{...cardState},dismissed:dismissedContexts.has(dismissalKey(contextKey,roleId)),failed,stale,...(error?{error}:{})};
  }
  function configure(options={}) {
    if(removed)throw new Error('Runtime was uninstalled.');
    if(options.fontDataUrl!==undefined){const next=asset(options.fontDataUrl,FONT,8*1024*1024,'invalid-font');if(next!==fontDataUrl){fontDataUrl=next;fontToken++;fontRequested=false;if(font){document.fonts.delete(font);font=null;}if(ui)loadFont();}}
    return status();
  }
  function show(options={}) {
    if(removed)throw new Error('Runtime was uninstalled.');
    assetCacheMiss=false;assetCacheHit=false;uiCacheHit=false;
    let nextContext,profile,avatar,foreground,contour,holoAssets,nextLayout,nextState,signature,assetKey=null;
    try{
      nextContext=cleanContext(options.contextKey);profile=cleanRole(options.role);
      nextLayout=cleanLayout(options.layout??{});nextState=cleanState(options.cardState??{});
      if(options.assetKey!==undefined){if(typeof options.assetKey!=='string'||!/^[a-f0-9]{64}$/.test(options.assetKey))throw new TypeError('invalid-asset-key');assetKey=options.assetKey;}
      if(assetKey&&!RESOURCE_FIELDS.some(name=>Object.hasOwn(options,name))){
        const entry=assetCache.get(assetKey);
        if(!entry||entry.imageId!==profile.imageId){
          clearRestore();removeUI(true);contextKey=nextContext;roleId=profile.id;stale=false;failed=false;error=null;assetCacheMiss=true;
          return status();
        }
        ({avatar,foreground,contour,holoAssets}=entry);assetCache.delete(assetKey);assetCache.set(assetKey,entry);assetCacheHit=true;
      }else{
        avatar=asset(options.avatarDataUrl??'',IMAGE,8*1024*1024,'invalid-avatar');
        foreground=asset(options.foregroundDataUrl??'',LAYER_IMAGE,5*1024*1024,'invalid-foreground');
        contour=asset(options.contourDataUrl??'',LAYER_IMAGE,5*1024*1024,'invalid-contour');
        if(contour&&!foreground)throw new TypeError('invalid-contour');
        holoAssets=null;
        if(options.holoAssets!==undefined&&options.holoAssets!==null){
          if(typeof options.holoAssets!=='object'||Array.isArray(options.holoAssets))throw new TypeError('invalid-holo-assets');
          holoAssets=Object.fromEntries(['character','background','ui','structure'].map(key=>[key,asset(options.holoAssets[key],LAYER_IMAGE,3*1024*1024,'invalid-holo-assets')]));
          if(Object.values(holoAssets).some(value=>!value))throw new TypeError('invalid-holo-assets');
        }
        if(assetKey)cacheAssets(assetKey,{imageId:profile.imageId,avatar,foreground,contour,holoAssets});
      }
      if(options.fontDataUrl!==undefined)configure({fontDataUrl:options.fontDataUrl});
      signature=assetKey?JSON.stringify([profile,assetKey]):JSON.stringify([profile,avatar,foreground,contour,holoAssets]);
    }catch(problem){if(nextContext)contextKey=nextContext;return fail(['invalid-profile','invalid-layout','invalid-card-state','invalid-avatar','invalid-foreground','invalid-contour','invalid-font','invalid-holo-assets','invalid-asset-key'].includes(problem.message)?problem.message:'invalid-show-options');}
    const unchanged=ui&&roleSignature===signature&&contextKey===nextContext;
    const hadFocus=Boolean(ui?.root.activeElement||recovery?.root.activeElement),sameIdentity=roleId===profile.id&&contextKey===nextContext;
    contextKey=nextContext;stale=false;failed=false;error=null;
    layout={...layout,...nextLayout};cardState={...(sameIdentity?cardState:{flipped:false,collapsed:false}),...nextState};
    if(!profile.enabled){clearRestore();purgeRole(profile.id);removeUI(true);roleId=profile.id;return status();}
    try{
      watchMetadata();clampPosition(false);
      purgeRole(profile.id,signature);
      // Only an explicit, validated show can authorize a recovery control.
      restoreTarget={profile,avatar,foreground,contour,holoAssets,assetKey,contextKey:nextContext,title:document.title};
      if(dismissedContexts.has(dismissalKey(contextKey,profile.id))){removeUI(true);roleId=profile.id;makeRecovery(hadFocus);return status();}
      removeRecovery();
      if(unchanged){uiCacheHit=canRetain(ui);syncCard(false);paintPosition();return status();}
      removeUI(true);
      let instance=readyCards.get(signature);
      if(instance){readyCards.delete(signature);uiCacheHit=true;}else instance=makeUI(profile,avatar,foreground,contour,holoAssets);
      pruneReady(UI_CACHE_LIMIT-1);ui=instance;instance.assetKey=assetKey;instance.signature=signature;roleId=profile.id;roleSignature=signature;
      document.body.append(instance.layer);syncCard(hadFocus);paintPosition();instance.resize.observe(instance.panel);
      if(getComputedStyle(instance.layer).position!=='fixed'||getComputedStyle(instance.layer).pointerEvents!=='none'||getComputedStyle(instance.panel).position!=='absolute'||getComputedStyle(instance.frontFace).position!=='absolute'||getComputedStyle(instance.front).position!=='relative')return fail('style-blocked');
      const pictures=instance.root.querySelectorAll('img');if([...pictures].some(image=>image.complete&&image.naturalWidth===0))return fail('portrait-load-failed');
      loadFont();instance.startMaterial();return status();
    }catch(problem){return fail(['viewport-too-small','style-blocked'].includes(problem.message)?problem.message:'render-failed');}
  }
  function restore() {
    if(removed)throw new Error('Runtime was uninstalled.');
    const target=restoreTarget;
    if(!target||failed||stale||contextKey!==target.contextKey||roleId!==target.profile.id)return status();
    if(document.title!==target.title){markStale('title-changed');return status();}
    dismissedContexts.delete(dismissalKey(contextKey,roleId));
    const result=show({role:target.profile,avatarDataUrl:target.avatar,foregroundDataUrl:target.foreground,contourDataUrl:target.contour,holoAssets:target.holoAssets,...(target.assetKey?{assetKey:target.assetKey}:{}),contextKey:target.contextKey,layout:{...layout},cardState:{...cardState}});
    if(ui)(cardState.collapsed?ui.compact.mini:cardState.flipped?ui.back:ui.front).focus({preventScroll:true});
    emit('mai-work-badges-state');return result;
  }
  function hide(options={}) {
    if(removed)return status();clearRestore();removeUI(true);
    if(options.contextKey!==undefined){const next=options.contextKey===null?null:cleanContext(options.contextKey);if(next!==contextKey){failed=false;error=null;}contextKey=next;}
    if(options.reason==='stale')stale=true;
    return status();
  }
  function uninstall() {
    if(removed)return;clearRestore();removeUI();for(const instance of [...readyCards.values()])destroyInstance(instance);assetCache.clear();assetBytes=0;removed=true;watchers?.abort();titleObserver?.disconnect();headObserver?.disconnect();watchers=null;
    fontToken++;if(font)document.fonts.delete(font);font=null;dismissedContexts.clear();roleId=null;contextKey=null;
    if(window[GLOBAL]===api)delete window[GLOBAL];
  }
  const api=Object.freeze({brand:BRAND,version:2,build:BUILD,configure,show,hide,restore,status,uninstall});
  Object.defineProperty(window,GLOBAL,{value:api,configurable:true});
})();
