# Day Trading Stock Scanner — App Memory

**HARD RULE FOR EVERY AGENT:** Read this entire file before any edit, commit, deploy, or architecture change to this app. Do not skip it. Do not work from memory of prior turns alone.

Repo: `xgamer791/day-trading-stock-scanner`  
Live: https://xgamer791.github.io/day-trading-stock-scanner/  
Owner intent: Realtime Stock Screener–style **top % gainers** across the **entire US market**.

---

## ZERO CACHING IN LIVE FEED — HARD MUST

This is non-negotiable. Violating it is a failed change.

1. **Live gainers / premarket panels must use LIVE API data only** on every successful poll.
2. **FORBIDDEN as a source for live mover rows (price, %Chg, volume, Flt, HOD/OFF):**
   - `public/data/live.json` / Actions snapshot as the displayed live feed
   - `public/data/floats.json` / any fundamentals snapshot file for the Flt column
   - In-memory “last good tick” / float maps reused across polls as if fresh (do not keep painting stale rows as LIVE after a failed poll — clear rows)
   - LocalStorage / sessionStorage / IndexedDB for quotes, gainers, or float
   - Service worker caches for market data
   - CDN/`live.json` fallback when browser live fetch fails
   - Mixing a live last price with a stale % from another source
3. **Allowed:**
   - `cache: "no-store"` + cache-bust query params on fetches
   - Short-lived in-flight request dedupe (same tick only)
   - Short-lived discovery **symbol** candidate list (which tickers to quote next) — never reuse stale price/%/vol/Flt as LIVE
   - Static app shell (HTML/JS/CSS) on GitHub Pages — that is not the live feed
4. **On live fetch failure:** show RECONNECTING / error and **clear** mover rows. Do **not** substitute snapshot/cached gainers. Empty or error > wrong/stale numbers.
5. **%Chg math (must match TradingView / Realtime):**  
   `(last − previousClose) / previousClose` from the **same quote payload**. Never pair Yahoo last with Nasdaq screener %.
6. If GitHub Pages CORS forces a proxy: proxies are for transport only. They must still return **current** API payloads. A proxy is not a license to serve `live.json` or `floats.json`.

---

## Product rules

- **Only ranking filter:** top % gainers (positive change). No HOD / min-price / min-volume gates for inclusion.
- **Feeds:** top 50.
- **Markets:** full US listed equities (NASDAQ, NYSE, AMEX/Arca, etc.).
- **Junk filter OK:** warrants / units / rights / preferreds / leveraged ETFs (retail screener parity).
- **Premarket tab ≠ Gainers tab** (session-aware).
- **No demo / fake fallback data.**
- Prefer GitHub Pages deploy; auto-deploy on changes and send the Pages link.

---

## Accuracy bug to never reintroduce

Root cause of past “correct for a split second, then wrong” / “+313% vs TradingView +513%”:

- Actions or Yahoo feed was correct, then a browser “upgrade” overwrote rows with Nasdaq Most Advanced % while keeping another last price (or inventing prevClose from Nasdaq % so `rowSynced` passed).
- **Never overlay** a secondary Nasdaq-% feed on top of an accurate last/prevClose feed.

**Required live path (client):**
1. Discover via live **Nasdaq Most Advanced** each poll (runners). Primary quotes from **Yahoo day_gainers** — `regularMarketPrice`, `regularMarketPreviousClose`, `regularMarketVolume`, and Flt share counts (`impliedSharesOutstanding` → `sharesOutstanding`) on the **same live payload**. Spark only fills Most Advanced symbols missing from day_gainers (≤30). Do **not** multi-batch spark 100+ symbols or hit the 10k full screener on the hot path.
2. Rank by `(last − previousClose) / previousClose` from the **same** quote; show **top 50**
3. **Flt** from the live day_gainers quote each poll when present (`impliedSharesOutstanding`). Most Advanced runners are often **absent** from day_gainers — for those, best-effort live Nasdaq summary `marketCap / price / 1e6` **that poll only** (Realtime implied-share parity). Cap Flt fill requests (≤8) with a short deadline so Flt never burns CORS proxies or fails the quote poll (“Load failed” / reconnect loops). Never `floats.json` / cross-poll float cache.
4. Poll ~every **3s**; on quote-poll failure show RECONNECTING and clear rows. Never fall back to `live.json` / `floats.json`. Flt miss → blank Flt cell, not a failed feed.

---

## Stack notes

- Next.js static export (`output: "export"`), `basePath` `/day-trading-stock-scanner` when `GITHUB_PAGES=true`.
- Deploy: `.github/workflows/deploy-pages.yml`.
- `scripts/fetch-live.mjs` may still build `live.json` / `floats.json` for offline/debug/build — **the client live UI must not depend on them for gainers/premarket/Flt.**

---

## Before every PR / push checklist

- [ ] Read this file again
- [ ] Client gainers path does not call or fall back to `live.json` or `floats.json`
- [ ] %Chg recomputes from same quote’s last + prevClose
- [ ] Price, volume, %Chg, and Flt come from the live poll — not cross-poll caches
- [ ] Failed live poll does not paint snapshot/cached movers as LIVE (rows cleared)
- [ ] Deployed Pages link verified after change
