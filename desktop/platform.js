// Optional native transport for the iOS containing app and its Safari extension.
export const browserAPI=typeof browser!=='undefined'?browser:(typeof chrome!=='undefined'?chrome:null);
export const nativeApp=!!globalThis.webkit?.messageHandlers?.paperdesk;
export const sharedNativeStorage=!!browserAPI?.runtime?.getManifest?.().permissions?.includes('nativeMessaging');
export async function nativeRequest(message){
  const result=nativeApp
    ?await globalThis.webkit.messageHandlers.paperdesk.postMessage(message)
    :await browserAPI.runtime.sendNativeMessage('paperdesk',message);
  if(!result?.ok)throw Error(result?.error||'The shared iPhone storage is unavailable.');
  return result.data;
}
export function createNativeStorage(send=nativeRequest){
  const revisions=new Map();
  return {
    async get(key){const r=await send({op:'get',key});revisions.set(key,r.revision);return r.value;},
    async set(key,value){
      if(!revisions.has(key)){const r=await send({op:'get',key});revisions.set(key,r.revision);}
      try{const r=await send({op:'set',key,value,expectedRevision:revisions.get(key)});revisions.set(key,r.revision);}
      catch(error){if(error.message==='PAPERDESK_CONFLICT')revisions.delete(key);throw error;}
    }
  };
}
export async function retryNative(work){
  for(let i=0;i<3;i++){
    try{return await work();}catch(error){if(error.message!=='PAPERDESK_CONFLICT')throw error;if(i===2)throw Error('Your portfolio changed in another view. Please try again.');}
  }
}
export async function nativeFetch(url){
  const result=await nativeRequest({op:'http',url:String(url)});
  return {ok:result.status>=200&&result.status<300,status:result.status,json:async()=>JSON.parse(result.body)};
}
