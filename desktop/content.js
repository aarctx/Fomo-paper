// Only observes the public page URL. No account, wallet, cookie, or network interception.
(() => {
  const api=typeof browser!=='undefined'?browser:chrome;
  if (document.getElementById('paperdesk-root')) return;
  const host = document.createElement('div'); host.id='paperdesk-root';
  host.style.cssText='position:fixed;right:max(12px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom));z-index:2147483646;';
  const root = host.attachShadow({mode:'closed'});
  const style = document.createElement('style');
  style.textContent='button{font:600 14px system-ui;cursor:pointer;border:1px solid #b8f49a;background:#c3f99d;color:#132016;border-radius:30px;padding:13px 20px;min-height:44px;box-shadow:0 6px 24px #0006}iframe{display:block;width:390px;height:min(760px,calc(100vh - 100px));height:min(760px,calc(100dvh - 100px - env(safe-area-inset-bottom)));border:1px solid #394237;border-radius:18px;background:#111710;box-shadow:0 10px 60px #0009;margin-bottom:10px;max-width:calc(100vw - 24px - env(safe-area-inset-left) - env(safe-area-inset-right))}.row{display:flex;justify-content:flex-end}';
  const button = document.createElement('button'); button.textContent='◈ Paper trade'; button.setAttribute('aria-label','Open paper trading panel');
  const row=document.createElement('div');row.className='row';row.append(button);root.append(style,row);document.documentElement.append(host);
  let frame, last=location.href;
  function source() { const m=location.pathname.match(/^\/tokens\/([a-z0-9-]+)\/([^/]+)\/?$/i); return m ? `${location.origin}/tokens/${m[1]}/${m[2]}` : ''; }
  function update() { if (frame) frame.src=api.runtime.getURL('app.html')+'?compact=1&token='+encodeURIComponent(source()); }
  button.addEventListener('click',()=>{
    if(frame){frame.remove();frame=null;button.textContent='◈ Paper trade';button.setAttribute('aria-label','Open paper trading panel');}
    else{frame=document.createElement('iframe');frame.title='Paperdesk — virtual trading';root.insertBefore(frame,row);update();button.textContent='Close paper panel';button.setAttribute('aria-label','Close paper trading panel');}
  });
  // Handles client-side navigation without patching Fomo or reading hidden app state.
  setInterval(()=>{if(last!==location.href){last=location.href;update();}},750);
})();
