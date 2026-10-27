/* Offline public-API/gesture checks, using a small DOM model rather than a browser.
 * This verifies controller behavior and a few explicitly static CSS contracts,
 * not CSS rendering, geometric scroll overflow, image decoding, or native
 * Enter/Space button activation. No network, app, CDP, browser, or port is used.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL(process.env.BADGE_TEST_TEMPLATE?'../runtime/renderer.template.js':'../runtime/renderer.js',import.meta.url),'utf8')
  .replace('/* __HOLO_ENGINE__ */',readFileSync(new URL('../runtime/holo-engine.js',import.meta.url),'utf8'));
let checks=0;
function check(name,fn){fn();checks++;process.stdout.write(`ok ${checks} - ${name}\n`);}

function environment(options={}){
  const mutationObservers=[],resizeObservers=[],frames=new Map();let nextFrame=1,frameTime=0;
  let document;const fontLoads=[],fonts=new Set(),events=[];
  class Target{
    constructor(){this.listeners=new Map();}
    addEventListener(type,fn,options={}){
      if(options.signal?.aborted)return;
      const entries=this.listeners.get(type)||new Set();entries.add(fn);this.listeners.set(type,entries);
      options.signal?.addEventListener('abort',()=>entries.delete(fn),{once:true});
    }
    removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
    dispatchEvent(event){
      if(!event.target)event.target=this;event.currentTarget=this;
      if(!event.path){event.path=[];for(let node=this;node;node=node.parentNode||node.host)event.path.push(node);}
      event.preventDefault??=function(){this.defaultPrevented=true;};
      event.stopPropagation??=function(){this.stopped=true;};
      for(const listener of [...(this.listeners.get(event.type)||[])])listener(event);
      const parent=event.path[event.path.indexOf(this)+1];
      if(!event.stopped&&event.bubbles&&parent)parent.dispatchEvent(event);
      return !event.defaultPrevented;
    }
    listenerCount(){return [...this.listeners.values()].reduce((sum,value)=>sum+value.size,0);}
  }
  function notify(target,record){
    for(const observer of [...mutationObservers])if(observer.watches.some(watch=>watch.target===target||(watch.options.subtree&&watch.target.contains(target))))observer.callback([record]);
  }
  class Element extends Target{
    constructor(tag){super();this.nodeName=tag.toUpperCase();this.children=[];this.parentNode=null;this.attributes=new Map();this.style={setProperty(name,value){this[name]=value;},removeProperty(name){delete this[name];}};this.className='';this.hidden=false;this.disabled=false;this._text='';this.complete=false;this.naturalWidth=100;this.captures=new Set();}
    get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
    set textContent(value){const old=[...this.children];for(const child of old)child.parentNode=null;this.children=[];this._text=String(value);notify(this,{type:'childList',addedNodes:[],removedNodes:old});}
    append(...nodes){for(let child of nodes){if(typeof child==='string'){const text=new Element('#text');text.textContent=child;child=text;}child.remove();this.children.push(child);child.parentNode=this;notify(this,{type:'childList',addedNodes:[child],removedNodes:[]});}}
    replaceChildren(...nodes){const old=[...this.children];for(const child of old)child.parentNode=null;this.children=[];this._text='';notify(this,{type:'childList',addedNodes:[],removedNodes:old});this.append(...nodes);}
    remove(){if(!this.parentNode)return;const parent=this.parentNode;parent.children=parent.children.filter(child=>child!==this);this.parentNode=null;notify(parent,{type:'childList',addedNodes:[],removedNodes:[this]});}
    contains(other){for(let node=other;node;node=node.parentNode)if(node===this)return true;return false;}
    get isConnected(){for(let node=this;node;node=node.parentNode||node.host)if(node===document)return true;return false;}
    attachShadow(){this.shadowRoot=new Element('#shadow-root');this.shadowRoot.host=this;this.shadowRoot.activeElement=null;return this.shadowRoot;}
    setAttribute(name,value){this.attributes.set(name,String(value));}
    getAttribute(name){return this.attributes.get(name)??null;}
    removeAttribute(name){this.attributes.delete(name);}
    toggleAttribute(name,value){const present=value===undefined?!this.attributes.has(name):Boolean(value);if(present)this.setAttribute(name,'');else this.removeAttribute(name);return present;}
    querySelectorAll(selector){const result=[];const matches=element=>selector.startsWith('.')?element.className.split(' ').includes(selector.slice(1)):element.nodeName===selector.toUpperCase();function visit(element){for(const child of element.children){if(matches(child))result.push(child);visit(child);}}visit(this);return result;}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    focus(){let root=this;while(root.parentNode)root=root.parentNode;if(root.host){root.activeElement=this;document.activeElement=root.host;}else document.activeElement=this;}
    setPointerCapture(id){this.captures.add(id);}
    hasPointerCapture(id){return this.captures.has(id);}
    releasePointerCapture(id){this.captures.delete(id);}
    getBoundingClientRect(){const width=parseFloat(this.style.width)||266,height=this.className==='panel'?400:372,left=parseFloat(this.style.left)||100,top=parseFloat(this.style.top)||100;return {width,height,left,top,right:left+width,bottom:top+height};}
  }
  document=new Element('#document');document.fonts=fonts;
  document.documentElement=new Element('html');document.head=new Element('head');document.body=new Element('body');
  document.append(document.documentElement);document.documentElement.append(document.head,document.body);
  const title=new Element('title');title.textContent='Guide';document.head.append(title);
  Object.defineProperty(document,'title',{get(){return document.head.querySelector('title')?.textContent||'';},set(value){document.head.querySelector('title').textContent=value;}});
  document.createElement=tag=>{const element=new Element(tag);if(tag==='canvas'&&options.materialFactory)element.getContext=()=>({});return element;};document.createElementNS=(_namespace,tag)=>new Element(tag);
  const window=new Target();window.innerWidth=1200;window.innerHeight=900;window.visualViewport=null;
  const baseDispatch=window.dispatchEvent.bind(window);window.dispatchEvent=event=>{events.push(event);return baseDispatch(event);};
  const motion=new Target();motion.matches=false;
  class MutationObserver{constructor(callback){this.callback=callback;this.watches=[];mutationObservers.push(this);}observe(target,options){this.watches.push({target,options});}disconnect(){this.watches=[];}}
  class ResizeObserver{constructor(callback){this.callback=callback;this.targets=new Set();resizeObservers.push(this);}observe(target){this.targets.add(target);}disconnect(){this.targets.clear();}}
  class FontFace{constructor(name,data){this.family=name;this.data=data;}load(){fontLoads.push(this);return Promise.resolve(this);}}
  class CustomEvent{constructor(type,options={}){this.type=type;Object.assign(this,options);}}
  const sandbox={window,document,MutationObserver,ResizeObserver,FontFace,CustomEvent,AbortController,console,__badgeMaterialFactory:options.materialFactory,__sidebarFactory:options.sidebarFactory,
    matchMedia:()=>motion,requestAnimationFrame:fn=>{const id=nextFrame++;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id),
    getComputedStyle:element=>({position:element.style.position||(element.className.split(' ').some(value=>value==='panel'||value==='face')?'absolute':element.className.split(' ').includes('flip-surface')?'relative':'static'),pointerEvents:element.style.pointerEvents||'auto'})};
  const script=options.script??source;
  const context=vm.createContext(sandbox);vm.runInContext(options.materialFactory?script.replace(readFileSync(new URL('../runtime/holo-engine.js',import.meta.url),'utf8'),'const createBadgeHoloRenderer=__badgeMaterialFactory;'):script,context,{filename:'renderer.js'});
  function stepFrames(count=1){for(let round=0;round<count&&frames.size;round++){frameTime+=1000/60;const pending=[...frames];frames.clear();for(const [,fn]of pending)fn(frameTime);}}
  function flushFrames(){stepFrames(180);assert.equal(frames.size,0,'animation queue settles within three seconds');}
  return {window,document,context,api:window.MaiWorkBadgeRuntime,frames,motion,mutationObservers,resizeObservers,fontLoads,fonts,events,flushFrames,stepFrames,
    layer:()=>document.body.children[0],root:()=>document.body.children[0]?.shadowRoot};
}
function profile(name='Guide'){return {id:name.toLowerCase(),name,chineseName:name==='Guide'?'向导':'',role:'示例职责',bio:'把每件小事认真做完。',serial:`${name.toUpperCase()} · 001`,duties:[['查待办','核对发布单和素材。']],approval:'经你确认后再发。',enabled:true,imageId:null};}
function input(name='Guide',contextKey='conversation:a',extra={}){return {role:profile(name),avatarDataUrl:'',layout:{x:500,y:180,width:266},cardState:{flipped:false,collapsed:false},contextKey,...extra};}
function event(target,type,options={}){const value={type,bubbles:true,...options};target.dispatchEvent(value);return value;}
function active(root,selector){return root.querySelectorAll(selector).find(element=>!element.disabled)||null;}

check('loading and configure create no DOM, listeners, fonts, or storage writes',()=>{
  const env=environment();assert.equal(env.api.brand,'mai-work-badges/2');assert.equal(env.api.version,2);
  env.api.configure({fontDataUrl:'data:font/ttf;base64,QUJDRA=='});
  assert.equal(env.document.body.children.length,0);assert.equal(env.window.listenerCount(),0);assert.equal(env.mutationObservers.length,0);assert.equal(env.fontLoads.length,0);
  assert.throws(()=>env.api.configure({fontDataUrl:'https://example.com/font.ttf'}),/invalid-font/);
});
check('one overlay, cream-card data, and unchanged show preserve DOM and focus',()=>{
  const env=environment();assert.equal(env.api.show(input()).mounted,true);env.flushFrames();
  const layer=env.layer(),front=env.root().querySelector('.front');front.focus();
  env.api.show(input());assert.equal(env.layer(),layer);assert.equal(env.root().activeElement,front);assert.equal(env.document.body.children.length,1);
  assert.match(env.root().textContent,/Guide/);assert.match(front.getAttribute('aria-describedby'),/work-badge-bio/);
  assert.ok(env.mutationObservers.flatMap(observer=>observer.watches).every(watch=>['TITLE','HEAD'].includes(watch.target.nodeName)));
});
check('Maker, MakerPlus, MakerAlt are distinct explicit profiles and empty avatars never reuse Guide',()=>{
  const env=environment();env.api.show(input());
  for(const name of ['Maker','MakerPlus','MakerAlt']){env.api.show(input(name,`conversation:${name}`));assert.equal(env.api.status().roleId,name.toLowerCase());assert.equal(env.root().querySelector('.english').textContent,name);assert.equal(env.root().querySelectorAll('.portrait').length,0);assert.equal(env.root().querySelector('.initial').textContent,'M');assert.doesNotMatch(env.root().textContent,/Guide/);assert.equal(env.document.body.children.length,1);}
});
check('unknown/disabled contexts clear old identity while retaining own layout',()=>{
  const env=environment();env.api.show(input());const before=env.api.status().layout;
  env.api.hide({contextKey:'conversation:unknown',reason:'unbound'});assert.equal(env.api.status().mounted,false);assert.equal(env.api.status().roleId,'guide');assert.equal(env.document.body.children.length,0);assert.deepEqual(env.api.status().layout,before);
  env.api.show(input('Maker','conversation:maker',{role:{...profile('Maker'),enabled:false}}));assert.equal(env.api.status().mounted,false);assert.equal(env.api.status().roleId,'maker');
});
check('title text changes hide immediately, mark stale, and require an explicit show',()=>{
  const env=environment();env.api.show(input());env.document.title='MakerPlus（资深分析师）';
  const state=env.api.status();assert.equal(state.mounted,false);assert.equal(state.roleId,'guide');assert.equal(state.stale,true);assert.equal(state.contextKey,'conversation:a');
  assert.ok(env.events.some(value=>value.type==='mai-work-badges-context-stale'));
  env.api.show(input('MakerPlus','conversation:analysis'));assert.equal(env.api.status().stale,false);assert.equal(env.api.status().roleId,'makerplus');
});
check('title replacement and navigation events also clear the prior identity',()=>{
  const env=environment();env.api.show(input());const replacement=env.document.createElement('title');replacement.textContent='MakerAlt';env.document.head.replaceChildren(replacement);assert.equal(env.api.status().stale,true);assert.equal(env.api.status().mounted,false);
  env.api.show(input('MakerAlt','conversation:design'));event(env.window,'popstate');assert.equal(env.api.status().stale,true);assert.equal(env.api.status().mounted,false);
  env.api.show(input());event(env.window,'hashchange');assert.equal(env.api.status().mounted,false);
});
check('front/back, Escape, collapse/expand update state immediately and transfer focus',()=>{
  const env=environment();env.api.show(input());event(env.root().querySelector('.front'),'click');assert.equal(env.api.status().cardState.flipped,true);assert.equal(env.root().activeElement,env.root().querySelector('.back'));
  event(env.root().querySelector('.shell'),'keydown',{key:'Escape'});assert.equal(env.api.status().cardState.flipped,false);
  event(active(env.root(),'.collapse'),'click');assert.equal(env.api.status().cardState.collapsed,true);assert.equal(env.root().activeElement,env.root().querySelector('.mini'));
  event(env.root().querySelector('.mini'),'click');assert.equal(env.api.status().cardState.collapsed,false);assert.equal(env.root().activeElement,env.root().querySelector('.front'));
});
check('each full-card face owns its header without nested buttons, and only active controls operate',()=>{
  const env=environment();env.api.show(input());const root=env.root(),frontFace=root.querySelector('.front-face'),backFace=root.querySelector('.back-face'),compact=root.querySelector('.compact-header');
  const frontHeader=frontFace.querySelector('.card-header'),backHeader=backFace.querySelector('.card-header');
  assert.equal(root.querySelector('.bar'),null);assert.equal(root.querySelectorAll('.card-header').length,3);
  assert.equal(frontHeader.parentNode,frontFace);assert.equal(backHeader.parentNode,backFace);assert.equal(frontFace.parentNode,root.querySelector('.rotator'));assert.equal(backFace.parentNode,root.querySelector('.rotator'));
  for(const button of root.querySelectorAll('button'))for(let parent=button.parentNode;parent&&parent!==root;parent=parent.parentNode)assert.notEqual(parent.nodeName,'BUTTON','header controls cannot be nested inside flip buttons');
  assert.equal(frontFace.inert,false);assert.equal(backFace.inert,true);assert.equal(compact.hidden,true);assert.equal(compact.inert,true);
  assert.equal(frontHeader.children.at(-1),frontHeader.querySelector('.close'));assert.match(frontHeader.querySelector('.drag').textContent,/MaiBadges/);
  event(backHeader.querySelector('.close'),'click');event(backHeader.querySelector('.collapse'),'click');assert.equal(env.api.status().mounted,true);assert.equal(env.api.status().cardState.collapsed,false);
  event(root.querySelector('.front'),'click');assert.equal(env.api.status().cardState.flipped,true);assert.equal(frontFace.inert,true);assert.equal(backFace.inert,false);assert.equal(frontFace.getAttribute('aria-hidden'),'true');assert.equal(backFace.getAttribute('aria-hidden'),'false');
  assert.equal(frontHeader.querySelector('.close').disabled,true);assert.equal(backHeader.querySelector('.close').disabled,false);assert.equal(root.querySelectorAll('.close').filter(button=>!button.disabled).length,1);
  event(frontHeader.querySelector('.close'),'click');event(frontHeader.querySelector('.collapse'),'click');event(root.querySelector('.front'),'click');assert.equal(env.api.status().mounted,true);assert.equal(env.api.status().cardState.collapsed,false);assert.equal(env.api.status().cardState.flipped,true);
  const key=event(backHeader.querySelector('.drag'),'keydown',{key:'ArrowDown'});assert.equal(key.defaultPrevented,true);assert.equal(env.api.status().layout.y,184);
  event(backHeader.querySelector('.collapse'),'click');assert.equal(env.api.status().cardState.collapsed,true);assert.equal(root.querySelector('.stage').hidden,true);assert.equal(compact.hidden,false);assert.equal(compact.inert,false);assert.equal(frontFace.inert,true);assert.equal(backFace.inert,true);assert.equal(root.activeElement,compact.querySelector('.mini'));
  assert.equal(root.querySelectorAll('.close').filter(button=>!button.disabled).length,1);assert.equal(active(root,'.close'),compact.querySelector('.close'));
  event(active(root,'.drag'),'keydown',{key:'ArrowDown'});assert.equal(env.api.status().layout.y,188);
  event(compact.querySelector('.mini'),'click');assert.equal(env.api.status().cardState.collapsed,false);assert.equal(env.api.status().cardState.flipped,true);assert.equal(root.activeElement,root.querySelector('.back'));assert.equal(compact.hidden,true);assert.equal(backFace.inert,false);
});
check('drag uses one pointer, survives cancellation, and never flips the card',()=>{
  const env=environment();env.api.show(input());env.flushFrames();const handle=env.root().querySelector('.drag');
  event(handle,'pointerdown',{button:0,pointerId:1,clientX:10,clientY:10});event(handle,'pointerdown',{button:0,pointerId:2,clientX:600,clientY:600});
  event(handle,'pointermove',{pointerId:2,clientX:700,clientY:700});assert.equal(env.api.status().layout.x,500);
  event(handle,'pointermove',{pointerId:1,clientX:50,clientY:30});assert.equal(env.api.status().layout.x,540);assert.equal(env.api.status().layout.y,200);assert.equal(env.api.status().cardState.flipped,false);
  event(handle,'pointerup',{pointerId:1});const click=event(handle,'click');assert.equal(click.defaultPrevented,true);assert.equal(env.api.status().cardState.flipped,false);assert.equal(handle.captures.size,0);assert.equal(handle.getAttribute('data-dragging'),null);
  event(handle,'pointerdown',{button:0,pointerId:3,clientX:50,clientY:30});event(env.window,'blur');assert.equal(handle.captures.size,0);env.flushFrames();
});
check('keyboard movement is immediate, bounded, and prevents host scrolling',()=>{
  const env=environment();env.api.show(input());const handle=env.root().querySelector('.drag');
  const key=event(handle,'keydown',{key:'ArrowRight',shiftKey:true});assert.equal(env.api.status().layout.x,520);assert.equal(key.defaultPrevented,true);assert.equal(key.stopped,true);
  for(let step=0;step<100;step++)event(handle,'keydown',{key:'ArrowLeft',shiftKey:true});assert.equal(env.api.status().layout.x,12);env.flushFrames();
});
check('dismissal stays with one context and does not uninstall the controller',()=>{
  const env=environment();let hostClicks=0;env.document.body.addEventListener('click',()=>hostClicks++);env.api.show(input());event(active(env.root(),'.close'),'click');assert.equal(hostClicks,0);assert.equal(env.api.status().dismissed,true);assert.equal(env.api.status().mounted,false);assert.ok(env.window.MaiWorkBadgeRuntime);
  assert.equal(env.api.show(input()).mounted,false);env.api.show(input('Maker','conversation:b'));assert.equal(env.api.status().mounted,true);assert.equal(env.api.status().dismissed,false);
  assert.equal(env.api.show(input()).mounted,false);assert.equal(env.api.status().dismissed,true);
  env.api.show(input('MakerPlus','conversation:a'));assert.equal(env.api.status().mounted,true);assert.equal(env.api.status().dismissed,false);assert.equal(env.api.status().roleId,'makerplus');
  assert.equal(env.api.show(input()).mounted,false);assert.equal(env.api.status().roleId,'guide');assert.equal(env.api.status().dismissed,true);
});
check('close offers an original-position restore without changing layout, face, or binding identity',()=>{
  const env=environment();let hostClicks=0;env.document.body.addEventListener('click',()=>hostClicks++);env.api.show(input('Guide','conversation:a',{cardState:{flipped:true,collapsed:false}}));env.flushFrames();
  const before=env.api.status();event(active(env.root(),'.close'),'click');const closed=env.api.status();
  assert.equal(closed.mounted,false);assert.equal(closed.restorable,true);assert.equal(closed.dismissed,true);assert.equal(env.document.body.children.length,1);assert.equal(env.root().querySelector('.front'),null);assert.equal(env.root().querySelector('.restore').textContent,'显示工牌');
  assert.equal(env.root().querySelector('.recovery').style.left,before.layout.x+'px');assert.equal(env.root().querySelector('.recovery').style.top,before.layout.y+'px');assert.equal(env.root().activeElement,env.root().querySelector('.restore'));
  event(env.root().querySelector('.restore'),'click');const opened=env.api.status();assert.equal(opened.mounted,true);assert.equal(opened.restorable,false);assert.equal(opened.dismissed,false);assert.equal(opened.contextKey,before.contextKey);assert.equal(opened.roleId,before.roleId);assert.deepEqual(opened.layout,before.layout);assert.deepEqual(opened.cardState,before.cardState);assert.equal(env.root().activeElement,env.root().querySelector('.back'));assert.equal(hostClicks,0);assert.equal(env.document.body.children.length,1);
  event(active(env.root(),'.collapse'),'click');event(active(env.root(),'.close'),'click');event(env.root().querySelector('.restore'),'click');assert.equal(env.api.status().cardState.collapsed,true);assert.equal(env.root().activeElement,env.root().querySelector('.mini'));
});
check('restore controls disappear on unbound, unknown, disabled, stale, invalid and replaced identities',()=>{
  const env=environment();
  for(const reason of ['unbound','unknown-context','stale']){env.api.show(input('Guide','conversation:'+reason));event(active(env.root(),'.close'),'click');assert.equal(env.api.status().restorable,true);env.api.hide({contextKey:'conversation:unknown',reason});assert.equal(env.api.status().mounted,false);assert.equal(env.api.status().restorable,false);assert.equal(env.document.body.children.length,0);assert.equal(env.api.restore().mounted,false);}
  env.api.show(input('Maker'));event(active(env.root(),'.close'),'click');env.api.show(input('Maker','conversation:a',{role:{...profile('Maker'),enabled:false}}));assert.equal(env.api.status().restorable,false);assert.equal(env.api.restore().mounted,false);assert.equal(env.document.body.children.length,0);
  env.api.show(input('MakerPlus'));event(active(env.root(),'.close'),'click');env.document.title='MakerAlt';assert.equal(env.api.status().restorable,false);assert.equal(env.api.status().stale,true);assert.equal(env.api.restore().mounted,false);assert.equal(env.document.body.children.length,0);
  env.api.show(input('MakerAlt','conversation:navigation'));event(active(env.root(),'.close'),'click');event(env.window,'popstate');assert.equal(env.api.status().restorable,false);assert.equal(env.api.restore().mounted,false);
  env.api.show(input('MakerAlt','conversation:invalid'));event(active(env.root(),'.close'),'click');env.api.show(input('Maker','conversation:bad',{role:{id:'bad'}}));assert.equal(env.api.status().failed,true);assert.equal(env.api.status().restorable,false);assert.equal(env.api.restore().mounted,false);
  env.api.show(input('Guide','conversation:unbound'));assert.equal(env.api.status().restorable,true);const oldRestore=env.root().querySelector('.restore');env.api.show(input('MakerPlus','conversation:b'));event(oldRestore,'click');assert.equal(env.api.status().restorable,false);assert.equal(env.api.status().roleId,'makerplus');assert.equal(env.document.body.children.length,1);assert.equal(env.root().querySelector('.restore'),null);
  event(active(env.root(),'.close'),'click');env.api.hide({reason:'unknown-context'});assert.equal(env.api.status().restorable,false);assert.equal(env.api.restore().mounted,false);assert.equal(env.document.body.children.length,0);
});
check('an explicit update refreshes a dismissed profile without opening or resurrecting it',()=>{
  const env=environment();env.api.show(input());event(active(env.root(),'.close'),'click');
  const changed={...profile(),name:'Guide 新名',bio:'更新后的职责说明',duties:[['新职责','采用最新资料。']]};
  env.api.show(input('Guide','conversation:a',{role:changed}));assert.equal(env.api.status().dismissed,true);assert.equal(env.api.status().mounted,false);assert.equal(env.api.status().restorable,true);assert.doesNotMatch(env.root().querySelector('.restore').textContent,/Guide/);
  event(env.root().querySelector('.restore'),'click');assert.equal(env.root().querySelector('.english').textContent,'Guide 新名');assert.match(env.root().querySelector('.bio').textContent,/更新后的/);assert.match(env.root().querySelector('.duties').textContent,/采用最新资料/);
});
check('restoring clears only the current context-role dismissal and uninstall clears recovery ownership',()=>{
  const env=environment();env.api.show(input());event(active(env.root(),'.close'),'click');env.api.show(input('Maker','conversation:b'));event(active(env.root(),'.close'),'click');
  env.api.restore();assert.equal(env.api.status().roleId,'maker');assert.equal(env.api.status().dismissed,false);env.api.show(input());assert.equal(env.api.status().dismissed,true);assert.equal(env.api.status().restorable,true);
  const staleButton=env.root().querySelector('.restore');env.api.uninstall();assert.equal(env.document.body.children.length,0);assert.equal(env.frames.size,0);assert.equal(env.window.listenerCount(),0);assert.equal(env.api.status().restorable,false);assert.equal(env.window.MaiWorkBadgeRuntime,undefined);event(staleButton,'click');assert.equal(env.document.body.children.length,0);assert.throws(()=>env.api.restore(),/uninstalled/);
});
check('an old avatar cannot fail a newer role, while current async failures are fatal',()=>{
  const env=environment(),avatar='data:image/png;base64,QUJDRA==';env.api.show(input('Guide','conversation:a',{avatarDataUrl:avatar}));const old=env.root().querySelector('.portrait');
  env.api.show(input('MakerPlus','conversation:b',{avatarDataUrl:avatar}));event(old,'error');assert.equal(env.api.status().failed,false);assert.equal(env.api.status().roleId,'makerplus');
  event(env.root().querySelector('.portrait'),'error');assert.equal(env.api.status().failed,true);assert.equal(env.api.status().error,'portrait-load-failed');assert.equal(env.api.status().mounted,false);
});
check('external removal is detected through own reference and can be shown again',()=>{
  const env=environment();env.api.show(input());env.layer().remove();assert.equal(env.api.status().mounted,false);assert.equal(env.api.status().failed,false);assert.equal(env.api.show(input()).mounted,true);
});
check('layout whitelist clamps narrow viewports and tiny viewport controls fail safely',()=>{
  const env=environment();env.window.innerWidth=252;env.window.innerHeight=320;
  env.api.show(input('Guide','conversation:a',{layout:{x:99999,y:99999,width:320,chat:'unused'}}));
  const state=env.api.status();assert.equal(state.layout.width,228);assert.equal(state.layout.x,12);assert.equal(state.layout.y,12);assert.equal(state.layout.chat,undefined);
  env.window.innerHeight=80;event(env.root().querySelector('.front'),'click');assert.equal(env.api.status().failed,true);assert.equal(env.api.status().error,'viewport-too-small');assert.equal(env.document.body.children.length,0);
});
check('static CSS contract: panel is not a scroller; only bounded card content scrolls vertically',()=>{
  const rule=selector=>{const escaped=selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const match=source.match(new RegExp('(?:^|[}\\n])\\s*'+escaped+'\\{([^}]*)\\}'));assert.ok(match,`CSS rule ${selector}`);return match[1];};
  const panel=rule('.panel'),stage=rule('.stage'),body=rule('.body'),content=rule('.body,.back-content');
  assert.match(panel,/(?:^|;)overflow:visible(?:;|$)/);assert.doesNotMatch(panel,/overflow(?:-[xy])?:(?:auto|scroll)/);
  assert.match(stage,/aspect-ratio:266\/372/);assert.match(stage,/max-height:var\(--available-height,/);assert.match(stage,/transform:rotateX\(var\(--rx,0deg\)\) rotateY\(var\(--ry,0deg\)\)/);
  assert.match(body,/min-height:0/);assert.match(content,/overflow-x:hidden/);assert.match(content,/overflow-y:auto/);assert.match(content,/scrollbar-width:thin/);
  assert.match(rule('.body>*'),/flex-shrink:0/);assert.match(rule('.back-content'),/height:100%/);assert.match(rule('.duties'),/flex:none/);
  assert.match(rule('.card-header'),/position:relative/);assert.doesNotMatch(rule('.card-header'),/position:(?:sticky|fixed)|margin-bottom:-/);
  assert.match(rule('.face'),/backface-visibility:hidden/);assert.match(rule('.flip-surface'),/min-height:0/);
  assert.match(rule('.back-face'),/transform:rotateY\(180deg\)/);
  assert.match(source,/@media\(prefers-reduced-motion:reduce\)\{\.stage,\.rotator,\.back-face\{transform:none!important;transition:none!important\}/);
  assert.match(source,/\.face\[aria-hidden=true\]\{visibility:hidden\}/);
  assert.match(rule('.shell[data-back] .rotator'),/transform:rotateY\(180deg\)/);
  assert.doesNotMatch(source,/scrollbar-width:none|::-webkit-scrollbar\s*\{[^}]*display:none/);
});
check('bounded whole-card hover uses stationary geometry and remains separate from flip and layout',()=>{
  const env=environment();env.api.show(input());env.flushFrames();const root=env.root(),stage=root.querySelector('.stage'),shell=root.querySelector('.shell'),before=env.api.status().layout;
  assert.equal(env.layer().style.overflow,'clip','the viewport overlay cannot enlarge the host scroll area');
  stage.getBoundingClientRect=()=>{throw new Error('transformed geometry must not drive tilt');};
  event(shell,'pointermove',{pointerType:'mouse',clientX:110,clientY:115});env.flushFrames();
  assert.equal(shell.getAttribute('data-hover'),'');assert.ok(stage.style['--px']);assert.ok(stage.style['--py']);
  assert.ok(Math.abs(parseFloat(stage.style['--rx']))<=14);assert.ok(Math.abs(parseFloat(stage.style['--ry']))<=18);assert.notEqual(parseFloat(stage.style['--rx']),0);assert.notEqual(parseFloat(stage.style['--ry']),0);assert.equal(stage.style.transform,undefined);assert.deepEqual(env.api.status().layout,before);
  event(shell,'pointermove',{pointerType:'mouse',clientX:366,clientY:100});env.flushFrames();assert.equal(stage.style['--rx'],'14deg');assert.equal(stage.style['--ry'],'18deg');
  event(shell,'pointerleave');assert.ok(env.frames.size>0,'leaving schedules a material return');env.stepFrames();assert.ok(Math.abs(parseFloat(stage.style['--rx']))>0,'the card does not snap to neutral');env.flushFrames();assert.equal(shell.getAttribute('data-hover'),null);for(const prop of ['--rx','--ry','--px','--py','--fg-x','--fg-y','--bg-x','--bg-y','--foil-angle','--foil-shift','--holo-color','--view-x','--view-y'])assert.equal(stage.style[prop],undefined);
  event(root.querySelector('.front'),'click');assert.equal(env.api.status().cardState.flipped,true);assert.equal(shell.getAttribute('data-back'),'');assert.deepEqual(env.api.status().layout,before);
  event(root.querySelector('.back-face').querySelector('.drag'),'pointermove',{pointerType:'mouse',clientX:200,clientY:200});env.flushFrames();assert.ok(stage.style['--rx']);assert.equal(shell.getAttribute('data-back'),'','tilt cannot replace the inner flip transform');
  event(active(root,'.drag'),'pointerdown',{button:0,pointerId:1,clientX:10,clientY:10});assert.equal(shell.getAttribute('data-hover'),null);assert.equal(stage.style['--rx'],undefined);
  event(shell,'pointermove',{pointerType:'mouse',clientX:210,clientY:200});assert.equal(env.frames.size,0,'drag suppresses hover');event(active(root,'.drag'),'pointercancel',{pointerId:1});env.flushFrames();
});
check('spring pointer follow is interruptible, settles without idle frames and preserves flip continuity',()=>{
  const env=environment();env.api.show(input());env.flushFrames();const root=env.root(),shell=root.querySelector('.shell'),stage=root.querySelector('.stage');
  event(shell,'pointermove',{pointerType:'mouse',clientX:366,clientY:100});env.stepFrames();
  const first=parseFloat(stage.style['--ry']);assert.ok(first>0&&first<18,'the first frame follows instead of teleporting');assert.equal(env.frames.size,1);
  event(shell,'pointermove',{pointerType:'mouse',clientX:100,clientY:472});assert.equal(env.frames.size,1,'retargeting reuses one spring');env.flushFrames();assert.equal(stage.style['--rx'],'-14deg');assert.equal(stage.style['--ry'],'-18deg');assert.equal(env.frames.size,0);
  event(root.querySelector('.front'),'click',{detail:1});assert.equal(env.api.status().cardState.flipped,true);assert.equal(stage.style['--rx'],'-14deg');
  event(shell,'pointerleave');env.stepFrames(3);assert.ok(Math.abs(parseFloat(stage.style['--ry']))<18);assert.ok(Math.abs(parseFloat(stage.style['--ry']))>0);env.flushFrames();assert.equal(stage.style['--ry'],undefined);assert.equal(env.frames.size,0);
});
check('body inspection rotates the card without moving it or triggering release-click flip',()=>{
  const env=environment();env.api.show(input());env.flushFrames();const root=env.root(),surface=root.querySelector('.front'),stage=root.querySelector('.stage'),before=env.api.status().layout;
  event(surface,'pointerdown',{pointerType:'mouse',button:0,pointerId:11,clientX:180,clientY:220});assert.equal(surface.captures.size,1);
  event(surface,'pointermove',{pointerType:'mouse',pointerId:99,clientX:600,clientY:100});assert.equal(surface.getAttribute('data-inspecting'),null,'another pointer cannot rotate the card');
  event(surface,'pointermove',{pointerType:'mouse',pointerId:11,clientX:184,clientY:223});assert.equal(surface.getAttribute('data-inspecting'),null,'small hand jitter is still a click');
  event(surface,'pointermove',{pointerType:'mouse',pointerId:11,clientX:600,clientY:100});env.flushFrames();assert.ok(parseFloat(stage.style['--rx'])>14&&parseFloat(stage.style['--rx'])<=22);assert.equal(stage.style['--ry'],'28deg');assert.equal(surface.getAttribute('data-inspecting'),'');assert.deepEqual(env.api.status().layout,before);
  event(surface,'pointerup',{pointerType:'mouse',pointerId:11,clientX:600,clientY:100});assert.equal(surface.captures.size,0);assert.equal(surface.getAttribute('data-inspecting'),null);
  const releaseClick=event(surface,'click',{detail:1});assert.equal(releaseClick.defaultPrevented,true);assert.equal(env.api.status().cardState.flipped,false);env.flushFrames();assert.equal(stage.style['--rx'],undefined);
  event(surface,'pointerdown',{pointerType:'mouse',button:0,pointerId:12,clientX:200,clientY:200});event(surface,'pointerup',{pointerType:'mouse',pointerId:12,clientX:200,clientY:200});event(surface,'click',{detail:1});assert.equal(env.api.status().cardState.flipped,true,'the next intentional click is not swallowed');
  const back=root.querySelector('.back');event(back,'pointerdown',{pointerType:'mouse',button:0,pointerId:13,clientX:200,clientY:200});event(back,'pointermove',{pointerType:'mouse',pointerId:13,clientX:250,clientY:200});event(back,'pointercancel',{pointerType:'mouse',pointerId:13});assert.equal(back.captures.size,0);env.flushFrames();assert.equal(env.frames.size,0);
});
check('blur, hidden-page and reduced-motion changes release body inspection and cancel all material frames',()=>{
  for(const reason of ['blur','hidden','reduced']){
    const env=environment();env.api.show(input());env.flushFrames();const root=env.root(),surface=root.querySelector('.front'),stage=root.querySelector('.stage');
    event(surface,'pointerdown',{pointerType:'mouse',button:0,pointerId:1,clientX:180,clientY:220});event(surface,'pointermove',{pointerType:'mouse',pointerId:1,clientX:300,clientY:150});env.stepFrames();assert.equal(surface.captures.size,1);assert.equal(env.frames.size,1);
    if(reason==='blur')event(env.window,'blur');else if(reason==='hidden'){env.document.hidden=true;event(env.document,'visibilitychange');}else{env.motion.matches=true;event(env.motion,'change');}
    assert.equal(surface.captures.size,0,reason);assert.equal(stage.style['--rx'],undefined,reason);assert.equal(surface.getAttribute('data-inspecting'),null,reason);assert.equal(env.frames.size,0,reason);
  }
});
check('opaque portrait framing fills its photo while cutout coordinates and collapsed thumbnails stay separate',()=>{
  // Static source contract: the fake DOM does not implement object-fit. Browser
  // verification still checks the crop; these selectors prevent a wide photo
  // region reverting to the narrow contain fit or moving past its own edge.
  const template=readFileSync(new URL('../runtime/renderer.template.js',import.meta.url),'utf8');
  const declarations=selector=>{
    const rule=template.split(selector+'{')[1]?.split('}')[0];assert.ok(rule,selector);
    return Object.fromEntries(rule.split(';').filter(Boolean).map(value=>value.split(':')));
  };
  const portrait=declarations('.portrait');assert.equal(portrait['object-fit'],'contain');assert.equal(portrait.width,'auto');
  const full=declarations('.photo:not([data-layered]) .portrait');
  assert.equal(full.width,'100%');assert.equal(full.height,'100%');assert.equal(full['object-fit'],'cover');assert.equal(full['object-position'],'center top');
  assert.equal(declarations('.photo:not([data-layered]) .avatar').transform,'none');
  const mini=declarations('.mini-avatar .portrait');assert.equal(mini.width,'38px');assert.equal(mini.height,'40px');assert.equal(mini['object-fit'],'cover');
});
check('holographic layers keep scenery, aligned cutout and contour separate from readable identity',()=>{
  const env=environment(),avatar='data:image/png;base64,QUJDRA==',foreground='data:image/png;base64,RUZHSA==',contour='data:image/png;base64,SUprTA==';
  env.api.show(input('Guide','conversation:holo',{avatarDataUrl:avatar,foregroundDataUrl:foreground,contourDataUrl:contour}));env.flushFrames();
  const root=env.root(),photo=root.querySelector('.photo'),portrait=photo.querySelector('.portrait'),line=photo.querySelector('.contour');
  assert.equal(photo.getAttribute('data-layered'),'');assert.ok(photo.querySelector('.scene'));assert.equal(portrait.src,foreground);assert.equal(root.querySelector('.mini-avatar').querySelector('.portrait').src,avatar);
  assert.equal(line.parentNode,photo.querySelector('.avatar'));assert.equal(line.style['mask-image'],`url(${contour})`);assert.equal(line.style['-webkit-mask-image'],`url(${contour})`);
  assert.equal(photo.children.at(-1),photo.querySelector('.foil'));assert.equal(root.querySelector('.body').querySelector('.foil'),null);assert.equal(root.querySelector('.back-content').querySelector('.foil'),null);
  const css=root.querySelector('style').textContent;assert.match(css,/\.body\{position:relative;z-index:4;background:var\(--paper\)/);assert.match(css,/\.back-content\{position:relative;z-index:4;background:var\(--paper\)/);assert.match(css,/mask-mode:luminance/);assert.doesNotMatch(css,/drop-shadow|blur\(/);
  event(root.querySelector('.shell'),'pointermove',{pointerType:'mouse',clientX:350,clientY:120});env.flushFrames();
  const stage=root.querySelector('.stage');assert.ok(parseFloat(stage.style['--fg-x'])>0);assert.ok(parseFloat(stage.style['--bg-x'])<0);assert.ok(parseFloat(stage.style['--fg-y'])<0);assert.ok(parseFloat(stage.style['--bg-y'])>0);assert.ok(Math.abs(parseFloat(stage.style['--fg-x']))<6);assert.ok(Math.abs(parseFloat(stage.style['--bg-x']))<15);
  const rightColor=stage.style['--holo-color'],rightPhase=stage.style['--foil-shift'];assert.match(rightColor,/^rgb\(\d+ \d+ \d+\)$/);assert.match(stage.style['--foil-angle'],/deg$/);
  event(root.querySelector('.shell'),'pointermove',{pointerType:'mouse',clientX:110,clientY:450});env.flushFrames();assert.ok(parseFloat(stage.style['--fg-x'])<0);assert.ok(parseFloat(stage.style['--bg-x'])>0);assert.notEqual(stage.style['--holo-color'],rightColor);assert.notEqual(stage.style['--foil-shift'],rightPhase);assert.equal(env.frames.size,0,'material does not run an idle animation loop');
  const beforeFlip=stage.style['--rx'];event(root.querySelector('.front'),'click');assert.equal(stage.style['--rx'],beforeFlip,'flip preserves outer tilt continuity');assert.equal(root.querySelector('.front-face').getAttribute('aria-hidden'),'true');
  event(active(root,'.close'),'click');event(env.root().querySelector('.restore'),'click');assert.equal(env.root().querySelector('.photo').querySelector('.portrait').src,foreground);assert.equal(env.root().querySelector('.contour').style['mask-image'],`url(${contour})`);
});
check('complete avatars are never repeated as scenery and foreground assets refresh a mounted or dismissed card',()=>{
  const env=environment(),avatar='data:image/png;base64,QUJDRA==',foreground='data:image/png;base64,RUZHSA==';
  env.api.show(input('Guide','conversation:holo',{avatarDataUrl:avatar}));const old=env.layer();assert.equal(env.root().querySelector('.scene'),null);assert.equal(env.root().querySelector('.photo').querySelector('.portrait').src,avatar);
  env.api.show(input('Guide','conversation:holo',{avatarDataUrl:avatar,foregroundDataUrl:foreground}));assert.notEqual(env.layer(),old);assert.equal(env.root().querySelector('.photo').querySelector('.portrait').src,foreground);assert.ok(env.root().querySelector('.scene'));
  event(active(env.root(),'.close'),'click');env.api.show(input('Guide','conversation:holo',{avatarDataUrl:avatar,foregroundDataUrl:'data:image/png;base64,SUprTA=='}));assert.equal(env.api.status().dismissed,true);event(env.root().querySelector('.restore'),'click');assert.equal(env.root().querySelector('.photo').querySelector('.portrait').src,'data:image/png;base64,SUprTA==');
});
check('layer assets reject external, non-PNG, malformed, oversized and orphan contour inputs',()=>{
  const bad=['https://example.com/image.png','data:image/svg+xml;base64,QUJDRA==','data:image/jpeg;base64,QUJDRA==','data:image/png;base64,not base64!','data:image/png;base64,'+'A'.repeat(5*1024*1024)];
  for(const value of bad){const env=environment();env.api.show(input());const state=env.api.show(input('Guide','conversation:bad',{foregroundDataUrl:value}));assert.equal(state.failed,true);assert.equal(state.error,'invalid-foreground');assert.equal(state.mounted,false);assert.equal(env.document.body.children.length,0);}
  for(const value of bad){const env=environment();env.api.show(input());const state=env.api.show(input('Guide','conversation:bad',{foregroundDataUrl:'data:image/png;base64,QUJDRA==',contourDataUrl:value}));assert.equal(state.failed,true);assert.equal(state.error,'invalid-contour');assert.equal(state.mounted,false);}
  const env=environment();const state=env.api.show(input('Guide','conversation:bad',{contourDataUrl:'data:image/png;base64,QUJDRA=='}));assert.equal(state.error,'invalid-contour');assert.equal(state.mounted,false);
});
check('holographic hover is neutral under reduced motion, touch, drag, collapse, hide and uninstall',()=>{
  const env=environment();env.api.show(input());env.flushFrames();const shell=env.root().querySelector('.shell'),stage=env.root().querySelector('.stage');
  const hover=()=>event(shell,'pointermove',{pointerType:'mouse',clientX:300,clientY:200});
  event(shell,'pointermove',{pointerType:'touch',clientX:300,clientY:200});assert.equal(env.frames.size,0);assert.equal(stage.style['--holo-color'],undefined);
  hover();env.flushFrames();assert.ok(stage.style['--holo-color']);env.motion.matches=true;event(env.motion,'change');for(const prop of ['--rx','--ry','--fg-x','--fg-y','--bg-x','--bg-y','--foil-angle','--foil-shift','--holo-color'])assert.equal(stage.style[prop],undefined);hover();assert.equal(env.frames.size,0);event(shell,'pointerleave');assert.equal(env.frames.size,0,'reduced motion cannot start a return loop');
  env.motion.matches=false;hover();assert.equal(env.frames.size,1);event(active(env.root(),'.drag'),'pointerdown',{button:0,pointerId:1,clientX:0,clientY:0});assert.equal(env.frames.size,0);assert.equal(stage.style['--holo-color'],undefined);event(active(env.root(),'.drag'),'pointercancel',{pointerId:1});env.flushFrames();
  hover();event(active(env.root(),'.collapse'),'click');env.flushFrames();assert.equal(stage.style['--holo-color'],undefined);hover();assert.equal(env.frames.size,0);
  event(env.root().querySelector('.mini'),'click');env.flushFrames();hover();assert.equal(env.frames.size,1);env.api.hide();assert.equal(env.frames.size,0);
  env.api.show(input());env.flushFrames();event(env.root().querySelector('.shell'),'pointermove',{pointerType:'mouse',clientX:300,clientY:200});env.api.uninstall();assert.equal(env.frames.size,0);assert.equal(env.document.body.children.length,0);
});
check('short visual viewports constrain the stage without moving controls into the content scroller',()=>{
  const env=environment(),visual=env.motion;Object.assign(visual,{width:252,height:320,offsetLeft:0,offsetTop:20});env.window.visualViewport=visual;
  env.api.show(input('Guide','conversation:short',{layout:{x:999,y:999,width:320},role:{...profile(),duties:Array.from({length:30},(_,index)=>['职责 '+index,'完整保留的长说明。'.repeat(30)])}}));env.flushFrames();
  const root=env.root(),panel=root.querySelector('.panel'),header=root.querySelector('.card-header');
  assert.equal(panel.style['--available-height'],'296px');assert.equal(panel.style.maxHeight,'296px');assert.equal(root.querySelectorAll('.duty').length,30);assert.equal(header.parentNode,root.querySelector('.front-face'));assert.notEqual(header.parentNode,root.querySelector('.back-content'));
  visual.height=180;event(visual,'resize');env.flushFrames();assert.equal(panel.style['--available-height'],'156px');assert.equal(panel.style.maxHeight,'156px');
  event(root.querySelector('.front'),'click');event(active(root,'.collapse'),'click');assert.equal(env.api.status().cardState.collapsed,true);assert.equal(active(root,'.close').hidden,false);assert.equal(active(root,'.drag').hidden,false);
});
check('reduced motion cancels hover animation and malformed profiles clear old content',()=>{
  const env=environment();env.api.show(input());env.flushFrames();const stage=env.root().querySelector('.stage');event(stage,'pointermove',{pointerType:'mouse',clientX:200,clientY:200});assert.equal(env.frames.size,1);env.motion.matches=true;event(env.motion,'change');assert.equal(env.frames.size,0);
  event(stage,'pointermove',{pointerType:'mouse',clientX:200,clientY:200});assert.equal(env.frames.size,0);
  const state=env.api.show(input('Maker','conversation:bad',{role:{id:'bad',name:'Maker'}}));assert.equal(state.failed,true);assert.equal(state.mounted,false);assert.equal(state.roleId,'guide');assert.equal(env.document.body.children.length,0);
});
check('registry limits use Unicode codepoints and permit persisted empty role/duty labels',()=>{
  const env=environment(),role={...profile('Maker'),name:'🦊'.repeat(80),chineseName:'麦'.repeat(80),role:'',bio:'🦊'.repeat(4000),serial:'S'.repeat(80),approval:'同'.repeat(2000),duties:Array.from({length:30},()=>['','🦊'.repeat(4000)])};
  const state=env.api.show(input('Maker','conversation:limits',{role}));assert.equal(state.mounted,true);assert.equal(state.failed,false);assert.equal(env.root().querySelectorAll('.duty').length,30);
  assert.equal(env.api.show(input('Maker','conversation:bad-limits',{role:{...role,bio:'🦊'.repeat(4001)}})).failed,true);
});
check('uninstall cleans own nodes, queued frames, captures, observers and global',()=>{
  const env=environment();env.api.show(input());const handle=env.root().querySelector('.drag');event(handle,'pointerdown',{button:0,pointerId:1,clientX:0,clientY:0});event(handle,'pointermove',{pointerId:1,clientX:3,clientY:5});
  env.api.uninstall();env.api.uninstall();assert.equal(env.window.MaiWorkBadgeRuntime,undefined);assert.equal(env.document.body.children.length,0);assert.equal(env.frames.size,0);assert.equal(handle.captures.size,0);assert.equal(env.window.listenerCount(),0);assert.ok(env.mutationObservers.every(observer=>observer.watches.length===0));assert.ok(env.resizeObservers.every(observer=>observer.targets.size===0));
  assert.throws(()=>env.api.show(input()),/uninstalled/);
});
check('reloading the same script preserves the current runtime and its single overlay',()=>{
  const env=environment();env.api.show(input());const instance=env.api,layer=env.layer();vm.runInContext(source,env.context);assert.equal(env.window.MaiWorkBadgeRuntime,instance);assert.equal(env.layer(),layer);assert.equal(env.document.body.children.length,1);
});
check('a new runtime revision uninstalls the old overlay and exposes one fresh controller',()=>{
  const env=environment();env.api.show(input());const previous=env.api;
  const revised=source.replace(/const REVISION = '[^']*';/,"const REVISION = 'fixture-next-revision';");
  vm.runInContext(revised,env.context);const current=env.window.MaiWorkBadgeRuntime;
  assert.notEqual(current,previous);assert.equal(current.revision,'fixture-next-revision');assert.equal(env.document.body.children.length,0);assert.equal(env.frames.size,0);
  assert.throws(()=>previous.show(input()),/uninstalled/);current.show(input());assert.equal(env.document.body.children.length,1);current.uninstall();
});

function sidebarHarness(){
  const controllers=[];
  const script=readFileSync(new URL('../runtime/renderer.template.js',import.meta.url),'utf8').replace('/* __HOLO_ENGINE__ */','').replace('/* __SIDEBAR_CARDS__ */','const createMaiSidebarCards=__sidebarFactory;');
  const env=environment({script,sidebarFactory:options=>{
    const controller={options,updates:[],removed:0,items:[],update(items){this.items=items;this.updates.push(items);},status(){return {mounted:this.items.length,items:this.items.length};},uninstall(){this.removed++;this.items=[];}};
    controllers.push(controller);return controller;
  }});
  const entry=(roleId='demo',extra={})=>({roleId,name:'Example',role:'Sample role',bindings:[{kind:'title',key:'Example chat'}],characterDataUrl:'data:image/png;base64,QUJDRA==',backgroundDataUrl:'',...extra});
  return {env,controllers,entry};
}
check('sidebar configuration validates local art and accepts any valid custom role without private fonts',()=>{
  const {env,controllers,entry}=sidebarHarness(),large='data:image/png;base64,'+'A'.repeat(4*1024*1024);
  const state=env.api.configureSidebar({projectTitle:'Example project',items:[entry('custom_role',{characterDataUrl:large,extra:'ignored'})]});
  assert.equal(state.sidebarVersion,1);assert.equal(state.sidebar.items,1);assert.equal(controllers.length,1);assert.equal(controllers[0].options.projectTitle,'Example project');
  assert.deepEqual(Object.keys(controllers[0].items[0]).sort(),['backgroundDataUrl','bindings','characterDataUrl','name','role','roleId']);assert.equal(controllers[0].items[0].characterDataUrl,large);
  assert.equal(env.document.body.children.length,0);assert.equal(env.fontLoads.length,0);assert.equal(Object.hasOwn(controllers[0].options,'signatureForRole'),false);
  const before=controllers[0].items;
  for(const options of [null,[],{items:null},{items:Array(201).fill(entry())},{items:[null]},{items:[entry('Bad ID')]},{items:[entry('demo',{bindings:[null]})]},{items:[entry('demo',{bindings:[{kind:'implicit',key:'Example'}]})]},{items:[entry('demo',{characterDataUrl:'https://example.com/image.png'})]},{items:[entry('demo',{backgroundDataUrl:large+'A'.repeat(200)})]},{items:[entry(),entry()]},{items:[],append:'true'}])assert.throws(()=>env.api.configureSidebar(options),/invalid-(sidebar|profile)/);
  assert.equal(controllers[0].items,before,'invalid batches do not mutate applied sidebar items');env.api.uninstall();
});
check('sidebar append updates repeated role IDs while replace and empty batches clear prior items',()=>{
  const {env,controllers,entry}=sidebarHarness();env.api.configureSidebar({items:[entry('demo'),entry('second')],projectTitle:'Example project'});
  env.api.configureSidebar({items:[entry('demo',{name:'Updated'}),entry('third')],projectTitle:'Example project',append:true});
  const controller=controllers[0];assert.deepEqual(Array.from(controller.items,item=>item.roleId),['demo','second','third']);assert.equal(controller.items[0].name,'Updated');
  env.api.configureSidebar({items:[],projectTitle:'Example project',append:true});assert.equal(controller.items.length,3);
  assert.throws(()=>env.api.configureSidebar({items:[entry('fourth')],projectTitle:'Other project',append:true}),/invalid-sidebar-project/);assert.equal(controller.items.length,3);
  env.api.configureSidebar({items:[entry('replacement')],projectTitle:'Example project'});assert.deepEqual(Array.from(controller.items,item=>item.roleId),['replacement']);
  env.api.configureSidebar({items:[],projectTitle:'Example project'});assert.equal(controller.items.length,0);env.api.uninstall();assert.equal(controller.removed,1);
});
check('sidebar merged capacity is bounded and changing scope restores the prior controller',()=>{
  const {env,controllers,entry}=sidebarHarness();env.api.configureSidebar({items:Array.from({length:200},(_,index)=>entry('role_'+index)),projectTitle:'First'});
  assert.throws(()=>env.api.configureSidebar({items:[entry('over_limit')],projectTitle:'First',append:true}),/invalid-sidebar-items/);assert.equal(controllers[0].items.length,200);
  env.api.configureSidebar({items:[entry('new_role')],projectTitle:'Second'});assert.equal(controllers[0].removed,1);assert.equal(controllers.length,2);assert.equal(controllers[1].options.projectTitle,'Second');assert.equal(controllers[1].items.length,1);
  env.api.uninstall();env.api.uninstall();assert.equal(controllers[1].removed,1);assert.throws(()=>env.api.configureSidebar({items:[]}),/uninstalled/);
});

{
  const env=environment();env.api.configure({fontDataUrl:'data:font/ttf;base64,QUJDRA=='});env.api.show(input());
  await Promise.resolve();await Promise.resolve();assert.equal(env.fontLoads.length,1);assert.equal(env.fonts.size,1);
  env.api.hide({contextKey:'conversation:b'});env.api.show(input('MakerPlus','conversation:b'));assert.equal(env.fontLoads.length,1);
  env.api.uninstall();assert.equal(env.fonts.size,0);
  const pending=environment();pending.api.show(input('Guide','conversation:a',{fontDataUrl:'data:font/ttf;base64,QUJDRA=='}));pending.api.uninstall();
  await Promise.resolve();await Promise.resolve();assert.equal(pending.fonts.size,0);
  checks++;process.stdout.write(`ok ${checks} - font ownership is cached and late promises cannot outlive uninstall\n`);
}

process.stdout.write(`${checks} offline renderer checks passed. Static CSS contracts do not verify geometric scroll overflow. CSS pixels, image/font decoding and native browser activation remain untested.\n`);

const fourPlanes=()=>Object.fromEntries(['character','background','ui','structure'].map(key=>[key,'data:image/png;base64,QUJDRA==']));
async function checkAsync(name,fn){await fn();checks++;process.stdout.write(`ok ${checks} - ${name}\n`);}
check('material assets must be complete local PNGs and invalid bundles clear the prior identity',()=>{
  for(const bad of [{},[],{...fourPlanes(),background:'https://example.com/a.png'},{...fourPlanes(),structure:''}]){
    const env=environment();env.api.show(input());assert.equal(env.api.show(input('Guide','conversation:a',{holoAssets:bad})).error,'invalid-holo-assets');assert.equal(env.api.status().mounted,false);
  }
});
await checkAsync('WebGL readiness is reported only after success; original DOM identity and API version stay intact',async()=>{
  let disposed=0;const calls=[];const env=environment({materialFactory:async(_canvas,assets,options)=>{assert.deepEqual(Object.keys(assets),['character','background','ui','structure']);assert.equal(options.depth,1.75);return {setView:v=>calls.push(v),dispose:()=>disposed++};}});
  const status=env.api.show(input('Guide','conversation:a',{holoAssets:fourPlanes()}));assert.equal(status.material,'loading');assert.equal(status.build,JSON.parse(readFileSync(new URL('../plugin.json',import.meta.url),'utf8')).version);await Promise.resolve();await Promise.resolve();assert.equal(env.api.status().material,'webgl');assert.match(env.root().querySelector('.front').textContent,/Guide/);assert.equal(env.root().querySelector('.front-face').getAttribute('data-material'),'webgl');env.api.hide();assert.equal(disposed,1);assert.equal(env.api.status().mounted,false);
});
await checkAsync('portrait material tuning matches original image content, independent of role name',async()=>{
  const demoImage=JSON.parse(readFileSync(new URL('../assets/holo/demo/manifest.json',import.meta.url),'utf8')).sourceImageId;
  const script=readFileSync(new URL('../runtime/renderer.template.js',import.meta.url),'utf8').replace('/* __HOLO_ENGINE__ */','const createBadgeHoloRenderer=__badgeMaterialFactory;');
  for(const [name,imageId,power,depth,contourBrightness,foregroundFoil,subjectGlow] of [['Renamed',demoImage,.35,1.5,0,0,0],['AnotherRole',demoImage,.35,1.5,0,0,0],['Demo',null,1.3,1.75,.15],['Demo','f'.repeat(64),1.3,1.75,.15]]){
    let received;const env=environment({script,materialFactory:async(_canvas,_assets,options)=>{received=options;return {setView(){},dispose(){}};}});
    env.api.show(input(name,'conversation:material',{role:{...profile(name),imageId},holoAssets:fourPlanes()}));
    await Promise.resolve();await Promise.resolve();assert.equal(env.api.status().material,'webgl');assert.equal(received.power,power);assert.equal(received.depth,depth);assert.equal(received.contourBrightness,contourBrightness);assert.equal(received.foregroundFoil,foregroundFoil);assert.equal(received.subjectGlow,subjectGlow);env.api.hide();
  }
});
await checkAsync('invalid image identifiers are rejected before material creation',async()=>{
  let creations=0;const env=environment({materialFactory:async()=>{creations++;return {setView(){},dispose(){}};}});
  const status=env.api.show(input('Maker','conversation:invalid-image',{role:{...profile('Maker'),imageId:'toString'},holoAssets:fourPlanes()}));
  await Promise.resolve();await Promise.resolve();assert.equal(status.failed,true);assert.equal(status.error,'invalid-profile');assert.equal(status.mounted,false);assert.equal(creations,0);
});
await checkAsync('late GPU initialization is aborted and disposed without resurrecting a closed card',async()=>{
  let resolve,options,disposed=0;const env=environment({materialFactory:(_canvas,_assets,opts)=>{options=opts;return new Promise(r=>resolve=r);}});env.api.show(input('Guide','conversation:a',{holoAssets:fourPlanes()}));env.api.hide();assert.equal(options.signal.aborted,true);resolve({setView(){},dispose(){disposed++;}});await Promise.resolve();await Promise.resolve();assert.equal(disposed,1);assert.equal(env.api.status().mounted,false);assert.equal(env.document.body.children.length,0);
});
await checkAsync('GPU failure preserves the accessible original-avatar fallback rather than failing the badge',async()=>{
  const env=environment({materialFactory:async()=>{throw new Error('WebGL unavailable');}});env.api.show(input('Guide','conversation:a',{holoAssets:fourPlanes(),avatarDataUrl:'data:image/png;base64,QUJDRA=='}));await Promise.resolve();await Promise.resolve();await Promise.resolve();assert.equal(env.api.status().material,'fallback');assert.equal(env.api.status().mounted,true);assert.equal(env.api.status().failed,false);assert.match(env.root().querySelector('.front').textContent,/Guide/);
});

const keyFor=number=>number.toString(16).padStart(64,'0');
const cachedInput=(name='Guide',key=keyFor(1),extra={})=>input(name,`conversation:${name}`,{assetKey:key,role:{...profile(name),imageId:key},holoAssets:fourPlanes(),...extra});
function warmInput(full,extra={}){const result={...full,...extra};for(const name of ['avatarDataUrl','foregroundDataUrl','contourDataUrl','holoAssets'])delete result[name];return result;}
const settle=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
function materialHarness(){
  const materials=[];
  const env=environment({materialFactory:async(canvas,assets,options)=>{const material={canvas,assets,options,disposed:0,draws:0,views:[],setView(value){this.views.push(value);},draw(){this.draws++;},dispose(){this.disposed++;}};materials.push(material);return material;}});
  return {env,materials};
}
await checkAsync('full resources establish a role-bound cache and warm show reuses the same decoded UI and GPU',async()=>{
  const {env,materials}=materialHarness(),first=cachedInput();
  assert.equal(env.api.status().assetCacheVersion,1);env.api.show(first);const layer=env.layer(),root=env.root();assert.equal(root.querySelector('.loading').hidden,false);await settle();assert.equal(root.querySelector('.loading').hidden,true);
  env.flushFrames();env.api.hide({contextKey:'conversation:unknown',reason:'unbound'});assert.equal(env.api.status().mounted,false);assert.equal(env.api.status().restorable,false);assert.equal(materials[0].disposed,0);assert.equal(materials[0].options.signal.aborted,false);assert.equal(env.resizeObservers[0].targets.size,0);assert.equal(env.frames.size,0);
  const result=env.api.show(warmInput(first));assert.equal(result.assetCacheHit,true);assert.equal(result.uiCacheHit,true);assert.equal(result.assetCacheMiss,false);assert.equal(env.layer(),layer);assert.equal(env.root(),root);assert.equal(materials.length,1);assert.equal(materials[0].draws,1);assert.equal(root.querySelector('.loading').hidden,true);assert.equal(env.resizeObservers[0].targets.size,1);
  env.api.uninstall();assert.equal(materials[0].disposed,1);assert.equal(env.api.status().cacheStats.entries,0);assert.equal(env.api.status().cacheStats.retainedUI,0);assert.equal(env.api.status().cacheStats.bytes,0);
});
await checkAsync('public examples sharing one avatar cache never share another role identity or card text',async()=>{
  const {env,materials}=materialHarness(),key=keyFor(7),first=cachedInput('Alex',key),second=cachedInput('Blair',key);
  env.api.show(first);await settle();const alexLayer=env.layer();assert.match(env.root().querySelector('.front').textContent,/Alex/);
  env.api.hide({reason:'context-change'});env.api.show(warmInput(second));await settle();
  assert.equal(env.api.status().assetCacheHit,true);assert.equal(env.api.status().roleId,'blair');assert.match(env.root().querySelector('.front').textContent,/Blair/);assert.doesNotMatch(env.root().querySelector('.front').textContent,/Alex/);assert.equal(materials.length,2);
  env.api.hide({reason:'context-change'});env.api.show(warmInput(first));await settle();assert.equal(env.layer(),alexLayer);assert.equal(env.api.status().uiCacheHit,true);assert.equal(materials.length,2);assert.match(env.root().querySelector('.front').textContent,/Alex/);env.api.uninstall();
});
await checkAsync('title changes park ready pixels but only explicit current-context show can remount them',async()=>{
  const {env,materials}=materialHarness(),first=cachedInput();env.api.show(first);await settle();const original=env.layer();
  env.document.title='Other conversation';assert.equal(env.api.status().mounted,false);assert.equal(env.api.status().stale,true);assert.equal(materials[0].disposed,0);
  env.document.title='Guide';assert.equal(env.api.restore().mounted,false);assert.equal(env.document.body.children.length,0);
  const result=env.api.show(warmInput(first));assert.equal(result.uiCacheHit,true);assert.equal(env.layer(),original);assert.equal(env.api.status().stale,false);assert.equal(materials.length,1);env.api.uninstall();
});
await checkAsync('cached canvases redraw once when a restored back, collapsed or hidden card becomes visible',async()=>{
  for(const state of [{flipped:true,collapsed:false},{flipped:false,collapsed:true}]){
    const {env,materials}=materialHarness(),first=cachedInput();env.api.show(first);await settle();env.api.hide();
    assert.equal(env.api.show(warmInput(first,{cardState:state})).uiCacheHit,true);assert.equal(materials[0].draws,0);
    event(active(env.root(),state.flipped?'.back':'.mini'),'click');assert.equal(materials[0].draws,1);
    env.api.show(warmInput(first));assert.equal(materials[0].draws,1,'unchanged visible show never adds idle redraws');env.api.uninstall();
  }
  const {env,materials}=materialHarness(),first=cachedInput();env.api.show(first);await settle();env.document.hidden=true;event(env.document,'visibilitychange');
  env.api.hide();env.api.show(warmInput(first));assert.equal(materials[0].draws,0);env.document.hidden=false;event(env.document,'visibilitychange');assert.equal(materials[0].draws,1);event(env.document,'visibilitychange');assert.equal(materials[0].draws,1);env.api.uninstall();
});
await checkAsync('unknown keys, image mismatches and invalid references never leave another identity visible',async()=>{
  const {env}=materialHarness(),first=cachedInput();env.api.show(first);await settle();
  let result=env.api.show(warmInput(cachedInput('MakerPlus',keyFor(2))));assert.equal(result.assetCacheMiss,true);assert.equal(result.mounted,false);assert.equal(result.restorable,false);assert.equal(result.roleId,'makerplus');assert.equal(result.failed,false);
  result=env.api.show(warmInput(first,{role:{...profile('MakerPlus'),imageId:keyFor(99)}}));assert.equal(result.assetCacheMiss,true);assert.equal(result.mounted,false);assert.equal(result.roleId,'makerplus');
  result=env.api.show(first);assert.equal(result.mounted,true);assert.equal(result.assetCacheMiss,false);
  result=env.api.show(warmInput(first,{assetKey:'toString'}));assert.equal(result.failed,true);assert.equal(result.error,'invalid-asset-key');assert.equal(result.mounted,false);env.api.uninstall();
});
await checkAsync('changed responsibilities and full replacement pixels invalidate earlier ready instances',async()=>{
  const {env,materials}=materialHarness(),first=cachedInput();env.api.show(first);await settle();const original=env.layer();env.api.hide();
  const revised=warmInput(first,{role:{...first.role,duties:[['新职责','已更新的工作内容']]}});let result=env.api.show(revised);assert.equal(result.uiCacheHit,false);assert.equal(materials[0].disposed,1);assert.notEqual(env.layer(),original);assert.match(env.root().querySelector('.duties').textContent,/新职责/);await settle();
  const changed={...first,role:revised.role,holoAssets:{...fourPlanes(),character:'data:image/png;base64,RUZHSA=='}};
  result=env.api.show(changed);assert.equal(result.uiCacheHit,false);assert.equal(materials[1].disposed,1);await settle();assert.equal(materials.length,3);assert.equal(materials[2].assets.character,changed.holoAssets.character);
  env.api.hide();result=env.api.show(warmInput(changed));assert.equal(result.uiCacheHit,true);assert.equal(materials.length,3);env.api.uninstall();assert.ok(materials.every(material=>material.disposed===1));
});
await checkAsync('pending shader work is never parked and late resolution cannot resurrect an old card',async()=>{
  let resolve,options,disposed=0;const env=environment({materialFactory:(_canvas,_assets,opts)=>{options=opts;return new Promise(done=>resolve=done);}}),first=cachedInput();
  env.api.show(first);env.api.hide();assert.equal(options.signal.aborted,true);assert.equal(env.api.status().cacheStats.retainedUI,0);resolve({setView(){throw Error('late material must not draw');},dispose(){disposed++;}});await settle();assert.equal(disposed,1);assert.equal(env.api.status().mounted,false);
  env.api.uninstall();
});
await checkAsync('parked lost contexts are removed and returning reconstructs from the valid image package',async()=>{
  const {env,materials}=materialHarness(),first=cachedInput();env.api.show(first);await settle();env.api.hide();materials[0].options.onLost();assert.equal(materials[0].disposed,1);assert.equal(env.api.status().cacheStats.retainedUI,0);assert.equal(env.api.status().cacheStats.entries,1);
  const result=env.api.show(warmInput(first));assert.equal(result.assetCacheHit,true);assert.equal(result.uiCacheHit,false);assert.equal(env.root().querySelector('.loading').hidden,false);await settle();assert.equal(materials.length,2);assert.equal(env.api.status().material,'webgl');env.api.uninstall();
});
await checkAsync('both resource and ready-card LRU limits dispose evicted GPU objects exactly once',async()=>{
  const {env,materials}=materialHarness();
  for(let number=1;number<=7;number++){env.api.show(cachedInput('Role'+number,keyFor(number)));await settle();assert.ok(env.api.status().cacheStats.entries<=6);assert.ok(env.api.status().cacheStats.retainedUI<=6);}
  assert.equal(materials[0].disposed,1);assert.equal(env.api.show(warmInput(cachedInput('Role1',keyFor(1)))).assetCacheMiss,true);assert.equal(env.api.status().mounted,false);env.api.uninstall();assert.ok(materials.every(material=>material.disposed===1));
  const shared=materialHarness();
  for(let number=1;number<=7;number++){shared.env.api.show(cachedInput('Shared'+number,keyFor(40)));await settle();}
  assert.equal(shared.env.api.status().cacheStats.entries,1);assert.equal(shared.env.api.status().cacheStats.retainedUI,6);assert.equal(shared.materials[0].disposed,1);shared.env.api.uninstall();assert.ok(shared.materials.every(material=>material.disposed===1));
});
await checkAsync('a conservative 32 MiB resource budget can skip a new bundle without blanking the visible card',async()=>{
  const {env,materials}=materialHarness();const large=Object.fromEntries(['character','background','ui','structure'].map((name,index)=>[name,'data:image/png;base64,'+String.fromCharCode(65+index).repeat(2*1024*1024)]));
  env.api.show(cachedInput('Large1',keyFor(50),{holoAssets:large}));await settle();const first=env.api.status();assert.equal(first.cacheStats.entries,1);assert.ok(first.cacheStats.bytes<=32*1024*1024);
  env.api.show(cachedInput('Large2',keyFor(51),{holoAssets:large}));await settle();const next=env.api.status();assert.equal(next.mounted,true);assert.equal(next.roleId,'large2');assert.equal(next.material,'webgl');assert.ok(next.cacheStats.bytes<=32*1024*1024);assert.ok(next.cacheStats.entries<=1);
  env.api.uninstall();assert.ok(materials.every(material=>material.disposed===1));
});
await checkAsync('dismissal, disablement and empty images retain explicit authorization while releasing old material',async()=>{
  const {env,materials}=materialHarness(),first=cachedInput();env.api.show(first);await settle();event(active(env.root(),'.close'),'click');assert.equal(materials[0].disposed,0);assert.equal(env.api.status().restorable,true);
  env.api.show(warmInput(first));assert.equal(env.api.status().mounted,false);assert.equal(env.api.status().restorable,true);assert.equal(env.api.restore().uiCacheHit,true);assert.equal(materials.length,1);
  env.api.hide({reason:'unbound'});assert.equal(env.api.restore().mounted,false);
  const disabled=warmInput(first,{role:{...first.role,enabled:false}});env.api.show(disabled);assert.equal(materials[0].disposed,1);assert.equal(env.api.status().restorable,false);
  const blank=cachedInput('Empty',keyFor(60),{role:{...profile('Empty'),imageId:null},holoAssets:null,avatarDataUrl:''});env.api.show(blank);assert.equal(env.root().querySelectorAll('.portrait').length,0);env.api.hide();assert.equal(env.api.show(warmInput(blank)).uiCacheHit,true);assert.equal(env.root().querySelector('.initial').textContent,'E');env.api.uninstall();
});
await checkAsync('loading feedback is local, immediately readable, stopped on hidden/back/collapse and static for reduced motion',async()=>{
  let resolve;const env=environment({materialFactory:()=>new Promise(done=>resolve=done)}),first=cachedInput();env.api.show(first);const root=env.root(),loading=root.querySelector('.loading'),shell=root.querySelector('.shell');
  assert.equal(loading.hidden,false);assert.match(loading.textContent,/正在加载工牌/);assert.match(root.querySelector('.names').textContent,/Guide/);assert.match(root.querySelector('.duties').textContent,/查待办/);
  event(active(root,'.front'),'click');assert.equal(loading.hidden,true);event(active(root,'.back'),'click');assert.equal(loading.hidden,false);
  event(active(root,'.collapse'),'click');assert.equal(loading.hidden,true);event(active(root,'.mini'),'click');assert.equal(loading.hidden,false);
  env.document.hidden=true;event(env.document,'visibilitychange');assert.equal(loading.hidden,true);assert.equal(shell.getAttribute('data-loading-paused'),'');env.document.hidden=false;event(env.document,'visibilitychange');assert.equal(loading.hidden,false);
  assert.match(source,/@media\(prefers-reduced-motion:reduce\)\{\.loading-dot\{animation:none;opacity:\.7\}\}/);assert.match(source,/\.shell\[data-loading-paused\] \.loading-dot\{animation-play-state:paused\}/);
  resolve({setView(){},dispose(){}});await settle();assert.equal(loading.hidden,true);env.api.hide();assert.equal(env.api.show(warmInput(first)).uiCacheHit,true);assert.equal(loading.hidden,true);env.api.uninstall();
});
await checkAsync('WebGL fallback keeps feedback until the original image loads, then removes it',async()=>{
  const env=environment({materialFactory:async()=>{throw Error('unsupported');}});env.api.show(cachedInput('Guide',keyFor(70),{avatarDataUrl:'data:image/png;base64,QUJDRA=='}));await settle();const root=env.root();assert.equal(env.api.status().material,'fallback');assert.equal(root.querySelector('.loading').hidden,false);
  for(const image of root.querySelectorAll('.portrait'))event(image,'load');assert.equal(root.querySelector('.loading').hidden,true);env.api.uninstall();
});
process.stdout.write(`${checks} total renderer contracts passed. Cache reuse and ownership are verified offline; native image decoding and visual animation still require browser checks.\n`);
