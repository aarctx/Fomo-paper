import {portfolioSeriesData} from './chart-data.js';

// One persistent chart per dashboard. The five-second render updates its data
// without replacing the canvas or resetting the user's zoom and scroll position.
export function createPortfolioChart(element, onInspect, library=globalThis.LightweightCharts) {
  if(!library?.createChart) throw Error('Chart library unavailable. Reload Paperdesk to load the bundled chart.');
  const formatTime=time=>new Date(Number(time)*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  const chart=library.createChart(element,{
    autoSize:true,
    layout:{background:{type:'solid',color:'#161c17'},textColor:'#939e92',fontFamily:'-apple-system, Segoe UI, sans-serif',fontSize:11,attributionLogo:true},
    grid:{vertLines:{color:'#222c24'},horzLines:{color:'#283229'}},
    rightPriceScale:{borderColor:'#364234',scaleMargins:{top:.15,bottom:.15},minimumWidth:64},
    timeScale:{borderColor:'#364234',timeVisible:true,secondsVisible:false,rightOffset:3,barSpacing:10,minBarSpacing:.1,shiftVisibleRangeOnNewBar:true,
      tickMarkFormatter:(time,type)=>{
        const date=new Date(Number(time)*1000);
        if(type===0)return date.toLocaleDateString(undefined,{year:'numeric'});
        if(type===1)return date.toLocaleDateString(undefined,{month:'short'});
        if(type===2)return date.toLocaleDateString(undefined,{month:'short',day:'numeric'});
        return date.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',hour12:false});
      }},
    crosshair:{mode:library.CrosshairMode.Normal,vertLine:{color:'#758870',labelBackgroundColor:'#34432f'},horzLine:{color:'#758870',labelBackgroundColor:'#34432f'}},
    localization:{priceFormatter:value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(value),timeFormatter:formatTime},
    handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},
    handleScale:{axisPressedMouseMove:true,mouseWheel:true,pinch:true},
  });
  let series, previousData=[], currentKey, currentStyle, observations=new Map(), latestBar, selectedTime;
  const report=()=>onInspect(observations.get(selectedTime)||latestBar);
  chart.subscribeCrosshairMove(event=>{selectedTime=typeof event.time==='number'?event.time:undefined;report();});
  const equal=(a,b)=>a?.time===b?.time&&a?.value===b?.value&&a?.open===b?.open&&a?.high===b?.high&&a?.low===b?.low&&a?.close===b?.close&&a?.color===b?.color;
  const latest=()=>{
    if(!previousData.length)return;
    const count=Math.max(12,Math.floor((element.clientWidth-64)/10)),end=previousData.length-1;
    chart.timeScale().setVisibleLogicalRange({from:end-count+1,to:end+3});
  };
  return {
    render({bars,style,interval,color,key}) {
      const reset=key!==currentKey;
      if(style!==currentStyle){
        if(series)chart.removeSeries(series);
        series=chart.addSeries(style==='candles'?library.CandlestickSeries:library.LineSeries,{
          priceFormat:{type:'price',precision:2,minMove:.01},
          ...(style==='candles'?{upColor:color,downColor:'#f49c9c',borderUpColor:color,borderDownColor:'#f49c9c',wickUpColor:color,wickDownColor:'#f49c9c'}:{color,lineWidth:2,pointMarkersVisible:false,crosshairMarkerVisible:true}),
        });
        previousData=[];currentStyle=style;
      }else series.applyOptions(style==='candles'?{upColor:color,borderUpColor:color,wickUpColor:color}:{color});
      const data=portfolioSeriesData(bars,style,interval,color);
      // A compact minute summary normally changes only the last bar. If a
      // history filter, baseline edit, or external view changes older data,
      // replace the series while preserving the viewport for the same filter.
      const incremental=!reset&&previousData.length>0&&data.length>=previousData.length&&
        previousData.slice(0,-1).every((point,i)=>equal(point,data[i]))&&
        data[previousData.length-1]?.time===previousData.at(-1).time;
      if(incremental){
        for(let i=previousData.length-1;i<data.length;i++)if(!equal(previousData[i],data[i]))series.update(data[i]);
      }else{
        const visible=!reset?chart.timeScale().getVisibleLogicalRange():null;
        series.setData(data);
        if(visible)chart.timeScale().setVisibleLogicalRange(visible);
      }
      previousData=data;currentKey=key;
      observations=new Map(bars.map(bar=>[bar.time/1000,bar]));latestBar=bars.at(-1);
      if(reset){selectedTime=undefined;chart.priceScale('right').applyOptions({autoScale:true});latest();}
      report();
    },
    fit(){
      chart.priceScale('right').applyOptions({autoScale:true});
      chart.timeScale().applyOptions({minBarSpacing:Math.min(.1,Math.max(.000001,(element.clientWidth-80)/(previousData.length+10)))});
      chart.timeScale().fitContent();
    },
    latest(){chart.priceScale('right').applyOptions({autoScale:true});latest();},
    destroy(){chart.remove();},
  };
}
