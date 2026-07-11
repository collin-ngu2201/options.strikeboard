// Chain proxy with provider abstraction.
// Default: Cboe delayed (free, no key). Optional: Tradier real-time —
// set TRADIER_TOKEN in Vercel env vars and it takes over automatically.
// Both providers are normalized to the Cboe response shape the pages expect:
// { timestamp, data: { current_price, prev_day_close, options:[{option,bid,ask,iv,delta,...}] } }

const UA = { 'User-Agent': 'Mozilla/5.0 (personal options analysis tool; manual lookups)' };

async function fromCboe(sym) {
  const url = s => `https://cdn.cboe.com/api/global/delayed_quotes/options/${s}.json`;
  let r = await fetch(url(sym), { headers: UA });
  if (!r.ok && !sym.startsWith('_')) {
    const r2 = await fetch(url('_' + sym), { headers: UA });
    if (r2.ok) r = r2;
    else return { status: (r.status >= 500 || r2.status >= 500) ? 502 : 404,
                  body: { error: `no listed options for "${sym}" (upstream ${r.status}/${r2.status})` } };
  }
  if (!r.ok) return { status: r.status >= 500 ? 502 : 404, body: { error: `upstream ${r.status}` } };
  return { status: 200, body: await r.json() };
}

// NOTE: written to Tradier's documented API but NOT yet exercised against a live
// key from this environment — verify the first response after adding your token.
async function fromTradier(sym, token) {
  const H = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const base = 'https://api.tradier.com/v1/markets';
  const qr = await fetch(`${base}/quotes?symbols=${encodeURIComponent(sym)}&greeks=false`, { headers: H });
  if (!qr.ok) return { status: 502, body: { error: `tradier quotes ${qr.status}` } };
  const q = (await qr.json())?.quotes?.quote;
  if (!q) return { status: 404, body: { error: `unknown symbol "${sym}"` } };
  const er = await fetch(`${base}/options/expirations?symbol=${encodeURIComponent(sym)}`, { headers: H });
  if (!er.ok) return { status: 502, body: { error: `tradier expirations ${er.status}` } };
  let dates = (await er.json())?.expirations?.date || [];
  if (!Array.isArray(dates)) dates = [dates];
  dates = dates.slice(0, 12);                                   // cap request fan-out
  const options = [];
  for (const d of dates) {
    const cr = await fetch(`${base}/options/chains?symbol=${encodeURIComponent(sym)}&expiration=${d}&greeks=true`, { headers: H });
    if (!cr.ok) continue;
    let list = (await cr.json())?.options?.option || [];
    if (!Array.isArray(list)) list = [list];
    for (const o of list) options.push({
      option: o.symbol,
      bid: o.bid ?? 0, ask: o.ask ?? 0, last_trade_price: o.last ?? 0,
      iv: o.greeks?.mid_iv ?? o.greeks?.smv_vol ?? 0,
      delta: o.greeks?.delta ?? 0, gamma: o.greeks?.gamma ?? 0,
      theta: o.greeks?.theta ?? 0, vega: o.greeks?.vega ?? 0, rho: o.greeks?.rho ?? 0,
      open_interest: o.open_interest ?? 0, volume: o.volume ?? 0,
    });
  }
  return { status: 200, body: { timestamp: new Date().toISOString(), provider: 'tradier',
    data: { current_price: q.last ?? q.close, prev_day_close: q.prevclose ?? q.close, options } } };
}

export default async function handler(req, res) {
  const raw = String(req.query.symbol || '').toUpperCase();
  const sym = raw.replace(/[^A-Z0-9._^]/g, '');
  if (!sym || sym.length > 10) return res.status(400).json({ error: 'valid symbol required' });
  try {
    const token = process.env.TRADIER_TOKEN;
    const out = token ? await fromTradier(sym, token) : await fromCboe(sym);
    if (out.status === 200) res.setHeader('Cache-Control', token ? 's-maxage=15' : 's-maxage=60, stale-while-revalidate=300');
    return res.status(out.status).json(out.body);
  } catch (e) {
    return res.status(502).json({ error: 'upstream fetch failed: ' + e.message });
  }
}
