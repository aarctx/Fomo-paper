import {createService} from './service.js';
import {browserAPI,nativeApp,createNativeStorage,nativeFetch,retryNative} from './platform.js';
export {nativeApp} from './platform.js';
export const extension = !!browserAPI?.runtime?.id;
let local;
if(nativeApp)local=createService(createNativeStorage(),nativeFetch);
else if (!extension) local=createService({
  get:async key=>JSON.parse(localStorage.getItem('paperdesk-preview:'+key)||'null'),
  set:async(key,value)=>{try{localStorage.setItem('paperdesk-preview:'+key,JSON.stringify(value));}catch{throw Error('Storage is full. Export your portfolio before continuing.');}}
});
export async function call(type,payload={}) {
  if(nativeApp)return retryNative(()=>local.call({type,payload}));
  if (!extension) {
    if(!navigator.locks)throw Error('This preview needs a browser with Web Locks. Use the installed app instead.');
    return navigator.locks.request('paperdesk-preview',()=>local.call({type,payload}));
  }
  const result = await browserAPI.runtime.sendMessage({type,payload});
  if(!result?.ok) throw Error(result?.error || 'Extension unavailable. Reload the page.');
  return result.data;
}
