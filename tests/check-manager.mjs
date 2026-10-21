/* Offline manager input and MCP Apps bridge contracts. No browser or app. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {blank,profileInput,recentContexts,contextByKey,bindingsForRole,savedBinding,validAvatar,validHoloLayer,cleanHoloAssets,matchingPreviewLayers,previewMotion,createBridge}=require('../plugins/work-badges/ui/manager.js');
let count=0;
async function check(name,fn){await fn();count++;console.log(`ok ${count} - ${name}`);}
function surface(){
  const listeners=new Set(),sent=[];
  const parent={postMessage(message){sent.push(message);}};
  const result={parent,sent,setTimeout,clearTimeout,
    addEventListener(kind,fn){if(kind==='message')listeners.add(fn);},
    removeEventListener(kind,fn){if(kind==='message')listeners.delete(fn);},
    respond(request,result,source=parent,error){for(const fn of listeners)fn({source,data:{jsonrpc:'2.0',id:request.id,result,error}});},
    listeners};
  return result;
}
async function connect(s,b){const promise=b.connect();assert.equal(s.sent[0].method,'ui/initialize');s.respond(s.sent[0],{protocolVersion:'2026-01-26',hostCapabilities:{}});await promise;}
function themedSurface({system='light',legacy}={}){
  const s=surface(),attributes=new Map(),globals=new Set(),mediaListeners=new Set();
  const add=s.addEventListener,remove=s.removeEventListener;
  s.document={documentElement:{setAttribute:(key,value)=>attributes.set(key,value)}};
  s.openai=legacy?{theme:legacy}:undefined;
  s.media={matches:system==='dark',addEventListener:(kind,fn)=>mediaListeners.add(fn),removeEventListener:(kind,fn)=>mediaListeners.delete(fn)};
  s.matchMedia=()=>s.media;
  s.addEventListener=(kind,fn)=>kind==='openai:set_globals'?globals.add(fn):add(kind,fn);
  s.removeEventListener=(kind,fn)=>kind==='openai:set_globals'?globals.delete(fn):remove(kind,fn);
  s.currentTheme=()=>attributes.get('data-theme');
  s.notify=(params,source=s.parent)=>{for(const fn of s.listeners)fn({source,data:{jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params}});};
  s.systemTheme=theme=>{s.media.matches=theme==='dark';for(const fn of mediaListeners)fn();};
  s.legacyTheme=theme=>{for(const fn of globals)fn({detail:{globals:{theme}}});};
  s.themeListenerCount=()=>globals.size+mediaListeners.size;
  return s;
}
await check('blank records never invent an avatar or duties',()=>{assert.deepEqual(blank().duties,[]);assert.equal(blank().bio,'');assert.equal(blank().imageId,undefined);});
await check('create and edit send allowed fields only',()=>{
  const input=profileInput({...blank(),name:'Maxie',role:'资深分析师',enabled:false,imageId:'internal'},'maxie','',false);
  assert.equal(input.id,'maxie');assert.equal(input.enabled,undefined);assert.equal(input.imageId,undefined);
});
await check('required name/job and length limits are checked',()=>{
  for(const row of [blank(),{...blank(),name:'Max',role:' '},{...blank(),name:'M'.repeat(49),role:'运营'}])assert.throws(()=>profileInput(row));
});
await check('malformed or incomplete duties are rejected',()=>{
  for(const duties of [{},['text'],[[1,2]],[['title']],[['','copy']],[['a','b','c']],Array(6).fill(['a','b'])])assert.throws(()=>profileInput({...blank(),name:'Max',role:'运营',duties}));
});
await check('avatar replace and clear are explicit and mutually exclusive',()=>{
  const fields={...blank(),name:'Milo',role:'互动运营'};
  assert.equal(profileInput(fields,'milo','data:image/png;base64,AA==',true).clearAvatar,undefined);
  assert.equal(profileInput(fields,'milo','',true).clearAvatar,true);
  assert.equal(profileInput(fields,'milo','',false).avatarDataUrl,undefined);
});
await check('external, malformed, and oversized avatars are rejected',()=>{
  assert.ok(validAvatar('data:image/png;base64,AA=='));assert.ok(validAvatar('data:image/webp;base64,AAAA'));
  for(const value of ['https://example.com/a.png','data:image/svg+xml;base64,AA==','data:image/png;base64,?!',null,'data:image/png;base64,'+'A'.repeat(5*1024*1024)])assert.equal(validAvatar(value),false);
});
await check('derived layers require matching original avatar identity and validated PNG data',()=>{
  const original='data:image/png;base64,AA==',foreground='data:image/png;base64,AQ==',contour='data:image/png;base64,Ag==';
  const avatars=new Map([['milo-image',original]]),layers=new Map([['milo-image',{foregroundDataUrl:foreground,contourDataUrl:contour}]]);
  assert.equal(matchingPreviewLayers(original,'milo-image',avatars,layers).foregroundDataUrl,foreground);
  assert.equal(matchingPreviewLayers('data:image/png;base64,Aw==','milo-image',avatars,layers),null);
  assert.equal(matchingPreviewLayers(original,null,avatars,layers),null);
  for(const value of ['https://example.com/cutout.png','data:image/svg+xml;base64,AA==','data:image/png;base64,?!','data:image/png;base64,'+'A'.repeat(8*1024*1024)])assert.equal(validHoloLayer(value),false);
  assert.equal(validHoloLayer(foreground),true);
  layers.set('milo-image',{foregroundDataUrl:foreground,contourDataUrl:'https://example.com/mask.png'});
  assert.equal(matchingPreviewLayers(original,'milo-image',avatars,layers).contourDataUrl,null);
});
await check('full-card WebGL layers validate all four local PNGs and bind to the unchanged original',()=>{
  const assets=Object.fromEntries(['character','background','ui','structure'].map((name,index)=>[name,`data:image/png;base64,${['AA==','AQ==','Ag==','Aw=='][index]}`]));
  assert.deepEqual(cleanHoloAssets({...assets,untrusted:'ignored'}),assets);
  for(const value of [null,[],{...assets,structure:undefined},{...assets,character:'https://example.com/x.png'},{...assets,ui:'data:image/png;base64,AA===='}])assert.equal(cleanHoloAssets(value),null);
  const original='data:image/png;base64,BA==',avatars=new Map([['milo-image',original]]),layers=new Map([['milo-image',{holoAssets:assets}]]);
  assert.deepEqual(matchingPreviewLayers(original,'milo-image',avatars,layers).holoAssets,assets);
  assert.equal(matchingPreviewLayers('data:image/png;base64,BQ==','milo-image',avatars,layers),null);
});
await check('holographic preview mapping bounds tilt, reverses scenery and changes spectral lighting',()=>{
  const right=previewMotion(99,-99),left=previewMotion(-.5,.5);
  assert.equal(right['--rx'],'14deg');assert.equal(right['--ry'],'18deg');assert.equal(left['--rx'],'-14deg');
  assert.ok(parseFloat(right['--fg-x'])>0);assert.ok(parseFloat(right['--bg-x'])<0);
  assert.ok(Math.abs(parseFloat(right['--fg-x']))<6);assert.ok(Math.abs(parseFloat(right['--bg-x']))<15);
  assert.notEqual(right['--holo-color'],left['--holo-color']);assert.notEqual(right['--foil-shift'],left['--foil-shift']);
  assert.equal(previewMotion(Number.NaN,Infinity)['--rx'],'0deg');
});
await check('recent window list hides stale records',()=>{
  const rows=[{title:'Max',seenAt:100},{title:'Maxie',seenAt:85},{title:'Maxin',seenAt:10}];
  assert.deepEqual(recentContexts(rows,102).map(row=>row.title),['Max','Maxie']);
});
await check('two chats seen in the same window select by context, never window id',()=>{
  const rows=[{windowId:'one',title:'Maxie',contextKey:'title:Maxie'},{windowId:'one',title:'Milo',contextKey:'title:Milo'}];
  assert.equal(contextByKey(rows,'title:Milo').title,'Milo');assert.equal(contextByKey(rows,'title:Maxie').title,'Maxie');
  assert.equal(contextByKey(rows,'title:Max'),undefined);
});
await check('role binding state comes from saved records and matches full keys',()=>{
  const snapshot={bindings:[{id:'a',roleId:'max',kind:'title',key:'Max（运营总监）'},{id:'b',roleId:'maxie',kind:'title',key:'Maxie（资深分析师）'}]};
  assert.equal(bindingsForRole(snapshot,'max').length,1);
  assert.equal(bindingsForRole(snapshot,null).length,0);
  assert.equal(savedBinding(snapshot,{roleId:'max',kind:'title',key:'Max'}),undefined);
  assert.equal(savedBinding(snapshot,{roleId:'maxie',kind:'title',key:'Max（运营总监）'}),undefined);
  assert.equal(savedBinding(snapshot,{roleId:'max',kind:'thread',key:'Max（运营总监）'}),undefined);
  assert.equal(savedBinding(snapshot,{roleId:'max',kind:'title',key:'Max（运营总监）'}).id,'a');
});
await check('bridge initializes once and sends initialized notification',async()=>{
  const s=surface(),b=createBridge(s);await connect(s,b);await b.connect();assert.equal(s.sent.length,2);
  assert.equal(s.sent[1].method,'ui/notifications/initialized');assert.equal(s.sent[0].params.protocolVersion,'2026-01-26');b.close();
});
await check('host initialization chooses a complete theme over system and legacy defaults',async()=>{
  const s=themedSurface({system:'dark',legacy:'dark'}),b=createBridge(s);
  assert.equal(s.currentTheme(),'dark');const pending=b.connect();
  s.respond(s.sent[0],{hostContext:{theme:'light'}});await pending;
  assert.equal(s.currentTheme(),'light');s.systemTheme('dark');s.legacyTheme('dark');assert.equal(s.currentTheme(),'light');
  s.notify({theme:'dark'});assert.equal(s.currentTheme(),'dark');b.close();
});
await check('theme notifications preserve partial context and reject malformed or foreign updates',async()=>{
  const s=themedSurface(),b=createBridge(s);await connect(s,b);
  s.notify({theme:'dark'});assert.equal(s.currentTheme(),'dark');
  for(const params of [null,[],{locale:'zh-CN'},{theme:'auto'},{theme:42},{theme:'light; background:red'}]){s.notify(params);assert.equal(s.currentTheme(),'dark');}
  s.notify({theme:'light'},{});assert.equal(s.currentTheme(),'dark');
  s.notify({theme:'light'});assert.equal(s.currentTheme(),'light');b.close();
});
await check('system follows live changes until the host supplies a theme; legacy compatibility still works',async()=>{
  const s=themedSurface(),b=createBridge(s);assert.equal(s.currentTheme(),'light');s.systemTheme('dark');assert.equal(s.currentTheme(),'dark');
  s.legacyTheme('light');assert.equal(s.currentTheme(),'light');s.systemTheme('dark');assert.equal(s.currentTheme(),'light');
  await connect(s,b);s.notify({theme:'dark'});s.legacyTheme('light');assert.equal(s.currentTheme(),'dark');b.close();
});
await check('closing and reconnecting own their theme listeners without stale writes',async()=>{
  const s=themedSurface(),first=createBridge(s);await connect(s,first);
  assert.equal(s.themeListenerCount(),2);first.close();assert.equal(s.themeListenerCount(),0);assert.equal(s.listeners.size,0);
  s.legacyTheme('dark');s.notify({theme:'dark'});assert.equal(s.currentTheme(),'light');
  const second=createBridge(s);assert.equal(s.themeListenerCount(),2);second.close();assert.equal(s.themeListenerCount(),0);
});
await check('tool replies correlate by id and reject other message sources',async()=>{
  const s=surface(),b=createBridge(s);await connect(s,b);
  const pending=b.call('work_badges_snapshot');await new Promise(setImmediate);
  const request=s.sent.find(row=>row.method==='tools/call');assert.ok(request);
  s.respond(request,{structuredContent:{version:99}},{});s.respond({...request,id:999},{structuredContent:{version:98}});
  s.respond(request,{structuredContent:{version:3}});assert.equal((await pending).structuredContent.version,3);b.close();
});
await check('optimistic conflict tells manager to reload without swallowing the error',async()=>{
  const s=surface(),b=createBridge(s);await connect(s,b);const pending=b.call('work_badges_save');await new Promise(setImmediate);
  s.respond(s.sent.at(-1),{isError:true,content:[{type:'text',text:'版本冲突'}],_meta:{error:{reload:true}}});
  await assert.rejects(pending,error=>error.reload===true&&error.message==='版本冲突');b.close();
});
await check('RPC errors reach the UI',async()=>{
  const s=surface(),b=createBridge(s);const pending=b.connect();s.respond(s.sent[0],null,s.parent,{code:-1,message:'not supported'});
  await assert.rejects(pending,/not supported/);b.close();
});
await check('timeout is bounded and a failed connection can be retried',async()=>{
  const s=surface(),b=createBridge(s,{timeout:5});await assert.rejects(b.connect(),/超时/);
  const pending=b.connect();s.respond(s.sent.at(-1),{});await pending;b.close();
});
await check('legacy host fallback keeps structured tool responses',async()=>{
  const s=surface();s.openai={callTool:async()=>({structuredContent:{version:7}})};
  const b=createBridge(s,{timeout:5});assert.equal((await b.call('work_badges_snapshot')).structuredContent.version,7);b.close();
});
await check('closing rejects pending requests and removes listeners',async()=>{
  const s=surface(),b=createBridge(s);const pending=b.connect();b.close();await assert.rejects(pending,/关闭/);
  assert.equal(s.listeners.size,0);await assert.rejects(b.call('work_badges_open'),/关闭/);
});

/* A small memory DOM runs the actual manager and bridge without a host or browser. */
function managerSurface({bindReply,roles,avatarMeta,holoFactory}={}){
  const template=readFileSync(new URL('../plugins/work-badges/ui/manager.template.html',import.meta.url),'utf8');
  const source=readFileSync(new URL('../plugins/work-badges/ui/manager.js',import.meta.url),'utf8');
  let doc;
  class Element{
    constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes=new Map();this.handlers=new Map();this.value='';this.checked=false;this.disabled=false;this.hidden=false;this._text='';this.style={values:new Map(),setProperty(key,value){this.values.set(key,String(value));},removeProperty(key){this.values.delete(key);}};}
    set textContent(value){this._text=String(value);this.children=[];}get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
    append(...items){for(const item of items){if(item.fragment)this.append(...item.children);else{item.parent=this;this.children.push(item);}}}
    replaceChildren(...items){this.children=[];this._text='';this.append(...items);}
    setAttribute(key,value){this.attributes.set(key,String(value));}
    removeAttribute(key){this.attributes.delete(key);}
    toggleAttribute(key,force){const next=force??!this.attributes.has(key);if(next)this.setAttribute(key,'');else this.removeAttribute(key);return next;}
    addEventListener(kind,fn){if(!this.handlers.has(kind))this.handlers.set(kind,[]);this.handlers.get(kind).push(fn);}
    dispatch(kind,event={}){for(const fn of this.handlers.get(kind)||[])fn({target:this,preventDefault(){},...event});}
    focus(){doc.activeElement=this;}
    click(){if(!this.disabled)this.dispatch('click');}
    remove(){this.parent.children=this.parent.children.filter(child=>child!==this);}
    querySelector(selector){
      if(selector==='[value=thread]')return this.threadOption??=new Element('option');
      for(const child of this.children){
        if(selector==='input'&&child.tagName==='INPUT'||selector==='[data-title]'&&'title'in child.dataset||selector==='[data-copy]'&&'copy'in child.dataset)return child;
        const found=child.querySelector(selector);if(found)return found;
      }
      return null;
    }
    getBoundingClientRect(){return {left:20,top:10,width:236,height:330};}
    get lastElementChild(){return this.children.at(-1);}
  }
  const nodes={};for(const match of template.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"/g))nodes[match[2]]=new Element(match[1]);
  nodes['binding-kind'].value='title';if(holoFactory)nodes['preview-material'].getContext=()=>({});
  const tablist=new Element();
  const documentListeners=new Map();
  doc={addEventListener(kind,fn){if(!documentListeners.has(kind))documentListeners.set(kind,new Set());documentListeners.get(kind).add(fn);},getElementById(id){if(!nodes[id])throw new Error(`Missing UI element: ${id}`);return nodes[id];},createElement:tag=>new Element(tag),createElementNS:(ns,tag)=>{const node=new Element(tag);node.namespaceURI=ns;return node;},createDocumentFragment:()=>Object.assign(new Element(),{fragment:true}),
    querySelector(selector){assert.equal(selector,'[role=tablist]');return tablist;},querySelectorAll(selector){assert.equal(selector,'.role-item');return nodes['role-list'].children;}};
  const listeners=new Map(),calls=[],frames=new Map(),motionListeners=new Set(),intervals=[];let frameId=0;
  const motion={matches:false,addEventListener(kind,fn){motionListeners.add(fn);},removeEventListener(kind,fn){motionListeners.delete(fn);}};
  let snapshot={version:1,roles:roles||[{id:'max',name:'Max',role:'运营总监',enabled:true,duties:[]}],bindings:[],contexts:[]};
  const win={document:doc,setTimeout,clearTimeout,matchMedia:()=>motion,requestAnimationFrame(fn){frames.set(++frameId,fn);return frameId;},cancelAnimationFrame(id){frames.delete(id);},setInterval(fn){intervals.push(fn);return intervals.length;},clearInterval(){},addEventListener(kind,fn){if(!listeners.has(kind))listeners.set(kind,new Set());listeners.get(kind).add(fn);},removeEventListener(kind,fn){listeners.get(kind)?.delete(fn);}};
  win.parent={postMessage(message){
    if(!message.id)return;
    let result={};
    if(message.method==='tools/call'){
      calls.push(message.params);
      result=message.params.name==='work_badges_avatar'?Promise.resolve(typeof avatarMeta==='function'?avatarMeta(message.params.arguments.imageId):avatarMeta).then(meta=>({_meta:meta||{}})):message.params.name==='work_badges_bind'?{structuredContent:bindReply??snapshot}:{structuredContent:snapshot};
    }
    Promise.resolve(result).then(value=>{for(const fn of listeners.get('message')||[])fn({source:win.parent,data:{jsonrpc:'2.0',id:message.id,result:value}});});
  }};
  vm.runInNewContext(source,{window:win,document:doc,console,setTimeout,clearTimeout,Date,AbortController,createBadgeHoloRenderer:holoFactory,FileReader:class {readAsDataURL(file){this.result=file.data;queueMicrotask(()=>this.onload());}}});
  const settle=async()=>{for(let i=0;i<6;i++)await new Promise(setImmediate);};
  return {nodes,calls,settle,frames,updateSnapshot(next){snapshot={...snapshot,...next};},refresh(){for(const fn of intervals)fn();},pagehide(){for(const fn of listeners.get('pagehide')||[])fn();},show(){doc.hidden=false;for(const fn of documentListeners.get('visibilitychange')||[])fn();},flushFrames(){const pending=[...frames.values()];frames.clear();for(const fn of pending)fn();},reduceMotion(value){motion.matches=value;for(const fn of motionListeners)fn();},hide(){doc.hidden=true;for(const fn of documentListeners.get('visibilitychange')||[])fn();},submitBinding(){nodes['binding-key'].value='Max（运营总监）';nodes['title-confirm'].checked=true;nodes['binding-form'].dispatch('submit');}};
}
await check('manager loads saved status and blocks binding while a profile draft is unsaved',async()=>{
  const ui=managerSurface();await ui.settle();
  assert.equal(ui.nodes.statusbar.attributes.has('data-error'),false,ui.nodes.status.textContent);
  assert.doesNotMatch(ui.nodes.status.textContent,/请确认在本地聊天/,ui.nodes.status.textContent);
  assert.equal(ui.nodes['role-count'].textContent,'1');assert.equal(ui.nodes['role-state'].textContent,'已启用');
  assert.match(ui.nodes['role-binding-state'].textContent,/尚未绑定/);assert.equal(ui.nodes['binding-tab-count'].textContent,'0');
  ui.nodes.name.value='New name';ui.nodes['profile-form'].dispatch('input',{target:ui.nodes.name});
  assert.equal(ui.nodes['binding-fields'].disabled,true);assert.match(ui.nodes['preview-save-state'].textContent,/未保存/);
  assert.equal(ui.nodes['preview-initials'].textContent,'N');
});
await check('preview motion is event-driven, resets on exit/back/visibility and respects reduced motion',async()=>{
  const ui=managerSurface();await ui.settle();const preview=ui.nodes.preview;
  preview.dispatch('pointermove',{pointerType:'mouse',clientX:256,clientY:10});assert.equal(ui.frames.size,1);ui.flushFrames();
  assert.equal(preview.style.values.get('--ry'),'18deg');assert.equal(preview.attributes.has('data-hover'),true);assert.equal(ui.frames.size,0);
  preview.dispatch('pointerleave');assert.equal(preview.style.values.size,0);assert.equal(preview.attributes.has('data-hover'),false);
  preview.dispatch('pointermove',{pointerType:'mouse',clientX:230,clientY:20});preview.click();assert.equal(ui.frames.size,0);assert.equal(preview.style.values.size,0);
  preview.dispatch('pointermove',{pointerType:'mouse',clientX:230,clientY:20});assert.equal(ui.frames.size,0);preview.click();
  ui.reduceMotion(true);preview.dispatch('pointermove',{pointerType:'mouse',clientX:230,clientY:20});assert.equal(ui.frames.size,0);
  ui.reduceMotion(false);preview.dispatch('pointermove',{pointerType:'mouse',clientX:230,clientY:20});ui.flushFrames();ui.hide();assert.equal(preview.style.values.size,0);
  preview.dispatch('pointermove',{pointerType:'mouse',clientX:230,clientY:20});assert.equal(ui.frames.size,0);
  preview.dispatch('pointermove',{pointerType:'touch',clientX:230,clientY:20});assert.equal(ui.frames.size,0);
});
await check('derived preview falls back without changing avatar saves and clears immediately on replacement',async()=>{
  const original='data:image/png;base64,AA==',foreground='data:image/png;base64,AQ==',contour='data:image/png;base64,Ag==';
  const ui=managerSurface({roles:[{id:'milo',name:'Milo',role:'互动运营',enabled:true,imageId:'milo-image',duties:[]}],avatarMeta:{avatarDataUrl:original,foregroundDataUrl:foreground,contourDataUrl:contour}});
  await ui.settle();assert.equal(ui.nodes['preview-image'].src,foreground);assert.equal(ui.nodes.preview.attributes.has('data-layered'),true);
  assert.equal(ui.nodes['preview-contour'].hidden,false);assert.match(ui.nodes['preview-contour'].style.values.get('mask-image'),/data:image\/png/);
  ui.nodes['profile-form'].dispatch('submit');await ui.settle();assert.equal(ui.calls.find(call=>call.name==='work_badges_save').arguments.profile.avatarDataUrl,undefined);
  ui.nodes.avatar.files=[{type:'image/png',size:3,data:'data:image/png;base64,Aw=='}];ui.nodes.avatar.dispatch('change');await ui.settle();
  assert.equal(ui.nodes['preview-image'].src,'data:image/png;base64,Aw==');assert.equal(ui.nodes.preview.attributes.has('data-layered'),false);assert.equal(ui.nodes['preview-contour'].hidden,true);
  ui.nodes['profile-form'].dispatch('submit');await ui.settle();assert.equal(ui.calls.filter(call=>call.name==='work_badges_save').at(-1).arguments.profile.avatarDataUrl,'data:image/png;base64,Aw==');
  assert.equal(ui.nodes['preview-image'].src,foreground);ui.nodes['preview-image'].dispatch('error');assert.equal(ui.nodes['preview-image'].src,original);assert.equal(ui.nodes.preview.attributes.has('data-layered'),false);
});
await check('WebGL preview follows pointer, preserves DOM identity and disposes on replacement, hiding and page exit',async()=>{
  const original='data:image/png;base64,AA==',assets=Object.fromEntries(['character','background','ui','structure'].map(name=>[name,'data:image/png;base64,AQ=='])),materials=[];
  const factory=async(canvas,received,options)=>{const material={canvas,received,options,views:[],disposed:0,setView(value){this.views.push(value);},dispose(){this.disposed++;}};materials.push(material);return material;};
  const ui=managerSurface({roles:[{id:'milo',name:'Milo',role:'互动运营',enabled:true,imageId:'milo-image',duties:[]}],avatarMeta:{avatarDataUrl:original,holoAssets:assets},holoFactory:factory});await ui.settle();
  assert.equal(materials.length,1);assert.equal(ui.nodes.preview.attributes.get('data-material'),'webgl');assert.deepEqual(JSON.parse(JSON.stringify(materials[0].received)),assets);assert.equal(ui.nodes['preview-name'].textContent,'Milo');assert.equal(ui.nodes['preview-role'].textContent,'互动运营');assert.equal(ui.nodes['preview-image'].src,original,'original fallback is retained');
  ui.nodes.preview.dispatch('pointermove',{pointerType:'mouse',clientX:256,clientY:10});ui.flushFrames();assert.equal(materials[0].views.at(-1).x,14);assert.equal(materials[0].views.at(-1).y,18);assert.equal(materials[0].views.at(-1).active,true);
  ui.nodes.name.value='New name';ui.nodes['profile-form'].dispatch('input',{target:ui.nodes.name});assert.equal(materials.length,1,'text changes stay live DOM without new GPU contexts');assert.equal(ui.nodes['preview-name'].textContent,'New name');
  ui.nodes.preview.click();assert.equal(materials[0].views.at(-1).active,false);ui.nodes.preview.click();
  ui.hide();assert.equal(materials[0].disposed,1);assert.equal(materials[0].options.signal.aborted,true);assert.equal(ui.nodes.preview.attributes.has('data-material'),false);ui.show();await ui.settle();assert.equal(materials.length,2);
  ui.nodes.avatar.files=[{type:'image/png',size:3,data:'data:image/png;base64,Ag=='}];ui.nodes.avatar.dispatch('change');assert.equal(materials[1].disposed,1);await ui.settle();assert.equal(ui.nodes.preview.attributes.has('data-material'),false);assert.equal(ui.nodes['preview-image'].src,'data:image/png;base64,Ag==');
  ui.nodes.discard.click();await ui.settle();assert.equal(materials.length,3);ui.pagehide();assert.equal(materials[2].disposed,1);assert.equal(materials[2].options.signal.aborted,true);
});
await check('saving a chat binding preserves the exact loaded portrait and WebGL material',async()=>{
  const original='data:image/png;base64,AA==',assets=Object.fromEntries(['character','background','ui','structure'].map(name=>[name,'data:image/png;base64,AQ=='])),materials=[];
  const role={id:'max',name:'Max',role:'运营总监',enabled:true,imageId:'max-image',duties:[]};
  const ui=managerSurface({roles:[role],avatarMeta:{avatarDataUrl:original,holoAssets:assets},bindReply:{version:2,roles:[role],bindings:[{id:'saved',roleId:'max',kind:'title',key:'Max（运营总监）'}],contexts:[]},holoFactory:async(_canvas,_assets,options)=>{const material={options,disposed:0,setView(){},dispose(){this.disposed++;}};materials.push(material);return material;}});
  await ui.settle();assert.equal(materials.length,1);ui.nodes.preview.click();
  ui.submitBinding();await ui.settle();
  assert.equal(materials.length,1);assert.equal(materials[0].disposed,0);assert.equal(materials[0].options.signal.aborted,false);
  assert.equal(ui.nodes['preview-image'].src,original);assert.equal(ui.nodes.preview.attributes.get('data-material'),'webgl');assert.equal(ui.nodes.preview.attributes.has('data-back'),true);
  assert.equal(ui.calls.filter(call=>call.name==='work_badges_avatar').length,1);assert.match(ui.nodes['binding-feedback'].textContent,/已保存：Max/);ui.pagehide();
});
await check('registry updates refresh DOM text without reloading unchanged portrait pixels or losing a draft',async()=>{
  const original='data:image/png;base64,AA==',assets=Object.fromEntries(['character','background','ui','structure'].map(name=>[name,'data:image/png;base64,AQ=='])),materials=[];
  const role={id:'max',name:'Max',role:'运营总监',enabled:true,imageId:'max-image',duties:[]},other={id:'milo',name:'Milo',role:'互动运营',enabled:true,duties:[]};
  const ui=managerSurface({roles:[role,other],avatarMeta:{avatarDataUrl:original,holoAssets:assets},holoFactory:async()=>{const material={disposed:0,setView(){},dispose(){this.disposed++;}};materials.push(material);return material;}});
  await ui.settle();ui.updateSnapshot({version:2,roles:[{...role,bio:'更新后的职责简介'}, {...other,name:'Milo 更新'}]});ui.refresh();await ui.settle();
  assert.equal(materials.length,1);assert.equal(materials[0].disposed,0);assert.equal(ui.nodes['preview-bio'].textContent,'更新后的职责简介');assert.match(ui.nodes['role-list'].textContent,/Milo 更新/);
  ui.nodes.name.value='我的草稿';ui.nodes['profile-form'].dispatch('input',{target:ui.nodes.name});
  ui.updateSnapshot({version:3,roles:[{...role,name:'别处保存的名字'},other]});ui.refresh();await ui.settle();
  assert.equal(ui.nodes.name.value,'我的草稿');assert.equal(ui.nodes['preview-name'].textContent,'我的草稿');assert.equal(ui.nodes['binding-fields'].disabled,true);assert.match(ui.nodes['dirty-message'].textContent,/草稿仍保留/);
  assert.equal(materials.length,1);assert.equal(materials[0].disposed,0);assert.equal(ui.calls.filter(call=>call.name==='work_badges_avatar').length,1);ui.pagehide();
});
await check('a real saved avatar change aborts old material and never displays it while the new portrait is loading',async()=>{
  const original='data:image/png;base64,AA==',replacement='data:image/png;base64,Ag==',assets=Object.fromEntries(['character','background','ui','structure'].map(name=>[name,'data:image/png;base64,AQ=='])),newAssets={...assets,character:'data:image/png;base64,Aw=='},materials=[];let resolveNew;
  const role={id:'max',name:'Max',role:'运营总监',enabled:true,imageId:'old-image',duties:[]};
  const ui=managerSurface({roles:[role],avatarMeta:imageId=>imageId==='old-image'?{avatarDataUrl:original,holoAssets:assets}:new Promise(resolve=>{resolveNew=resolve;}),holoFactory:async(_canvas,received,options)=>{const material={received,options,disposed:0,setView(){},dispose(){this.disposed++;}};materials.push(material);return material;}});
  await ui.settle();ui.updateSnapshot({version:2,roles:[{...role,imageId:'new-image'}]});ui.refresh();await ui.settle();
  assert.equal(materials[0].disposed,1);assert.equal(materials[0].options.signal.aborted,true);assert.equal(ui.nodes.preview.attributes.has('data-material'),false);assert.equal(ui.nodes['preview-image'].hidden,true);assert.equal(materials.length,1);
  resolveNew({avatarDataUrl:replacement,holoAssets:newAssets});await ui.settle();
  assert.equal(ui.nodes['preview-image'].src,replacement);assert.equal(ui.nodes['preview-image'].hidden,false);assert.equal(materials.length,2);assert.equal(materials[1].received.character,newAssets.character);ui.pagehide();assert.equal(materials[1].disposed,1);
});
await check('switching colleagues cancels an old avatar response and does not lend its layers to an unknown portrait',async()=>{
  const original='data:image/png;base64,AA==',assets=Object.fromEntries(['character','background','ui','structure'].map(name=>[name,'data:image/png;base64,AQ=='])),materials=[];let resolveOld;
  const ui=managerSurface({roles:[{id:'max',name:'Max',role:'运营总监',enabled:true,imageId:'max-image',duties:[]},{id:'maxie',name:'Maxie',role:'资深分析师',enabled:true,imageId:'unknown-image',duties:[]}],avatarMeta:imageId=>imageId==='max-image'?new Promise(resolve=>{resolveOld=resolve;}):{},holoFactory:async()=>{const material={disposed:0,setView(){},dispose(){this.disposed++;}};materials.push(material);return material;}});
  await ui.settle();ui.nodes['role-list'].children[1].click();await ui.settle();resolveOld({avatarDataUrl:original,holoAssets:assets});await ui.settle();
  assert.equal(ui.nodes['preview-name'].textContent,'Maxie');assert.equal(ui.nodes['preview-image'].hidden,true);assert.equal(ui.nodes['preview-initials'].hidden,false);assert.equal(ui.nodes.preview.attributes.has('data-material'),false);assert.equal(materials.length,0);ui.pagehide();
});
await check('preview portrait material uses exact image identity and preserves other images original tuning',async()=>{
  const demoImage=JSON.parse(readFileSync(new URL('../plugins/work-badges/assets/holo/demo/manifest.json',import.meta.url),'utf8')).sourceImageId;
  const assets=Object.fromEntries(['character','background','ui','structure'].map(name=>[name,'data:image/png;base64,AQ==']));
  for(const [name,imageId,power,depth,contourBrightness,foregroundFoil,subjectGlow] of [['Renamed',demoImage,.35,1.5,0,0,0],['Other role',demoImage,.35,1.5,0,0,0],['Demo','f'.repeat(64),1.3,1.25,.15],['Demo','unknown-image',1.3,1.25,.15],['Demo','toString',1.3,1.25,.15]]){
    let received;const ui=managerSurface({roles:[{id:'max',name,role:'运营总监',enabled:true,imageId,duties:[]}],avatarMeta:{avatarDataUrl:'data:image/png;base64,AA==',holoAssets:assets},holoFactory:async(_canvas,_assets,options)=>{received=options;return {setView(){},dispose(){}};}});
    await ui.settle();assert.equal(ui.nodes.preview.attributes.get('data-material'),'webgl');assert.equal(received.power,power);assert.equal(received.depth,depth);assert.equal(received.contourBrightness,contourBrightness);assert.equal(received.foregroundFoil,foregroundFoil);assert.equal(received.subjectGlow,subjectGlow);ui.pagehide();
  }
});
await check('WebGL loading races and context loss fall back without losing editable avatar data',async()=>{
  const original='data:image/png;base64,AA==',assets=Object.fromEntries(['character','background','ui','structure'].map(name=>[name,'data:image/png;base64,AQ==']));let resolveMaterial,options;
  const pending=managerSurface({roles:[{id:'milo',name:'Milo',role:'互动运营',enabled:true,imageId:'milo-image',duties:[]}],avatarMeta:{avatarDataUrl:original,holoAssets:assets},holoFactory:(canvas,received,opts)=>{options=opts;return new Promise(resolve=>{resolveMaterial=resolve;});}});await pending.settle();assert.equal(pending.nodes.preview.attributes.get('data-material'),'loading');
  pending.nodes['clear-avatar'].click();assert.equal(options.signal.aborted,true);const late={disposed:0,setView(){throw new Error('stale material must never render');},dispose(){this.disposed++;}};resolveMaterial(late);await pending.settle();assert.equal(late.disposed,1);assert.equal(pending.nodes.preview.attributes.has('data-material'),false);
  let liveOptions;const lost=managerSurface({roles:[{id:'milo',name:'Milo',role:'互动运营',enabled:true,imageId:'milo-image',duties:[]}],avatarMeta:{avatarDataUrl:original,holoAssets:assets},holoFactory:async(canvas,received,opts)=>{liveOptions=opts;return {setView(){},dispose(){}};}});await lost.settle();liveOptions.onLost();assert.equal(lost.nodes.preview.attributes.get('data-material'),'fallback');assert.equal(lost.nodes['preview-image'].src,original);assert.equal(lost.nodes['profile-fields'].disabled,false);lost.nodes['profile-form'].dispatch('submit');await lost.settle();assert.equal(lost.calls.find(call=>call.name==='work_badges_save').arguments.profile.avatarDataUrl,undefined);
  const unavailable=managerSurface({roles:[{id:'milo',name:'Milo',role:'互动运营',enabled:true,imageId:'milo-image',duties:[]}],avatarMeta:{avatarDataUrl:original,holoAssets:assets},holoFactory:async()=>{throw new Error('WebGL unavailable');}});await unavailable.settle();assert.equal(unavailable.nodes.preview.attributes.get('data-material'),'fallback');assert.equal(unavailable.nodes['preview-image'].src,original);assert.equal(unavailable.nodes.statusbar.attributes.has('data-error'),false);
});
await check('manager confirms binding only when returned snapshot contains exact saved record',async()=>{
  const ui=managerSurface({bindReply:{version:2,roles:[{id:'max',name:'Max',role:'运营总监',enabled:true,duties:[]}],bindings:[{id:'saved',roleId:'max',kind:'title',key:'Max（运营总监）'}],contexts:[]}});
  await ui.settle();ui.submitBinding();await ui.settle();
  assert.match(ui.nodes['binding-feedback'].textContent,/已保存：Max → Max（运营总监）/);
  assert.equal(ui.nodes['binding-feedback'].attributes.has('data-error'),false);
  assert.equal(ui.nodes['binding-tab-count'].textContent,'1');assert.match(ui.nodes['binding-list'].textContent,/Max（运营总监）/);
  assert.equal(ui.calls.find(call=>call.name==='work_badges_bind').arguments.expectedVersion,1);
});
await check('manager rejects false success when binding is absent from returned snapshot',async()=>{
  const ui=managerSurface();await ui.settle();ui.submitBinding();await ui.settle();
  assert.match(ui.nodes['binding-feedback'].textContent,/尚不能确认保存成功/);
  assert.equal(ui.nodes['binding-feedback'].attributes.has('data-error'),true);
  assert.equal(ui.nodes['binding-tab-count'].textContent,'0');
  assert.doesNotMatch(ui.nodes.status.textContent,/聊天绑定已保存/);
});
await check('standalone preview never touches an embedding host and rejects every mutation',async()=>{
  const win={setTimeout,clearTimeout,postMessage(){throw new Error('Preview reached an external window');}};
  const attributes=new Map(),buttons=new Map(['light','dark'].map(name=>[name,{attributes:new Map(),handlers:new Map(),setAttribute(key,value){this.attributes.set(key,value);},addEventListener(kind,fn){this.handlers.set(kind,fn);}}]));
  win.document={documentElement:{setAttribute:(key,value)=>attributes.set(key,value)},getElementById:id=>buttons.get(id.replace('preview-theme-',''))};
  Object.defineProperty(win,'parent',{get(){throw new Error('Preview read its external parent');}});
  const genericSample={profiles:['Alex','Blair','Casey','Drew','Ellis'].map((name,index)=>({id:['max','maxie','milo','matthew','maxin'][index],name,duties:[]}))};
  const fixture=readFileSync(new URL('../plugins/work-badges/ui/preview-fixture.js',import.meta.url),'utf8').replace('/* __PREVIEW_SAMPLE_DATA__ */ null',JSON.stringify(genericSample));
  vm.runInNewContext(fixture,{window:win,structuredClone,queueMicrotask,Date});
  const bridge=createBridge(win.WorkBadgePreviewSurface);
  const before=await bridge.call('work_badges_snapshot');
  assert.equal(before.structuredContent.roles.length,5);assert.equal(before.structuredContent.roles[0].id,'max');assert.deepEqual(Array.from(before.structuredContent.bindings),[]);assert.equal(before.structuredContent.roles[0].name,'Alex');assert.equal(before.structuredContent.contexts[0].title,'示例聊天');
  assert.equal(attributes.get('data-theme'),'light');buttons.get('dark').handlers.get('click')();assert.equal(attributes.get('data-theme'),'dark');assert.equal(buttons.get('dark').attributes.get('aria-pressed'),'true');
  buttons.get('light').handlers.get('click')();assert.equal(attributes.get('data-theme'),'light');
  for(const name of ['work_badges_save','work_badges_enable','work_badges_bind','work_badges_unbind']){
    await assert.rejects(bridge.call(name),/不会写入资料库/);
  }
  bridge.close();
  const reconnected=createBridge(win.WorkBadgePreviewSurface);
  const after=await reconnected.call('work_badges_snapshot');
  assert.deepEqual(after.structuredContent.roles,before.structuredContent.roles);
  assert.deepEqual(after.structuredContent.bindings,before.structuredContent.bindings);
  reconnected.close();
});
await check('standalone avatar fixtures dispatch by the exact original image and never reuse another role material',async()=>{
  const sample={profiles:[{id:'max',name:'Max',imageId:'new-max-sha',duties:[]},{id:'milo',name:'Milo',imageId:'milo-sha',duties:[]}],miloSourceId:'milo-sha',avatarDataUrl:'milo-original',foregroundDataUrl:'milo-foreground',contourDataUrl:'milo-contour',holoAssets:{character:'milo-character'},avatars:{'new-max-sha':{avatarDataUrl:'max-original',foregroundDataUrl:'max-foreground',holoAssets:{character:'max-character'}}}};
  const win={setTimeout,clearTimeout,document:{getElementById(){return null;}}};
  Object.defineProperty(win,'parent',{get(){throw new Error('Preview read its external parent');}});
  const fixture=readFileSync(new URL('../plugins/work-badges/ui/preview-fixture.js',import.meta.url),'utf8').replace('/* __PREVIEW_SAMPLE_DATA__ */ null',JSON.stringify(sample));
  vm.runInNewContext(fixture,{window:win,structuredClone,queueMicrotask,Date});
  const bridge=createBridge(win.WorkBadgePreviewSurface);
  const max=await bridge.call('work_badges_avatar',{imageId:'new-max-sha'});
  assert.equal(max.structuredContent.imageId,'new-max-sha');assert.equal(max._meta.avatarDataUrl,'max-original');assert.equal(max._meta.holoAssets.character,'max-character');assert.equal(max._meta.contourDataUrl,undefined);
  const milo=await bridge.call('work_badges_avatar',{imageId:'milo-sha'});
  assert.equal(milo._meta.avatarDataUrl,'milo-original');assert.equal(milo._meta.holoAssets.character,'milo-character');assert.equal(milo._meta.contourDataUrl,'milo-contour');
  for(const imageId of ['different-max-avatar','unknown','toString','__proto__'])await assert.rejects(bridge.call('work_badges_avatar',{imageId}),/示例头像不存在/);
  bridge.close();
});
await check('ordinary preview photos fill the image region without changing aligned cutout geometry',()=>{
  const template=readFileSync(new URL('../plugins/work-badges/ui/manager.template.html',import.meta.url),'utf8');
  const declarations=selector=>{
    const rule=template.split(selector+'{')[1]?.split('}')[0];assert.ok(rule,selector);
    return Object.fromEntries(rule.split(';').filter(Boolean).map(value=>value.split(':')));
  };
  const ordinary=declarations('.badge:not([data-layered]) .badge-photo>img');
  assert.equal(ordinary.width,'100%');assert.equal(ordinary.height,'100%');assert.equal(ordinary['object-fit'],'cover');assert.equal(ordinary['object-position'],'center top');assert.equal(ordinary.transform,'none');
  const layered=declarations('.badge-photo>img');assert.equal(layered.height,'calc(100% - 30px)');assert.equal(layered['object-fit'],'contain');assert.match(layered.transform,/--fg-x/);
  const brand=declarations('.badge-brand-avatar');assert.equal(brand.width,'21px');assert.equal(brand.height,'21px');assert.equal(brand['object-fit'],'contain');
});
await check('static themes keep readable text, visible input edges and independent badge colors',()=>{
  const template=readFileSync(new URL('../plugins/work-badges/ui/manager.template.html',import.meta.url),'utf8');
  const declarations=selector=>{
    const escaped=selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const match=template.match(new RegExp(escaped+'\\s*\\{([^}]+)\\}'));assert.ok(match,selector);
    return Object.fromEntries([...match[1].matchAll(/(--[\w-]+):\s*(#[\da-f]{6})/gi)].map(row=>[row[1],row[2]]));
  };
  const luminance=hex=>{
    const channels=hex.slice(1).match(/../g).map(value=>parseInt(value,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);
    return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;
  };
  const contrast=(a,b)=>{const values=[luminance(a),luminance(b)].sort((x,y)=>x-y);return (values[1]+.05)/(values[0]+.05);};
  for(const selector of [':root',':root[data-theme=dark]']){
    const tokens=declarations(selector);
    for(const bg of ['--app-bg','--surface','--surface-subtle','--rail'])for(const text of ['--text','--muted'])assert.ok(contrast(tokens[text],tokens[bg])>=4.5,`${selector} ${text}/${bg}`);
    assert.ok(contrast(tokens['--control-border'],tokens['--surface'])>=3,`${selector} input edge`);
    assert.ok(contrast(tokens['--accent'],tokens['--accent-soft'])>=4.5,`${selector} selected role`);
  }
  assert.match(template,/body\{[^}]*background:var\(--app-bg\)[^}]*color:var\(--text\)/);
  assert.match(template,/\.badge\{[^}]*--badge-paper:#f4f0e5/);
  assert.match(template,/\.badge-face\{[^}]*background:var\(--badge-paper\)[^}]*color:var\(--badge-ink\)/);
  assert.doesNotMatch(template,/\.role-list\{[^}]*overflow-x:auto/);
});
console.log(`${count} manager contracts passed`);
