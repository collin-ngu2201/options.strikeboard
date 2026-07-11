# Strikeboard — deploy to Vercel

Two pages:
- /         — full multi-leg strategy builder (15 templates)
- /doubles  — dedicated double calendar & double diagonal desk with
              front/back expiry pickers, wing controls, and a back-month
              IV shift slider

An options strategy analyzer (multi-leg P/L, Greeks, live delayed US chains
from Cboe). The `api/chain.js` serverless function fetches Cboe server-side,
so the browser never hits CORS.

## Deploy (about 2 minutes)

Requires Node.js installed. In this folder, run:

    npx vercel login        # opens your browser, log in to your Vercel account
    npx vercel --prod       # accept the defaults when prompted

That's it. The CLI prints your live URL, e.g. https://strikeboard.vercel.app
Open it and load SPY — the header will show quotes served via your own
/api/chain endpoint (no "via relay" note = the server route is working).

To verify the proxy directly, open:
    https://YOUR-URL.vercel.app/api/chain?symbol=SPY

## Alternative: Git integration

Push this folder to a GitHub repo and click "Add New → Project" in the
Vercel dashboard. Every push then redeploys automatically.

## Testing

Run `node tests.js` from the project folder before deploying — 31 assertions
covering all pricing and probability math. All must pass.

## Real-time data (optional)

Add `TRADIER_TOKEN` in Vercel → Settings → Environment Variables and /api/chain
switches from Cboe delayed to Tradier real-time automatically (same response shape).
Verify the first response after enabling — the adapter is written to Tradier's spec
but shipped untested without a key.

## Notes

- Data: Cboe delayed quotes (~15 min), cached 60s at the edge. Intended for
  manual, interactive lookups — don't script bulk polling against it.
- Works for stocks/ETFs (SPY, QQQ, AAPL…) and indices (SPX, VIX, XSP — the
  underscore prefix Cboe uses is handled automatically).
- The page also works standalone (double-click index.html): it falls back to
  public CORS relays, which are less reliable than your deployed endpoint.
