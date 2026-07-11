"use strict";

"use strict";
/* =================================================================
   Strikeboard — math, data layer, strategy templates
   ================================================================= */
// Risk-free rate: configurable, persisted (platform improvement #2)
const _store = (typeof localStorage !== 'undefined') ? localStorage : { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
let R = Math.min(0.20, Math.max(0, parseFloat(_store.getItem('sb_r')) || 0.045));
function setR(v){ R = Math.min(0.20, Math.max(0, v)); _store.setItem('sb_r', String(R)); }
function sbGet(key, fallback){ try{ const v = _store.getItem(key); return v==null ? fallback : JSON.parse(v); }catch(e){ return fallback; } }
function sbSet(key, val){ try{ _store.setItem(key, JSON.stringify(val)); }catch(e){} }
const MS_YEAR = 365 * 24 * 3600 * 1000;

/* ---------- Black-Scholes ---------- */
function normCdf(x){ // Abramowitz-Stegun erf approximation
  const t = 1/(1+0.2316419*Math.abs(x));
  const d = 0.3989422804014327*Math.exp(-x*x/2);
  let p = d*t*(0.319381530+t*(-0.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));
  return x >= 0 ? 1-p : p;
}
function bsPrice(type, S, K, T, iv){
  if (T <= 1e-7 || iv <= 1e-6) {
    return type === 'C' ? Math.max(S-K,0) : Math.max(K-S,0);
  }
  const sq = iv*Math.sqrt(T);
  const d1 = (Math.log(S/K)+(R+iv*iv/2)*T)/sq;
  const d2 = d1-sq;
  if (type === 'C') return S*normCdf(d1)-K*Math.exp(-R*T)*normCdf(d2);
  return K*Math.exp(-R*T)*normCdf(-d2)-S*normCdf(-d1);
}
function bsGreeks(type, S, K, T, iv){
  if (T <= 1e-7 || iv <= 1e-6){
    const itm = type==='C' ? S>K : S<K;
    return {delta: itm ? (type==='C'?1:-1) : 0, gamma:0, theta:0, vega:0, rho:0};
  }
  const sq = iv*Math.sqrt(T);
  const d1 = (Math.log(S/K)+(R+iv*iv/2)*T)/sq;
  const d2 = d1-sq;
  const pdf = Math.exp(-d1*d1/2)/Math.sqrt(2*Math.PI);
  const delta = type==='C' ? normCdf(d1) : normCdf(d1)-1;
  const gamma = pdf/(S*sq);
  const vega  = S*pdf*Math.sqrt(T)/100;                       // per 1 vol pt
  const theta = (-(S*pdf*iv)/(2*Math.sqrt(T))
                 - (type==='C'? 1:-1)*R*K*Math.exp(-R*T)*normCdf((type==='C'?1:-1)*d2))/365;
  const rho   = (type==='C'? 1:-1)*K*T*Math.exp(-R*T)*normCdf((type==='C'?1:-1)*d2)/100;
  return {delta,gamma,theta,vega,rho};
}

/* ---------- state ---------- */
const state = {
  symbol: null,
  spot: null,
  prevClose: null,
  stamp: null,
  chain: new Map(),   // expiry "YYYY-MM-DD" -> { calls: Map(strike->q), puts: Map(strike->q), strikes:[...] }
  expiries: [],
  legs: [],           // {side:+1/-1, type:'C'|'P'|'S', strike, exp, qty, price, iv, greeks}
  demo: false,
};

/* ---------- OCC symbol parsing ---------- */
const OCC_RE = /^([A-Z0-9._^]+?)(\d{6})([CP])(\d{8})$/;
function parseOcc(sym){
  const m = OCC_RE.exec(sym.trim());
  if (!m) return null;
  const [, , d, cp, k] = m;
  return {
    exp: `20${d.slice(0,2)}-${d.slice(2,4)}-${d.slice(4,6)}`,
    type: cp,
    strike: parseInt(k,10)/1000,
  };
}

/* ---------- data: Cboe delayed quotes ----------
   Preferred route: this app's own serverless proxy (/api/chain), which
   fetches Cboe server-side — no CORS involved. Fallbacks: direct fetch,
   then public CORS relays (useful when the file is opened standalone). */
async function fetchCboe(sym){
  const base = s => `https://cdn.cboe.com/api/global/delayed_quotes/options/${s}.json`;
  const attempts = [
    ['server',     `/api/chain?symbol=${encodeURIComponent(sym)}`, true],   // tries _SYM itself
    ['direct',     base(sym), false],
    ['direct',     base('_'+sym), false],
    ['allorigins', 'https://api.allorigins.win/raw?url='+encodeURIComponent(base(sym)), false],
    ['allorigins', 'https://api.allorigins.win/raw?url='+encodeURIComponent(base('_'+sym)), false],
    ['corsproxy',  'https://corsproxy.io/?url='+encodeURIComponent(base(sym)), false],
    ['corsproxy',  'https://corsproxy.io/?url='+encodeURIComponent(base('_'+sym)), false],
    ['codetabs',   'https://api.codetabs.com/v1/proxy?quest='+encodeURIComponent(base(sym)), false],
  ];
  let lastErr = null;
  for (const [name, url, authoritative] of attempts){
    try{
      const r = await fetch(url, {cache:'no-store'});
      if (r.status === 404){
        lastErr = new Error(`no listed options found for "${sym}"`);
        if (authoritative) throw lastErr;   // server already tried both symbol variants
        continue;
      }
      if (!r.ok){ lastErr = new Error(`HTTP ${r.status} via ${name}`); continue; }
      const j = JSON.parse(await r.text());
      if (j && j.data && Array.isArray(j.data.options) && j.data.options.length){
        state.route = name;
        return j;
      }
      lastErr = new Error('empty chain via ' + name);
    }catch(e){
      if (e === lastErr) throw e;           // authoritative 404 — stop immediately
      lastErr = e;
    }
  }
  throw lastErr || new Error('all data routes failed');
}

function ingestChain(json, sym){
  const d = json.data || {};
  state.symbol = sym;
  state.spot = d.current_price ?? d.close ?? d.last_trade_price ?? null;
  state.prevClose = d.prev_day_close ?? d.close ?? null;
  state.stamp = json.timestamp || d.last_trade_time || '';
  state.chain = new Map();
  for (const o of (d.options || [])){
    const p = parseOcc(o.option || '');
    if (!p) continue;
    let e = state.chain.get(p.exp);
    if (!e){ e = {calls:new Map(), puts:new Map(), strikes:new Set()}; state.chain.set(p.exp, e); }
    const q = {
      bid: +o.bid || 0, ask: +o.ask || 0,
      last: +o.last_trade_price || 0,
      iv: +o.iv || 0,
      delta: +o.delta || 0, gamma: +o.gamma || 0,
      theta: +o.theta || 0, vega: +o.vega || 0, rho: +o.rho || 0,
      oi: +o.open_interest || 0, vol: +o.volume || 0,
    };
    (p.type==='C' ? e.calls : e.puts).set(p.strike, q);
    e.strikes.add(p.strike);
  }
  const today = new Date().toISOString().slice(0,10);
  state.expiries = [...state.chain.keys()].filter(x => x >= today).sort();
  for (const e of state.chain.values()) e.strikes = [...e.strikes].sort((a,b)=>a-b);
}

/* ---------- demo chain (synthetic, for offline/preview use) ---------- */
function buildDemoChain(){
  const S = 100, now = Date.now();
  const expiries = [10, 31, 59, 94].map(dd => new Date(now + dd*864e5).toISOString().slice(0,10));
  state.symbol = 'DEMO'; state.spot = S; state.prevClose = 99.2;
  state.stamp = 'synthetic sample data'; state.demo = true;
  state.chain = new Map();
  for (const exp of expiries){
    const T = Math.max((new Date(exp+'T21:00:00Z') - now)/MS_YEAR, 1e-4);
    const e = {calls:new Map(), puts:new Map(), strikes:[]};
    for (let K = 60; K <= 140.01; K += 2.5){
      const skew = 0.24 + 0.35*Math.max(0,(S-K)/S) + 0.10*Math.max(0,(K-S)/S); // put skew
      const iv = skew + 0.02*Math.random();
      for (const t of ['C','P']){
        const px = bsPrice(t, S, K, T, iv);
        const spr = Math.max(0.02, px*0.03);
        const g = bsGreeks(t, S, K, T, iv);
        (t==='C'?e.calls:e.puts).set(K, {
          bid:+(Math.max(0,px-spr/2)).toFixed(2), ask:+(px+spr/2).toFixed(2), last:+px.toFixed(2),
          iv:+iv.toFixed(4), delta:+g.delta.toFixed(4), gamma:+g.gamma.toFixed(4),
          theta:+g.theta.toFixed(4), vega:+g.vega.toFixed(4), rho:+g.rho.toFixed(4),
          oi: Math.round(3000*Math.exp(-Math.abs(K-S)/8)), vol: Math.round(800*Math.exp(-Math.abs(K-S)/6)),
        });
      }
      e.strikes.push(K);
    }
    state.chain.set(exp, e);
  }
  state.expiries = expiries;
}

/* ---------- quote helpers ---------- */
function getQ(exp, type, strike){
  const e = state.chain.get(exp); if (!e) return null;
  return (type==='C' ? e.calls : e.puts).get(strike) || null;
}
function mid(q){ if (!q) return 0; return (q.bid>0 && q.ask>0) ? (q.bid+q.ask)/2 : (q.last || q.ask || q.bid || 0); }
function yearsTo(exp, from = Date.now()){ return Math.max((new Date(exp+'T21:00:00Z') - from)/MS_YEAR, 0); }
function nearestStrike(strikes, target){
  let best = strikes[0];
  for (const k of strikes) if (Math.abs(k-target) < Math.abs(best-target)) best = k;
  return best;
}
function strikeStep(strikes, around){
  const i = strikes.indexOf(nearestStrike(strikes, around));
  const a = strikes[Math.max(0,i-1)], b = strikes[Math.min(strikes.length-1,i+1)];
  return Math.max((b-a)/2, 0.5) || 1;
}
function offsetStrike(strikes, from, steps){
  const i = strikes.indexOf(from);
  return strikes[Math.min(strikes.length-1, Math.max(0, i+steps))];
}

/* ---------- leg factory ---------- */
function mkLeg(side, type, strike, exp, qty=1){
  const q = type==='S' ? null : getQ(exp, type, strike);
  return {
    side, type, strike: type==='S' ? null : strike, exp: type==='S' ? null : exp,
    qty, price: type==='S' ? +state.spot.toFixed(2) : +mid(q).toFixed(2),
    iv: q ? q.iv : 0,
  };
}

/* ---------- strategy templates ---------- */
const TEMPLATE_NAMES = {
  long_call:'Long call', long_put:'Long put', covered_call:'Covered call', csp:'Cash-secured put',
  bull_call:'Bull call spread', bear_put:'Bear put spread', bull_put:'Bull put spread', bear_call:'Bear call spread',
  straddle:'Long straddle', strangle:'Long strangle', iron_condor:'Iron condor', iron_fly:'Iron butterfly',
  call_fly:'Call butterfly', calendar:'Calendar spread', diagonal:'Diagonal spread', custom:'Custom position',
};
function buildTemplate(name, exp){
  const S = state.spot, e = state.chain.get(exp);
  if (!e) return [];
  const K = e.strikes, atm = nearestStrike(K, S);
  const pct = p => nearestStrike(K, S*(1+p));
  const nextExp = state.expiries[Math.min(state.expiries.length-1, state.expiries.indexOf(exp)+1)];
  switch(name){
    case 'long_call':    return [mkLeg(+1,'C',atm,exp)];
    case 'long_put':     return [mkLeg(+1,'P',atm,exp)];
    case 'covered_call': return [mkLeg(+1,'S',null,null,100), mkLeg(-1,'C',pct(0.05),exp)];
    case 'csp':          return [mkLeg(-1,'P',pct(-0.05),exp)];
    case 'bull_call':    return [mkLeg(+1,'C',atm,exp), mkLeg(-1,'C',pct(0.04),exp)];
    case 'bear_put':     return [mkLeg(+1,'P',atm,exp), mkLeg(-1,'P',pct(-0.04),exp)];
    case 'bull_put':     return [mkLeg(-1,'P',pct(-0.03),exp), mkLeg(+1,'P',pct(-0.07),exp)];
    case 'bear_call':    return [mkLeg(-1,'C',pct(0.03),exp), mkLeg(+1,'C',pct(0.07),exp)];
    case 'straddle':     return [mkLeg(+1,'C',atm,exp), mkLeg(+1,'P',atm,exp)];
    case 'strangle':     return [mkLeg(+1,'C',pct(0.05),exp), mkLeg(+1,'P',pct(-0.05),exp)];
    case 'iron_condor':  return [mkLeg(+1,'P',pct(-0.09),exp), mkLeg(-1,'P',pct(-0.05),exp),
                                 mkLeg(-1,'C',pct(0.05),exp),  mkLeg(+1,'C',pct(0.09),exp)];
    case 'iron_fly':     return [mkLeg(+1,'P',pct(-0.06),exp), mkLeg(-1,'P',atm,exp),
                                 mkLeg(-1,'C',atm,exp),        mkLeg(+1,'C',pct(0.06),exp)];
    case 'call_fly': {
      const w = Math.max(1, Math.round((S*0.04)/strikeStep(K,S)));
      return [mkLeg(+1,'C',offsetStrike(K,atm,-w),exp), mkLeg(-1,'C',atm,exp,2), mkLeg(+1,'C',offsetStrike(K,atm,w),exp)];
    }
    case 'calendar':     return [mkLeg(-1,'C',atm,exp), mkLeg(+1,'C',nearestStrike((state.chain.get(nextExp)||e).strikes,S),nextExp)];
    case 'diagonal':     return [mkLeg(-1,'C',pct(0.04),exp), mkLeg(+1,'C',nearestStrike((state.chain.get(nextExp)||e).strikes,S*0.98),nextExp)];
    default:             return state.legs.length ? state.legs : [mkLeg(+1,'C',atm,exp)];
  }
}

/* ---------- position analytics ---------- */
state.ivShift = 0;      // relative IV shift applied in model curves (all legs)
state.backIvMode = 'entry'; // 'entry' | 'forward' — how surviving back-month legs are marked (doubles)
state.backIvShift = 0;  // relative shift applied only to legs expiring AFTER the front expiry
function legModelIv(leg){
  let iv = leg.iv || 0.25;
  const isBack = leg.exp && leg.exp !== earliestExpiry();
  if (isBack && state.backIvMode === 'forward'){
    const f = forwardVolForLeg(leg);
    if (f) iv = f;
  }
  if (isBack && state.backIvShift) iv = iv * (1 + state.backIvShift);
  if (state.ivShift) iv = iv * (1 + state.ivShift);
  return Math.max(0.01, iv);
}
function legValue(leg, S, atDate){
  // value per share/contract-unit at time atDate (ms epoch)
  if (leg.type === 'S') return S;
  const T = yearsTo(leg.exp, atDate);
  return bsPrice(leg.type, S, leg.strike, T, legModelIv(leg));
}
function forwardVolForLeg(leg){
  // implied forward vol between the front expiry and this leg's expiry, same strike
  const front = earliestExpiry();
  if (!front || !leg.exp || leg.exp === front) return null;
  const chF = state.chain.get(front); if (!chF) return null;
  const kF = nearestStrike(chF.strikes, leg.strike);
  const qF = (leg.type==='C' ? chF.calls : chF.puts).get(kF);
  const ivF = qF ? qF.iv : 0, ivB = leg.iv || 0;
  const Tf = yearsTo(front), Tb = yearsTo(leg.exp);
  if (!(ivF>0 && ivB>0 && Tb>Tf)) return null;
  const v = (ivB*ivB*Tb - ivF*ivF*Tf) / (Tb - Tf);
  return v > 1e-6 ? Math.sqrt(v) : 0.02;   // floor when term structure is steeply inverted
}
function positionPL(S, atDate){
  let pl = 0;
  for (const l of state.legs){
    const mult = l.type==='S' ? 1 : 100;
    pl += l.side * l.qty * mult * (legValue(l, S, atDate) - l.price);
  }
  return pl;
}
function earliestExpiry(){
  const es = state.legs.filter(l=>l.exp).map(l=>l.exp).sort();
  return es[0] || null;
}
function evalDates(){
  const e = earliestExpiry();
  return { now: Date.now(), exp: e ? new Date(e+'T21:00:00Z').getTime() : Date.now() };
}
function priceRange(){
  const S = state.spot;
  const ks = state.legs.filter(l=>l.strike).map(l=>l.strike);
  const lo = Math.min(S, ...(ks.length?ks:[S]));
  const hi = Math.max(S, ...(ks.length?ks:[S]));
  const pad = Math.max((hi-lo)*0.9, S*0.16);
  return [Math.max(0.01, lo-pad), hi+pad];
}
function curve(atDate, n=241){
  const [a,b] = priceRange(), pts = [];
  for (let i=0;i<n;i++){ const S = a + (b-a)*i/(n-1); pts.push([S, positionPL(S, atDate)]); }
  return pts;
}
function breakevens(pts){
  const out = [];
  for (let i=1;i<pts.length;i++){
    const [x0,y0] = pts[i-1], [x1,y1] = pts[i];
    if ((y0<=0 && y1>0) || (y0>=0 && y1<0)){
      out.push(x0 + (x1-x0)*(-y0)/(y1-y0 || 1e-9));
    }
  }
  return out;
}
function netPremium(){
  let c = 0;
  for (const l of state.legs) c += -l.side * l.qty * (l.type==='S'?1:100) * l.price;
  return c; // + credit received, - debit paid
}
function extremes(pts, atDate){
  let mx=-Infinity, mn=Infinity;
  for (const [,y] of pts){ mx=Math.max(mx,y); mn=Math.min(mn,y); }
  // true downside floor: underlying cannot trade below 0
  const floor = positionPL(0.01, atDate);
  mx = Math.max(mx, floor); mn = Math.min(mn, floor);
  // asymptotic behavior for S → ∞ (payoffs are ~linear far OTM)
  const hugeS = Math.max(state.spot*50, pts[pts.length-1][0]*10);
  const p1 = positionPL(hugeS, atDate), p2 = positionPL(hugeS*1.05, atDate);
  const slope = (p2-p1)/(hugeS*0.05);
  let maxP = mx, maxL = mn;
  if (slope > 1e-4) maxP = Infinity;
  else if (slope < -1e-4) maxL = -Infinity;
  else { maxP = Math.max(maxP, p1); maxL = Math.min(maxL, p1); }
  return {maxP, maxL};
}
function popEstimate(pts){
  // P(P/L > 0 at expiry) under lognormal with ATM IV of the earliest expiry
  const e = earliestExpiry(); if (!e || !state.spot) return null;
  const ch = state.chain.get(e); if (!ch) return null;
  const atm = nearestStrike(ch.strikes, state.spot);
  const iv = (mid2 => mid2)( (ch.calls.get(atm)?.iv || 0) || (ch.puts.get(atm)?.iv || 0) ) || 0.25;
  const T = yearsTo(e); if (T <= 0) return null;
  const cdf = x => normCdf((Math.log(x/state.spot) - (R - iv*iv/2)*T)/(iv*Math.sqrt(T)));
  let p = 0, inProfit = pts[0][1] > 0, start = 0; // start of profit region (as price)
  const first = pts[0][0], last = pts[pts.length-1][0];
  if (inProfit) start = first;
  for (let i=1;i<pts.length;i++){
    const cross = (pts[i-1][1]<=0) !== (pts[i][1]<=0);
    if (cross){
      const x = pts[i-1][0] + (pts[i][0]-pts[i-1][0])*(-pts[i-1][1])/((pts[i][1]-pts[i-1][1])||1e-9);
      if (inProfit){ p += cdf(x) - cdf(start); inProfit=false; }
      else { start = x; inProfit=true; }
    }
  }
  if (inProfit) p += cdf(last*10) - cdf(start);           // open-ended upside
  if (pts[0][1] > 0) p += cdf(first) - 0;                  // tail below sampled range
  return Math.min(1, Math.max(0, p));
}
function netGreeks(){
  const g = {delta:0,gamma:0,theta:0,vega:0,rho:0};
  for (const l of state.legs){
    if (l.type==='S'){ g.delta += l.side*l.qty; continue; }
    const q = getQ(l.exp, l.type, l.strike);
    let lg;
    if (q && (q.delta || q.gamma || q.vega)) lg = q;
    else lg = bsGreeks(l.type, state.spot, l.strike, yearsTo(l.exp), l.iv || 0.25);
    for (const k of ['delta','gamma','theta','vega','rho']) g[k] += l.side*l.qty*100*(lg[k]||0);
  }
  return g;
}


/* ---------- v2 shared analytics ---------- */
function lognCdf(x, S0, iv, T){        // risk-neutral P(S_T <= x)
  if (x <= 0) return 0;
  return normCdf((Math.log(x/S0) - (R - iv*iv/2)*T)/(iv*Math.sqrt(T)));
}
function atmIvFor(exp){
  const ch = state.chain.get(exp); if (!ch || state.spot==null) return null;
  const k = nearestStrike(ch.strikes, state.spot);
  const c = ch.calls.get(k), p = ch.puts.get(k);
  const iv = ((c&&c.iv)||0) && ((p&&p.iv)||0) ? (c.iv+p.iv)/2 : ((c&&c.iv) || (p&&p.iv) || 0);
  return iv || null;
}
function probTouch(level){
  // P(price touches `level` before the earliest expiry). Driftless GBM approximation:
  // POT ≈ 2 · P(S_T beyond level). Approximate — ignores drift and vol path.
  const exp = earliestExpiry(); if (!exp || state.spot==null || level==null) return null;
  const iv = atmIvFor(exp), T = yearsTo(exp);
  if (!iv || T<=0) return null;
  const p = 2 * normCdf(-Math.abs(Math.log(level/state.spot))/(iv*Math.sqrt(T)));
  return Math.min(1, Math.max(0, p));
}
function evAtExpiry(){
  // Risk-neutral expected P/L at the earliest expiry (numeric integration, ±5σ)
  const exp = earliestExpiry(); if (!exp || state.spot==null) return null;
  const iv = atmIvFor(exp), T = yearsTo(exp);
  if (!iv || T<=0) return null;
  const atDate = new Date(exp+'T21:00:00Z').getTime();
  const mu = Math.log(state.spot) + (R - iv*iv/2)*T, sd = iv*Math.sqrt(T);
  const N = 400; let ev = 0;
  for (let i=0;i<N;i++){
    const z = -5 + 10*(i+0.5)/N;
    const S = Math.exp(mu + sd*z);
    const w = Math.exp(-z*z/2)/Math.sqrt(2*Math.PI) * (10/N);
    ev += positionPL(S, atDate) * w;
  }
  return ev;
}
function probPLAbove(threshold){
  // P(expiry P/L >= threshold) by scanning the expiry curve for crossing intervals
  const exp = earliestExpiry(); if (!exp || state.spot==null) return null;
  const iv = atmIvFor(exp), T = yearsTo(exp);
  if (!iv || T<=0) return null;
  const atDate = new Date(exp+'T21:00:00Z').getTime();
  const [a,b] = priceRange();
  const lo = Math.min(a, state.spot*0.4), hi = Math.max(b, state.spot*2.2);
  const N = 600; let p = 0, inZone = false, zStart = 0;
  let prevS = lo, prevY = positionPL(lo, atDate) - threshold;
  if (prevY >= 0){ inZone = true; zStart = 0; }               // include left tail
  for (let i=1;i<=N;i++){
    const S = lo + (hi-lo)*i/N, y = positionPL(S, atDate) - threshold;
    if (y >= 0 && !inZone){ inZone = true; zStart = lognCdf(prevS + (S-prevS)*(-prevY)/(y-prevY||1e-9), state.spot, iv, T); }
    if (y < 0 && inZone){ inZone = false; p += lognCdf(prevS + (S-prevS)*(-prevY)/(y-prevY||1e-9), state.spot, iv, T) - zStart; }
    prevS = S; prevY = y;
  }
  if (inZone) p += 1 - zStart;                                 // include right tail
  return Math.min(1, Math.max(0, p));
}
function expectedMove(exp){
  // straddle-based expected move: ATM call mid + put mid
  const ch = state.chain.get(exp); if (!ch || state.spot==null) return null;
  const k = nearestStrike(ch.strikes, state.spot);
  const c = ch.calls.get(k), p = ch.puts.get(k);
  if (!c || !p) return null;
  const em = mid(c) + mid(p);
  return em > 0 ? em : null;
}
function shortStrikes(){
  return state.legs.filter(l => l.side<0 && l.strike).map(l => ({strike:l.strike, type:l.type}));
}
function assignmentWarnings(euroStyle){
  // short ITM options whose extrinsic value is nearly gone are early-assignment candidates
  if (euroStyle) return [];
  const out = [];
  for (const l of state.legs){
    if (l.side >= 0 || l.type === 'S' || !l.strike) continue;
    const intrinsic = l.type==='C' ? Math.max(state.spot - l.strike, 0) : Math.max(l.strike - state.spot, 0);
    if (intrinsic <= 0) continue;
    const q = getQ(l.exp, l.type, l.strike);
    const px = q ? mid(q) : l.price;
    const extrinsic = px - intrinsic;
    if (extrinsic < 0.10) out.push(`short ${l.strike}${l.type} extrinsic $${Math.max(0,extrinsic).toFixed(2)} — early-assignment candidate (esp. before ex-dividend)`);
  }
  return out;
}
const EURO_STYLE = new Set(['SPX','XSP','NDX','RUT','DJX','VIX','MRUT','MXEA','MXEF']);
