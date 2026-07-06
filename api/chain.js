// Serverless proxy: fetches Cboe delayed option chains server-side (no CORS).
// Note: Cboe serves index chains under an underscore prefix (_SPX, _VIX, _XSP)
// and returns 403 — not 404 — for the bare index symbol, so we retry the
// underscore variant on any upstream failure.
export default async function handler(req, res) {
  const raw = String(req.query.symbol || '').toUpperCase();
  const sym = raw.replace(/[^A-Z0-9._^]/g, '');
  if (!sym || sym.length > 10) {
    return res.status(400).json({ error: 'valid symbol required' });
  }
  const get = s => fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/${s}.json`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (personal options analysis tool; manual lookups)' },
  });
  const send = async r => {
    const j = await r.json();
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json(j);
  };
  try {
    const r1 = await get(sym);
    if (r1.ok) return send(r1);
    if (!sym.startsWith('_')) {
      const r2 = await get('_' + sym);
      if (r2.ok) return send(r2);
      if (r1.status >= 500 || r2.status >= 500) {
        return res.status(502).json({ error: `upstream ${r1.status}/${r2.status}` });
      }
      return res.status(404).json({ error: `no listed options for "${raw}" (upstream ${r1.status}/${r2.status})` });
    }
    return res.status(r1.status >= 500 ? 502 : 404).json({ error: `upstream ${r1.status}` });
  } catch (e) {
    return res.status(502).json({ error: 'upstream fetch failed: ' + e.message });
  }
}
