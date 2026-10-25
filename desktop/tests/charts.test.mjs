import test from 'node:test';
import assert from 'node:assert/strict';
import {makePortfolio,snapshot,keyOf,REFRESH_INTERVAL_MS} from '../ledger.js';
import {portfolioCandles,CHART_INTERVALS,portfolioSeriesData} from '../chart-data.js';
import {createMarket} from '../market.js';
import {createService} from '../service.js';

const minute=60_000,base=Date.UTC(2026,9,17,0);
const point=(seconds,value,complete=true)=>({ts:base+seconds*1000,value,cash:value,complete});
const ohlc=bar=>[bar.open,bar.high,bar.low,bar.close];
const token=(n,chain='robinhood')=>({chain,address:'0x'+n.toString(16).padStart(40,'0'),pair:'0x'+(n+100).toString(16).padStart(40,'0')});
const row=(t,price=1)=>({chainId:t.chain,pairAddress:t.pair,baseToken:{address:t.address,symbol:'TEST'},priceUsd:String(price),liquidity:{usd:100_000}});
function storeFixture(p=makePortfolio('Test',100,base)) {
  let value={version:1,activeId:p.id,portfolios:[p]};
  return {get:async()=>structuredClone(value),set:async(k,v)=>{value=structuredClone(v);}};
}

test('all five chart intervals have UTC-aligned observed OHLC and a live last candle',()=>{
  assert.deepEqual(Object.keys(CHART_INTERVALS),['1','5','15','60','240']);
  for (const minutes of [1,5,15,60,240]) {
    const boundary=minutes*60;
    const bars=portfolioCandles([point(0,100),point(5,110),point(10,90),point(boundary-5,105),point(boundary,108)],minutes,base+boundary*1000+2000);
    assert.equal(bars.length,2);assert.equal(bars[0].time,base);assert.equal(bars[1].time,base+minutes*minute);
    assert.deepEqual(ohlc(bars[0]),[100,110,90,105]);assert.deepEqual(ohlc(bars[1]),[108,108,108,108]);
    assert.equal(bars[0].live,false);assert.equal(bars[1].live,true);
  }
  assert.throws(()=>portfolioCandles([],2),/interval/);
});

test('five-second snapshots retain intraminute extremes in a compact minute summary',()=>{
  const p=makePortfolio('Test',100,base),old=structuredClone(p.history);
  for (const [seconds,value] of [[5,102],[10,120],[15,80],[20,105],[55,110],[60,111]]) {p.cash=value;snapshot(p,base+seconds*1000);}
  assert.deepEqual(p.history[0],old[0]);
  // The 35-second gap is a separate record, not hidden inside a rollup.
  assert.equal(p.history.length,4);assert.deepEqual([p.history[1].open,p.history[1].high,p.history[1].low,p.history[1].value],[102,120,80,105]);
  assert.equal(p.history[1].samples,4);
  const bars=portfolioCandles(p.history,1,base+65_000);
  assert.deepEqual(ohlc(bars[0]),[100,120,80,110]);assert.equal(bars[0].partial,true);
});

test('legacy observations are unchanged and no prices or candles are fabricated across gaps',()=>{
  const history=[point(0,100),point(5,120,false),point(600,110)];const before=structuredClone(history);
  const bars=portfolioCandles(history,1,base+610_000);
  assert.equal(bars.length,2);assert.deepEqual(ohlc(bars[0]),[100,100,100,100]);
  assert.equal(bars[0].partial,true);assert.equal(bars[1].breakBefore,true);
  assert.deepEqual(history,before);
});

test('stale samples cannot affect a candle high or low even when the same interval recovers',()=>{
  const bars=portfolioCandles([point(0,100),point(5,999,false),point(10,105)],1,base+12_000);
  assert.deepEqual(ohlc(bars[0]),[100,105,100,105]);assert.equal(bars[0].partial,true);assert.equal(bars[0].breakBefore,true);
  const trailingFailure=portfolioCandles([point(0,100),point(5,999,false)],1,base+6000);
  assert.equal(trailingFailure[0].partial,true);
});

test('starting cash changes reset the current candle and break the old performance line',()=>{
  const bars=portfolioCandles([point(0,100),point(60,101),{...point(65,200),event:'Starting cash changed'},point(70,201)],1,base+72_000);
  assert.deepEqual(ohlc(bars[0]),[100,100,100,100]);assert.deepEqual(ohlc(bars[1]),[200,201,200,201]);
  assert.equal(bars[1].breakBefore,true);assert.equal(bars[1].event,'Starting cash changed');
});

test('polling rollups never absorb trade observations, stale intervals, or setup events',()=>{
  const p=makePortfolio('Test',100,base);snapshot(p,base+5000);snapshot(p,base+10_000,true);
  const trade=structuredClone(p.history.at(-1));p.cash=80;snapshot(p,base+15_000);
  assert.deepEqual(p.history.at(-2),trade);
  p.history.at(-1).event='Starting cash changed';snapshot(p,base+20_000);
  assert.equal(p.history.at(-2).event,'Starting cash changed');assert.equal(p.history.at(-1).samples,1);
});

test('30 positions on one chain use one batched price request and keep their exact pools',async()=>{
  const tokens=Array.from({length:30},(_,i)=>token(i+1)),requests=[];
  const market=createMarket(async url=>{requests.push(url);return {ok:true,json:async()=>({pairs:tokens.map(t=>row(t))})};},()=>base);
  const results=await market.quoteMany(tokens);
  assert.equal(requests.length,1);assert.equal(new URL(requests[0]).pathname.split('/').at(-1).split(',').length,30);
  assert.equal(results.length,30);assert.ok(results.every(r=>r.quote?.pair===r.token.pair));
  await market.quote(tokens[0]);assert.equal(requests.length,1);
});

test('missing pools and a failed chain mark only affected positions unavailable',async()=>{
  const a=token(1),missing=token(2),b=token(3,'base');
  const market=createMarket(async url=>{
    if(url.includes('/base/'))throw Error('offline');
    return {ok:true,json:async()=>({pairs:[row(a),row({...missing,pair:'wrong-pool'},999)]})};
  },()=>base);
  const results=await market.quoteMany([a,missing,b]);
  assert.equal(results.find(r=>r.token===a).quote.price,1);
  assert.match(results.find(r=>r.token===missing).error,/exact token and pool/);
  assert.match(results.find(r=>r.token===b).error,/unreachable/);
});

test('a five-second tick fetches a new quote and updates value without duplicate cross-view polls',async()=>{
  let now=base,price=1,calls=0;const t=token(1),p=makePortfolio('Test',100,base);p.cash=50;
  p.positions[keyOf(t)]={token:t,qty:50,basis:50,mark:{price:1,ts:base}};
  const storage=storeFixture(p),fetcher=async()=>{calls++;return {ok:true,json:async()=>({pairs:[row(t,price)]})};};
  const a=createService(storage,fetcher,()=>now),b=createService(storage,fetcher,()=>now);
  await a.call({type:'refresh'});assert.equal(calls,1);
  now+=1000;await b.call({type:'refresh'});assert.equal(calls,1);
  now=base+REFRESH_INTERVAL_MS;price=2;
  const second=await a.call({type:'refresh'});assert.equal(calls,2);assert.equal(second.portfolios[0].history.at(-1).value,150);
  now+=REFRESH_INTERVAL_MS;price=3;
  const third=await a.call({type:'refresh'});assert.equal(calls,3);assert.equal(third.portfolios[0].history.at(-1).value,200);
  assert.equal(third.portfolios[0].history.at(-1).samples,2);
});

test('forced trade quotes bypass the polling cache and rate limits pause network requests',async()=>{
  let now=base,calls=0,limited=false;const t=token(1);
  const market=createMarket(async()=>{calls++;return limited?{ok:false,status:429}:{ok:true,json:async()=>({pairs:[row(t)]})};},()=>now);
  await market.quote(t);await market.quote(t);assert.equal(calls,1);
  await market.quote(t,{force:true});assert.equal(calls,2);
  now+=5000;limited=true;await assert.rejects(()=>market.quote(t),/rate limit/);assert.equal(calls,3);
  now+=5000;await assert.rejects(()=>market.quote(t),/pause/);assert.equal(calls,3);
  now+=60_000;limited=false;await market.quote(t);assert.equal(calls,4);
});

test('chart preferences persist separately per portfolio and reject invalid intervals atomically',async()=>{
  const p=makePortfolio('Original',100,base),storage=storeFixture(p),svc=createService(storage);
  const payload={portfolioId:p.id,style:'candles',interval:15};
  await svc.call({type:'chartSettings',payload});
  const newer=await svc.call({type:'newPortfolio',payload:{name:'Other',capital:500}});
  assert.equal(newer.portfolios[1].chartSettings,undefined);
  const reloaded=await createService(storage).call({type:'state'});
  assert.deepEqual(reloaded.portfolios[0].chartSettings,{style:'candles',interval:15,range:0,hideSpikes:false});
  const before=structuredClone(reloaded);
  await assert.rejects(()=>svc.call({type:'chartSettings',payload:{...payload,interval:2}}),/supported/);
  assert.deepEqual(await svc.call({type:'state'}),before);
  assert.deepEqual(reloaded.portfolios[0].history,p.history);
});

test('ordinary one-minute sampling marks partial candles without breaking every line segment',()=>{
  const history=Array.from({length:20},(_,i)=>point(i*60,100+i));
  for(const interval of [1,5,15]){
    const bars=portfolioCandles(history,interval,base+20*minute);
    assert.ok(bars.length>=2);assert.ok(bars.slice(1).every(b=>!b.breakBefore));
    assert.ok(bars.some(b=>b.partial));
  }
});

test('TradingView data uses UTC seconds, whitespace gaps, and hidden gap connectors',()=>{
  const bars=portfolioCandles([point(0,100),point(60,110),point(86400,90),point(86460,100)],1,base+86465_000);
  const line=portfolioSeriesData(bars,'line',1,'#c4f69d');
  assert.deepEqual(line.map(p=>p.time),[0,60,120,86400,86460].map(t=>base/1000+t));
  assert.deepEqual(line[2],{time:base/1000+120});
  assert.equal(line[1].color,'transparent');assert.equal(line[0].color,'#c4f69d');
  const candles=portfolioSeriesData(bars,'candles',1,'#c4f69d');
  assert.equal(candles.length,5);assert.deepEqual(candles[0],{time:base/1000,open:100,high:100,low:100,close:100});
});

test('baseline changes hide the incoming line without changing earlier stored history',()=>{
  const bars=portfolioCandles([point(0,100),{...point(60,200),event:'Starting cash changed'},point(120,201)],1,base+121_000);
  const data=portfolioSeriesData(bars,'line',1,'#c4f69d');
  assert.deepEqual(data.map(p=>p.color),['transparent','#c4f69d','#c4f69d']);
  assert.deepEqual(data.map(p=>p.value),[100,200,201]);
});


test('cash changes during unavailable marks do not turn funding into a gain candle on recovery',()=>{
  for(const recoveredAt of [70,125]){
    const history=[point(0,100),point(60,101),{...point(65,200,false),event:'Starting cash changed'},point(recoveredAt,201)];
    const before=structuredClone(history),bars=portfolioCandles(history,1,base+(recoveredAt+2)*1000),last=bars.at(-1);
    assert.deepEqual(ohlc(last),[201,201,201,201]);assert.equal(last.breakBefore,true);assert.equal(last.event,'Starting cash changed');
    assert.equal(portfolioSeriesData(bars,'line',1,'green').at(-2).color,'transparent');assert.deepEqual(history,before);
  }
});
