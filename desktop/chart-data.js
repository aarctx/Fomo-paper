import {REFRESH_INTERVAL_MS} from './ledger.js';

export const CHART_INTERVALS = {1:'1 min',5:'5 min',15:'15 min',60:'1 hour',240:'4 hours'};

// UTC-aligned intervals, using only values actually observed by this portfolio.
// Old single-value observations remain usable; they never gain invented OHLC.
export function portfolioCandles(history, minutes = 1, now = Date.now()) {
  if (!Object.hasOwn(CHART_INTERVALS,minutes)) throw Error('Unsupported chart interval.');
  const duration = Number(minutes)*60_000, tolerance = REFRESH_INTERVAL_MS*3;
  const bars = []; let current, previous, gap = false, pendingEvent = '';
  for (const h of history) {
    if (!Number.isFinite(h.ts) || h.ts > now) continue;
    // Carry funding changes through unavailable marks until a trustworthy value arrives.
    if (h.event) pendingEvent = h.event;
    if (!h.complete || !Number.isFinite(h.value)) {
      gap = true;
      if (current && h.ts < current.end) current.partial = true;
      continue;
    }
    const first = h.firstTs ?? h.ts;
    const time = Math.floor(first/duration)*duration;
    const open = h.open ?? h.value, high = h.high ?? h.value, low = h.low ?? h.value;
    // Sparse but valid observations still form a line between closes. Sampling
    // cadence controls candle completeness, not whether every line is broken.
    const sparse = previous !== undefined && first-previous > tolerance;
    const event = pendingEvent, breakBefore = gap || !!event;
    // A starting-balance change is a new baseline, not an investment gain.
    if (event && current?.time === time) { bars.pop(); current = null; }
    if (!current || current.time !== time) {
      current = {time, end:time+duration, open, high, low, close:h.value,
        firstTs:first, lastTs:h.ts, samples:h.samples ?? 1, breakBefore,
        partial:first-time > tolerance || sparse, event};
      bars.push(current);
    } else {
      current.high = Math.max(current.high,high); current.low = Math.min(current.low,low);
      current.close = h.value; current.lastTs = h.ts; current.samples += h.samples ?? 1;
      if (sparse || breakBefore) current.partial = true;
      if (breakBefore) current.breakBefore = true;
    }
    gap = false; pendingEvent = ''; previous = h.ts;
  }
  for (const bar of bars) {
    bar.live = now < bar.end;
    if (Math.min(now,bar.end)-bar.lastTs > tolerance) bar.partial = true;
  }
  return bars;
}

// Lightweight Charts uses UTC seconds. One whitespace slot represents a gap;
// no fabricated values or thousands of empty bars are added after a long pause.
export function portfolioSeriesData(bars, style, minutes, color) {
  const data=[], duration=Number(minutes)*60_000;
  bars.forEach((bar,i)=>{
    const previous=bars[i-1], next=bars[i+1];
    if(previous && bar.time-previous.time>duration) data.push({time:(previous.time+duration)/1000});
    const time=bar.time/1000;
    if(style==='candles') data.push({time,open:bar.open,high:bar.high,low:bar.low,close:bar.close});
    // v5 colors the segment leaving each point. Whitespace alone does not
    // break a line, so explicitly hide the connector across gaps/baselines.
    else data.push({time,value:bar.close,color:next&&(next.breakBefore||next.time-bar.time>duration)?'transparent':color});
  });
  return data;
}

// Review only legacy observations lacking per-token audit data. These are
// suspected spikes, not proven errors; filtering is explicit and view-only.
export function reviewLegacyHistory(history,trades=[]) {
  const flagged=new Set(), windowMs=10*60_000;
  const value=h=>h.value-h.cash;
  for(let i=1;i<history.length-1;i++){
    const before=history[i-1],first=history[i];
    if(!before.complete||!first.complete||first.marks||first.event||first.rollup===false||before.cash!==first.cash||value(before)<=0||value(first)<=0)continue;
    const unusual=h=>value(before)/value(h)>=3;
    if(!unusual(first))continue;
    const group=[];
    for(let j=i;j<history.length;j++){
      const h=history[j];
      if(h.ts-before.ts>windowMs||h.cash!==before.cash||!h.complete||h.marks||h.event||h.rollup===false||value(h)<=0)break;
      if(trades.some(t=>t.ts>before.ts&&t.ts<=h.ts))break;
      if(unusual(h)){group.push(j);continue;}
      if(Math.max(value(h)/value(before),value(before)/value(h))<=1.25){group.forEach(index=>flagged.add(index));i=j-1;}
      break;
    }
  }
  return {count:flagged.size,filtered:history.map((h,i)=>flagged.has(i)?{...h,complete:false}:h)};
}
