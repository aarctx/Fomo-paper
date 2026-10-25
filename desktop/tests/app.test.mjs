// Lightweight DOM integration: exercise the shipped UI and timer without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as ledger from '../ledger.js';
import * as charts from '../chart-data.js';
import {createPortfolioChart} from '../chart-view.js';
import {mockCharts} from './chart-mock.mjs';
import {parseToken} from '../market.js';
import {createService} from '../service.js';

class Element {
  constructor(tag,attrs={}) {
    this.tagName=tag;this.attributes=attrs;this.dataset={};this.children=[];this.listeners={};this.value='';this.textContent='';this.style={setProperty(){}};
    const classes=new Set((attrs.class||'').split(' '));
    this.classList={add:v=>classes.add(v),contains:v=>classes.has(v),toggle:(v,on)=>on?classes.add(v):classes.delete(v)};
    for(const [k,v] of Object.entries(attrs))if(k.startsWith('data-'))this.dataset[k.slice(5)]=v;
  }
  setAttribute(k,v){this.attributes[k]=String(v);}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  addEventListener(k,fn){this.listeners[k]=fn;}
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
export async function fixture({history,width=740,style='line',interval=1}={}){
  let now=Date.now();
  const html=fs.readFileSync(new URL('../app.html',import.meta.url),'utf8');
  const elements=[...html.matchAll(/<([a-z0-9-]+)\b([^>]*)>/gi)].map(([,tag,text])=>new Element(tag,Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]))));
  const byId=new Map(elements.filter(e=>e.attributes.id).map(e=>[e.attributes.id,e]));
  byId.get('chart').clientWidth=width;
  const selector=sel=>elements.filter(e=>sel.startsWith('.')?(e.attributes.class||'').split(' ').includes(sel.slice(1)):Object.hasOwn(e.attributes,sel.slice(1,-1)));
  const document={body:new Element('body'),documentElement:new Element('html'),visibilityState:'visible',
    getElementById:id=>{assert.ok(byId.has(id),`Missing HTML element ${id}`);return byId.get(id);},
    querySelector:sel=>selector(sel)[0],querySelectorAll:selector,addEventListener(){},
    createElement:tag=>new Element(tag),createElementNS:(ns,tag)=>{const e=new Element(tag);e.namespaceURI=ns;return e;}};
  const p=ledger.makePortfolio('Chart test',100,now-180_000);
  p.history=history?history(now):Array.from({length:37},(_,i)=>({ts:now-180_000+i*5000,value:100+Math.sin(i)*10,complete:true}));
  p.chartSettings={style,interval,range:0};
  let state={version:1,activeId:p.id,portfolios:[p]};
  const service=createService({get:async()=>structuredClone(state),set:async(k,v)=>{state=structuredClone(v);}},undefined,()=>now);
  const calls=[],timers=[], library=mockCharts();
  const context=vm.createContext({...ledger,...charts,createPortfolioChart:(element,inspect)=>createPortfolioChart(element,inspect,library),parseToken,document,location:{search:''},window:{addEventListener(){}},
    Date:class extends Date{static now(){return now;}},Intl,URL,URLSearchParams,
    extension:true,nativeApp:false,sharedNativeStorage:false,nativeRequest:async()=>{},
    setInterval:(callback,delay)=>{timers.push({callback,delay});return timers.length;},setTimeout:()=>1,clearTimeout(){},
    call:async(type,payload)=>{calls.push(type);return service.call({type,payload});}});
  vm.runInContext(fs.readFileSync(new URL('../app.js',import.meta.url),'utf8').replace(/^import .+;\r?\n/gm,''),context);
  await flush();await flush();
  return {context,document,byId,selector,timers,calls,library,advance:ms=>{now+=ms;}};
}

test('dashboard controls render line and candle charts for every interval and persist the selection',async()=>{
  const f=await fixture(),chart=f.byId.get('chart');
  assert.match(chart.attributes['aria-label'],/Line chart/);
  await f.selector('[data-style]').find(e=>e.dataset.style==='candles').onclick();
  for(const button of f.selector('[data-interval]')){
    await button.onclick();
    assert.equal(button.attributes['aria-pressed'],'true');
    assert.match(chart.attributes['aria-label'],/Candlestick chart/);
    const series=f.library.charts[0].series;
    assert.equal(series.type,'candles');assert.ok(series.data.length);
    f.library.charts[0].crosshair({time:series.data[0].time});
    assert.match(f.byId.get('chart-readout').textContent,/O \$/);
  }
  await f.selector('[data-style]').find(e=>e.dataset.style==='line').onclick();
  assert.equal(f.library.charts[0].series.type,'line');
  assert.equal(f.library.charts.length,1);
  assert.match(f.byId.get('chart-note').textContent,/4 hours closing values/);
});

test('five-second UI timer refreshes visible views, pauses hidden views, and never overlaps requests',async()=>{
  const f=await fixture(),timer=f.timers.find(t=>t.delay===5000);
  assert.ok(timer);
  let count=f.calls.filter(t=>t==='refresh').length;
  f.advance(5000);timer.callback();await flush();
  assert.equal(f.calls.filter(t=>t==='refresh').length,count+1);
  f.document.visibilityState='hidden';f.advance(5000);timer.callback();await flush();
  assert.equal(f.calls.filter(t=>t==='refresh').length,count+1);
  f.document.visibilityState='visible';
  const normal=f.context.call;let release,started=0;
  f.context.call=async(type,payload)=>{if(type==='refresh'){started++;await new Promise(r=>{release=r;});}return normal(type,payload);};
  f.advance(5000);timer.callback();timer.callback();await flush();
  assert.equal(started,1);release();await flush();
  timer.callback();await flush();assert.equal(started,2);release();await flush();
});

test('legacy history sends connected closing values to the real chart adapter',async()=>{
  const f=await fixture({history:now=>Array.from({length:20},(_,i)=>({ts:now-(19-i)*60_000,value:100+i*.5,complete:true}))});
  const series=f.library.charts[0].series;
  assert.equal(series.type,'line');assert.equal(series.data.filter(p=>p.value!==undefined).length,20);
  assert.ok(series.data.every(p=>p.color==='#c4f69d'));
});

test('flat legacy candles and long gaps preserve real OHLC without inventing prices',async()=>{
  const f=await fixture({width:280,style:'candles',history:now=>[24*60,20*60,3,2,1,0].map(m=>({ts:now-m*60_000,value:100,complete:true}))});
  const data=f.library.charts[0].series.data;
  assert.equal(data.filter(p=>p.open!==undefined).length,6);
  assert.equal(data.filter(p=>p.open===undefined).length,2);
  assert.ok(data.filter(p=>p.open!==undefined).every(p=>p.open===100&&p.high===100&&p.low===100&&p.close===100));
});

test('mobile viewport starts readable while retaining all history for panning and Fit all',async()=>{
  const f=await fixture({width:280,style:'candles',history:now=>Array.from({length:240},(_,i)=>({ts:now-(239-i)*60_000,value:100+i,complete:true}))});
  const chart=f.library.charts[0];
  assert.equal(chart.series.data.length,240);assert.ok(chart.visible.to-chart.visible.from<30);
  f.byId.get('chart-fit').onclick();assert.equal(chart.fits,1);
  f.byId.get('chart-latest').onclick();assert.ok(chart.visible.from>200);
  f.byId.get('chart-range').value='7';await f.byId.get('chart-range').onchange();
  assert.equal(f.byId.get('chart-range').value,'7');
  assert.deepEqual(f.selector('[data-interval]').map(e=>e.dataset.interval),['1','5','15','60','240']);
});
