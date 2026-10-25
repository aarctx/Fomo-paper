import assert from 'node:assert/strict';
// API recorder for UI/update semantics; canvas rendering is checked separately
// against the unmodified production library in an isolated headless browser.
export function mockCharts(){
  const library={charts:[],CrosshairMode:{Normal:0},LineSeries:'line',CandlestickSeries:'candles'};
  library.createChart=()=>{
    const chart={visible:null,fits:0,remove(){},subscribeCrosshairMove(fn){this.crosshair=fn;},removeSeries(){this.series=null;},
      priceScale(){return {applyOptions(){}};},timeScale(){return {applyOptions(){},getVisibleLogicalRange:()=>this.visible,setVisibleLogicalRange:range=>{this.visible=range;},fitContent:()=>{this.fits++;}};},
      addSeries(type){
        const series={type,data:[],sets:0,updates:0,applyOptions(){},setData(data){
          assert.ok(data.every((p,i)=>Number.isFinite(p.time)&&(!i||p.time>data[i-1].time)));
          this.data=structuredClone(data);this.sets++;
        },update(point){
          const last=this.data.at(-1);assert.ok(!last||point.time>=last.time);
          if(last?.time===point.time)this.data[this.data.length-1]=structuredClone(point);
          else this.data.push(structuredClone(point));this.updates++;
        }};this.series=series;return series;
      }};
    library.charts.push(chart);return chart;
  };return library;
}
