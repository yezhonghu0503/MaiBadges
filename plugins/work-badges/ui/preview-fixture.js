/* Standalone UI preview. All replies are in memory; mutations always fail. */
(() => {
  'use strict';
  const sample=/* __PREVIEW_SAMPLE_DATA__ */ null;
  const sourceImageId=sample?.sourceImageId??sample?.miloSourceId;
  const avatars=Object.assign(Object.create(null),sourceImageId?{
    [sourceImageId]:{avatarDataUrl:sample.avatarDataUrl||'',foregroundDataUrl:sample.foregroundDataUrl||'',contourDataUrl:sample.contourDataUrl||'',holoAssets:sample.holoAssets||{}}
  }:{},sample?.avatars);
  let theme=window.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light';
  const snapshot={version:1,roles:sample?.profiles||[],bindings:[],contexts:[]};
  const listeners=new Set();
  const host={postMessage(message){
    if(!message||message.jsonrpc!=='2.0'||typeof message.id!=='number')return;
    let result,error;
    if(message.method==='ui/initialize')result={protocolVersion:'2026-01-26',hostCapabilities:{},hostContext:{theme}};
    else if(message.method==='tools/call'){
      const name=message.params?.name;
      if(name==='work_badges_snapshot'){
        const data=structuredClone(snapshot);
        data.contexts=[{contextKey:'title:示例聊天',title:'示例聊天',seenAt:Date.now()/1000}];
        result={structuredContent:data};
      }else if(name==='work_badges_avatar'){
        const imageId=message.params?.arguments?.imageId;
        result=Object.hasOwn(avatars,imageId)?{structuredContent:{imageId},_meta:avatars[imageId]}:{isError:true,content:[{type:'text',text:'示例头像不存在。'}]};
      }
      else result={isError:true,content:[{type:'text',text:'这是界面预览，不会写入资料库。请在插件管理页中保存工牌或聊天绑定。'}]};
    }else error={code:-32601,message:'界面预览只提供本地示例资料。'};
    queueMicrotask(()=>{const event={source:host,data:{jsonrpc:'2.0',id:message.id,result,error}};for(const listener of listeners)listener(event);});
  }};
  window.WorkBadgePreviewSurface=Object.freeze({
    document:window.document,
    matchMedia:window.matchMedia?.bind(window),
    parent:Object.freeze(host),
    setTimeout:window.setTimeout.bind(window),
    clearTimeout:window.clearTimeout.bind(window),
    addEventListener(kind,listener){if(kind==='message')listeners.add(listener);},
    removeEventListener(kind,listener){if(kind==='message')listeners.delete(listener);}
  });
  function updateThemeButtons(){
    for(const name of ['light','dark'])window.document?.getElementById(`preview-theme-${name}`)?.setAttribute('aria-pressed',String(theme===name));
  }
  for(const name of ['light','dark'])window.document?.getElementById(`preview-theme-${name}`)?.addEventListener('click',()=>{
    theme=name;updateThemeButtons();
    const event={source:host,data:{jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{theme}}};
    for(const listener of listeners)listener(event);
  });
  updateThemeButtons();
})();
