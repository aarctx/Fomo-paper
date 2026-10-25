import test from 'node:test';
import assert from 'node:assert/strict';
import {makePortfolio,execute,summary,updateMark,keyOf,snapshot} from '../ledger.js';
import {parseToken,normalizePair,createMarket} from '../market.js';
import {createService} from '../service.js';
const now=Date.now(),address='0x5173d45a1191ee33cbb7d8c7e65f21b04ed54802';
const token={chain:'robinhood',address,pair:'0x5860dD468B4FC1740EaF80a3b7F22e78D70a076a'};
const q={...token,price:1,ts:now,symbol:'RAM',name:'Ramses',source:'test',liquidity:100000};
const order=(id,side='buy',other={})=>({id,side,token,amount:10,percent:50,...other});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} differs from ${b}`);
test('buy, partial sell, and full exit conserve cash and cost basis including fees',()=>{
  const p=makePortfolio('Test',100,now);const buy=execute(p,order('buy'),q,now);near(p.cash,90);near(buy.qty,10/1.01/1.005);near(p.positions[keyOf(token)].basis,10);
  const sale=execute(p,order('half','sell'),{...q,price:2},now);near(p.positions[keyOf(token)].basis,5);near(sale.realized,sale.cashDelta-5);
  execute(p,order('rest','sell',{percent:100}),{...q,price:2},now);assert.equal(Object.keys(p.positions).length,0);near(p.cash-100,p.realized);near(p.fees,p.trades.reduce((n,t)=>n+t.fee,0));
});
test('retries return the original fill and never double spend',()=>{
  const p=makePortfolio('Test',100,now);const first=execute(p,order('same'),q,now);const next=execute(p,order('same'),{...q,price:2},now);assert.equal(first,next);assert.equal(p.trades.length,1);near(p.cash,90);
});
test('invalid orders, missing positions, overspending, stale quotes and mismatched pools do not mutate',()=>{
  const p=makePortfolio('Test',100,now),before=JSON.stringify(p);
  for(const [o,quote]of [[order('a','buy',{amount:101}),q],[order('b','sell'),q],[order('c','buy',{amount:NaN}),q],[order('d'),{...q,ts:now-61000}],[order('e'),{...q,address:'0x'+'1'.repeat(40)}],[order('f'),{...q,price:0}],[order('g'),{...q,ts:now+1}]]){assert.throws(()=>execute(p,o,quote,now));assert.equal(JSON.stringify(p),before);}
  execute(p,order('valid'),q,now);const bought=JSON.stringify(p);assert.throws(()=>execute(p,order('different'),{...q,pair:'0x'+'2'.repeat(40)},now));assert.equal(JSON.stringify(p),bought);
});
test('missing and stale marks remain last known instead of becoming zero',()=>{
  const p=makePortfolio('Test',100,now);execute(p,order('x'),q,now);const original=summary(p,now).value;
  p.positions[keyOf(token)].mark.error='unavailable';const s=summary(p,now);near(s.value,original);assert.equal(s.stale,1);snapshot(p,now+60001);assert.equal(p.history.at(-1).complete,false);assert.equal(p.history.length,3);
  updateMark(p,token,{...q,ts:now+60002,price:2},now+60002);assert.equal(summary(p,now+60002).stale,0);
});
test('Fomo URLs provide exact chain and address without carrying referral data',()=>{
  assert.deepEqual(parseToken(`https://fomo.family/tokens/robinhood/${address}?r=HugeLoyalJay`),{chain:'robinhood',address});
  assert.throws(()=>parseToken('https://evil.example/tokens/robinhood/'+address));assert.throws(()=>parseToken(address,''));
});
test('provider identity and liquidity are required',()=>{
  const row={chainId:'robinhood',pairAddress:token.pair,baseToken:{address,symbol:'RAM'},priceUsd:'1',liquidity:{usd:10000}};
  assert.equal(normalizePair(row,token,now).price,1);assert.throws(()=>normalizePair({...row,chainId:'base'},token,now));assert.throws(()=>normalizePair({...row,liquidity:{usd:0}},token,now));
});
test('long sequences preserve realized + unrealized = total P&L',()=>{
  const p=makePortfolio('Test',10000,now);let seed=42;const random=()=>((seed=(1664525*seed+1013904223)>>>0)/2**32);
  for(let i=0;i<500;i++){
    const mark={...q,price:.05+random()*10,ts:now+i};const held=p.positions[keyOf(token)];
    if(held&&random()>.45)execute(p,order('s'+i,'sell',{percent:25+random()*74}),mark,now+i);
    else execute(p,order('b'+i,'buy',{amount:Math.max(.01,Math.min(5,p.cash/10))}),mark,now+i);
    const s=summary(p,now+i);near(s.pnl,s.realized+s.unrealized);near(p.cash,10000+p.trades.reduce((sum,t)=>sum+t.cashDelta,0));assert.ok(p.cash>=0);
  }
});
function fixture(){const values=new Map(),store={get:async k=>structuredClone(values.get(k)),set:async(k,v)=>values.set(k,structuredClone(v))};const row={chainId:'robinhood',pairAddress:token.pair,baseToken:{address,symbol:'RAM'},priceUsd:'1',liquidity:{usd:10000}};let fail=false;
  const fetcher=async url=>{if(fail)throw Error('offline');return{ok:true,json:async()=>url.includes('/token-pairs/')?[row]:{pairs:[row]}};};
  return{values,service:createService(store,fetcher,()=>Date.now()),offline:()=>{fail=true;}};
}
test('concurrent orders are serialized and cannot overspend',async()=>{
  const f=fixture(),s=await f.service.call({type:'state'}),id=s.activeId;
  const results=await Promise.allSettled([1,2].map(i=>f.service.call({type:'trade',payload:{portfolioId:id,order:order('race'+i,'buy',{amount:75})}})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const after=await f.service.call({type:'state'});near(after.portfolios[0].cash,25);assert.equal(after.portfolios[0].trades.length,1);
});
test('network failure cannot create a fill or wipe a held position',async()=>{
  const f=fixture(),s=await f.service.call({type:'state'}),id=s.activeId;await f.service.call({type:'trade',payload:{portfolioId:id,order:order('ok')}});f.offline();
  await assert.rejects(()=>f.service.call({type:'trade',payload:{portfolioId:id,order:order('fail')}}));
  const result=await f.service.call({type:'refresh',payload:{force:true}});assert.equal(result.portfolios[0].trades.length,1);assert.ok(result.portfolios[0].positions[keyOf(token)].mark.error);assert.equal(summary(result.portfolios[0]).stale,1);
});
test('Etherscan key excluded from portfolio export and daily cap blocks before network',async()=>{
  const f=fixture();await f.service.call({type:'saveKey',payload:{key:'test-not-a-real-key'}});const data=await f.service.call({type:'export'});assert.equal(JSON.stringify(data).includes('test-not-a-real-key'),false);
  f.values.set('etherscanUsage',{day:new Date().toISOString().slice(0,10),count:90000,last:0});await assert.rejects(()=>f.service.call({type:'explorer',payload:{address,chain:'robinhood'}}),/cap/);
});
