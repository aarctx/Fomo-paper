import {newState, makePortfolio, execute, updateMark, snapshot, keyOf, poolKey, number, customizePortfolio} from './ledger.js';
import {createMarket, parseToken, CHAINS} from './market.js';
import {CHART_INTERVALS} from './chart-data.js';

export function createService(storage, fetcher = fetch, clock = Date.now) {
  const market = createMarket(fetcher,clock);
  let queue = Promise.resolve();
  const serial = fn => { const job = queue.then(fn); queue = job.catch(()=>{}); return job; };
  async function load() {
    let s = await storage.get('ledger');
    if (!s) { s = newState(); await storage.set('ledger',s); }
    if (s.version !== 1 || !Array.isArray(s.portfolios)) throw Error('Saved portfolio cannot be read. Export your data before changing versions.');
    return structuredClone(s);
  }
  async function refresh(s, force = false) {
    const started = clock();
    // Share the polling cadence across tabs and the two native views. A view
    // reopening still receives the latest stored state without another request.
    if (!force && s.lastRefreshAt !== undefined && started >= s.lastRefreshAt && started-s.lastRefreshAt < 4000) return s;
    const unique = new Map();
    for (const p of s.portfolios) for (const pos of Object.values(p.positions)) {
      const key=poolKey(pos.token),old=unique.get(key);
      if(!old||pos.mark.ts>old.referenceAt)unique.set(key,{...pos.token,referencePrice:pos.mark.price,referenceAt:pos.mark.ts});
    }
    for (const {token,quote:q,error,rejectedQuote} of await market.quoteMany([...unique.values()],{force})) {
      for (const p of s.portfolios) {
        const pos = p.positions[keyOf(token)];
        if (!pos || poolKey(pos.token) !== poolKey(token)) continue;
        try{
          if(q)updateMark(p,token,q,clock());
          else{
            pos.mark.error=error;pos.mark.checkedAt=clock();
            if(rejectedQuote)pos.mark.rejectedQuote=rejectedQuote;else delete pos.mark.rejectedQuote;
          }
        }catch(e){pos.mark.error=e.message;pos.mark.checkedAt=clock();}
      }
    }
    for (const p of s.portfolios) snapshot(p,clock());
    s.lastRefreshAt = started;
    await storage.set('ledger',s); return s;
  }
  async function explorer(token) {
    const apiKey = await storage.get('etherscanKey');
    if (!apiKey) throw Error('Add an Etherscan key in Settings first.');
    const chainId = CHAINS[token.chain];
    if (!chainId) throw Error('Etherscan does not support this chain.');
    const today = new Date(clock()).toISOString().slice(0,10);
    let usage = await storage.get('etherscanUsage') || {day:today,count:0,last:0};
    if (usage.day !== today) usage = {day:today,count:0,last:usage.last};
    if (usage.count >= 90000) throw Error('The 90,000-call daily cap has been reached.');
    if (clock()-usage.last < 1000) throw Error('Wait one second before another explorer check.');
    usage.count++; usage.last = clock(); await storage.set('etherscanUsage',usage);
    const params = new URLSearchParams({chainid:String(chainId),module:'contract',action:'getsourcecode',address:token.address,apikey:apiKey});
    let response, data;
    try { response = await fetcher('https://api.etherscan.io/v2/api?'+params,{signal:AbortSignal.timeout(12000),credentials:'omit',redirect:'error'}); data = await response.json(); }
    catch { throw Error('Etherscan unavailable. Your key has not been included in this error.'); }
    if (!response.ok || data.status !== '1' || !Array.isArray(data.result)) throw Error('Etherscan could not serve this check. Check key, plan, or provider limits.');
    const row = data.result[0];
    return {verified:Boolean(row?.SourceCode), name:String(row?.ContractName || '').slice(0,100), note:'Source verification only; not a safety rating or an execution quote.'};
  }
  return {
    call(message) { return serial(async()=>{
      const {type,payload = {}} = message;
      if (type === 'quote') {
        const token = parseToken(payload.input,payload.chain);
        const s = await load(), p = s.portfolios.find(p=>p.id===payload.portfolioId);
        const pos = p?.positions[keyOf(token)];
        return market.quote(pos?.token || token,{force:!!payload.force,referencePrice:pos?.mark.price});
      }
      if (type === 'explorer') { const token = parseToken(payload.address,payload.chain); return explorer(token); }
      if (type === 'saveKey') {
        const key = String(payload.key || '').trim();
        if (key && !/^[A-Za-z0-9_-]{10,200}$/.test(key)) throw Error('The API key format is invalid.');
        await storage.set('etherscanKey',key); return {configured:!!key};
      }
      if (type === 'providerStatus') {
        const usage = await storage.get('etherscanUsage');
        return {configured:!!(await storage.get('etherscanKey')),count:usage?.day===new Date(clock()).toISOString().slice(0,10) ? usage.count : 0,cap:90000};
      }
      const s = await load();
      if (type === 'state' || type === 'export') return s;
      if (type === 'refresh') return refresh(s,!!payload.force);
      if (type === 'newPortfolio') {
        if (s.portfolios.length >= 20) throw Error('Maximum 20 local portfolios.');
        const p = makePortfolio(payload.name,payload.capital,clock()); customizePortfolio(p,payload,clock()); s.portfolios.push(p); s.activeId = p.id;
      } else if (type === 'select') {
        if (!s.portfolios.some(p=>p.id===payload.id)) throw Error('Portfolio not found.'); s.activeId=payload.id;
      } else {
        const p = s.portfolios.find(p=>p.id===payload.portfolioId);
        if (!p) throw Error('Portfolio not found.');
        if (type === 'trade') {
          const existing = p.trades.find(t=>t.id===payload.order.id);
          if (existing) return {state:s,trade:existing};
          const token = parseToken(payload.order.token.address,payload.order.token.chain);
          const pos = p.positions[keyOf(token)];
          const totalPositions=s.portfolios.reduce((n,p)=>n+Object.keys(p.positions).length,0);
          if (!pos && totalPositions >= 30) throw Error('Maximum 30 open positions across local portfolios.');
          const selected = pos?.token || {...token,pair:payload.order.token.pair};
          const quote = await market.quote(selected,{force:true,referencePrice:pos?.mark.price??payload.order.referencePrice});
          const gross = payload.order.side === 'buy' ? Number(payload.order.amount) : (pos?.qty || 0)*Number(payload.order.percent)/100*quote.price;
          if (gross > quote.liquidity*0.01) throw Error('Order exceeds 1% of reported pool liquidity. Reduce its size; this simulator cannot model that impact.');
          const trade = execute(p,payload.order,quote,clock());
          await storage.set('ledger',s); return {state:s,trade};
        } else if (type === 'chartSettings') {
          const settings = {style:'line',interval:1,range:0,hideSpikes:false,...p.chartSettings,...payload};
          if (typeof settings.hideSpikes!=='boolean' || !['line','candles'].includes(settings.style) || !Object.hasOwn(CHART_INTERVALS,settings.interval) || ![0,1,7,30].includes(settings.range)) throw Error('Choose a supported chart style, interval, and range.');
          p.chartSettings = {style:settings.style,interval:Number(settings.interval),range:settings.range,hideSpikes:settings.hideSpikes};
        } else if (type === 'customize') {
          customizePortfolio(p,payload,clock());
        } else if (type === 'settings') {
          p.settings = {feeBps:number(payload.feeBps,'Fee',0,2000),slippageBps:number(payload.slippageBps,'Slippage',0,2000)};
        } else throw Error('Unknown request.');
      }
      await storage.set('ledger',s); return s;
    }); }
  };
}
