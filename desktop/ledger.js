// Pure accounting. All values are simulated USD; no wallet or transaction code.
export const VERSION = 1;
// Storage version stays compatible with existing portfolios.
export const MAX_QUOTE_AGE = 60_000;
export const REFRESH_INTERVAL_MS = 5_000;
export const THEMES = {lime:'#c4f69d',mint:'#9de8cd',sky:'#a7d7ff',violet:'#d6bbff',peach:'#ffc5a5'};
export const uuid = () => crypto.randomUUID();
export function number(value, label, min = 0, max = 1e12) {
  const n = Number(value);
  if (value === '' || value === null || !Number.isFinite(n) || n < min || n > max) throw Error(`${label} is invalid.`);
  return n;
}
export function keyOf(token) {
  if (!token || !/^[a-z0-9-]{1,30}$/.test(token.chain || '') || !/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(token.address || '')) throw Error('A chain and full contract address are required.');
  return `${token.chain}:${token.address.startsWith('0x') ? token.address.toLowerCase() : token.address}`;
}
export function poolKey(token) {
  const key=keyOf(token);
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(token.pair || '')) throw Error('Invalid pool identity.');
  return key+':'+(token.chain==='solana'?token.pair:token.pair.toLowerCase());
}
export function quoteMark(q) {
  const mark={price:q.price,ts:q.ts,source:q.source,pair:q.pair};
  for(const field of ['dex','liquidity','priceNative','quoteAddress','quoteSymbol','priceCheck'])if(q[field]!==undefined)mark[field]=q[field];
  return mark;
}
export function makePortfolio(name = 'My paper portfolio', capital = 100, now = Date.now()) {
  capital = number(capital, 'Starting cash', 1, 1e8);
  if (!String(name).trim() || String(name).length > 60) throw Error('Use a portfolio name between 1 and 60 characters.');
  return {id: uuid(), name: String(name).trim(), description:'', theme:'lime', createdAt: now, capital, cash: capital, realized: 0, fees: 0,
    settings: {feeBps: 100, slippageBps: 50}, positions: {}, trades: [], history: [{ts: now, value: capital, cash: capital, complete: true}]};
}
// Adjust funding by the difference, retaining invested amounts and trading P&L.
export function startingCashChange(p, value) {
  const capital=number(value,'Starting cash',1,1e8);
  const minimum=Math.max(1,Math.ceil((p.capital-p.cash-1e-9)*100)/100);
  const delta=capital-p.capital, cash=p.cash+delta;
  if(cash < -1e-9)throw Error(`Use at least $${minimum.toFixed(2)} in starting cash so available cash stays at or above $0.`);
  return {capital,delta,cash:Math.max(0,cash),minimum};
}
export function customizePortfolio(p, fields, now = Date.now()) {
  const name=String(fields.name ?? p.name).trim();
  const description=String(fields.description ?? p.description ?? '').trim();
  const theme=fields.theme ?? p.theme ?? 'lime';
  const adjustment=startingCashChange(p,fields.capital ?? p.capital),capital=adjustment.capital;
  if(fields.expectedCapital!==undefined&&fields.expectedCapital!==p.capital)throw Error('Starting cash changed in another view. Close and reopen Customize to review the latest balance.');
  const feeBps=number(fields.feeBps ?? p.settings.feeBps,'Fee',0,2000);
  const slippageBps=number(fields.slippageBps ?? p.settings.slippageBps,'Slippage',0,2000);
  if(!name || name.length>60) throw Error('Use a portfolio name between 1 and 60 characters.');
  if(description.length>280) throw Error('Keep the portfolio description within 280 characters.');
  if(!Object.hasOwn(THEMES,theme)) throw Error('Choose one of the portfolio colors.');
  const capitalChanged=capital!==p.capital;
  // Validate the full update before touching the saved portfolio.
  p.name=name;p.description=description;p.theme=theme;p.settings={feeBps,slippageBps};
  if(capitalChanged){
    const previous=p.capital,cashBefore=p.cash;p.cash=adjustment.cash;p.capital=capital;
    p.configurationChanges??=[];p.configurationChanges.push({ts:now,field:'startingCash',previous,value:capital,cashDelta:adjustment.delta,cashBefore,cashAfter:p.cash});
    snapshot(p,now,true);p.history.at(-1).event='Starting cash changed';p.history.at(-1).cashAdjustment=adjustment.delta;
  }
  return p;
}
export function newState() {
  const p = makePortfolio();
  return {version: VERSION, activeId: p.id, portfolios: [p]};
}
export function summary(p, now = Date.now()) {
  let holdings = 0, basis = 0, stale = 0;
  for (const pos of Object.values(p.positions)) {
    holdings += pos.qty * pos.mark.price;
    basis += pos.basis;
    if (pos.mark.error || now - pos.mark.ts > MAX_QUOTE_AGE || pos.mark.ts > now) stale++;
  }
  const value = p.cash + holdings;
  return {value, cash: p.cash, holdings, basis, pnl: value - p.capital, pnlPct: (value / p.capital - 1) * 100, unrealized: holdings - basis, realized: p.realized, fees: p.fees, stale};
}
export function snapshot(p, now = Date.now(), force = false) {
  const last = p.history.at(-1);
  const s = summary(p, now);
  const complete = s.stale === 0;
  if (!force && last && now - last.ts < REFRESH_INTERVAL_MS*.8 && last.complete === complete) return;
  // New observations keep the per-token inputs behind each portfolio total.
  // Existing records are left intact; missing old prices cannot be reconstructed.
  const marks=Object.fromEntries(Object.entries(p.positions).map(([key,pos])=>[key,{
    qty:pos.qty,price:pos.mark.price,ts:pos.mark.ts,pair:pos.token.pair,
    ...(pos.mark.priceNative?{priceNative:pos.mark.priceNative,quoteAddress:pos.mark.quoteAddress}:{}),
    ...(pos.mark.error?{error:pos.mark.error}:{}),
    ...(pos.mark.rejectedQuote?{rejectedQuote:pos.mark.rejectedQuote}:{}),
  }]));
  // Keep minute OHLC summaries of new polling samples. Existing history and trade
  // observations stay intact; never combine stale intervals or setup changes.
  if (!force && last?.rollup && !last.event && last.complete === complete &&
      now > last.ts && now-last.ts <= REFRESH_INTERVAL_MS*3 &&
      Math.floor(last.ts/60_000) === Math.floor(now/60_000)) {
    if(s.value<last.low)last.lowMarks=marks;
    if(s.value>last.high)last.highMarks=marks;
    last.high = Math.max(last.high,s.value); last.low = Math.min(last.low,s.value);last.marks=marks;
    last.ts = now; last.value = s.value; last.cash = s.cash; last.samples++;
  } else {
    p.history.push({ts:now, firstTs:now, value:s.value, cash:s.cash, complete,
      open:s.value, high:s.value, low:s.value, samples:1, rollup:!force,marks});
  }
}
export function validateQuote(q, now = Date.now()) {
  keyOf(q);
  number(q.price, 'Price', Number.MIN_VALUE);
  if (!q.pair || !/^[a-zA-Z0-9-]{1,100}$/.test(q.pair)) throw Error('Pool identity is missing.');
  if (!Number.isFinite(q.ts) || q.ts > now || now - q.ts > MAX_QUOTE_AGE || q.error) throw Error('Fresh price unavailable. Refresh before trading.');
}
export function execute(p, order, q, now = Date.now()) {
  if (!order || typeof order.id !== 'string' || order.id.length > 100) throw Error('Order identity missing.');
  // Retrying an already committed request returns the exact saved fill.
  const duplicate = p.trades.find(t => t.id === order.id);
  if (duplicate) return duplicate;
  validateQuote(q, now);
  if (keyOf(order.token) !== keyOf(q)) throw Error('The price belongs to a different token.');
  const k = keyOf(q), pos = p.positions[k];
  if (pos && poolKey(pos.token) !== poolKey(q)) throw Error('The selected pool differs from your existing position.');
  const feeRate = number(p.settings.feeBps, 'Fee', 0, 2000) / 10_000;
  const slip = number(p.settings.slippageBps, 'Slippage', 0, 2000) / 10_000;
  const side = order.side;
  if (!['buy', 'sell'].includes(side)) throw Error('Choose Buy or Sell.');
  const fillPrice = q.price * (side === 'buy' ? 1 + slip : 1 - slip);
  let qty, gross, fee, cashDelta, realized = 0, basisRemoved = 0;
  if (side === 'buy') {
    const spend = number(order.amount, 'Total spend', 0.01, 1e8);
    if (spend > p.cash + 1e-9) throw Error('Not enough paper cash.');
    gross = spend / (1 + feeRate); fee = spend - gross; qty = gross / fillPrice; cashDelta = -spend;
  } else {
    if (!pos) throw Error('You do not hold this token.');
    const pct = number(order.percent, 'Sell percentage', 0.01, 100);
    qty = pos.qty * pct / 100; gross = qty * fillPrice; fee = gross * feeRate; cashDelta = gross - fee;
    basisRemoved = pos.basis * pct / 100; realized = cashDelta - basisRemoved;
  }
  if (![qty, gross, fee, cashDelta, realized].every(Number.isFinite) || qty <= 0) throw Error('Order size cannot be represented.');
  const token = {chain:q.chain, address:q.address, pair:q.pair, symbol:String(q.symbol || 'TOKEN').slice(0,30), name:String(q.name || q.symbol || 'Token').slice(0,100)};
  const trade = {id:order.id, ts:now, token, side, qty, referencePrice:q.price, price:fillPrice, quoteAt:q.ts, source:q.source,
    gross, fee, slippageBps:p.settings.slippageBps, feeBps:p.settings.feeBps, cashDelta, realized, note:String(order.note || '').slice(0,500)};
  if (side === 'buy') {
    p.positions[k] = {token, qty:(pos?.qty || 0) + qty, basis:(pos?.basis || 0) - cashDelta, mark:quoteMark(q)};
  } else if (Number(order.percent) === 100) delete p.positions[k];
  else { pos.qty -= qty; pos.basis -= basisRemoved; pos.mark = quoteMark(q); }
  p.cash = Math.max(0, p.cash + cashDelta); p.realized += realized; p.fees += fee; p.trades.push(trade);
  snapshot(p, now, true);
  return trade;
}
export function updateMark(p, token, quote, now = Date.now()) {
  const pos = p.positions[keyOf(token)];
  if (!pos) return;
  validateQuote(quote, now);
  if (poolKey(quote) !== poolKey(token)) throw Error('Pool or token changed.');
  pos.mark = quoteMark(quote);
}
