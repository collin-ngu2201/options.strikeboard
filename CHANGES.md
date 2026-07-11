# Strikeboard v2.0 — changelog

## Platform
- `common.js` shared math/data module — the four pages no longer carry duplicate copies
  (the class of bug that hit /doubles once is now structurally impossible)
- Risk-free rate is configurable (r% input in the builder header), persisted in localStorage,
  honored by every page
- `tests.js` — 31-assertion suite covering pricing, templates, probabilities, forward vol,
  fly floors, freedom solvers, scanners, Monte Carlo. Run `node tests.js` before deploying.
- localStorage persistence: last ticker, saved positions (builder), leg-in journal (freefly)
- `api/chain.js` provider abstraction: Cboe delayed by default; set TRADIER_TOKEN in Vercel
  env vars to switch to real-time Tradier (adapter written to spec, verify first response)

## Full builder ( / )
- Model-date slider: view P/L on any date between today and expiry (T+n curves)
- IV shift slider applied to all legs in the model curves
- New metrics: model EV at expiry, P(≥50% of max profit), buying power (defined-risk exact,
  naked estimated by 20% rule), return on BP
- Risk notes: probability-of-touch per short strike; early-assignment warnings when a short
  ITM option's extrinsic is nearly gone (American underlyings)
- Copy-link (position encoded in URL), pin-compare overlay, saved positions list
- Chain intelligence: expected move per expiry, ±1σ band highlighted in the chain,
  IV-smile sparkline

## Doubles desk ( /doubles )
- Term-structure panel: front vs back IV per side, forward vol, rich/contango verdict
- Back legs marked at forward vol by default (entry-IV mode available, labeled optimistic)
- Setup optimizer: scans wings × front/back pairs, ranks by tent-to-debit
- Event-date check with plain-language warnings; profit-target line on the chart
- Model-date slider; call-only / put-only single-calendar modes

## Boxscan ( /boxscan )
- Long (lend) and short (borrow) box modes with correct executable pricing each way
- Hurdle-rate input: rows judged against YOUR cash/margin rate, not just r
- Liquidity screen: max leg spread % and min open interest filters
- Per-box early-assignment flag (short legs near zero extrinsic on American underlyings)
- Implied-rate term structure chart: best box APR per expiry vs r and your hurdle
- Conversion/reversal scanner (stock priced at spot, approximation noted)

## Freefly ( /freefly )
- P(reach freedom before expiry) — the number that completes the honest picture
- Freedom-spot decay chart: the price needed for freedom, by days elapsed
- 5,000-path Monte Carlo: EV of holding vs the leg-in plan (they match — conversion
  redistributes outcomes, it does not add expected value)
- Put-side leg-ins (bearish mirror), exact piecewise floors on both sides
- Broken-wing scanner mode with ceiling/floor ratio
- IC roll planner on live quotes: cost to close the threatened side, credit to roll the
  untested side to ~1σ, lock-in verdict
- Journal with freedom hit-rate tracking
