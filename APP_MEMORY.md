# Day Trading Stock Scanner — App Memory

**HARD RULE FOR EVERY AGENT:** Read this entire file before any edit, commit, deploy, or architecture change to this app. Do not skip it. Do not work from memory of prior turns alone.

Repo: `xgamer791/day-trading-stock-scanner`  
Live: https://xgamer791.github.io/day-trading-stock-scanner/  
Owner intent: Realtime Stock Screener–style **top % gainers** across the **entire US market**.

---

## ZERO CACHING IN LIVE FEED — HARD MUST

This is non-negotiable. Violating it is a failed change.

1. **Live gainers / premarket panels must use LIVE API data only** on every successful poll.
2. **FORBIDDEN as a source for live mover rows (price, %Chg, volume, HOD/OFF):**
   - `public/data/live.json` / Actions snapshot as the displayed live feed
   - In-memory “last good tick” used as if it were fresh live data after a failed poll (do not silently keep painting stale rows as LIVE)
   - LocalStorage / sessionStorage / IndexedDB for quotes or gainers
   - Service worker caches for market data
   - CDN/`live.json` fallback when browser live fetch fails
   - Mixing a live last price with a stale % from another source
3. **Allowed:**
   - `cache: "no-store"` + cache-bust query params on fetches
   - Short-lived in-flight request dedupe (same tick only)
   - Static app shell (HTML/JS/CSS) on GitHub Pages — that is not the live feed
4. **On live fetch failure:** show RECONNECTING / error. Do **not** substitute snapshot/cached gainers. Empty or error > wrong/stale numbers.
5. **%Chg math (must match TradingView / Realtime):**  
   `(last − previousClose) / previousClose` from the **same quote payload**. Never pair Yahoo last with Nasdaq screener %.
6. If GitHub Pages CORS forces a proxy: proxies are for transport only. They must still return **current** API payloads. A proxy is not a license to serve `live.json`.

---

## Product rules

- **Only ranking filter:** top % gainers (positive change). No HOD / min-price / min-volume gates for inclusion.
- **Feeds:** top 20.
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
1. Discover via live **Nasdaq Most Advanced** each poll (small). Do **not** hit the 10k full screener every 3s — that rate-limits CORS proxies and dies ~20s in.
2. Quote via **Yahoo spark batch** (`v7/finance/spark`) — last + previousClose from same meta
3. Rank by `(last − previousClose) / previousClose`
4. Poll ~every **3s**; on failure show RECONNECTING (not LIVE). Never fall back to `live.json`.

---

## Stack notes

- Next.js static export (`output: "export"`), `basePath` `/day-trading-stock-scanner` when `GITHUB_PAGES=true`.
- Deploy: `.github/workflows/deploy-pages.yml`.
- `scripts/fetch-live.mjs` may still build `live.json` for offline/debug/build — **the client live UI must not depend on it for gainers/premarket.**

---

## Before every PR / push checklist

- [ ] Read this file again
- [ ] Client gainers path does not call or fall back to `live.json`
- [ ] %Chg recomputes from same quote’s last + prevClose
- [ ] Failed live poll does not paint snapshot/cached movers as LIVE
- [ ] Deployed Pages link verified after change
