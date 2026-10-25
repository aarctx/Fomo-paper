import {call,extension,nativeApp} from './bridge.js';
import {summary,startingCashChange,keyOf,uuid,MAX_QUOTE_AGE,THEMES,REFRESH_INTERVAL_MS} from './ledger.js';
import {parseToken} from './market.js';
import {portfolioCandles,CHART_INTERVALS,reviewLegacyHistory} from './chart-data.js';
import {createPortfolioChart} from './chart-view.js';
import {nativeRequest,sharedNativeStorage} from './platform.js';
const $ = id=>document.getElementById(id);
const params = new URLSearchParams(location.search);
if(params.has('compact')) document.body.classList.add('compact');
if(nativeApp||sharedNativeStorage) document.querySelector('.source-note').textContent='Shared with Paperdesk on this iPhone. Refreshes every 5 seconds while a view is active; iOS may suspend background activity. Prices may be delayed by the provider.';
if(!extension&&!nativeApp) {
  $('preview-banner').hidden=false;
  $('key-form').hidden=true;
  document.querySelector('.source-note').textContent='Browser preview: refreshes every 5 seconds while this page is active. The installed extension can record while the browser is running. This preview has a separate ledger.';
}
const money = (v, digits=2)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:digits,maximumFractionDigits:digits}).format(v);
const price = v=>money(v, v>=1?4:Math.min(10,Math.max(4,Math.ceil(-Math.log10(v))+3)));
const quantity = v=>new Intl.NumberFormat('en-US',{maximumSignificantDigits:7}).format(v);
const signed = v=>(v>=0?'+':'−')+money(Math.abs(v));
const stamp = ts=>new Date(ts).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
let state,portfolio,quote,side='buy',busy=false,toastTimer,refreshing=false,lookupSequence=0;
function node(tag,text,className) { const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n; }
function toast(message,error=false){const el=$('toast');el.textContent=message;el.classList.toggle('error',error);el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.hidden=true,error?11000:5000);}
function pnl(el,value){el.classList.toggle('positive',value>=0);el.classList.toggle('negative',value<0);}
function setState(s){state=s;portfolio=s.portfolios.find(p=>p.id===s.activeId)||s.portfolios[0];render();}
function empty(el,title,text,icon='◇'){el.replaceChildren();const box=node('div',undefined,'empty-state');box.append(node('div',icon,'empty-icon'),node('h3',title),node('p',text));el.append(box);}
function render(){
  const s=summary(portfolio);
  document.documentElement.style.setProperty('--green',THEMES[portfolio.theme]||THEMES.lime);
  $('portfolio-title').textContent=portfolio.name;
  $('portfolio-description').textContent=portfolio.description||'Real market prices. Virtual money. Every decision is yours.';
  $('portfolio-select').replaceChildren(...state.portfolios.map(p=>{const o=node('option',p.name);o.value=p.id;return o;}));$('portfolio-select').value=portfolio.id;
  $('total-value').textContent=money(s.value);$('total-pnl').textContent=`${signed(s.pnl)} (${s.pnlPct>=0?'+':''}${s.pnlPct.toFixed(2)}%)`;pnl($('total-pnl'),s.pnl);
  $('cash').textContent=money(s.cash);$('holdings').textContent=money(s.holdings);$('realized').textContent=signed(s.realized);pnl($('realized'),s.realized);$('fees').textContent=money(s.fees);
  const positions=Object.values(portfolio.positions);$('position-count').textContent=positions.length;
  $('mark-status').classList.toggle('warning',s.stale>0);
  $('mark-status').textContent=s.stale?`${s.stale} position${s.stale>1?'s':''} with unavailable or older prices · total uses last known marks`:positions.length?'Reference prices received within the last minute · provider data may lag':'Ready for your next paper trade';
  drawChart();renderPositions(positions);renderTrades();estimate();
  if($('customize-dialog').open)renderCapitalPreview();
}
let portfolioChart;
function drawChart(){
  const {style='line',interval=1,range=0,hideSpikes=false}=portfolio.chartSettings||{};
  for(const [attr,value] of [['style',style],['interval',interval]]) {
    document.querySelectorAll(`[data-${attr}]`).forEach(b=>{const active=String(b.dataset[attr])===String(value);b.classList.toggle('active',active);b.setAttribute('aria-pressed',active);});
  }
  $('chart-range').value=String(range);
  const reviewed=reviewLegacyHistory(portfolio.history,portfolio.trades);
  $('chart-filter').checked=hideSpikes;
  $('chart-quality').hidden=!reviewed.count;
  $('chart-audit').textContent=`${reviewed.count} old sample${reviewed.count===1?'':'s'} flagged as possible price drops. ${hideSpikes?'Hidden from this chart only.':'Showing all recorded values.'} Original values remain in exports.`;
  // The compact Fomo ticket has no portfolio canvas. Initialize when visible.
  if(!$('chart').clientWidth)return;
  const now=Date.now(),cutoff=range?now-range*86400000:0;
  const bars=portfolioCandles(hideSpikes?reviewed.filtered:portfolio.history,interval,now).filter(b=>b.lastTs>=cutoff);
  const inspect=b=>{$('chart-readout').textContent=b?`${stamp(b.time)} · O ${money(b.open)}  H ${money(b.high)}  L ${money(b.low)}  C ${money(b.close)}${b.live?' · forming':''}${b.partial?' · partial observations':''}${b.event?' · '+b.event:''}`:'Your first observation will appear here.';};
  try{
    if(!portfolioChart)portfolioChart=createPortfolioChart($('chart'),inspect);
    portfolioChart.render({bars,style,interval,color:THEMES[portfolio.theme]||THEMES.lime,key:`${portfolio.id}:${style}:${interval}:${range}:${hideSpikes}`});
    $('chart-empty').hidden=bars.length>0;
    $('chart-empty').textContent='No fresh observations in this range. The chart grows as prices are recorded.';
    $('chart-fit').disabled=!bars.length;$('chart-latest').disabled=!bars.length;
  }catch(error){
    $('chart-empty').hidden=false;$('chart-empty').textContent=error.message;
    $('chart-fit').disabled=true;$('chart-latest').disabled=true;
  }
  $('chart-start').textContent=bars.length?'Recorded from '+stamp(bars[0].time):'No observations';
  $('chart-end').textContent=bars.length?'Latest '+stamp(bars.at(-1).lastTs):'';
  $('chart-note').textContent=`${CHART_INTERVALS[interval]} ${style==='candles'?'candles':'closing values'} · sampled portfolio value. Drag to pan; scroll or pinch to zoom. Gaps contain no invented values. ${style==='candles'?'Flat candles mean unchanged or single observed values. Inspect a candle for partial observations.':''}`;
  $('chart').setAttribute('aria-label',`${style==='candles'?'Candlestick':'Line'} chart of portfolio value. ${bars.length} recorded intervals of ${CHART_INTERVALS[interval]}. Latest ${bars.length?money(bars.at(-1).close):'unavailable'}.`);
}
function table(headers){const t=node('table'),head=node('thead'),row=node('tr'),body=node('tbody');headers.forEach(h=>row.append(node('th',h)));head.append(row);t.append(head,body);return [t,body];}
function renderPositions(positions){
  if(!positions.length){empty($('positions'),'No open positions. Yet.','Find a token on the right and make your first paper buy.');return;}
  const[t,body]=table(['Token / Price source','Quantity / Cost','Value / P&L','']);
  positions.sort((a,b)=>b.qty*b.mark.price-a.qty*a.mark.price).forEach(pos=>{
    const row=node('tr'),name=node('td'),token=node('div',undefined,'token-cell'),identity=node('div');
    identity.append(node('b',pos.token.symbol),node('small',pos.token.chain));token.append(node('span',pos.token.symbol.slice(0,1),'token-avatar'),identity);name.append(token);
    const pool=node('a','View pricing pool ↗','pool-link');pool.href=`https://dexscreener.com/${encodeURIComponent(pos.token.chain)}/${encodeURIComponent(pos.token.pair)}`;pool.target='_blank';pool.rel='noopener noreferrer';name.append(pool);
    const qty=node('td',quantity(pos.qty),'position-quantity');qty.append(node('small',`Avg cost ${price(pos.basis/pos.qty)} incl. fees`));
    const value=pos.qty*pos.mark.price,pl=value-pos.basis;
    const mark=node('td',money(value),'position-value'),gain=node('small',`${signed(pl)} (${pl>=0?'+':''}${(pl/pos.basis*100).toFixed(2)}%)`);pnl(gain,pl);mark.append(gain);
    mark.append(node('small',`Mark ${price(pos.mark.price)} / token`));
    mark.append(node('small',`Received ${new Date(pos.mark.ts).toLocaleTimeString()}`));
    if(pos.mark.priceCheck)mark.append(node('small','Large move rechecked','quote-rechecked'));
    if(pos.mark.error||Date.now()-pos.mark.ts>MAX_QUOTE_AGE||pos.mark.ts>Date.now()){
      const stale=node('small',pos.mark.error||'Price is older than one minute. Value uses the last known mark.','price-warning');mark.append(stale);
      if(pos.mark.rejectedQuote)mark.append(node('small',`Unconfirmed quote: ${price(pos.mark.rejectedQuote.price)} / token`,'price-warning'));
    }
    const action=node('td'),btn=node('button','Trade','table-button');btn.addEventListener('click',()=>{showView('trade');$('token-input').value=pos.token.address;$('chain').value=pos.token.chain;setSide('sell');lookup().then(()=>{if(!document.body.classList.contains('compact'))$('token-input').scrollIntoView({behavior:'smooth',block:'center'});}); });action.append(btn);row.append(name,qty,mark,action);body.append(row);
  });$('positions').replaceChildren(t);
}
function renderTrades(){
  if(!portfolio.trades.length){empty($('trades'),'Your decisions, documented.','Entries, exits, costs, and notes will appear here.','≡');return;}
  const[t,body]=table(['Trade','When','Size / Fill','Fee / Realized','Note']);
  [...portfolio.trades].reverse().slice(0,200).forEach(trade=>{
    const row=node('tr'),asset=node('td'),when=node('td',stamp(trade.ts)),size=node('td',quantity(trade.qty)),fee=node('td',money(trade.fee)),note=node('td',trade.note||'—','trade-note');
    asset.append(node('span',trade.side,'side-tag '+trade.side),node('small',trade.token.symbol));size.append(node('small',price(trade.price)));const realized=node('small',trade.side==='sell'?signed(trade.realized):'—');pnl(realized,trade.realized);fee.append(realized);row.append(asset,when,size,fee,note);body.append(row);
  });$('trades').replaceChildren(t);
  if(portfolio.trades.length>200)$('trades').append(node('p','Showing the latest 200 fills. Export CSV for the full journal.','muted small'));
}
function renderQuote(){
  $('quote').hidden=!quote;$('verify').disabled=!quote;
  if(!quote){$('quote').replaceChildren();estimate();return;}
  const name=node('div',undefined,'quote-name');name.append(node('strong',quote.symbol),node('strong',price(quote.price)));
  const address=node('div',quote.address,'quote-address');
  const meta=node('div',undefined,'quote-meta');meta.append(node('span',`${quote.chain} · ${quote.dex}`),node('span',`Liquidity ${money(quote.liquidity,0)}`));
  const receipt=node('p',`${quote.error?'Refresh unavailable · last known price. ':''}Price received ${new Date(quote.ts).toLocaleTimeString()} · ${quote.source}`,'muted small');receipt.style.marginBottom='0';
  const pool=node('a','View exact pricing pool ↗','pool-link');pool.href=`https://dexscreener.com/${encodeURIComponent(quote.chain)}/${encodeURIComponent(quote.pair)}`;pool.target='_blank';pool.rel='noopener noreferrer';
  $('quote').replaceChildren(name,address,meta,receipt,pool);estimate();
}
async function lookup(){
  const sequence=++lookupSequence;quote=null;renderQuote();$('verify-result').textContent='';$('lookup').disabled=true;
  try{const t=parseToken($('token-input').value,$('chain').value);$('chain').value=t.chain;
    const q=await call('quote',{input:t.address,chain:t.chain,portfolioId:portfolio.id,force:true});
    if(sequence===lookupSequence){quote=q;renderQuote();}
  }catch(e){if(sequence===lookupSequence)toast(e.message,true);}finally{if(sequence===lookupSequence)$('lookup').disabled=false;}
}
function invalidate(){lookupSequence++;quote=null;renderQuote();$('lookup').disabled=false;$('verify-result').textContent='';}
function setSide(next){side=next;const sell=side==='sell';$('buy-tab').classList.toggle('active',!sell);$('sell-tab').classList.toggle('active',sell);$('sell-tab').classList.add('sell');$('submit-trade').classList.toggle('sell',sell);$('amount-label').textContent=sell?'Share of your position to sell':'Total spend, including fee';$('amount-unit').textContent=sell?'%':'$';$('amount').max=sell?'100':'100000000';$('amount').value=sell?'25':'10';$('submit-trade').textContent=sell?'Paper sell':'Paper buy';$('presets').replaceChildren();for(const n of sell?[25,50,75,100]:[10,25,50,'Max']){const b=node('button',sell?n+'%':n==='Max'?'Max':'$'+n);b.type='button';b.onclick=()=>{$('amount').value=n==='Max'?Math.floor(portfolio.cash*100)/100:n;estimate();};$('presets').append(b);}estimate();}
function estimate(){
  if(!portfolio)return;
  const value=Number($('amount').value),fresh=quote&&!quote.error&&Date.now()-quote.ts<=MAX_QUOTE_AGE;
  const pos=quote?portfolio.positions[keyOf(quote)]:null;
  $('submit-trade').disabled=busy||!fresh||!Number.isFinite(value)||value<=0||(side==='buy'&&value>portfolio.cash+1e-9)||(side==='sell'&&(!pos||value>100));
  if(!quote){$('estimate').textContent='Find a token to preview your order.';return;}
  const feeRate=portfolio.settings.feeBps/10000,slip=portfolio.settings.slippageBps/10000;
  const fill=quote.price*(side==='buy'?1+slip:1-slip);
  const qty=side==='buy'?value/(1+feeRate)/fill:(pos?.qty||0)*value/100;
  const fee=qty*fill*feeRate;
  const rows=side==='buy'?[['Est. tokens',quantity(qty)+' '+quote.symbol],['Est. fee',money(fee)],['Available cash',money(portfolio.cash)]]:[['Est. tokens sold',quantity(qty)+' '+quote.symbol],['Est. proceeds after fee',money(qty*fill-fee)],['Position held',quantity(pos?.qty||0)+' '+quote.symbol]];
  rows.push(['Assumptions',`${(feeRate*100).toFixed(2)}% fee · ${(slip*100).toFixed(2)}% slip`]);
  if(!fresh)rows.push(['Quote','Expired — find token again']);
  if(side==='sell'&&!pos)rows.push(['Position','No tokens held in this portfolio']);
  $('estimate').replaceChildren(...rows.map(([a,b])=>{const n=node('div',undefined,'estimate-row');n.append(node('span',a),node('strong',b));return n;}));
}
async function refresh(force=false){
  if(refreshing||busy)return;refreshing=true;$('refresh').disabled=true;
  try{
    const id=portfolio?.id,sequence=lookupSequence;
    setState(await call('refresh',{force}));
    if(quote&&id===portfolio.id&&sequence===lookupSequence){
      const token={address:quote.address,chain:quote.chain};
      try{const next=await call('quote',{input:token.address,chain:token.chain,portfolioId:portfolio.id,force:false});if(sequence===lookupSequence&&id===portfolio.id){quote=next;renderQuote();}}
      catch{if(sequence===lookupSequence&&quote){quote.error=true;renderQuote();}}
    }
  }
  catch(e){toast(e.message,true);}finally{refreshing=false;$('refresh').disabled=false;}
}
$('lookup-form').addEventListener('submit',e=>{e.preventDefault();lookup();});
$('token-input').addEventListener('input',invalidate);$('chain').addEventListener('change',invalidate);
$('buy-tab').onclick=()=>setSide('buy');$('sell-tab').onclick=()=>setSide('sell');$('amount').oninput=estimate;
$('order-form').addEventListener('submit',async e=>{
  e.preventDefault();if(busy||!quote)return;busy=true;estimate();const previous=$('submit-trade').textContent;$('submit-trade').textContent='Getting fresh price…';
  const order={id:uuid(),side,token:{chain:quote.chain,address:quote.address,pair:quote.pair},referencePrice:quote.price,amount:Number($('amount').value),percent:Number($('amount').value),note:$('note').value};
  try{const result=await call('trade',{portfolioId:portfolio.id,order});setState(result.state);$('note').value='';toast(`Paper ${result.trade.side}: ${quantity(result.trade.qty)} ${result.trade.token.symbol} at ${price(result.trade.price)}.`);}
  catch(e){toast(e.message,true);}finally{busy=false;$('submit-trade').textContent=side==='buy'?'Paper buy':'Paper sell';estimate();}
});
$('portfolio-select').onchange=async()=>{try{setState(await call('select',{id:$('portfolio-select').value}));invalidate();}catch(e){toast(e.message,true);}};
$('new-portfolio').onclick=()=>{newPortfolioDefaults={};$('new-dialog').showModal();};
let editingPortfolioId,editingCapital,customizing=false;
function showView(view){document.body.dataset.view=view;$('view-portfolio').classList.toggle('active',view==='portfolio');$('view-trade').classList.toggle('active',view==='trade');if(view==='portfolio'&&portfolio)drawChart();}
$('view-portfolio').onclick=()=>showView('portfolio');$('view-trade').onclick=()=>showView('trade');
showView(params.has('compact')?'trade':'portfolio');
if(nativeApp)document.querySelector('.brand').onclick=e=>{e.preventDefault();showView('portfolio');};
function renderCapitalPreview(){
  const p=state.portfolios.find(p=>p.id===editingPortfolioId);
  if(!p)return;
  const input=$('edit-capital'),minimum=startingCashChange(p,p.capital).minimum;
  input.disabled=false;input.min=String(minimum);
  let error='',change;
  try{
    if(editingCapital!==p.capital)throw Error('Starting cash changed in another view. Close and reopen Customize to review the latest balance.');
    change=startingCashChange(p,input.value);
  }catch(e){error=e.message;}
  input.setCustomValidity(error);input.setAttribute('aria-invalid',error?'true':'false');
  $('capital-preview').classList.toggle('invalid',!!error);
  $('capital-before').textContent=money(p.cash);
  $('capital-after').textContent=change?money(change.cash):'—';
  $('capital-change').textContent=error||(change.delta>0?`Adds ${money(change.delta)} to available paper cash.`:change.delta<0?`Removes ${money(-change.delta)} from available paper cash.`:'Enter a different starting amount to adjust available paper cash.');
  $('capital-help').textContent=`Minimum for this portfolio: ${money(minimum)}. Positions and trades stay intact. Trading P&L in dollars stays the same; return % uses the new starting cash.`;
  $('customize-save').disabled=customizing||!!error;
  $('customize-save').textContent=customizing?'Saving…':'Save changes';
  $('new-from-current').disabled=customizing;
}
$('customize-open').onclick=()=>{
  editingPortfolioId=portfolio.id;editingCapital=portfolio.capital;
  $('edit-name').value=portfolio.name;$('edit-description').value=portfolio.description||'';$('edit-theme').value=portfolio.theme||'lime';$('edit-capital').value=portfolio.capital;
  $('edit-fee').value=portfolio.settings.feeBps/100;$('edit-slippage').value=portfolio.settings.slippageBps/100;
  renderCapitalPreview();$('customize-dialog').showModal();
};
$('edit-capital').addEventListener('input',renderCapitalPreview);
const customization=()=>({name:$('edit-name').value,description:$('edit-description').value,theme:$('edit-theme').value,capital:Number($('edit-capital').value),feeBps:Number($('edit-fee').value)*100,slippageBps:Number($('edit-slippage').value)*100});
$('customize-form').onsubmit=async e=>{
  e.preventDefault();if(customizing)return;
  renderCapitalPreview();if($('customize-save').disabled)return;
  const payload={portfolioId:editingPortfolioId,expectedCapital:editingCapital,...customization()};
  customizing=true;renderCapitalPreview();
  try{setState(await call('customize',payload));$('customize-dialog').close();toast('Portfolio updated.');}
  catch(e){toast(e.message,true);}
  finally{customizing=false;if($('customize-dialog').open)renderCapitalPreview();}
};
let newPortfolioDefaults={};
$('new-from-current').onclick=()=>{newPortfolioDefaults=customization();$('portfolio-name').value=(newPortfolioDefaults.name+' · new').slice(0,60);$('capital').value=newPortfolioDefaults.capital;$('customize-dialog').close();$('new-dialog').showModal();};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
$('new-form').onsubmit=async e=>{e.preventDefault();try{setState(await call('newPortfolio',{...newPortfolioDefaults,name:$('portfolio-name').value,capital:$('capital').value}));newPortfolioDefaults={};$('new-dialog').close();invalidate();toast('New portfolio created.');}catch(e){toast(e.message,true);}};
async function providerStatus(){const s=await call('providerStatus');$('provider-status').textContent=`${s.configured?'Key saved locally':'No key saved'} · ${s.count.toLocaleString()} / ${s.cap.toLocaleString()} calls today (UTC)`;}
$('settings-open').onclick=async()=>{$('fee').value=portfolio.settings.feeBps/100;$('slippage').value=portfolio.settings.slippageBps/100;$('settings-dialog').showModal();try{await providerStatus();}catch(e){toast(e.message,true);}};
$('settings-form').onsubmit=async e=>{e.preventDefault();try{setState(await call('settings',{portfolioId:portfolio.id,feeBps:Number($('fee').value)*100,slippageBps:Number($('slippage').value)*100}));toast('Future fills will use these assumptions.');}catch(e){toast(e.message,true);}};
$('key-form').onsubmit=async e=>{e.preventDefault();try{if(!$('api-key').value.trim())throw Error('Enter a key, or use Remove key.');await call('saveKey',{key:$('api-key').value});$('api-key').value='';await providerStatus();toast('Key saved locally.');}catch(e){toast(e.message,true);}};
$('remove-key').onclick=async()=>{try{await call('saveKey',{key:''});await providerStatus();toast('Saved key removed.');}catch(e){toast(e.message,true);}};
$('verify').onclick=async()=>{if(!quote)return;$('verify').disabled=true;try{const result=await call('explorer',{address:quote.address,chain:quote.chain});$('verify-result').textContent=(result.verified?`Published source found${result.name?' · '+result.name:''}. `:'No published source returned. ')+result.note;}catch(e){$('verify-result').textContent=e.message;}finally{$('verify').disabled=!quote;}};
$('refresh').onclick=()=>refresh(true);
async function changeChart(fields){try{setState(await call('chartSettings',{portfolioId:portfolio.id,...fields}));}catch(e){toast(e.message,true);}}
$('chart-fit').onclick=()=>portfolioChart?.fit();
$('chart-latest').onclick=()=>portfolioChart?.latest();
$('chart-filter').onchange=()=>changeChart({hideSpikes:$('chart-filter').checked});
$('chart-range').onchange=()=>changeChart({range:Number($('chart-range').value)});
document.querySelectorAll('[data-interval]').forEach(b=>b.onclick=()=>changeChart({interval:Number(b.dataset.interval)}));
document.querySelectorAll('[data-style]').forEach(b=>b.onclick=()=>changeChart({style:b.dataset.style}));
function download(name,text,type){if(nativeApp){nativeRequest({op:'share',name,text}).catch(e=>toast(e.message,true));return;}const url=URL.createObjectURL(new Blob([text],{type}));const link=node('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),3000);}
const csvCell = value=>{let v=String(value??'');if(typeof value==='string'&&(/^[\s]*[=+@\-]/.test(v)||/^[\t\r\n]/.test(v)))v="'"+v;return '"'+v.replaceAll('"','""')+'"';};
$('export-csv').onclick=()=>{const cols=['time','side','chain','address','symbol','quantity','reference_price_usd','fill_price_usd','gross_usd','fee_usd','cash_change_usd','realized_pnl_usd','source','quote_received_at','fee_bps','slippage_bps','note'];const rows=portfolio.trades.map(t=>[new Date(t.ts).toISOString(),t.side,t.token.chain,t.token.address,t.token.symbol,t.qty,t.referencePrice,t.price,t.gross,t.fee,t.cashDelta,t.realized,t.source,new Date(t.quoteAt).toISOString(),t.feeBps,t.slippageBps,t.note]);download('paperdesk-trades.csv',[cols,...rows].map(r=>r.map(csvCell).join(',')).join('\r\n'),'text/csv');};
$('export-json').onclick=async()=>{try{download('paperdesk-portfolios.json',JSON.stringify(await call('export'),null,2),'application/json');}catch(e){toast(e.message,true);}};
async function start(){try{setState(await call('state'));setSide('buy');const from=params.get('token');if(from){$('token-input').value=from;await lookup();}refresh();setInterval(()=>{if(document.visibilityState==='visible')refresh();},REFRESH_INTERVAL_MS);setInterval(()=>{if(portfolio){estimate();const s=summary(portfolio);if(s.stale)$('mark-status').textContent=`${s.stale} position(s) use last known prices. Refresh to update.`;}},10000);}catch(e){toast(e.message,true);}}
start();
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&portfolio)refresh();});
window.addEventListener('focus',()=>{if(portfolio)refresh();});

window.addEventListener('resize',()=>{if(portfolio)drawChart();});
