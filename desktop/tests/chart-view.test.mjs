import test from 'node:test';
import assert from 'node:assert/strict';
import {createPortfolioChart} from '../chart-view.js';
import {mockCharts} from './chart-mock.mjs';
const bar=(time,value)=>({time:time*60000,open:value,high:value+2,low:value-1,close:value+1});
test('live OHLC updates and new candles preserve a manually panned viewport',()=>{
  const library=mockCharts(),inspect=[];
  const view=createPortfolioChart({clientWidth:700},b=>inspect.push(b),library);
  const input={bars:[bar(1,100),bar(2,103)],style:'candles',interval:1,color:'#c4f69d',key:'p:candles:1:0'};
  view.render(input);
  const chart=library.charts[0],series=chart.series;chart.visible={from:-10,to:1};
  input.bars[1]={...input.bars[1],high:120,close:110};view.render(input);
  assert.equal(series.sets,1);assert.equal(series.updates,1);assert.equal(series.data.at(-1).high,120);
  input.bars.push(bar(3,111));view.render(input);
  assert.equal(series.sets,1);assert.equal(series.updates,2);
  assert.deepEqual(chart.visible,{from:-10,to:1});assert.equal(library.charts.length,1);
  chart.crosshair({time:60});assert.equal(inspect.at(-1).open,100);
  view.render(input);assert.equal(inspect.at(-1).open,100);
  chart.crosshair({});assert.equal(inspect.at(-1).open,111);
});
test('history corrections, color changes, and empty ranges safely replace data',()=>{
  const library=mockCharts(),view=createPortfolioChart({clientWidth:300},()=>{},library);
  const input={bars:[bar(1,100),bar(2,103)],style:'line',interval:1,color:'#c4f69d',key:'p:line:1:0'};
  view.render(input);const chart=library.charts[0];chart.visible={from:0,to:1};
  input.bars[0]=bar(1,99);view.render(input);assert.equal(chart.series.sets,2);
  assert.deepEqual(chart.visible,{from:0,to:1});
  input.color='#a7d7ff';view.render(input);assert.equal(chart.series.data[0].color,'#a7d7ff');
  view.render({...input,bars:[],key:'p:line:1:1'});assert.deepEqual(chart.series.data,[]);
  view.fit();view.latest();view.destroy();
});
test('a missing vendor fails only chart initialization with an actionable message',()=>{
  assert.throws(()=>createPortfolioChart({},()=>{},{}),/Reload Paperdesk/);
});
test('a new portfolio keeps normal candle spacing instead of stretching one candle across the screen',()=>{
  const library=mockCharts(),view=createPortfolioChart({clientWidth:700},()=>{},library);
  view.render({bars:[bar(1,100)],style:'candles',interval:1,color:'#c4f69d',key:'new'});
  const range=library.charts[0].visible;
  assert.ok(range.to-range.from>=60);assert.equal(range.to,3);
});
