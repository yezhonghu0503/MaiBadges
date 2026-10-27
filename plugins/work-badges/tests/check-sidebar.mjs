/* Offline sidebar public-contract checks. This deliberately models only DOM
 * semantics, ownership, event propagation and mutation scheduling: it does not
 * render CSS, connect to the app, read chats, or use a browser/CDP connection.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../runtime/sidebar.js',import.meta.url),'utf8');
let checks=0;
function check(name,fn){fn();process.stdout.write(`ok ${++checks} - ${name}\n`);}

function environment(options={}){
  let document,nextFrame=1,nextTimer=1,time=0;
  const frames=new Map(),timers=new Map(),observers=[],metrics={geometryReads:0,documentQueries:0};
  function parts(value,delimiter=','){
    const result=[];let start=0,depth=0,quote='';
    for(let i=0;i<value.length;i++){const c=value[i];if(quote){if(c===quote&&value[i-1]!=='\\')quote='';continue;}if(c==='"'||c==="'"){quote=c;continue;}if(c==='['||c==='(')depth++;else if(c===']'||c===')')depth--;else if(c===delimiter&&!depth){result.push(value.slice(start,i).trim());start=i+1;}}
    result.push(value.slice(start).trim());return result.filter(Boolean);
  }
  function notify(target,record){
    for(const observer of observers)for(const {target:root,options} of observer.watches){
      if(!(root===target||(options.subtree&&root.contains(target))))continue;
      if(record.type==='attributes'&&(!options.attributes||(options.attributeFilter&&!options.attributeFilter.includes(record.attributeName))))continue;
      if(record.type==='childList'&&!options.childList)continue;
      if(record.type==='characterData'&&!options.characterData)continue;
      observer.records.push({...record,target});break;
    }
  }
  class Target{
    constructor(){this.listeners=new Map();}
    addEventListener(type,fn,options={}){if(options.signal?.aborted)return;let set=this.listeners.get(type);if(!set)this.listeners.set(type,set=new Set());set.add(fn);options.signal?.addEventListener('abort',()=>set.delete(fn),{once:true});}
    removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
    dispatchEvent(event){
      event.target??=this;event.currentTarget=this;event.preventDefault??=function(){this.defaultPrevented=true;};event.stopPropagation??=function(){this.stopped=true;};
      for(const fn of [...(this.listeners.get(event.type)||[])])fn(event);
      if(event.bubbles&&!event.stopped)this.parentNode?.dispatchEvent(event);return !event.defaultPrevented;
    }
  }
  function styleFor(element){
    const values=new Map(),priorities=new Map(),dash=name=>name.replace(/[A-Z]/g,c=>'-'+c.toLowerCase());
    const methods={
      setProperty(name,value,priority=''){name=dash(name);value=String(value);if(values.get(name)===value&&priorities.get(name)===(priority||''))return;values.set(name,value);priorities.set(name,priority||'');notify(element,{type:'attributes',attributeName:'style'});},
      getPropertyValue:name=>values.get(dash(name))||'',getPropertyPriority:name=>priorities.get(dash(name))||'',
      removeProperty(name){name=dash(name);const old=values.get(name)||'';if(values.delete(name)){priorities.delete(name);notify(element,{type:'attributes',attributeName:'style'});}return old;},
      get cssText(){return [...values].map(([name,value])=>`${name}: ${value}${priorities.get(name)?' !'+priorities.get(name):''};`).join(' ');},
      set cssText(value){values.clear();priorities.clear();for(const declaration of String(value).split(';')){const split=declaration.indexOf(':');if(split<0)continue;let val=declaration.slice(split+1).trim();const important=/\s*!important$/.test(val);val=val.replace(/\s*!important$/,'');methods.setProperty(declaration.slice(0,split).trim(),val,important?'important':'');}notify(element,{type:'attributes',attributeName:'style'});}
    };
    return new Proxy(methods,{get(target,key){if(key in target)return target[key];return values.get(dash(String(key)))||'';},set(target,key,value){if(key==='cssText')target.cssText=value;else target.setProperty(String(key),value);return true;},ownKeys(){return [...values.keys()];},getOwnPropertyDescriptor(){return {enumerable:true,configurable:true};}});
  }
  function compound(element,selector){
    if(selector==='*'||selector===':scope')return true;
    selector=selector.replace(/:(not|is|where)\(([^()]*)\)/g,(_,kind,inside)=>{const yes=parts(inside).some(value=>matches(element,value));return (kind==='not'?!yes:yes)?'':':__fail';});
    if(selector.includes(':'))return false;
    const tag=selector.match(/^[\w*-]+/);if(tag&&tag[0]!=='*'&&element.localName!==tag[0].toLowerCase())return false;
    for(const match of selector.matchAll(/([.#])([\w-]+)/g)){const actual=match[1]==='#'?element.id:element.className.split(/\s+/);if(match[1]==='#'?actual!==match[2]:!actual.includes(match[2]))return false;}
    for(const match of selector.matchAll(/\[\s*([^\s~|^$*=\]]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*(i)?)?\s*\]/g)){
      let actual=element.getAttribute(match[1]);if(actual===null)return false;if(!match[2])continue;let expected=match[3]??match[4]??match[5]??'';if(match[6]){actual=actual.toLowerCase();expected=expected.toLowerCase();}
      if(!({'=':()=>actual===expected,'*=':()=>actual.includes(expected),'^=':()=>actual.startsWith(expected),'$=':()=>actual.endsWith(expected),'~=':()=>actual.split(/\s+/).includes(expected),'|=':()=>actual===expected||actual.startsWith(expected+'-')})[match[2]]())return false;
    }
    return true;
  }
  function matches(element,selector){
    if(parts(selector).length>1)return parts(selector).some(value=>matches(element,value));
    let depth=0,quote='';const tokens=[];let start=0;
    for(let i=0;i<selector.length;i++){const c=selector[i];if(quote){if(c===quote)quote='';continue;}if(c==='"'||c==="'"){quote=c;continue;}if(c==='['||c==='(')depth++;else if(c===']'||c===')')depth--;else if(!depth&&(c==='>'||c===' ')){if(i>start)tokens.push(selector.slice(start,i));if(c==='>')tokens.push('>');start=i+1;}}
    if(start<selector.length)tokens.push(selector.slice(start));if(!tokens.length)return false;
    let current=element,index=tokens.length-1;if(!compound(current,tokens[index--]))return false;
    while(index>=0){const direct=tokens[index]==='>';if(direct)index--;const token=tokens[index--];current=current.parentElement;if(direct){if(!current||!compound(current,token))return false;}else {while(current&&!compound(current,token))current=current.parentElement;if(!current)return false;}}
    return true;
  }
  class Element extends Target{
    constructor(tag){super();this.nodeType=1;this.localName=tag.toLowerCase();this.tagName=this.nodeName=tag.toUpperCase();this.children=[];this.parentNode=null;this.attributes=new Map();this._text='';this.style=styleFor(this);this.hidden=false;this._rect={x:0,y:0,left:0,top:0,width:280,height:42,right:280,bottom:42};this.dataset=new Proxy({},{get:(_target,key)=>this.getAttribute('data-'+String(key).replace(/[A-Z]/g,c=>'-'+c.toLowerCase())),set:(_target,key,value)=>{this.setAttribute('data-'+String(key).replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),value);return true;}});}
    get parentElement(){return this.parentNode?.nodeType===1?this.parentNode:null;}
    get childNodes(){return this.children;}
    get childElementCount(){return this.children.length;}
    get firstChild(){return this.children[0]||null;}
    get firstElementChild(){return this.firstChild;}
    get nextSibling(){const siblings=this.parentNode?.children||[];return siblings[siblings.indexOf(this)+1]||null;}
    get className(){return this.getAttribute('class')||'';}
    set className(value){this.setAttribute('class',value);}
    get id(){return this.getAttribute('id')||'';}
    set id(value){this.setAttribute('id',value);}
    get title(){return this.getAttribute('title')||'';}
    set title(value){this.setAttribute('title',value);}
    get href(){return this.getAttribute('href')||'';}
    set href(value){this.setAttribute('href',value);}
    get textContent(){if(this.forbidTextRead)throw new Error('main conversation text must not be read');return this._text+this.children.map(child=>child.textContent).join('');}
    set textContent(value){const removedNodes=[...this.children];for(const child of removedNodes)child.parentNode=null;this.children=[];this._text=String(value);notify(this,{type:'childList',addedNodes:[],removedNodes});}
    get innerText(){return this.textContent;}
    get isConnected(){for(let node=this;node;node=node.parentNode)if(node===document)return true;return false;}
    append(...nodes){for(const child of nodes){child.remove();this.children.push(child);child.parentNode=this;notify(this,{type:'childList',addedNodes:[child],removedNodes:[]});}}
    appendChild(child){this.append(child);return child;}
    prepend(...nodes){for(const child of [...nodes].reverse()){child.remove();this.children.unshift(child);child.parentNode=this;notify(this,{type:'childList',addedNodes:[child],removedNodes:[]});}}
    insertBefore(child,before){if(!before)return this.appendChild(child);child.remove();const index=this.children.indexOf(before);assert.ok(index>=0);this.children.splice(index,0,child);child.parentNode=this;notify(this,{type:'childList',addedNodes:[child],removedNodes:[]});return child;}
    remove(){if(!this.parentNode)return;const parent=this.parentNode;parent.children=parent.children.filter(child=>child!==this);this.parentNode=null;notify(parent,{type:'childList',addedNodes:[],removedNodes:[this]});}
    removeChild(child){assert.equal(child.parentNode,this);child.remove();return child;}
    replaceChildren(...nodes){this.textContent='';this.append(...nodes);}
    contains(other){for(let node=other;node;node=node.parentNode)if(node===this)return true;return false;}
    setAttribute(name,value){value=String(value);if(name==='style'){this.style.cssText=value;return;}if(this.attributes.get(name)===value)return;this.attributes.set(name,value);notify(this,{type:'attributes',attributeName:name});}
    getAttribute(name){if(name==='style')return this.style.cssText||null;return this.attributes.get(name)??null;}
    hasAttribute(name){return this.getAttribute(name)!==null;}
    removeAttribute(name){if(name==='style'){this.style.cssText='';return;}if(this.attributes.delete(name))notify(this,{type:'attributes',attributeName:name});}
    toggleAttribute(name,force){const present=force===undefined?!this.hasAttribute(name):Boolean(force);if(present)this.setAttribute(name,'');else this.removeAttribute(name);return present;}
    matches(selector){return matches(this,selector);}
    closest(selector){for(let node=this;node?.nodeType===1;node=node.parentElement)if(matches(node,selector))return node;return null;}
    querySelectorAll(selector){if(this===document)metrics.documentQueries++;const result=[];function visit(node){for(const child of node.children){if(matches(child,selector))result.push(child);visit(child);}}visit(this);return result;}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    getBoundingClientRect(){metrics.geometryReads++;return {...this._rect};}
    getClientRects(){for(let node=this;node;node=node.parentElement)if(node.hidden||node.getAttribute('aria-hidden')==='true'||node.style.display==='none'||node.style.visibility==='hidden')return [];return this._rect.width&&this._rect.height?[this.getBoundingClientRect()]:[];}
  }
  document=new Element('#document');document.nodeType=9;document.createElement=tag=>new Element(tag);document.createElementNS=(_namespace,tag)=>new Element(tag);
  document.documentElement=new Element('html');document.head=new Element('head');document.body=new Element('body');document.append(document.documentElement);document.documentElement.append(document.head,document.body);
  const title=new Element('title');title.textContent='Unbound chat';document.head.append(title);
  Object.defineProperty(document,'title',{get(){return document.head.querySelector('title')?.textContent||'';},set(value){document.head.querySelector('title').textContent=value;}});
  const window=new Target(),motion=new Target();motion.matches=false;window.innerWidth=1200;window.innerHeight=900;window.getComputedStyle=element=>({position:element.style.position||'static',display:element.style.display||'block',visibility:element.style.visibility||'visible',getPropertyValue:name=>element.style.getPropertyValue(name)});
  class MutationObserver{constructor(callback){this.callback=callback;this.watches=[];this.records=[];observers.push(this);}observe(target,options){this.watches.push({target,options});}disconnect(){this.watches=[];this.records=[];}takeRecords(){const records=this.records;this.records=[];return records;}}
  const sandbox={window,document,MutationObserver,HTMLElement:Element,Element,Node:{ELEMENT_NODE:1,TEXT_NODE:3},URL,AbortController,console,location:{href:'codex://threads/current'},getComputedStyle:window.getComputedStyle,matchMedia:()=>motion,
    requestAnimationFrame:fn=>{const id=nextFrame++;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id),performance:{now:()=>time},
    setTimeout:(fn,delay=0)=>{const id=nextTimer++;timers.set(id,{fn,at:time+delay});return id;},clearTimeout:id=>timers.delete(id)};
  window.requestAnimationFrame=sandbox.requestAnimationFrame;window.cancelAnimationFrame=sandbox.cancelAnimationFrame;
  const context=vm.createContext(sandbox);vm.runInContext(source,context,{filename:'sidebar.js'});
  assert.equal(typeof context.createMaiSidebarCards,'function');
  const api=context.createMaiSidebarCards({signatureForRole:options.signatureForRole===null?undefined:()=>({family:'FixtureSignature',size:'24px'}),projectTitle:options.projectTitle??''});
  for(const name of ['update','status','uninstall'])assert.equal(typeof api[name],'function',`${name} is a public controller method`);
  assert.equal(typeof api.status(),'object');
  function deliver(){const batch=observers.map(observer=>[observer,observer.takeRecords()]);for(const [observer,records] of batch)if(records.length)observer.callback(records,observer);}
  function step(){deliver();time+=1000/60;for(const [id,timer] of [...timers])if(timer.at<=time){timers.delete(id);timer.fn();}const batch=[...frames];frames.clear();for(const [,callback] of batch)callback(time);}
  function settle(maker=30){for(let round=0;round<maker;round++){if(!frames.size&&!timers.size&&!observers.some(observer=>observer.records.length))return;step();}assert.fail('mutation and animation queues must settle without an observer feedback loop');}
  function characterMutation(node,value){node._text=String(value);notify(node,{type:'characterData'});}
  return {document,window,location:sandbox.location,motion,api,frames,timers,observers,metrics,deliver,step,settle,characterMutation,Element};
}

function fixture(env){
  const {document}=env,aside=document.createElement('aside'),nav=document.createElement('nav'),main=document.createElement('main');
  aside.setAttribute('data-sidebar','');aside.append(nav);document.body.append(aside,main);
  function row(title,id='',container=nav){
    const link=document.createElement('a');link.href=id?`/threads/${id}`:'/settings';link.setAttribute('draggable','true');link.setAttribute('aria-current','false');
    const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('data-native-task-icon','');const path=document.createElementNS('http://www.w3.org/2000/svg','path');icon.append(path);
    const label=document.createElement('span');label.textContent=title;label.title=title;label.setAttribute('data-native-title','');
    const state=document.createElement('span');state.setAttribute('data-native-state','');state.setAttribute('aria-label','Scheduled');
    link.append(icon,label,state);container.append(link);return {link,icon,path,label,state};
  }
  return {aside,nav,main,row};
}
const asset='data:image/png;base64,QUJDRA==';
function item(roleId='guide',bindings=[{kind:'title',key:'Guide'}]){return {roleId,name:roleId==='guide'?'Guide':'Maker',role:'示例职责',bindings,characterDataUrl:asset,backgroundDataUrl:asset};}
const cards=env=>env.document.querySelectorAll('[data-mai-sidebar-card]');
const card=row=>row.link.querySelector('[data-mai-sidebar-card]');
function nativeSnapshot(row){return {children:[...row.link.children],attributes:[...row.link.attributes],style:row.link.style.cssText,labelAttributes:[...row.label.attributes],labelStyle:row.label.style.cssText,label:row.label.textContent};}
function assertNativeIdentity(row,before){assert.equal(row.icon.parentNode,row.link);assert.equal(row.path.parentNode,row.icon);assert.equal(row.state.parentNode,row.link);assert.equal(row.label.parentNode,row.link);for(const node of before.children)assert.ok(row.link.children.includes(node));assert.equal(row.link.getAttribute('draggable'),'true');assert.equal(row.link.getAttribute('aria-current'),'false');assert.equal(row.label.textContent,before.label);}
function assertRestored(row,before){assert.deepEqual(row.link.children,before.children);assert.deepEqual([...row.link.attributes],before.attributes);assert.equal(row.link.style.cssText,before.style);assert.deepEqual([...row.label.attributes],before.labelAttributes);assert.equal(row.label.style.cssText,before.labelStyle);}
function projectFixture(env){
  const f=fixture(env);
  function section(title){
    const section=env.document.createElement('section'),heading=env.document.createElement('button'),label=env.document.createElement('span'),rows=env.document.createElement('div');
    heading.setAttribute('aria-expanded','true');label.textContent=title;heading.append(label);section.append(heading,rows);f.nav.append(section);return {section,heading,label,rows};
  }
  function row(title,container,target=''){
    const link=env.document.createElement('div');link.setAttribute('role','button');link.setAttribute('draggable','true');link.setAttribute('aria-current','false');if(target)link.setAttribute('data-thread-id',target);
    const icon=env.document.createElementNS('http://www.w3.org/2000/svg','svg'),path=env.document.createElementNS('http://www.w3.org/2000/svg','path'),label=env.document.createElement('span'),state=env.document.createElement('span');
    icon.append(path);label.textContent=title;state.setAttribute('role','status');state.setAttribute('aria-label','Scheduled');link.append(icon,label,state);container.append(link);return {link,icon,path,label,state};
  }
  return {...f,section,row};
}
function assertProjectCounts(env,expected){
  const scope=env.api.status().projectScope;assert.ok(scope&&typeof scope==='object');assert.deepEqual(Object.keys(scope).sort(),['configured','headers','matches','roots']);
  assert.equal(typeof scope.configured,'boolean');for(const key of ['headers','roots','matches'])assert.ok(Number.isInteger(scope[key])&&scope[key]>=0,`${key} is a nonnegative count`);
  for(const [key,value] of Object.entries(expected))assert.equal(scope[key],value,`projectScope.${key}`);assert.equal(JSON.stringify(scope).includes('Example project'),false);
}

check('exact title binding decorates only its visible navigation row and preserves native objects and events',()=>{
  const env=environment(),f=fixture(env),guide=f.row('Guide'),unbound=f.row('Guide extra'),outside=f.row('Guide','outside',f.main),hidden=f.row('Guide');hidden.link.hidden=true;
  const before=nativeSnapshot(guide),untouched=[unbound,outside,hidden].map(nativeSnapshot);let clicks=0,drags=0;
  guide.link.addEventListener('click',()=>clicks++);guide.link.addEventListener('dragstart',()=>drags++);f.main.forbidTextRead=true;
  env.api.update([item()]);env.settle();assert.ok(card(guide));assert.equal(cards(env).length,1);assertNativeIdentity(guide,before);
  for(const [index,row] of [unbound,outside,hidden].entries())assertRestored(row,untouched[index]);
  const click={type:'click',bubbles:true},drag={type:'dragstart',bubbles:true};guide.icon.dispatchEvent(click);guide.link.dispatchEvent(drag);assert.equal(clicks,1);assert.equal(drags,1);assert.equal(click.defaultPrevented,undefined);assert.equal(drag.defaultPrevented,undefined);
  for(const layer of cards(env))assert.equal(layer.style.pointerEvents||env.window.getComputedStyle(layer).pointerEvents,'none');
  guide.state.setAttribute('aria-label','Running');env.settle();assert.equal(guide.state.getAttribute('aria-label'),'Running');assert.equal(guide.icon,guide.link.querySelector('svg'));
});

check('duplicate exact titles fail closed while a stable thread binding identifies one row',()=>{
  const env=environment(),f=fixture(env),first=f.row('Guide','first'),second=f.row('Guide','second');
  const a=nativeSnapshot(first),b=nativeSnapshot(second);env.api.update([item()]);env.settle();assert.equal(cards(env).length,0);assertRestored(first,a);assertRestored(second,b);
  env.api.update([item('guide',[{kind:'title',key:'Guide'},{kind:'thread',key:'first'}])]);env.settle();assert.ok(card(first));assert.ok(card(second)===null,'the duplicate title remains ambiguous even when the first row has a thread binding');assert.equal(cards(env).length,1);assertRestored(second,b);
});

check('names, title prefixes and aggregate row text never create an implicit binding',()=>{
  const env=environment(),f=fixture(env),prefix=f.row('MakerPlus'),name=f.row('Maker'),aggregate=f.row('Unrelated');aggregate.state.textContent='Guide';
  const before=[prefix,name,aggregate].map(nativeSnapshot);env.api.update([item('maker',[{kind:'title',key:'MakerAlt'}]),item()]);env.settle();assert.equal(cards(env).length,0);
  for(const [index,row] of [prefix,name,aggregate].entries())assertRestored(row,before[index]);
});

check('repeated update reuses one decoration and update([]) restores and permits re-enabling',()=>{
  const env=environment(),f=fixture(env),guide=f.row('Guide'),before=nativeSnapshot(guide),entry=item();env.api.update([entry]);env.settle();const first=card(guide);assert.ok(first);
  for(let i=0;i<5;i++){env.api.update([entry]);env.settle();assert.equal(card(guide),first);assert.equal(cards(env).length,1);}
  env.api.update([item()]);env.settle();assert.equal(cards(env).length,1);assertNativeIdentity(guide,before);
  env.api.update([]);env.settle();assert.equal(cards(env).length,0);assertRestored(guide,before);
  env.api.update([item()]);env.settle();assert.ok(card(guide));assert.equal(cards(env).length,1);env.api.uninstall();env.settle();assertRestored(guide,before);assert.equal(cards(env).length,0);assert.equal(env.frames.size,0);assert.ok(env.observers.every(observer=>observer.watches.length===0));
});

check('uninstall restores only values still owned and preserves later host style and attributes',()=>{
  const env=environment(),f=fixture(env),guide=f.row('Guide');guide.link.style.setProperty('position','absolute','important');guide.label.style.color='purple';const before=nativeSnapshot(guide);
  env.api.update([item()]);env.settle();assert.ok(card(guide));
  guide.link.style.setProperty('position','sticky','important');guide.label.style.color='orange';guide.link.setAttribute('data-host-update','latest');guide.link.setAttribute('aria-current','page');
  env.api.uninstall();env.settle();assert.equal(cards(env).length,0);assert.deepEqual(guide.link.children,before.children);assert.equal(guide.link.style.position,'sticky');assert.equal(guide.link.style.getPropertyPriority('position'),'important');assert.equal(guide.label.style.color,'orange');assert.equal(guide.link.getAttribute('data-host-update'),'latest');assert.equal(guide.link.getAttribute('aria-current'),'page');assert.equal(guide.link.getAttribute('data-mai-sidebar-row'),null);assert.equal(guide.label.getAttribute('data-mai-sidebar-label'),null);
});

check('virtualized row metadata changes clear the old decoration and allow a fresh binding',()=>{
  const env=environment(),f=fixture(env),guide=f.row('Guide','guide-thread');env.api.update([item('guide',[{kind:'thread',key:'guide-thread'}])]);env.settle();assert.ok(card(guide));
  guide.link.href='/threads/unknown-thread';guide.label.textContent='Ordinary chat';guide.label.title='Ordinary chat';env.settle();assert.ok(card(guide)===null,'recycled native row cannot retain the prior role decoration');assert.equal(guide.label.textContent,'Ordinary chat');
  env.api.update([item('maker',[{kind:'thread',key:'unknown-thread'}])]);env.settle();assert.ok(card(guide));assert.match(card(guide).textContent,/Maker/);assert.doesNotMatch(card(guide).textContent,/Guide/);
  guide.link.remove();env.settle();assert.equal(cards(env).length,0);assert.equal(guide.link.getAttribute('data-mai-sidebar-row'),null);assert.equal(guide.label.getAttribute('data-mai-sidebar-label'),null);
});

check('mutation bursts share one pending scan and owned mutations do not run an idle loop',()=>{
  const env=environment(),f=fixture(env);env.api.update([item()]);env.settle();
  const guide=f.row('Guide');for(let i=0;i<20;i++)guide.state.setAttribute('data-native-tick',i);env.deliver();assert.equal(env.frames.size+env.timers.size,1,'one pending reconciliation per mutation batch');
  env.step();env.settle();assert.ok(card(guide));assert.equal(cards(env).length,1);assert.equal(env.frames.size,0);
  for(let i=0;i<5;i++){env.deliver();assert.equal(env.frames.size,0,'owned changes cannot keep requesting frames');}
  env.api.uninstall();env.settle();assert.equal(env.frames.size,0);
});

check('a visible left navigation fallback works while editor, header and distant controls stay untouched',()=>{
  const env=environment(),f=fixture(env),left=env.document.createElement('div'),editor=env.document.createElement('div'),header=env.document.createElement('header'),distant=env.document.createElement('div');
  editor.setAttribute('contenteditable','true');env.document.body.append(left,editor,header,distant);
  const fallback=f.row('Guide','',left),editing=f.row('Guide','',editor),heading=f.row('Guide','',header),right=f.row('Guide','',distant);right.link._rect={left:700,right:980,top:0,bottom:42,width:280,height:42};
  const others=[editing,heading,right],before=others.map(nativeSnapshot);env.api.update([item()]);env.settle();assert.ok(card(fallback));assert.equal(cards(env).length,1);
  for(const [index,row] of others.entries())assertRestored(row,before[index]);
});

check('new native task icons retain identity and receive a visible layer that is removed on cleanup',()=>{
  const env=environment(),f=fixture(env),guide=f.row('Guide');env.api.update([item()]);env.settle();
  const wrapper=env.document.createElement('span'),icon=env.document.createElementNS('http://www.w3.org/2000/svg','svg');wrapper.setAttribute('role','status');wrapper.setAttribute('aria-label','Running');wrapper.append(icon);guide.link.append(wrapper);env.settle();
  assert.equal(icon.parentNode,wrapper);assert.equal(wrapper.parentNode,guide.link);assert.ok(Number(wrapper.style.zIndex)>=3);assert.ok(Number(icon.style.zIndex)>=4);assert.equal(cards(env).length,1);
  env.api.update([]);env.settle();assert.equal(icon.parentNode,wrapper);assert.equal(wrapper.parentNode,guide.link);assert.equal(wrapper.style.cssText,'');assert.equal(icon.style.cssText,'');assert.equal(guide.icon.style.cssText,'');
});

check('reduced motion, document hiding and uninstall cancel interaction frames',()=>{
  const env=environment(),f=fixture(env),guide=f.row('Guide');env.api.update([item()]);env.settle();
  const move=()=>guide.link.dispatchEvent({type:'pointermove',pointerType:'mouse',clientX:210,clientY:8});
  move();move();assert.equal(env.frames.size,1);env.motion.matches=true;env.motion.dispatchEvent({type:'change'});assert.equal(env.frames.size,0);move();assert.equal(env.frames.size,0);assert.equal(card(guide).style.getPropertyValue('--mai-rx'),'');
  env.motion.matches=false;move();assert.equal(env.frames.size,1);env.document.hidden=true;env.document.dispatchEvent({type:'visibilitychange'});assert.equal(env.frames.size,0);move();assert.equal(env.frames.size,0);
  env.document.hidden=false;env.document.dispatchEvent({type:'visibilitychange'});env.settle();move();assert.equal(env.frames.size,1);env.api.uninstall();assert.equal(env.frames.size,0);move();env.settle();assert.equal(env.frames.size,0);
});

check('native status metadata cannot supply a chat title when the actual title is a plain text leaf',()=>{
  const env=environment(),f=fixture(env),ordinary=f.row('Ordinary chat');ordinary.label.removeAttribute('title');ordinary.state.setAttribute('role','status');ordinary.state.setAttribute('aria-label','Guide');ordinary.state.textContent='Guide';
  const before=nativeSnapshot(ordinary);env.api.update([item()]);env.settle();assert.equal(cards(env).length,0,'role=status metadata is not a title binding');assertRestored(ordinary,before);
});

check('a later host icon style survives subsequent reconciliations and uninstall',()=>{
  const env=environment(),f=fixture(env),guide=f.row('Guide');env.api.update([item()]);env.settle();guide.icon.style.setProperty('z-index','99','important');guide.icon.style.setProperty('position','absolute','important');
  guide.state.setAttribute('aria-label','Running');env.settle();assert.equal(guide.icon.style.zIndex,'99','a later native icon style is no longer owned by the decoration');env.api.uninstall();env.settle();assert.equal(guide.icon.style.zIndex,'99');assert.equal(guide.icon.style.position,'absolute');assert.equal(guide.icon.style.getPropertyPriority('z-index'),'important');
});

check('navigation inside a main app shell works while article and editor wrappers remain excluded',()=>{
  const env=environment(),f=fixture(env);f.main.setAttribute('role','main');f.main.append(f.aside);f.main.forbidTextRead=true;const allowed=f.row('Guide');
  const article=env.document.createElement('article'),editor=env.document.createElement('div'),articleNav=env.document.createElement('nav'),editorNav=env.document.createElement('nav');editor.setAttribute('contenteditable','plaintext-only');article.append(articleNav);editor.append(editorNav);env.document.body.append(article,editor);
  const blockedArticle=f.row('Guide','article-chat',articleNav),blockedEditor=f.row('Guide','editor-chat',editorNav),before=[blockedArticle,blockedEditor].map(nativeSnapshot);
  env.api.update([item()]);env.settle();assert.ok(card(allowed));assert.equal(cards(env).length,1);assertRestored(blockedArticle,before[0]);assertRestored(blockedEditor,before[1]);
});

check('exact document title changes update only the owned current marker and preserve native aria state',()=>{
  const env=environment(),f=fixture(env),guide=f.row('Guide'),maker=f.row('Maker');env.document.title='Guide';env.api.update([item(),item('maker',[{kind:'title',key:'Maker'}])]);env.settle();
  assert.ok(guide.link.hasAttribute('data-mai-sidebar-current'));assert.equal(maker.link.hasAttribute('data-mai-sidebar-current'),false);
  env.document.title='Maker';env.settle();assert.equal(guide.link.hasAttribute('data-mai-sidebar-current'),false);assert.ok(maker.link.hasAttribute('data-mai-sidebar-current'));
  env.document.title='Maker extra';env.settle();assert.equal(guide.link.hasAttribute('data-mai-sidebar-current'),false);assert.equal(maker.link.hasAttribute('data-mai-sidebar-current'),false);
  for(const row of [guide,maker]){assert.equal(row.link.getAttribute('aria-current'),'false');assert.equal(row.link.getAttribute('aria-selected'),null);}
  guide.link.setAttribute('data-mai-sidebar-current','host-owned');env.document.title='Guide';env.settle();assert.equal(guide.link.getAttribute('data-mai-sidebar-current'),'host-owned');env.api.uninstall();env.settle();assert.equal(guide.link.getAttribute('data-mai-sidebar-current'),'host-owned');assert.equal(maker.link.getAttribute('data-mai-sidebar-current'),null);
});

check('a direct text row fails closed with a count-only missing-label diagnostic',()=>{
  const env=environment(),f=fixture(env),row=env.document.createElement('a'),secretTitle='Private fixture title 93872';row.href='/threads/direct-text';row.title=secretTitle;row.textContent=secretTitle;f.nav.append(row);
  env.document.title=secretTitle;env.api.update([item('guide',[{kind:'title',key:secretTitle}])]);env.settle();assert.equal(cards(env).length,0);assert.equal(row.textContent,secretTitle);assert.equal(row.hasAttribute('data-mai-sidebar-row'),false);
  const state=env.api.status();assert.equal(state.diagnostics.missingLabel,1);assert.ok(Object.values(state.diagnostics).every(value=>typeof value==='number'));assert.equal(JSON.stringify(state).includes(secretTitle),false);assert.equal(Object.hasOwn(state,'title'),false);assert.equal(Object.hasOwn(state,'titles'),false);
});

check('duplicate title rows for the same proven thread can both decorate without replacing either native icon',()=>{
  for(const identity of ['href','data-thread-id']){
    const env=environment(),f=fixture(env),recent=env.document.createElement('nav');f.aside.append(recent);
    const first=f.row('Guide',identity==='href'?'same-thread':''),second=f.row('Guide',identity==='href'?'same-thread':'',recent);
    if(identity==='data-thread-id')for(const row of [first,second])row.link.setAttribute('data-thread-id','same-thread');
    const before=[first,second].map(nativeSnapshot);env.api.update([item()]);env.settle();assert.equal(cards(env).length,2,`${identity} proves both rows navigate to the same thread`);
    for(const [index,row] of [first,second].entries()){assert.ok(card(row));assertNativeIdentity(row,before[index]);assert.equal(row.link.querySelector('svg'),row.icon);}
    env.api.update([]);env.settle();for(const [index,row] of [first,second].entries())assertRestored(row,before[index]);
  }
});

check('duplicate titles with different or unknown thread targets still fail closed',()=>{
  for(const ids of [['first','second'],['first',''],['','']]){
    const env=environment(),f=fixture(env),first=f.row('Guide',ids[0]),second=f.row('Guide',ids[1]),before=[first,second].map(nativeSnapshot);
    env.api.update([item()]);env.settle();assert.equal(cards(env).length,0,'only an equal stable thread target resolves duplicate titles');assertRestored(first,before[0]);assertRestored(second,before[1]);
  }
});

check('an explicit project scope decorates its five unknown-target rows and leaves matching recents native',()=>{
  const env=environment({projectTitle:'Example project'}),f=projectFixture(env),project=f.section('Example project'),recents=f.section('最近'),names=['Guide','Maker','MakerPlus','Planner','MakerAlt'];
  const projectRows=names.map(name=>f.row(name,project.rows)),recentRows=names.map(name=>f.row(name,recents.rows)),before=[...projectRows,...recentRows].map(nativeSnapshot);
  env.api.update(names.map(name=>({...item(name.toLowerCase(),[{kind:'title',key:name}]),name})));env.settle();assert.equal(cards(env).length,5);assertProjectCounts(env,{configured:true,headers:1,roots:1,matches:5});
  for(const [index,row] of projectRows.entries()){assert.ok(card(row));assertNativeIdentity(row,before[index]);}for(const [index,row] of recentRows.entries())assertRestored(row,before[index+5]);
  env.api.update([]);env.settle();for(const [index,row] of [...projectRows,...recentRows].entries())assertRestored(row,before[index]);
});

check('project scope preserves ambiguity between different thread targets inside the chosen project',()=>{
  const env=environment({projectTitle:'Example project'}),f=projectFixture(env),project=f.section('Example project'),first=f.row('Guide',project.rows,'one'),second=f.row('Guide',project.rows,'two'),before=[first,second].map(nativeSnapshot);
  env.api.update([item()]);env.settle();assert.equal(cards(env).length,0);assert.equal(env.api.status().diagnostics.ambiguous,2);assertRestored(first,before[0]);assertRestored(second,before[1]);assertProjectCounts(env,{configured:true,headers:1,roots:1,matches:2});
});

check('a missing or collapsed project scope never falls back to the recent list',()=>{
  for(const mode of ['missing','collapsed']){
    const env=environment({projectTitle:'Example project'}),f=projectFixture(env),project=f.section(mode==='missing'?'其他项目':'Example project'),recents=f.section('最近');
    const projectRow=f.row('Guide',project.rows),recentRow=f.row('Guide',recents.rows),before=[projectRow,recentRow].map(nativeSnapshot);
    if(mode==='collapsed'){project.heading.setAttribute('aria-expanded','false');project.rows.hidden=true;}
    env.api.update([item()]);env.settle();assert.equal(cards(env).length,0,`${mode} project cannot authorize a row in recents`);assertRestored(projectRow,before[0]);assertRestored(recentRow,before[1]);assertProjectCounts(env,{configured:true,roots:0,matches:0});
  }
});

check('independent projects with the same scope heading all remain native',()=>{
  const env=environment({projectTitle:'Example project'}),f=projectFixture(env),first=f.section('Example project'),second=f.section('Example project'),guide=f.row('Guide',first.rows),maker=f.row('Maker',second.rows),before=[guide,maker].map(nativeSnapshot);
  env.api.update([item(),item('maker',[{kind:'title',key:'Maker'}])]);env.settle();assert.equal(cards(env).length,0,'a duplicated scope name does not select or merge independent project branches');assertRestored(guide,before[0]);assertRestored(maker,before[1]);assertProjectCounts(env,{configured:true,headers:2,matches:0});
});

check('project scope cannot authorize an unbound new role',()=>{
  const env=environment({projectTitle:'Example project'}),f=projectFixture(env),project=f.section('Example project'),recents=f.section('最近'),guide=f.row('Guide',project.rows),stranger=f.row('NewRole',project.rows),recent=f.row('Guide',recents.rows),before=[stranger,recent].map(nativeSnapshot);
  env.api.update([item()]);env.settle();assert.equal(cards(env).length,1);assert.ok(card(guide));assertRestored(stranger,before[0]);assertRestored(recent,before[1]);assertProjectCounts(env,{configured:true,headers:1,roots:1,matches:1});
});

check('an empty project scope retains the existing duplicate-title behavior',()=>{
  const env=environment({projectTitle:''}),f=projectFixture(env),project=f.section('Example project'),recents=f.section('最近'),first=f.row('Guide',project.rows),second=f.row('Guide',recents.rows),before=[first,second].map(nativeSnapshot);
  env.api.update([item()]);env.settle();assert.equal(cards(env).length,0);assert.equal(env.api.status().diagnostics.ambiguous,2);assertRestored(first,before[0]);assertRestored(second,before[1]);assertProjectCounts(env,{configured:false});
});

check('streaming conversation and editor mutations schedule no scans or geometry reads',()=>{
  const env=environment({projectTitle:'Example project'}),f=projectFixture(env),project=f.section('Example project'),guide=f.row('Guide',project.rows);
  const article=env.document.createElement('article'),paragraph=env.document.createElement('p'),editor=env.document.createElement('div');editor.setAttribute('contenteditable','true');article.append(paragraph);f.main.append(article,editor);
  env.api.update([item()]);env.settle();assert.ok(card(guide));const before=env.api.status().performance,geometry=env.metrics.geometryReads,queries=env.metrics.documentQueries;
  for(let i=0;i<120;i++){
    env.characterMutation(paragraph,`token ${i}`);paragraph.textContent=`reply ${i}`;editor.textContent=`typing ${i}`;env.step();
  }
  env.settle();const after=env.api.status().performance;
  assert.equal(after.scans,before.scans);assert.equal(env.metrics.geometryReads,geometry);assert.equal(env.metrics.documentQueries,queries);assert.equal(env.frames.size+env.timers.size,0);assert.ok(after.ignoredMutations>=before.ignoredMutations+360);
});

check('plain streaming nodes inside main are ignored even without message-specific selectors',()=>{
  const env=environment(),f=fixture(env),guide=f.row('Guide'),stream=env.document.createElement('div');f.main.append(stream);env.api.update([item()]);env.settle();
  const scans=env.api.status().performance.scans,geometry=env.metrics.geometryReads;
  for(let i=0;i<50;i++){const span=env.document.createElement('span');span.textContent=`ordinary text ${i}`;stream.append(span);env.characterMutation(span,`updated ${i}`);env.step();}
  env.settle();assert.equal(env.api.status().performance.scans,scans);assert.equal(env.metrics.geometryReads,geometry);assert.ok(card(guide));
});

check('navigation updates reuse cached roots without querying the document tree',()=>{
  const env=environment({projectTitle:'Example project'}),f=projectFixture(env),project=f.section('Example project'),guide=f.row('Guide',project.rows);env.api.update([item()]);env.settle();
  const before=env.api.status().performance,queries=env.metrics.documentQueries;
  guide.state.setAttribute('aria-label','Running');env.settle();const after=env.api.status().performance;
  assert.equal(env.metrics.documentQueries,queries);assert.equal(after.fullScans,before.fullScans);assert.equal(after.scopedScans,before.scopedScans+1);assert.ok(after.scopeCount>=1);assert.ok(card(guide));
});

check('frequent native status changes are rate limited and their last value is preserved',()=>{
  const env=environment(),f=fixture(env),guide=f.row('Guide');env.api.update([item()]);env.settle();const scans=env.api.status().performance.scans;
  for(let i=0;i<80;i++){guide.state.setAttribute('aria-label',`state ${i}`);env.step();}
  env.settle();const delta=env.api.status().performance.scans-scans;
  assert.ok(delta>1&&delta<=10,`80 frame-spaced mutations used ${delta} reconciliations`);assert.equal(guide.state.getAttribute('aria-label'),'state 79');assert.equal(guide.link.querySelector('svg'),guide.icon);assert.ok(card(guide));
});

check('replacing the sidebar discovers the new container and cleans detached owned rows',()=>{
  const env=environment(),f=fixture(env),old=f.row('Guide');env.api.update([item()]);env.settle();const before=env.api.status().performance;
  f.aside.remove();const replacement=env.document.createElement('aside'),nav=env.document.createElement('nav');replacement.append(nav);env.document.body.append(replacement);const fresh=f.row('Guide','',nav);env.settle();
  assert.ok(card(fresh));assert.equal(card(old),null);assert.equal(old.link.hasAttribute('data-mai-sidebar-row'),false);assert.equal(cards(env).length,1);assert.ok(env.api.status().performance.fullScans>before.fullScans);
});

check('a new navigation branch with a duplicate title invalidates cached scope and fails closed',()=>{
  const env=environment(),f=fixture(env),first=f.row('Guide','first');env.api.update([item()]);env.settle();assert.ok(card(first));
  const newAside=env.document.createElement('aside'),newNav=env.document.createElement('nav');newAside.append(newNav);env.document.body.append(newAside);const duplicate=f.row('Guide','second',newNav);env.settle();
  assert.equal(card(first),null);assert.equal(card(duplicate),null);assert.equal(env.api.status().diagnostics.ambiguous,2);
  newAside.remove();env.settle();assert.ok(card(first));assert.equal(cards(env).length,1);
});

check('cached project scope detects a newly added duplicate heading and recovers after its removal',()=>{
  const env=environment({projectTitle:'Example project'}),f=projectFixture(env),first=f.section('Example project'),guide=f.row('Guide',first.rows);env.api.update([item()]);env.settle();assert.ok(card(guide));
  const second=f.section('Example project'),maker=f.row('Maker',second.rows);env.settle();assert.equal(cards(env).length,0);assertProjectCounts(env,{headers:2,matches:0});
  second.section.remove();env.settle();assert.ok(card(guide));assert.equal(card(maker),null);assertProjectCounts(env,{headers:1,roots:1,matches:1});
});

check('character data changes in a cached plain-text title clear a recycled row',()=>{
  const env=environment(),f=fixture(env),guide=f.row('Guide');guide.label.removeAttribute('title');env.api.update([item()]);env.settle();assert.ok(card(guide));
  env.characterMutation(guide.label,'Ordinary chat');env.settle();assert.equal(card(guide),null);
});

check('hiding and uninstalling cancel deferred reconciliation timers',()=>{
  const env=environment(),f=fixture(env),guide=f.row('Guide');env.api.update([item()]);env.settle();guide.state.setAttribute('aria-label','Running');env.deliver();assert.equal(env.frames.size+env.timers.size,1);
  env.document.hidden=true;env.document.dispatchEvent({type:'visibilitychange'});assert.equal(env.frames.size+env.timers.size,0);
  env.document.hidden=false;env.document.dispatchEvent({type:'visibilitychange'});env.settle();guide.state.setAttribute('aria-label','Done');env.deliver();assert.equal(env.frames.size+env.timers.size,1);env.api.uninstall();env.settle();assert.equal(env.frames.size+env.timers.size,0);assert.equal(cards(env).length,0);
});

check('moving an existing native task icon into a new wrapper raises that wrapper without replacing the icon',()=>{
  const env=environment(),f=fixture(env),guide=f.row('Guide');env.api.update([item()]);env.settle();const originalCard=card(guide);
  const wrapper=env.document.createElement('span');wrapper.setAttribute('role','status');guide.link.append(wrapper);wrapper.append(guide.icon);env.settle();
  assert.equal(card(guide),originalCard);assert.equal(guide.icon.parentNode,wrapper);assert.ok(Number(wrapper.style.zIndex)>=3);assert.equal(guide.icon.style.zIndex,'4');
  env.api.uninstall();env.settle();assert.equal(guide.icon.parentNode,wrapper);assert.equal(wrapper.style.cssText,'');assert.equal(guide.icon.style.cssText,'');
});

check('a semantic navigation first mounted inside main is discovered without scanning conversation text',()=>{
  const env=environment(),f=fixture(env),first=f.row('Guide','first');env.api.update([item()]);env.settle();
  const otherAside=env.document.createElement('aside'),otherNav=env.document.createElement('nav');otherAside.append(otherNav);f.main.append(otherAside);const duplicate=f.row('Guide','second',otherNav);f.main.forbidTextRead=true;env.settle();
  assert.equal(card(first),null);assert.equal(card(duplicate),null);assert.equal(env.api.status().diagnostics.ambiguous,2);
});

check('history changes reuse navigation roots and update the current marker for stable thread bindings',()=>{
  const env=environment(),f=fixture(env),guide=f.row('Guide','one'),maker=f.row('Maker','two');env.location.href='app://-/threads/one';
  env.api.update([item('guide',[{kind:'thread',key:'one'}]),item('maker',[{kind:'thread',key:'two'}])]);env.settle();
  assert.ok(guide.link.hasAttribute('data-mai-sidebar-current'));assert.equal(maker.link.hasAttribute('data-mai-sidebar-current'),false);const before=env.api.status().performance;
  for(let i=0;i<20;i++){
    const useMaker=i%2===0;env.location.href=`app://-/threads/${useMaker?'two':'one'}`;env.window.dispatchEvent({type:i%2?'popstate':'hashchange'});env.settle();
    assert.equal(maker.link.hasAttribute('data-mai-sidebar-current'),useMaker);assert.equal(guide.link.hasAttribute('data-mai-sidebar-current'),!useMaker);
  }
  const after=env.api.status().performance;assert.equal(after.fullScans,before.fullScans);assert.equal(after.scopedScans-before.scopedScans,20);
});

check('custom role identifiers and missing signature fonts use generic decoration without identity assets',()=>{
  const env=environment({signatureForRole:null}),f=fixture(env),row=f.row('Custom role');
  env.api.update([item('constructor',[{kind:'title',key:'Custom role'}])]);env.settle();const layer=card(row),name=layer.querySelector('.mai-sidebar-name');
  assert.ok(layer);assert.match(name.style.fontFamily,/MaiWorkBadgesDisplay/);assert.equal(name.style.fontSize,'21px');assert.equal(name.style.getPropertyValue('--mai-signature-angle'),'0deg');
  env.api.update([{...item('constructor',[{kind:'title',key:'Custom role'}]),characterDataUrl:'',backgroundDataUrl:''}]);env.settle();assert.equal(card(row).querySelectorAll('img').length,0);env.api.uninstall();
});
check('native text and CSS status children stay above decoration and restore their original styles',()=>{
  const env=environment(),f=fixture(env),row=f.row('Guide'),dot=env.document.createElement('span');dot.className='native-css-dot';row.state.textContent='Scheduled';row.link.append(dot);
  const stateStyle=row.state.style.cssText,dotStyle=dot.style.cssText;env.api.update([item()]);env.settle();
  assert.equal(row.state.textContent,'Scheduled');assert.ok(Number(row.state.style.zIndex)>=3);assert.ok(Number(dot.style.zIndex)>=3);assert.equal(row.label.style.opacity,'0');
  row.state.style.setProperty('z-index','40','important');row.state.setAttribute('aria-label','Running');env.settle();assert.equal(row.state.style.zIndex,'40');
  env.api.uninstall();env.settle();assert.equal(row.state.style.zIndex,'40');assert.equal(row.state.style.position,'');assert.equal(dot.style.cssText,dotStyle);assert.equal(stateStyle,'');
});

process.stdout.write(`${checks} offline sidebar checks passed\n`);
