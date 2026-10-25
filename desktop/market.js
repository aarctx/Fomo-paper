import {keyOf, poolKey, validateQuote} from './ledger.js';
export const CHAINS = {robinhood:4663, ethereum:1, base:8453, bsc:56, arbitrum:42161, polygon:137, optimism:10, avalanche:43114, monad:143, solana:null};
export function parseToken(input, chain = '') {
  let address = String(input || '').trim();
  if (/^https?:/i.test(address)) {
    let u; try { u = new URL(address); } catch { throw Error('Invalid token URL.'); }
    if (!['fomo.family','www.fomo.family','fomo.fun','www.fomo.fun'].includes(u.hostname)) throw Error('Paste a Fomo token link or a full contract address.');
    const m = u.pathname.match(/^\/tokens\/([a-z0-9-]+)\/([^/]+)\/?$/i);
    if (!m) throw Error('Use a Fomo /tokens/chain/address link.');
    chain = m[1].toLowerCase(); address = decodeURIComponent(m[2]);
  }
  chain = ({eth:'ethereum',bnb:'bsc',hood:'robinhood'})[chain] || chain;
  if (!(chain in CHAINS)) throw Error('Choose the token’s chain.');
  const t = {chain, address:address.startsWith('0x') ? address.toLowerCase() : address};
  keyOf(t); return t;
}
export function normalizePair(row, token, now = Date.now()) {
  if (!row || row.chainId !== token.chain || keyOf({chain:row.chainId,address:row.baseToken?.address}) !== keyOf(token)) throw Error('Pool token identity does not match.');
  const q = {chain:token.chain,address:token.address,pair:row.pairAddress, symbol:row.baseToken.symbol, name:row.baseToken.name,
    price:Number(row.priceUsd), liquidity:Number(row.liquidity?.usd), change:Number(row.priceChange?.h24),
    dex:row.dexId, ts:now, source:'DEX Screener'};
  if(Number.isFinite(Number(row.priceNative))&&Number(row.priceNative)>0)q.priceNative=Number(row.priceNative);
  if(row.quoteToken?.address)q.quoteAddress=row.quoteToken.address;
  if(row.quoteToken?.symbol)q.quoteSymbol=String(row.quoteToken.symbol).slice(0,30);
  validateQuote(q, now);
  if (!Number.isFinite(q.liquidity) || q.liquidity <= 0) throw Error('No reported pool liquidity.');
  return q;
}
export function createMarket(fetcher = fetch, clock = Date.now) {
  let lastRequest = 0, blockedUntil = 0;
  const cache = new Map(), confirmations = new Map();
  const cacheKey = token => token.pair?poolKey(token):keyOf(token);
  const recent = (token,referencePrice=token.referencePrice) => { const q=cache.get(cacheKey(token)); return q && clock()-q.ts>=0 && clock()-q.ts<4000 && !largeMove(q.price,referencePrice) ? {...q} : null; };
  const checkPair = token => poolKey(token);
  function validQuotes(rows,token,receivedAt=clock()) {
    const quotes=[],seen=new Set();
    for(const row of Array.isArray(rows)?rows:[]){
      try{
        const q=normalizePair(row,token,receivedAt),key=poolKey(q);
        if(!seen.has(key)){quotes.push(q);seen.add(key);}
      }catch{ /* Exclude unrelated, malformed, or unpriced pools. */ }
    }
    return quotes.sort((a,b)=>b.liquidity-a.liquidity);
  }
  function selectQuote(rows,token) {
    const quotes=validQuotes(rows,token).filter(q=>!token.pair||poolKey(q)===poolKey(token));
    if(!quotes.length)throw Error('No usable price for this exact token and pool. It may be unindexed or unavailable.');
    return quotes[0];
  }
  const ratio=(a,b)=>Math.max(a/b,b/a);
  const largeMove=(price,previous)=>Number.isFinite(previous)&&previous>0&&ratio(price,previous)>=3;
  const peersFor=(q,quotes)=>quotes.filter(other=>poolKey(other)!==poolKey(q)&&other.liquidity>=Math.max(1000,q.liquidity*.01));
  function rejectPrice(quote,reason,referencePrice,peers=[]) {
    const error=Error(reason);
    error.rejectedQuote={price:quote.price,pair:quote.pair,ts:quote.ts,liquidity:quote.liquidity,
      ...(quote.priceNative?{priceNative:quote.priceNative,quoteAddress:quote.quoteAddress}:{}),
      ...(Number.isFinite(referencePrice)?{referencePrice}:{}),
      comparisons:peers.slice(0,5).map(q=>({price:q.price,pair:q.pair,liquidity:q.liquidity}))};
    throw error;
  }
  function remember(quote,token) {
    cache.set(cacheKey(token),quote);cache.set(poolKey(quote),quote);return {...quote};
  }
  async function checkedQuote(rows,token,{referencePrice,force=false,discovery=false}={}) {
    const candidate=selectQuote(rows,token);
    const previous=referencePrice??token.referencePrice??cache.get(cacheKey(token))?.price;
    let quotes=discovery?validQuotes(rows,token):null;
    if(!largeMove(candidate.price,previous)){
      const peers=quotes?peersFor(candidate,quotes):[];
      if(peers.length&&peers.every(q=>largeMove(candidate.price,q.price)))rejectPrice(candidate,'Pool prices disagree sharply. Price unavailable until the pools agree.',previous,peers);
      return remember(candidate,token);
    }
    if(!quotes){
      const saved=confirmations.get(keyOf(token));
      if(!force&&saved&&clock()-saved.ts>=0&&clock()-saved.ts<10000)quotes=validQuotes(saved.rows,token,saved.ts);
      else{
        let comparisonRows;
        try{comparisonRows=await json(`/token-pairs/v1/${token.chain}/${token.address}`);}
        catch{rejectPrice(candidate,'Large price move could not be checked. Keeping the last known valuation; trading is paused for this token.',previous);}
        confirmations.set(keyOf(token),{ts:clock(),rows:comparisonRows});quotes=validQuotes(comparisonRows,token);
      }
    }
    const checked=quotes.find(q=>poolKey(q)===poolKey(candidate)),peers=peersFor(candidate,quotes);
    if(!checked)rejectPrice(candidate,'The selected pool is missing from the price recheck. Keeping the last known valuation.',previous,peers);
    const corroborating=peers.filter(q=>ratio(checked.price,q.price)<=1.25);
    // Keep the selected pool. Recover a transient endpoint error, or accept a
    // real crash/pump if another substantial pool corroborates the new price.
    if(!largeMove(checked.price,previous)||corroborating.length){
      checked.priceCheck={at:clock(),status:'rechecked',initialPrice:candidate.price,referencePrice:previous,
        comparisons:corroborating.slice(0,5).map(q=>({pair:q.pair,price:q.price,liquidity:q.liquidity}))};
      return remember(checked,token);
    }
    rejectPrice(candidate,'Large price move is unconfirmed across pools. Keeping the last known valuation; trading is paused for this token.',previous,peers);
  }
  async function json(path) {
    if (clock() < blockedUntil) throw Error('Price service rate limit. Retrying after a one-minute pause.');
    // Calls are serialized; portfolio pools are batched by chain.
    const wait = 300 - (clock() - lastRequest);
    if (wait > 0) await new Promise(r=>setTimeout(r,wait));
    lastRequest = clock();
    let response;
    try { response = await fetcher('https://api.dexscreener.com' + path, {signal:AbortSignal.timeout(8000),credentials:'omit',redirect:'error',cache:'no-store'}); }
    catch { throw Error('Price service unreachable. Try again when connected.'); }
    if (response.status === 429) blockedUntil = clock()+60_000;
    if (!response.ok) throw Error(response.status === 429 ? 'Price service rate limit. Retrying after a one-minute pause.' : 'Price service temporarily unavailable.');
    return response.json();
  }
  return {
    async quote(token, {force = false,referencePrice} = {}) {
      const cached = recent(token,referencePrice);
      if (!force && cached) return cached;
      let rows;
      if (token.pair) {
        checkPair(token);
        const result = await json(`/latest/dex/pairs/${token.chain}/${token.pair}`); rows = result.pairs;
      } else rows = await json(`/token-pairs/v1/${token.chain}/${token.address}`);
      return checkedQuote(rows,token,{force,referencePrice,discovery:!token.pair});
    },
    async quoteMany(tokens, {force = false} = {}) {
      const groups=new Map(), results=[];
      for (const token of tokens) {
        try { checkPair(token); } catch(e) { results.push({token,error:e.message}); continue; }
        const cached=recent(token);
        if (!force && cached) { results.push({token,quote:cached}); continue; }
        if (!groups.has(token.chain)) groups.set(token.chain,[]);
        groups.get(token.chain).push(token);
      }
      for (const [chain,group] of groups) {
        // The ledger permits at most 30 positions. Chunk defensively as well.
        for (let i=0;i<group.length;i+=30) {
          const chunk=group.slice(i,i+30);
          let rows;
          try { rows=(await json(`/latest/dex/pairs/${chain}/${[...new Set(chunk.map(t=>t.pair))].join(',')}`)).pairs; }
          catch(e) { results.push(...chunk.map(token=>({token,error:e.message}))); continue; }
          for (const token of chunk) {
            try { results.push({token,quote:await checkedQuote(rows,token,{force})}); }
            catch(e) { results.push({token,error:e.message,...(e.rejectedQuote?{rejectedQuote:e.rejectedQuote}:{})}); }
          }
        }
      }
      return results;
    }
  };
}
