import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarket,normalizePair} from '../market.js';
import {createService} from '../service.js';
import {makePortfolio,execute,updateMark,snapshot,keyOf,poolKey,summary} from '../ledger.js';
import {reviewLegacyHistory} from '../chart-data.js';
const base=Date.UTC(2026,9,25,16),address='nxPqZ4F7ux8Vph5NFu25rEP6Kx9Gr1U6Fmj36Rjpump';
const token={chain:'solana',address,pair:'31viZ3y3pWyiH6dC1G3NpHSDkgtLeX7hUSVQutu2F65S'};
const peer='G2UuRbmVDzDFP4qyoBJrSKBXSi7d6V4bPP9tHPs36y4b';
const row=(price,pair=token.pair,liquidity=500000)=>({chainId:token.chain,pairAddress:pair,baseToken:{address,symbol:'DACITY'},quoteToken:{address:'So11111111111111111111111111111111111111112',symbol:'SOL'},priceNative:String(price/100),priceUsd:String(price),dexId:'test',liquidity:{usd:liquidity}});
function fixture({candidate=.008,checked=candidate,peerPrice,offline=false}={}){
  let now=base+5000;const requests=[];
  const p=makePortfolio('Synthetic test',1000,base);
  execute(p,{id:'entry',side:'buy',token,amount:250},{...token,price:.01,ts:base,liquidity:500000},base);
  const initial={version:1,activeId:p.id,portfolios:[p]},stored={ledger:structuredClone(initial)};
  const fetcher=async url=>{
    requests.push(url);const rows=url.includes('/token-pairs/')?[row(checked),...(peerPrice===undefined?[]:[row(peerPrice,peer,250000)])]:[row(candidate)];
    if(offline&&url.includes('/token-pairs/'))throw Error('offline');
    return {ok:true,json:async()=>url.includes('/token-pairs/')?rows:{pairs:rows}};
  };
  const service=createService({get:async k=>structuredClone(stored[k]),set:async(k,v)=>{stored[k]=structuredClone(v);}},fetcher,()=>now);
  return {service,stored,initial,requests,fetcher,advance:ms=>{now+=ms;},clock:()=>now};
}

test('a near-zero quote cannot wipe a held position or create a false chart low',async()=>{
  const f=fixture({candidate:1e-8,peerPrice:.0101});
  const result=await f.service.call({type:'refresh'}),p=result.portfolios[0],pos=p.positions[keyOf(token)],original=f.initial.portfolios[0];
  assert.equal(pos.mark.price,.01);assert.match(pos.mark.error,/unconfirmed/);assert.equal(pos.mark.rejectedQuote.price,1e-8);
  assert.equal(p.cash,original.cash);assert.equal(pos.qty,original.positions[keyOf(token)].qty);assert.deepEqual(p.trades,original.trades);
  assert.equal(p.history.at(-1).complete,false);assert.equal(p.history.at(-1).value,summary(original,base).value);
  assert.equal(p.history.at(-1).marks[keyOf(token)].rejectedQuote.price,1e-8);
  assert.equal(f.requests.length,2);
});

test('the alternate endpoint can recover a transient bad quote without changing pools',async()=>{
  const f=fixture({candidate:1e-8,checked:.0098,peerPrice:.0099});
  const result=await f.service.call({type:'refresh'}),pos=result.portfolios[0].positions[keyOf(token)];
  assert.equal(pos.mark.price,.0098);assert.equal(pos.token.pair,token.pair);assert.equal(pos.mark.error,undefined);
  assert.equal(pos.mark.priceCheck.initialPrice,1e-8);assert.equal(pos.mark.priceCheck.comparisons[0].pair,peer);
});

test('a corroborated real 90 percent loss is accepted rather than hidden',async()=>{
  const f=fixture({candidate:.001,peerPrice:.00102});
  const result=await f.service.call({type:'refresh'}),p=result.portfolios[0];
  assert.equal(p.positions[keyOf(token)].mark.price,.001);assert.equal(p.history.at(-1).complete,true);
  assert.ok(summary(p,base+5000).holdings<25);
  const sale=await f.service.call({type:'trade',payload:{portfolioId:p.id,order:{id:'exit',side:'sell',token,percent:100}}});
  assert.equal(Object.keys(sale.state.portfolios[0].positions).length,0);
});

test('forced quotes and both trade directions reject unconfirmed prices without changing the ledger',async()=>{
  const f=fixture({candidate:1e-8,peerPrice:.01}),id=f.initial.activeId;
  await assert.rejects(()=>f.service.call({type:'quote',payload:{portfolioId:id,input:address,chain:'solana',force:true}}),/unconfirmed/);
  for(const side of ['buy','sell'])await assert.rejects(()=>f.service.call({type:'trade',payload:{portfolioId:id,order:{id:side,side,token,amount:10,percent:50}}}),/unconfirmed/);
  assert.deepEqual(f.stored.ledger,f.initial);
});

test('a single-pool extreme move is clearly unconfirmed, and network failure preserves the last mark',async()=>{
  for(const offline of [false,true]){
    const f=fixture({candidate:.0001,offline});
    const result=await f.service.call({type:'refresh'}),pos=result.portfolios[0].positions[keyOf(token)];
    assert.equal(pos.mark.price,.01);assert.match(pos.mark.error,/unconfirmed|could not be checked/);
  }
});

test('first lookup rejects an outlier pool while tiny consistent prices remain valid',async()=>{
  const market=createMarket(async()=>({ok:true,json:async()=>[row(.01),row(.000001,peer,250000)]}),()=>base);
  await assert.rejects(()=>market.quote({chain:'solana',address}),/disagree/);
  const tiny=createMarket(async()=>({ok:true,json:async()=>[row(1e-10),row(1.01e-10,peer,250000)]}),()=>base);
  assert.equal((await tiny.quote({chain:'solana',address})).price,1e-10);
});

test('wrong-contract and dust pools cannot corroborate an extreme move',async()=>{
  const other={...row(.0001,peer,100000),baseToken:{address:'DFMt2FyLpB6ekPNAzVErLXgpSnJ9CRf1VnxBAkTLpump',symbol:'DACITY'}};
  const market=createMarket(async url=>({ok:true,json:async()=>url.includes('/token-pairs/')?[row(.0001),other,row(.0001,'dust',1)]:{pairs:[row(.0001)]}}),()=>base);
  await assert.rejects(()=>market.quote(token,{referencePrice:.01}),/unconfirmed/);
});

test('confirmation caching limits extra calls and retains the actual receipt timestamp',async()=>{
  const f=fixture({candidate:1e-8,checked:.01,peerPrice:.01});
  await f.service.call({type:'refresh'});f.advance(5000);
  const result=await f.service.call({type:'refresh'});
  assert.equal(f.requests.filter(u=>u.includes('/token-pairs/')).length,1);
  assert.equal(result.portfolios[0].positions[keyOf(token)].mark.ts,base+5000);
  f.advance(5000);await f.service.call({type:'refresh'});
  assert.equal(f.requests.filter(u=>u.includes('/token-pairs/')).length,2);
});

test('one bad token does not prevent another held token from receiving its price update',async()=>{
  const a=fixture({candidate:1e-8,peerPrice:.01});
  const other={...token,address:'DFMt2FyLpB6ekPNAzVErLXgpSnJ9CRf1VnxBAkTLpump',pair:'2jAq7KMy4eqxex1DQHo1nSybEv2yTY94dUDKmvZ2yUb3'};
  a.stored.ledger.portfolios[0].positions[keyOf(other)]={token:other,qty:100,basis:10,mark:{price:.1,ts:base}};
  const marketFetch=async url=>({ok:true,json:async()=>url.includes('/token-pairs/')?[row(1e-8),row(.01,peer,250000)]:{pairs:[row(1e-8),{...row(.11,other.pair),baseToken:{address:other.address,symbol:'OTHER'}}]}});
  const svc=createService({get:async k=>structuredClone(a.stored[k]),set:async(k,v)=>a.stored[k]=structuredClone(v)},marketFetch,a.clock);
  const result=await svc.call({type:'refresh'}),positions=result.portfolios[0].positions;
  assert.equal(positions[keyOf(token)].mark.price,.01);assert.equal(positions[keyOf(other)].mark.price,.11);
});

test('EVM pool casing is normalized in refresh and fills while Solana remains case-sensitive',async()=>{
  const t={chain:'base',address:'0x'+'a'.repeat(40),pair:'0x'+'Ab'.repeat(20)},q={...t,price:1,ts:base};
  const p=makePortfolio('EVM',100,base);execute(p,{id:'buy',side:'buy',amount:10,token:t},q,base);
  updateMark(p,t,{...q,pair:t.pair.toLowerCase(),price:2},base);
  execute(p,{id:'sell',side:'sell',percent:50,token:t},{...q,pair:t.pair.toLowerCase()},base);
  assert.equal(poolKey(t),poolKey({...t,pair:t.pair.toLowerCase()}));
  assert.notEqual(poolKey(token),poolKey({...token,pair:token.pair.toLowerCase()}));
  const svc=createService({get:async()=>({version:1,activeId:p.id,portfolios:[p]}),set:async()=>{}},async()=>({ok:true,json:async()=>({pairs:[{chainId:t.chain,pairAddress:t.pair.toLowerCase(),baseToken:{address:t.address},priceUsd:'1.1',liquidity:{usd:10000}}]})}),()=>base+5000);
  const result=await svc.call({type:'refresh'});assert.equal(result.portfolios[0].positions[keyOf(t)].mark.price,1.1);
});

test('new snapshots retain valuation inputs and minute-low evidence without altering older records',()=>{
  const p=makePortfolio('Audit',100,base),q={...token,price:.01,ts:base};execute(p,{id:'buy',side:'buy',amount:10,token},q,base);
  const old=structuredClone(p.history);snapshot(p,base+5000);updateMark(p,token,{...q,price:.009,ts:base+10000},base+10000);snapshot(p,base+10000);
  assert.deepEqual(p.history.slice(0,old.length),old);
  const last=p.history.at(-1);assert.equal(last.marks[keyOf(token)].price,.009);assert.equal(last.lowMarks[keyOf(token)].price,.009);
});

const h=(minute,holdings,extra={})=>({ts:base+minute*60000,cash:500,value:500+holdings,complete:true,rollup:true,...extra});
test('legacy spike filtering is reversible, preserves originals, and leaves sustained losses visible',()=>{
  const history=[h(0,200),h(1,26),h(2,26),h(3,198),h(4,195),h(5,20),h(20,21)];
  const original=structuredClone(history),review=reviewLegacyHistory(history);
  assert.equal(review.count,2);assert.equal(review.filtered[1].complete,false);assert.equal(review.filtered[5].complete,true);
  assert.deepEqual(history,original);
});

test('trades, cash changes, trusted new observations, and long gaps are never filtered as legacy spikes',()=>{
  assert.equal(reviewLegacyHistory([h(0,200),h(1,26),h(2,200)],[{ts:base+60000}]).count,0);
  for(const extra of [{marks:{}},{cash:100},{event:'Starting cash changed'},{rollup:false},{complete:false}])assert.equal(reviewLegacyHistory([h(0,200),h(1,26,extra),h(2,200)]).count,0);
  assert.equal(reviewLegacyHistory([h(0,200),h(1,26),h(20,200)]).count,0);
});

test('a cached quote from another portfolio cannot bypass the held-position jump check',async()=>{
  const market=createMarket(async url=>({ok:true,json:async()=>url.includes('/token-pairs/')?[row(1e-8),row(.01,peer,250000)]:{pairs:[row(1e-8)]}}),()=>base);
  // A standalone pinned-pool lookup lacks a held-position reference.
  await market.quote(token);
  const results=await market.quoteMany([{...token,referencePrice:.01}]);
  assert.equal(results[0].quote,undefined);assert.match(results[0].error,/unconfirmed/);
});

test('healthy recoveries between multiple legacy dips are never hidden as upward spikes',()=>{
  const reviewed=reviewLegacyHistory([h(0,200),h(1,26),h(2,200),h(3,198),h(4,26),h(5,201)]);
  assert.equal(reviewed.count,2);assert.equal(reviewed.filtered[2].complete,true);assert.equal(reviewed.filtered[3].complete,true);
});
