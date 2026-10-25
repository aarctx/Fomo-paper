import test from 'node:test';
import assert from 'node:assert/strict';
import {makePortfolio,customizePortfolio,startingCashChange,summary,execute} from '../ledger.js';
import {createService} from '../service.js';
import {portfolioCandles,portfolioSeriesData} from '../chart-data.js';
import {createNativeStorage,retryNative} from '../platform.js';
const token={chain:'robinhood',address:'0x'+'1'.repeat(40),pair:'0x'+'2'.repeat(40)};
const q={...token,price:1,ts:Date.now(),source:'test',symbol:'TEST'};
test('customization retains an existing position, fills and original fee assumptions',()=>{
  const p=makePortfolio('Original',100);execute(p,{id:'fill',side:'buy',token,amount:10},q,q.ts);
  const saved=JSON.stringify({trades:p.trades,positions:p.positions,history:p.history});
  customizePortfolio(p,{name:'My strategy',description:'My notes',theme:'violet',feeBps:50,slippageBps:20});
  assert.equal(p.name,'My strategy');assert.equal(p.theme,'violet');assert.equal(p.settings.feeBps,50);assert.equal(p.trades[0].feeBps,100);
  assert.equal(JSON.stringify({trades:p.trades,positions:p.positions,history:p.history}),saved);
});
test('starting cash changes before trading retain setup observations and create no P&L',()=>{
  const p=makePortfolio('Test',100,1),initial=structuredClone(p.history);
  customizePortfolio(p,{capital:2500},2);assert.equal(p.cash,2500);assert.equal(p.capital,2500);assert.equal(summary(p).pnl,0);
  assert.deepEqual(p.history.slice(0,1),initial);assert.equal(p.history.at(-1).event,'Starting cash changed');assert.equal(p.configurationChanges[0].previous,100);
});
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} differs from ${expected}`);
function heldPortfolio(){
  const p=makePortfolio('Test',1000,q.ts-60000);
  execute(p,{id:'buy',side:'buy',token,amount:500},q,q.ts);
  return p;
}

test('starting cash remains editable after trading and only adds the funding difference',()=>{
  const p=heldPortfolio(),before=structuredClone(p),old=summary(p,q.ts);
  customizePortfolio(p,{name:'Changed',capital:1500,expectedCapital:1000},q.ts+5000);
  assert.equal(p.id,before.id);assert.equal(p.capital,1500);assert.equal(p.cash,1000);
  assert.deepEqual(p.positions,before.positions);assert.deepEqual(p.trades,before.trades);
  assert.equal(p.realized,before.realized);assert.equal(p.fees,before.fees);
  assert.deepEqual(p.history.slice(0,before.history.length),before.history);
  near(summary(p,q.ts+5000).pnl,old.pnl);near(summary(p).pnlPct,old.pnl/1500*100);
  assert.deepEqual(p.configurationChanges[0],{ts:q.ts+5000,field:'startingCash',previous:1000,value:1500,cashDelta:500,cashBefore:500,cashAfter:1000});
  assert.equal(p.history.at(-1).cashAdjustment,500);
});

test('starting cash can decrease to the invested minimum without negative available cash',()=>{
  const p=heldPortfolio(),before=summary(p,q.ts);
  assert.deepEqual(startingCashChange(p,500),{capital:500,delta:-500,cash:0,minimum:500});
  customizePortfolio(p,{capital:500},q.ts+1000);
  assert.equal(p.cash,0);assert.equal(p.capital,500);near(summary(p).pnl,before.pnl);
  assert.equal(p.configurationChanges[0].cashDelta,-500);
});

test('invalid reductions and other invalid fields reject the entire edit atomically',()=>{
  const p=heldPortfolio(),before=JSON.stringify(p);
  assert.throws(()=>customizePortfolio(p,{name:'Changed',theme:'sky',capital:499.99}),/at least \$500.00/);
  assert.equal(JSON.stringify(p),before);
  for(const fields of [{name:'',capital:1500},{theme:'url(evil)',capital:1500},{feeBps:NaN,capital:1500},{description:'a'.repeat(281),capital:1500},{capital:''},{capital:NaN},{capital:0},{capital:1e8+1}]){
    assert.throws(()=>customizePortfolio(p,fields));assert.equal(JSON.stringify(p),before);
  }
});

test('cash changes preserve realized results after partial and complete exits',()=>{
  for(const percent of [50,100]){
    const p=heldPortfolio();execute(p,{id:'sell',side:'sell',token,percent},{...q,price:.5},q.ts);
    const before=structuredClone(p),old=summary(p,q.ts);
    customizePortfolio(p,{capital:1200},q.ts+1000);
    near(p.cash,before.cash+200);near(summary(p).pnl,old.pnl);
    assert.equal(p.realized,before.realized);assert.equal(p.fees,before.fees);
    assert.deepEqual(p.trades,before.trades);assert.deepEqual(p.positions,before.positions);
    const minimum=startingCashChange(p,p.capital).minimum;
    customizePortfolio(p,{capital:minimum},q.ts+2000);
    assert.ok(p.cash>=0&&p.cash<.01000001);near(summary(p).pnl,old.pnl);
    const saved=JSON.stringify(p);assert.throws(()=>customizePortfolio(p,{capital:minimum-.01}),/at least/);assert.equal(JSON.stringify(p),saved);
  }
});

test('repeating the same starting cash adds neither cash nor duplicate audit events',()=>{
  const p=heldPortfolio();customizePortfolio(p,{capital:1500},q.ts+5000);
  const before=structuredClone(p);customizePortfolio(p,{capital:1500},q.ts+10000);
  assert.deepEqual(p,before);
});

test('starting cash changes create a chart baseline without gain candles or rewritten history',()=>{
  const p2=heldPortfolio(),stamp=Math.ceil(q.ts/60000)*60000;
  customizePortfolio(p2,{capital:1500},stamp);
  const bars=portfolioCandles(p2.history,1,stamp);
  const last=bars.at(-1);assert.equal(last.event,'Starting cash changed');assert.equal(last.breakBefore,true);
  assert.equal(last.open,last.close);assert.equal(last.high,last.close);assert.equal(last.low,last.close);
  const line=portfolioSeriesData(bars,'line',1,'green');assert.equal(line.at(-2).color,'transparent');
});

test('stale starting cash cannot overwrite a newer edit',()=>{
  const p=heldPortfolio();customizePortfolio(p,{capital:1500,expectedCapital:1000});const before=structuredClone(p);
  assert.throws(()=>customizePortfolio(p,{capital:2000,expectedCapital:1000,name:'Stale edit'}),/another view/);
  assert.deepEqual(p,before);
});

test('saving uses the latest available cash if a trade happened after opening Customize',async()=>{
  const p=heldPortfolio();let state={version:1,activeId:p.id,portfolios:[p]};
  assert.equal(startingCashChange(p,600).cash,100);
  execute(p,{id:'later buy',side:'buy',token,amount:200},q,q.ts);
  const before=structuredClone(state),svc=createService({get:async()=>structuredClone(state),set:async(k,v)=>{state=structuredClone(v);}});
  await assert.rejects(()=>svc.call({type:'customize',payload:{portfolioId:p.id,capital:600,expectedCapital:1000}}),/at least \$700.00/);
  assert.deepEqual(state,before);
});

test('v0.1 portfolios stay intact and gain optional customization without a reset',async()=>{
  const p=makePortfolio('Legacy',100);delete p.description;delete p.theme;const old={version:1,activeId:p.id,portfolios:[p]};let data=structuredClone(old);
  const svc=createService({get:async()=>structuredClone(data),set:async(k,v)=>{data=structuredClone(v);}});
  const initial=await svc.call({type:'state'});assert.deepEqual(initial,old);
  const result=await svc.call({type:'customize',payload:{portfolioId:p.id,name:'Renamed',theme:'sky'}});
  assert.equal(result.portfolios[0].id,p.id);assert.equal(result.portfolios[0].cash,100);assert.deepEqual(result.portfolios[0].history,p.history);
});
function sharedHost(){const records=new Map();return async message=>{
  const record=records.get(message.key)||{value:null,revision:0};
  if(message.op==='get')return structuredClone(record);
  if(message.expectedRevision!==record.revision)throw Error('PAPERDESK_CONFLICT');
  const next={value:structuredClone(message.value),revision:record.revision+1};records.set(message.key,next);return{revision:next.revision};
};}
test('two native views cannot overwrite each other with stale saves',async()=>{
  const send=sharedHost(),a=createNativeStorage(send),b=createNativeStorage(send);
  await a.get('ledger');await b.get('ledger');await a.set('ledger',{value:'a'});
  await assert.rejects(()=>b.set('ledger',{value:'b'}),/PAPERDESK_CONFLICT/);assert.deepEqual(await a.get('ledger'),{value:'a'});
});
test('native app and Safari retry conflicts against the newest shared ledger',async()=>{
  const send=sharedHost(),svcA=createService(createNativeStorage(send)),svcB=createService(createNativeStorage(send));
  await Promise.all([retryNative(()=>svcA.call({type:'state'})),retryNative(()=>svcB.call({type:'state'}))]);
  await Promise.all([retryNative(()=>svcA.call({type:'newPortfolio',payload:{name:'Safari',capital:500}})),retryNative(()=>svcB.call({type:'newPortfolio',payload:{name:'Home Screen',capital:250}}))]);
  const result=await svcA.call({type:'state'});assert.equal(result.portfolios.length,3);assert.ok(result.portfolios.some(p=>p.name==='Safari'));assert.ok(result.portfolios.some(p=>p.name==='Home Screen'));
});
test('native key-save conflict retry refreshes its revision without resetting the ledger',async()=>{
  const send=sharedHost(),a=createNativeStorage(send),b=createNativeStorage(send);await a.get('etherscanKey');await b.get('etherscanKey');await a.set('etherscanKey','old');
  await retryNative(()=>b.set('etherscanKey','new'));assert.equal(await a.get('etherscanKey'),'new');
});
test('simultaneous iPhone app and Safari buys cannot overspend the shared balance',async()=>{
  const send=sharedHost();const row={chainId:token.chain,pairAddress:token.pair,baseToken:{address:token.address,symbol:'TEST'},priceUsd:'1',liquidity:{usd:10000}};
  const fetcher=async()=>({ok:true,json:async()=>({pairs:[row]})});
  const a=createService(createNativeStorage(send),fetcher),b=createService(createNativeStorage(send),fetcher);
  const state=await a.call({type:'state'});
  const results=await Promise.allSettled([a,b].map((svc,i)=>retryNative(()=>svc.call({type:'trade',payload:{portfolioId:state.activeId,order:{id:'cross-view-'+i,token,side:'buy',amount:75}}}))));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const result=await b.call({type:'state'});assert.equal(result.portfolios[0].cash,25);assert.equal(result.portfolios[0].trades.length,1);
});


test('concurrent native cash edits apply only once against the original capital',async()=>{
  const send=sharedHost(),a=createService(createNativeStorage(send)),b=createService(createNativeStorage(send));
  const state=await a.call({type:'state'}),id=state.activeId;
  const results=await Promise.allSettled([a,b].map((svc,i)=>retryNative(()=>svc.call({type:'customize',payload:{portfolioId:id,capital:200+i*50,expectedCapital:100}}))));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/another view/);
  const saved=(await a.call({type:'state'})).portfolios[0];
  assert.ok([200,250].includes(saved.capital));assert.equal(saved.cash,saved.capital);
  assert.equal(saved.configurationChanges.length,1);assert.equal(summary(saved).pnl,0);
});
