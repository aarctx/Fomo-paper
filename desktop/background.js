import {createService} from './service.js';
import {browserAPI,sharedNativeStorage,createNativeStorage,retryNative} from './platform.js';
const api=browserAPI;
const store = sharedNativeStorage?createNativeStorage():{get:async key=>(await api.storage.local.get(key))[key],set:async(key,value)=>api.storage.local.set({[key]:value})};
const ready = sharedNativeStorage?Promise.resolve():Promise.resolve(api.storage.local.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'}));
const service = createService(store);
api.runtime.onMessage.addListener((message,sender,reply)=>{
  const allowed=api.runtime.getURL('app.html');
  if (sender.id !== api.runtime.id || !sender.url || sender.url.split(/[?#]/)[0]!==allowed) { reply({ok:false,error:'Unsupported caller.'}); return false; }
  ready.then(()=>retryNative(()=>service.call(message))).then(data=>reply({ok:true,data}),error=>reply({ok:false,error:error.message}));
  return true;
});
api.action?.onClicked.addListener(()=>api.tabs.create({url:api.runtime.getURL('app.html')}));
async function ensureAlarm() { await ready; if (api.alarms && !await api.alarms.get('marks')) await api.alarms.create('marks',{periodInMinutes:1}); }
api.runtime.onInstalled.addListener(()=>ensureAlarm().catch(()=>{}));
api.runtime.onStartup?.addListener(()=>ensureAlarm().catch(()=>{}));
api.alarms?.onAlarm.addListener(a=>{ if (a.name === 'marks') ready.then(()=>retryNative(()=>service.call({type:'refresh'}))).catch(()=>{}); });
ensureAlarm().catch(()=>{});
