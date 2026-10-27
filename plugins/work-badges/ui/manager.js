/* Self-contained MCP Apps manager. User data is rendered with textContent only. */
(() => {
  'use strict';
  const MAX_IMAGE=3*1024*1024,MAX_HOLO_LAYER=5*1024*1024;
  const DEFAULT_HOLO_MATERIAL=Object.freeze({power:1.3,depth:1.25,contourBrightness:.15});
  // Asset-authored tuning only: keep the authored demo preset in sync with the
  // other product surface. Role names and user-provided options never select it.
  const HOLO_MATERIAL_PRESETS=Object.freeze({
    'bad02c86952324615efafffa529bcd2249529066dded16c645d61978c4667cb2':Object.freeze({power:.35,depth:1.5,contourBrightness:0,foregroundFoil:0,subjectGlow:0})
  });
  function holoMaterialPreset(imageId){return Object.hasOwn(HOLO_MATERIAL_PRESETS,imageId)?HOLO_MATERIAL_PRESETS[imageId]:DEFAULT_HOLO_MATERIAL;}

  function blank(){return {name:'',chineseName:'',role:'',bio:'',serial:'',duties:[],approval:''};}
  function profileInput(fields,id,avatarDataUrl,clearAvatar){
    if(!fields||typeof fields!=='object'||(fields.duties!==undefined&&!Array.isArray(fields.duties)))throw new Error('职责格式不正确。');
    if((fields.duties||[]).some(row=>!Array.isArray(row)||row.length!==2||row.some(value=>typeof value!=='string')))throw new Error('职责格式不正确。');
    const value={...blank(),...fields,duties:(fields.duties||[]).map(row=>[row[0],row[1]])};
    const limits={name:48,chineseName:24,role:64,bio:160,serial:40,approval:160};
    const clean={};
    for(const [key,limit] of Object.entries(limits)){
      if(typeof value[key]!=='string'||value[key].length>limit)throw new Error(`${key} 的内容过长或格式不正确。`);
      clean[key]=value[key];
    }
    if(!clean.name.trim()||!clean.role.trim())throw new Error('请填写姓名和职位。');
    if(value.duties.length>5||value.duties.some(row=>!row[0].trim()||!row[1].trim()||row[0].length>40||row[1].length>160))throw new Error('职责需要填写标题和说明，最多 5 条。');
    clean.duties=value.duties;
    if(id)clean.id=id;
    if(avatarDataUrl)clean.avatarDataUrl=avatarDataUrl;
    else if(clearAvatar)clean.clearAvatar=true;
    return clean;
  }
  function recentContexts(contexts,now=Date.now()/1000){return (contexts||[]).filter(item=>{
    const stamp=typeof item.seenAt==='number'?item.seenAt:Date.parse(item.seenAt)/1000;
    return Number.isFinite(stamp)&&Math.abs(now-stamp)<20&&typeof item.title==='string';
  });}
  function contextByKey(contexts,key){return (contexts||[]).find(item=>item.contextKey===key);}
  function bindingsForRole(snapshot,roleId){return roleId?(snapshot?.bindings||[]).filter(item=>item.roleId===roleId):[];}
  function savedBinding(snapshot,target){return (snapshot?.bindings||[]).find(item=>item.roleId===target.roleId&&item.kind===target.kind&&item.key===target.key);}
  function validAvatar(value){return typeof value==='string'&&/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)&&value.length<=Math.ceil(MAX_IMAGE*4/3)+100;}
  function validHoloLayer(value){return typeof value==='string'&&/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)&&value.length<=Math.ceil(MAX_HOLO_LAYER*4/3)+100;}
  function cleanHoloAssets(value){
    const names=['character','background','ui','structure'];
    if(!value||typeof value!=='object'||Array.isArray(value)||names.some(name=>!validHoloLayer(value[name])))return null;
    return Object.fromEntries(names.map(name=>[name,value[name]]));
  }
  function matchingPreviewLayers(avatar,imageId,avatars,layers){
    if(!avatar||!imageId||avatars.get(imageId)!==avatar)return null;
    const layer=layers.get(imageId);
    const holoAssets=cleanHoloAssets(layer?.holoAssets),foregroundDataUrl=validHoloLayer(layer?.foregroundDataUrl)?layer.foregroundDataUrl:null;
    if(!foregroundDataUrl&&!holoAssets)return null;
    return {foregroundDataUrl,contourDataUrl:foregroundDataUrl&&validHoloLayer(layer.contourDataUrl)?layer.contourDataUrl:null,holoAssets};
  }
  // Adapted from Holo Card's view mapping and cosine spectrum; no continuous render loop.
  function previewMotion(x,y){
    const clamp=value=>Math.max(-.5,Math.min(.5,Number.isFinite(value)?value:0));
    x=clamp(x);y=clamp(y);
    const rx=-y*28,ry=x*36,viewX=Math.sin(ry*Math.PI/180)*.65,viewY=Math.sin(rx*Math.PI/180)*.65;
    const phase=((x+.5)*.62+(y+.5)*.36+viewX*1.9+viewY*.8)*2.2;
    const spectrum=[0,.33,.67].map(offset=>Math.round((.52+.48*Math.cos(2*Math.PI*(phase+offset)))*255));
    return {'--rx':`${rx}deg`,'--ry':`${ry}deg`,'--px':`${(x+.5)*100}%`,'--py':`${(y+.5)*100}%`,
      '--fg-x':`${viewX*28}px`,'--fg-y':`${-viewY*28}px`,'--bg-x':`${-viewX*70}px`,'--bg-y':`${viewY*70}px`,
      '--foil-angle':`${125+viewX*360-viewY*120}deg`,'--foil-shift':`${50+(viewX*1.9+viewY*.8)*180}%`,'--holo-color':`rgb(${spectrum.join(' ')})`};
  }
  function createThemeController(surface){
    const root=surface.document?.documentElement;
    const valid=value=>value==='light'||value==='dark';
    const media=typeof surface.matchMedia==='function'?surface.matchMedia('(prefers-color-scheme: dark)'):null;
    let hostTheme=null,legacyTheme=valid(surface.openai?.theme)?surface.openai.theme:null,closed=false;
    function paint(){if(!closed&&root)root.setAttribute('data-theme',hostTheme||legacyTheme||(media?.matches?'dark':'light'));}
    function updateHost(context){
      if(!closed&&context&&typeof context==='object'&&!Array.isArray(context)&&valid(context.theme)){hostTheme=context.theme;paint();}
    }
    function updateLegacy(event){const theme=event.detail?.globals?.theme;if(valid(theme)){legacyTheme=theme;paint();}}
    surface.addEventListener('openai:set_globals',updateLegacy);
    media?.addEventListener('change',paint);
    paint();
    return {updateHost,close(){closed=true;surface.removeEventListener('openai:set_globals',updateLegacy);media?.removeEventListener('change',paint);}};
  }
  function createBridge(surface,{timeout=20000}={}){
    let counter=0,ready=null,legacy=false,closed=false;
    const theme=createThemeController(surface);
    const requests=new Map();
    const post=(message)=>surface.parent.postMessage({jsonrpc:'2.0',...message},'*');
    const notify=(method,params)=>post({method,params});
    function rpc(method,params){
      if(closed)return Promise.reject(new Error('管理页已关闭。'));
      return new Promise((resolve,reject)=>{
        const id=++counter;
        const timer=surface.setTimeout(()=>{requests.delete(id);reject(new Error('插件响应超时，请重新连接。'));},timeout);
        requests.set(id,{resolve,reject,timer});post({id,method,params});
      });
    }
    function receive(event){
      if(event.source!==surface.parent)return;
      const message=event.data;
      if(!message||message.jsonrpc!=='2.0')return;
      if(message.id===undefined&&message.method==='ui/notifications/host-context-changed'){theme.updateHost(message.params);return;}
      if(typeof message.id!=='number')return;
      const request=requests.get(message.id);if(!request)return;
      requests.delete(message.id);surface.clearTimeout(request.timer);
      if(message.error)request.reject(new Error(typeof message.error.message==='string'?message.error.message:'插件连接失败。'));
      else request.resolve(message.result);
    }
    surface.addEventListener('message',receive);
    async function connect(){
      if(!ready)ready=(async()=>{
        try{
          const initialized=await rpc('ui/initialize',{appInfo:{name:'work-badges-manager',version:'0.8.0'},appCapabilities:{},protocolVersion:'2026-01-26'});
          theme.updateHost(initialized?.hostContext);
          notify('ui/notifications/initialized',{});
        }catch(error){
          if(typeof surface.openai?.callTool==='function')legacy=true;
          else {ready=null;throw error;}
        }
      })();
      return ready;
    }
    return {connect,async call(name,args={}){
      await connect();
      const result=legacy?await surface.openai.callTool(name,args):await rpc('tools/call',{name,arguments:args});
      if(!result||typeof result!=='object')throw new Error('插件返回了无法读取的结果。');
      if(result.isError){
        const text=(result.content||[]).filter(item=>item.type==='text').map(item=>item.text).join('\n');
        const error=new Error(text||'操作未完成，请检查输入。');error.reload=Boolean(result._meta?.error?.reload);throw error;
      }
      return result;
    },close(){
      closed=true;surface.removeEventListener('message',receive);theme.close();
      for(const item of requests.values()){surface.clearTimeout(item.timer);item.reject(new Error('管理页已关闭。'));}requests.clear();
    }};
  }
  const Pure={blank,profileInput,recentContexts,contextByKey,bindingsForRole,savedBinding,validAvatar,validHoloLayer,cleanHoloAssets,matchingPreviewLayers,previewMotion,createThemeController,createBridge};
  if(typeof module!=='undefined'&&module.exports)module.exports=Pure;
  if(typeof window==='undefined'||!window.document)return;
  window.WorkBadgeManagerPure=Object.freeze(Pure);
  const $=id=>document.getElementById(id);
  const state={snapshot:null,selected:null,dirty:false,busy:false,mutation:null,connected:false,baseVersion:0,avatar:null,avatarImageId:null,clearAvatar:false,avatarToken:0,pendingSelection:undefined};
  let bridge=createBridge(window),timer=null,previewBack=false;
  const avatarCache=new Map(),holoLayerCache=new Map();
  let previewFrame=null,previewMaterial=null,previewMaterialSignature='',previewMaterialToken=0,previewMaterialAbort=null;
  let previewView={x:0,y:0,pointerX:.5,pointerY:.5,active:false};
  const previewReducedMotion=typeof window.matchMedia==='function'?window.matchMedia('(prefers-reduced-motion: reduce)'):null;
  function resetPreviewMotion(){
    if(previewFrame!==null){window.cancelAnimationFrame?.(previewFrame);previewFrame=null;}
    const preview=$('preview');preview.removeAttribute('data-hover');
    for(const key of Object.keys(previewMotion(0,0)))preview.style.removeProperty(key);
    previewView={x:0,y:0,pointerX:.5,pointerY:.5,active:false};
    if(!document.hidden)previewMaterial?.setView(previewView);
  }
  function disposePreviewMaterial(){
    ++previewMaterialToken;previewMaterialAbort?.abort();previewMaterialAbort=null;
    previewMaterial?.dispose();previewMaterial=null;previewMaterialSignature='';
    $('preview').removeAttribute('data-material');
  }
  function syncPreviewMaterial(layers){
    const assets=layers?.holoAssets,preview=$('preview'),canvas=$('preview-material');
    // Registry revisions also include bindings and other colleagues. Only this
    // portrait's identity and pixels can require a new GPU material.
    const signature=assets?JSON.stringify([state.selected,state.avatarImageId,state.avatar,assets]):'';
    if(signature&&signature===previewMaterialSignature)return;
    disposePreviewMaterial();
    if(!assets||document.hidden)return;
    previewMaterialSignature=signature;
    if(typeof createBadgeHoloRenderer!=='function'||typeof canvas.getContext!=='function'){preview.setAttribute('data-material','fallback');return;}
    const token=previewMaterialToken,controller=typeof AbortController==='function'?new AbortController():null;
    const materialOptions=holoMaterialPreset(state.avatarImageId);
    previewMaterialAbort=controller;preview.setAttribute('data-material','loading');
    const fallback=()=>{if(token!==previewMaterialToken)return;++previewMaterialToken;previewMaterial?.dispose();previewMaterial=null;controller?.abort();previewMaterialAbort=null;preview.setAttribute('data-material','fallback');};
    Promise.resolve().then(()=>{if(token!==previewMaterialToken||controller?.signal.aborted)return null;return createBadgeHoloRenderer(canvas,assets,{width:800,...materialOptions,signal:controller?.signal,onLost:fallback});}).then(material=>{
      if(token!==previewMaterialToken||controller?.signal.aborted){material?.dispose();return;}
      if(!material||typeof material.setView!=='function'||typeof material.dispose!=='function'){material?.dispose?.();fallback();return;}
      previewMaterial=material;preview.setAttribute('data-material','webgl');
      material.setView(previewBack||previewReducedMotion?.matches?{x:0,y:0,pointerX:.5,pointerY:.5,active:false}:previewView);
    }).catch(fallback);
  }
  function announce(message,error=false){$('status').textContent=message;$('statusbar').toggleAttribute('data-error',error);}
  function bindingFeedback(message,error=false){const node=$('binding-feedback');node.textContent=message;node.hidden=!message;node.toggleAttribute('data-error',error);}
  function renderRoleStatus(){
    const role=currentRole(),count=bindingsForRole(state.snapshot,state.selected).length;
    const pill=$('role-state');
    pill.textContent=state.selected?(role?.enabled===false?'已停用':'已启用'):'待保存';
    pill.dataset.state=state.selected?(role?.enabled===false?'disabled':'enabled'):'draft';
    $('role-binding-state').textContent=!state.selected?'保存工牌后，可绑定对应聊天。':count?`已绑定 ${count} 个聊天${role?.enabled===false?' · 启用后恢复显示':''}`:'尚未绑定聊天 · 在「聊天绑定」中保存对应关系';
    for(const id of ['binding-tab-count','binding-list-count'])$(id).textContent=String(count);
    $('preview-save-state').textContent=state.dirty?'当前为未保存预览，保存后才会同步。':state.selected?'已保存资料的预览。':'新增工牌的预览，尚未保存。';
    $('binding-prerequisite').hidden=Boolean(state.selected&&!state.dirty);
    $('binding-prerequisite').textContent=state.selected?'工牌资料有未保存的修改，请先保存或放弃修改，再设置绑定。':'请先保存这张工牌，再设置聊天绑定。';
  }
  function controls(){
    const available=state.connected&&!state.busy;
    $('profile-fields').disabled=!available;
    $('binding-fields').disabled=!available||!state.selected||state.dirty;
    for(const id of ['new-role','copy-role','toggle-role'])$(id).disabled=!available||(id!=='new-role'&&!state.selected);
    $('save-profile').textContent=state.mutation==='work_badges_save'?'正在保存…':'保存工牌';
    $('save-binding').textContent=state.mutation==='work_badges_bind'?'正在保存绑定…':'保存聊天绑定';
    $('statusbar').toggleAttribute('data-connected',state.connected);
    $('dirtybar').hidden=!state.dirty;
    document.querySelectorAll('.role-item').forEach(button=>button.disabled=state.busy);
    renderRoleStatus();
  }
  function markDirty(){state.dirty=true;$('dirty-message').textContent='有未保存的修改。';controls();renderPreview();}
  function fields(){return {name:$('name').value,chineseName:$('chinese-name').value,role:$('role').value,bio:$('bio').value,serial:$('serial').value,
    approval:$('approval').value,duties:[...$('duties').children].map(row=>[row.querySelector('[data-title]').value,row.querySelector('[data-copy]').value])};}
  function dutyRow(title='',copy=''){
    const row=document.createElement('div');row.className='duty-row';
    const heading=document.createElement('input');heading.dataset.title='';heading.maxLength=40;heading.value=title;heading.placeholder='职责名称';heading.setAttribute('aria-label','职责名称');
    const body=document.createElement('input');body.dataset.copy='';body.maxLength=160;body.value=copy;body.placeholder='简短说明';body.setAttribute('aria-label','职责说明');
    const remove=document.createElement('button');remove.className='text-button';remove.type='button';remove.setAttribute('aria-label','移除此条职责');
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
    const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d','m6 6 12 12M18 6 6 18');svg.append(path);remove.append(svg);
    remove.addEventListener('click',()=>{row.remove();markDirty();$('add-duty').disabled=false;});
    row.append(heading,body,remove);$('duties').append(row);
    $('add-duty').disabled=$('duties').children.length>=5;
  }
  function currentRole(){return state.snapshot?.roles.find(role=>role.id===state.selected);}
  function listRoles(){
    const fragment=document.createDocumentFragment();
    $('role-count').textContent=String(state.snapshot?.roles?.length||0);
    for(const role of state.snapshot?.roles||[]){
      const button=document.createElement('button');button.type='button';button.className='role-item';button.setAttribute('aria-pressed',String(role.id===state.selected));
      const monogram=document.createElement('span');monogram.className='role-monogram';monogram.textContent=Array.from(role.name||'?').slice(0,1).join('').toUpperCase();monogram.setAttribute('aria-hidden','true');
      const copy=document.createElement('span');copy.className='role-item-copy';
      const name=document.createElement('span');name.className='role-name';name.textContent=role.name;
      const job=document.createElement('small');job.textContent=role.role;
      const count=bindingsForRole(state.snapshot,role.id).length;
      const note=document.createElement('span');note.className='role-binding-note';note.textContent=role.enabled===false?'已停用':count?`已绑定 ${count} 个聊天`:'未绑定聊天';
      copy.append(name,job,note);button.append(monogram,copy);
      button.addEventListener('click',()=>requestSelection(role.id));fragment.append(button);
    }
    $('role-list').replaceChildren(fragment);
  }
  function requestSelection(id){
    if(state.dirty){state.pendingSelection=id;$('dirty-message').textContent='请先保存，或放弃修改后切换工牌。';$('dirtybar').hidden=false;$('discard').focus();return;}
    selectRole(id);
  }
  async function selectRole(id,copyFrom=null){
    const role=copyFrom||state.snapshot.roles.find(item=>item.id===id)||blank();
    const imageId=role.imageId||null;
    // Retain only the exact saved portrait of the same colleague. Uploaded
    // drafts, cleared images and different roles must never inherit its layers.
    const preservePreview=!copyFrom&&state.selected===id&&state.avatarImageId===imageId&&
      (imageId?Boolean(state.avatar)&&avatarCache.get(imageId)===state.avatar:!state.avatar);
    state.selected=id;state.dirty=Boolean(copyFrom);state.pendingSelection=undefined;state.clearAvatar=false;
    if(!preservePreview){state.avatar=null;state.avatarImageId=imageId;resetPreviewMotion();disposePreviewMaterial();}
    const token=++state.avatarToken;
    state.baseVersion=state.snapshot.version;
    for(const [field,key] of [['name','name'],['chinese-name','chineseName'],['role','role'],['bio','bio'],['serial','serial'],['approval','approval']])$(field).value=role[key]||'';
    $('avatar').value='';$('duties').replaceChildren();for(const row of role.duties||[])dutyRow(row[0],row[1]);$('add-duty').disabled=(role.duties||[]).length>=5;
    $('editor-title').textContent=id?`${role.name} 的工牌`:'新增工牌';$('toggle-role').textContent=role.enabled===false?'启用':'停用';
    $('binding-key').value='';$('binding-label').value='';$('title-confirm').checked=false;$('replace-confirm').checked=false;
    bindingFeedback('');
    if(!preservePreview)previewBack=false;
    renderPreview();listRoles();renderContexts();updateBindingKind(true);renderBindings();controls();
    if(role.imageId&&!preservePreview){
      try{
        let image=avatarCache.get(role.imageId);
        if(!image){
          const result=await bridge.call('work_badges_avatar',{imageId:role.imageId});image=result._meta?.avatarDataUrl;
          if(validAvatar(image)){
            avatarCache.set(role.imageId,image);
            const holoAssets=cleanHoloAssets(result._meta?.holoAssets);
            if(validHoloLayer(result._meta?.foregroundDataUrl)||holoAssets)holoLayerCache.set(role.imageId,{foregroundDataUrl:result._meta.foregroundDataUrl,contourDataUrl:result._meta.contourDataUrl,holoAssets});
          }
        }
        if(token===state.avatarToken&&validAvatar(image)){state.avatar=image;renderPreview();}
      }catch(error){if(token===state.avatarToken)announce('头像未能读取；资料仍可编辑。',true);}
    }
  }
  function renderPreview(){
    const data=fields();
    for(const [id,value] of [['preview-name',data.name||'姓名'],['preview-cn',data.chineseName],['preview-role',data.role||'职位'],['preview-bio',data.bio],['preview-serial',data.serial],['preview-back-name',`${data.name||'角色'} 的职责`],['preview-approval',data.approval]])$(id).textContent=value;
    $('preview-initials').textContent=Array.from(data.name.trim()||'M').slice(0,1).join('').toUpperCase();
    const layers=matchingPreviewLayers(state.avatar,state.avatarImageId,avatarCache,holoLayerCache);
    const image=$('preview-image');image.hidden=!state.avatar;$('preview-initials').hidden=Boolean(state.avatar);
    if(state.avatar)image.src=layers?.foregroundDataUrl||state.avatar;else image.removeAttribute('src');
    $('preview').toggleAttribute('data-layered',Boolean(layers?.foregroundDataUrl));
    syncPreviewMaterial(layers);
    const contour=$('preview-contour');contour.hidden=!layers?.contourDataUrl;
    if(layers?.contourDataUrl){const mask=`url("${layers.contourDataUrl}")`;contour.style.setProperty('mask-image',mask);contour.style.setProperty('-webkit-mask-image',mask);}
    else {contour.style.removeProperty('mask-image');contour.style.removeProperty('-webkit-mask-image');}
    $('preview-duties').replaceChildren(...data.duties.map(([title,copy])=>{
      const row=document.createElement('span');row.className='preview-duty';const heading=document.createElement('b');heading.textContent=title;const text=document.createElement('span');text.textContent=copy;row.append(heading,text);return row;
    }));
    if(previewBack)resetPreviewMotion();
    $('preview').toggleAttribute('data-back',previewBack);$('preview').setAttribute('aria-label',previewBack?'返回工牌正面':'翻到职责背面');$('preview-toggle').textContent=previewBack?'返回正面':'查看背面';
  }
  function renderContexts(){
    const select=$('window-context'),previous=select.value;
    const contexts=recentContexts(state.snapshot?.contexts);
    select.replaceChildren();const empty=document.createElement('option');empty.value='';empty.textContent=contexts.length?'选择当前聊天窗口':'暂未发现窗口，可手动填写标题';select.append(empty);
    for(const item of contexts){const option=document.createElement('option');option.value=item.contextKey;option.textContent=item.title;select.append(option);}
    if(contexts.some(item=>item.contextKey===previous))select.value=previous;
    else if(contexts.length===1)select.value=contexts[0].contextKey;
    $('context-help').textContent=contexts.length?'选择标题与你当前聊天一致的窗口，再保存绑定。':'先登记并启用加载器，窗口标题会在这里出现。也可先填写完整标题。';
    updateBindingKind(false);
  }
  function selectedContext(){return contextByKey(recentContexts(state.snapshot?.contexts),$('window-context').value);}
  function updateBindingKind(fill=true){
    const context=selectedContext();const kind=$('binding-kind');kind.querySelector('[value=thread]').disabled=!context?.threadKey;
    if(kind.value==='thread'&&!context?.threadKey)kind.value='title';
    const isThread=kind.value==='thread';$('binding-key').readOnly=isThread;$('binding-key-label').textContent=isThread?'聊天链接标识':'完整聊天标题';$('title-confirm-wrap').hidden=isThread;
    if(fill&&context)$('binding-key').value=isThread?context.threadKey:context.title;
    checkReplacement();
  }
  function checkReplacement(){
    const kind=$('binding-kind').value,key=$('binding-key').value;
    const old=(state.snapshot?.bindings||[]).find(item=>item.kind===kind&&item.key===key&&item.roleId!==state.selected);
    $('replace-wrap').hidden=!old;
    if(old){const role=state.snapshot.roles.find(item=>item.id===old.roleId);$('replace-copy').textContent=`该聊天已绑定 ${role?.name||'其他角色'}，我要替换原绑定。`;}
    const existing=savedBinding(state.snapshot,{roleId:state.selected,kind,key});
    $('binding-draft-status').textContent=existing?'这条聊天已绑定当前工牌。再次保存可更新备注。':old?'保存后将替换这条聊天的原绑定，请核对角色与标题。':key?'这条绑定尚未保存，请确认匹配规则后点击下方按钮。':'填写完整聊天标题后，点击「保存聊天绑定」。';
    return old;
  }
  function renderBindings(){
    const bindings=bindingsForRole(state.snapshot,state.selected);
    $('binding-list').replaceChildren();
    if(!bindings.length){const empty=document.createElement('p');empty.className='empty';empty.textContent=state.selected?'还没有已保存的绑定。在下方选择聊天，确认后保存。':'请先保存这张工牌，再添加对应聊天。';$('binding-list').append(empty);return;}
    for(const binding of bindings){
      const row=document.createElement('div');row.className='binding-row';const body=document.createElement('div');const label=document.createElement('strong');label.textContent=binding.label||binding.key;
      const key=document.createElement('small');key.textContent=(binding.kind==='title'?'完整标题：':'聊天标识：')+binding.key;
      const mark=document.createElement('span');mark.className='binding-row-mark';mark.textContent='已保存绑定';body.append(label,key,mark);
      const remove=document.createElement('button');remove.type='button';remove.className='text-button';remove.textContent='解除绑定';remove.disabled=state.busy||state.dirty;
      remove.addEventListener('click',()=>mutate('work_badges_unbind',{bindingId:binding.id,expectedVersion:state.snapshot.version},'已解除绑定；对应聊天将隐藏工牌。'));
      row.append(body,remove);$('binding-list').append(row);
    }
  }
  function snapshotOf(result){const value=result.structuredContent;if(!value||!Number.isInteger(value.version)||!Array.isArray(value.roles)||!Array.isArray(value.bindings))throw new Error('工牌资料格式不正确，请重新连接。');return value;}
  async function applySnapshot(snapshot,{selectId,force=false}={}){
    const initial=!state.snapshot;
    const changed=state.snapshot&&state.snapshot.version!==snapshot.version;
    state.snapshot=snapshot;state.connected=true;
    if(force||initial||!state.dirty&&changed){
      const id=selectId!==undefined?selectId:state.selected??snapshot.roles[0]?.id??null;
      await selectRole(snapshot.roles.some(role=>role.id===id)?id:null);
    }else{
      listRoles();renderContexts();renderBindings();if(changed)renderPreview();
      if(changed){$('dirty-message').textContent='资料已在其他界面更新。你的草稿仍保留，保存时会检查冲突。';}
      controls();
    }
  }
  async function mutate(name,args,message,{newRole=false,bindingTarget=null}={}){
    if(state.busy)return;state.busy=true;state.mutation=name;controls();renderBindings();
    const oldIds=new Set(state.snapshot.roles.map(role=>role.id));
    try{
      const result=await bridge.call(name,args);const snapshot=snapshotOf(result);
      state.dirty=false;
      const selected=newRole?snapshot.roles.find(role=>!oldIds.has(role.id))?.id:state.selected;
      await applySnapshot(snapshot,{selectId:selected,force:true});
      if(bindingTarget){
        if(!savedBinding(snapshot,bindingTarget))throw new Error('返回资料中未找到这条绑定，尚不能确认保存成功。请重新读取「已保存的聊天」后检查。');
        const role=snapshot.roles.find(item=>item.id===bindingTarget.roleId);
        bindingFeedback(`已保存：${role?.name||'当前工牌'} → ${bindingTarget.key}。上方「已保存的聊天」可核对完整记录。`);
      }
      announce(message);
    }catch(error){
      announce(error.message,true);
      if(bindingTarget)bindingFeedback(error.message,true);
      if(error.reload){$('dirty-message').textContent='保存冲突：你的草稿还在。先复制需要保留的内容，再放弃修改以读取最新版。';}
    }finally{state.busy=false;state.mutation=null;controls();renderBindings();}
  }
  async function refresh(){if(!state.connected||state.busy)return;try{await applySnapshot(snapshotOf(await bridge.call('work_badges_snapshot',{})));}catch(error){announce(error.message,true);}}
  async function connect(){
    $('reconnect').disabled=true;announce('正在读取本机工牌…');
    try{await bridge.connect();await applySnapshot(snapshotOf(await bridge.call('work_badges_snapshot',{})));announce('已连接。本机保存，资料变更会自动同步。');if(!timer)timer=window.setInterval(refresh,5000);}
    catch(error){state.connected=false;controls();announce(error.message+' 请确认在本地聊天中打开了MaiBadges。',true);}
    finally{$('reconnect').disabled=false;}
  }
  $('reconnect').addEventListener('click',()=>{bridge.close();bridge=createBridge(window);connect();});
  $('new-role').addEventListener('click',()=>requestSelection(null));
  $('copy-role').addEventListener('click',()=>{
    if(state.dirty){announce('先保存或放弃当前修改，再复制工牌。',true);return;}
    const role=currentRole();if(role)selectRole(null,{...role,name:role.name+' 副本',serial:''});
  });
  $('toggle-role').addEventListener('click',()=>{
    if(state.dirty){announce('先保存或放弃修改，再改变启用状态。',true);return;}
    const role=currentRole();if(role)mutate('work_badges_enable',{roleId:role.id,enabled:!role.enabled,expectedVersion:state.snapshot.version},role.enabled?'已停用，资料和绑定保留。':'已启用工牌。');
  });
  $('discard').addEventListener('click',()=>{const next=state.pendingSelection;state.dirty=false;selectRole(next!==undefined?next:state.selected);refresh();});
  $('profile-form').addEventListener('input',event=>{if(event.target.id!=='avatar')markDirty();});
  $('profile-form').addEventListener('submit',event=>{
    event.preventDefault();try{
      const role=currentRole();const avatarChanged=state.avatar&&(!role?.imageId||avatarCache.get(role.imageId)!==state.avatar);
      const profile=profileInput(fields(),state.selected,avatarChanged?state.avatar:null,state.clearAvatar);
      const bound=bindingsForRole(state.snapshot,state.selected).length;
      mutate('work_badges_save',{profile,expectedVersion:state.baseVersion},bound?'工牌资料已保存。已绑定聊天中的工牌会自动更新。':'工牌资料已保存。还需在「聊天绑定」中单独保存聊天对应关系。',{newRole:!state.selected});
    }catch(error){announce(error.message,true);}
  });
  $('add-duty').addEventListener('click',()=>{if($('duties').children.length<5){dutyRow();markDirty();$('duties').lastElementChild.querySelector('input').focus();}});
  $('clear-avatar').addEventListener('click',()=>{++state.avatarToken;state.avatar=null;state.avatarImageId=null;state.clearAvatar=true;$('avatar').value='';markDirty();});
  $('avatar').addEventListener('change',async event=>{
    const file=event.target.files?.[0];if(!file)return;
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>MAX_IMAGE){announce('请选择不超过 3 MB 的 PNG、JPG 或 WebP 图片。',true);event.target.value='';return;}
    disposePreviewMaterial();
    const token=++state.avatarToken;
    try{
      const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('图片读取失败，请重新选择。'));reader.readAsDataURL(file);});
      if(token!==state.avatarToken)return;if(!validAvatar(data))throw new Error('图片格式不受支持。');state.avatar=data;state.avatarImageId=null;state.clearAvatar=false;markDirty();
    }catch(error){announce(error.message,true);}
  });
  $('preview-image').addEventListener('error',()=>{
    const layers=matchingPreviewLayers(state.avatar,state.avatarImageId,avatarCache,holoLayerCache);
    if(layers){holoLayerCache.delete(state.avatarImageId);renderPreview();return;}
    state.avatar=null;state.avatarImageId=null;renderPreview();announce('图片无法预览，请重新选择有效图片。',true);
  });
  $('preview-contour').addEventListener('error',()=>{if(state.avatarImageId)holoLayerCache.delete(state.avatarImageId);renderPreview();});
  $('preview').addEventListener('pointermove',event=>{
    if(event.pointerType!=='mouse'||previewBack||document.hidden||previewReducedMotion?.matches)return;
    const preview=$('preview'),bounds=preview.getBoundingClientRect();if(!bounds.width||!bounds.height)return;
    const values=previewMotion((event.clientX-bounds.left)/bounds.width-.5,(event.clientY-bounds.top)/bounds.height-.5);
    if(previewFrame!==null)window.cancelAnimationFrame?.(previewFrame);
    previewFrame=window.requestAnimationFrame(()=>{
      previewFrame=null;if(previewBack||document.hidden||previewReducedMotion?.matches)return;
      preview.setAttribute('data-hover','');for(const [key,value] of Object.entries(values))preview.style.setProperty(key,value);
      previewView={x:parseFloat(values['--rx']),y:parseFloat(values['--ry']),pointerX:parseFloat(values['--px'])/100,pointerY:parseFloat(values['--py'])/100,active:true};previewMaterial?.setView(previewView);
    });
  });
  for(const kind of ['pointerleave','pointercancel'])$('preview').addEventListener(kind,resetPreviewMotion);
  previewReducedMotion?.addEventListener('change',resetPreviewMotion);
  document.addEventListener('visibilitychange',()=>{if(document.hidden){resetPreviewMotion();disposePreviewMaterial();}else renderPreview();});
  for(const id of ['preview','preview-toggle'])$(id).addEventListener('click',()=>{previewBack=!previewBack;renderPreview();});
  for(const [tab,panel] of [['details-tab','details-panel'],['bindings-tab','bindings-panel']])$(tab).addEventListener('click',()=>{
    for(const [otherTab,otherPanel] of [['details-tab','details-panel'],['bindings-tab','bindings-panel']]){const selected=tab===otherTab;$(otherTab).setAttribute('aria-selected',String(selected));$(otherTab).tabIndex=selected?0:-1;$(otherPanel).hidden=!selected;}
    if(panel==='bindings-panel'){resetPreviewMotion();renderContexts();if(!$('binding-key').value)updateBindingKind(true);}
  });
  document.querySelector('[role=tablist]').addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const target=event.key==='Home'?'details-tab':event.key==='End'?'bindings-tab':document.activeElement===$('details-tab')?'bindings-tab':'details-tab';
    $(target).click();$(target).focus();
  });
  $('window-context').addEventListener('change',()=>{updateBindingKind(true);$('title-confirm').checked=false;$('replace-confirm').checked=false;bindingFeedback('');});
  $('binding-kind').addEventListener('change',()=>{updateBindingKind(true);$('title-confirm').checked=false;$('replace-confirm').checked=false;bindingFeedback('');});
  $('binding-key').addEventListener('input',()=>{checkReplacement();$('title-confirm').checked=false;$('replace-confirm').checked=false;bindingFeedback('');});
  $('binding-form').addEventListener('submit',event=>{
    event.preventDefault();if(!state.selected)return;
    const kind=$('binding-kind').value,key=$('binding-key').value;
    if(!key||kind==='title'&&!$('title-confirm').checked){const message='请填写完整标题，并确认标题匹配规则。';announce(message,true);bindingFeedback(message,true);return;}
    if(kind==='thread'&&key!==selectedContext()?.threadKey){const message='当前没有可确认的聊天链接标识。请选择完整标题绑定。';announce(message,true);bindingFeedback(message,true);return;}
    const existing=checkReplacement();if(existing&&!$('replace-confirm').checked){const message='该聊天已绑定其他角色，请确认是否替换。';announce(message,true);bindingFeedback(message,true);return;}
    const bindingTarget={roleId:state.selected,kind,key};
    mutate('work_badges_bind',{...bindingTarget,label:$('binding-label').value,replace:Boolean(existing),expectedVersion:state.snapshot.version},'聊天绑定已保存。返回对应聊天后，运行中的加载器会显示工牌。',{bindingTarget});
  });
  window.addEventListener('pagehide',()=>{resetPreviewMotion();disposePreviewMaterial();previewReducedMotion?.removeEventListener('change',resetPreviewMotion);if(timer)window.clearInterval(timer);bridge.close();},{once:true});
  controls();connect();
})();
