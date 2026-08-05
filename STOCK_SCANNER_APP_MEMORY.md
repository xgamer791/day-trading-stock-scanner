# Day Trading Stock Scanner — App Memory

**SCOPE:** This file is **only** for the Day Trading Stock Scanner app / repo (`xgamer791/day-trading-stock-scanner`). Do **not** apply these rules to any other project, site, or agent task.

**HARD RULE FOR EVERY AGENT:** Before any edit, commit, deploy, or architecture change **in this repository**, read this entire file. Do not skip it. Do not work from memory of prior turns alone.

Repo: `xgamer791/day-trading-stock-scanner`  
Live: https://xgamer791.github.io/day-trading-stock-scanner/  
Owner intent: Realtime Stock Screener–style **top % gainers** across the **entire US market**.

---

## SECOND AGENT / VISUAL QA — HARD MUST

When the user asks for a “second agent”, “another agent”, or a visual check that work is identical / correct:

1. **Use another Grok agent only** (same provider — Cursor Grok / Task subagent with a Grok model).
2. **Do NOT** hand visual QA to a different model provider (Claude, GPT, Gemini, etc.) just because a “second agent” was requested.
3. “Another agent” means a **separate Grok reviewer pass** (fresh Task/subagent), not a different company/model family.
4. Computer-use / screenshot capture for evidence is fine; the **verdict** agent must still be Grok when the user asked for a second-agent check.

---

## VERIFY YOUR WORK — HARD MUST

Do **not** tell the user a fix is done until you have verified it. Claiming “deployed” without checking the live board is a failed change.

After any change that touches the live feed, Flt, polling, or UI data columns:

1. Deploy to GitHub Pages (or confirm the commit is on `main` and the Pages workflow succeeded).
2. **Prove Flt is populated** on the live app for the current top runners (Most Advanced names like today’s leaders) — not only large-cap day_gainers. Acceptable proof:
   - Browser/computer-use check of the live Gainers table showing numeric Flt (e.g. `6M`) for most visible rows, **or**
   - A verification script against the same live client path / APIs showing `floatMillions != null` for ≥70% of the top 15 ranked gainers.
3. **Prove price, %Chg, and Vol still update** (LIVE badge, not stuck RECONNECTING / empty board).
4. If Flt is still `—` for most rows, the task is **not done** — keep fixing. Soft-fail is for a single symbol, not for the whole column.
5. Do not rely on “it should work” or proxy success on the agent VM alone. Verify the **user-facing Pages URL**.

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
   - Sticky CORS **proxy preference** (transport only)
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

Related failure (~20s “list randomly switches to a completely different board”):

- Yahoo `day_gainers` died after CORS proxy burn, then the client painted **Nasdaq Most Advanced + spark alone** as top gainers.
- **Never** use Most Advanced / spark-only as the ranked gainers board when `day_gainers` fails — throw RECONNECTING and clear rows instead.
- Keep Flt summary proxy traffic small so it does not knock out `day_gainers`.

**Required live path (client):**
1. Discover via live **Nasdaq Most Advanced** each poll (runners / discovery only). Primary quotes from **Yahoo day_gainers** — `regularMarketPrice`, `regularMarketPreviousClose`, `regularMarketVolume`, and Flt share counts (`impliedSharesOutstanding` → `sharesOutstanding`) on the **same live payload**. Spark only fills Most Advanced symbols missing from day_gainers (≤30).
2. Rank by `(last − previousClose) / previousClose` from the **same** quote; show **top 50**. If `day_gainers` is empty/failed → error, do **not** substitute Most Advanced.
3. **Flt** each poll (live only):
   - Prefer Yahoo day_gainers `impliedSharesOutstanding` when the row came from that payload.
   - For Most Advanced / spark runners (usually **absent** from day_gainers): live-fetch small Nasdaq `quote/.../summary` **marketCap** (batched) and compute `marketCap / livePrice / 1e6`.
   - **Do not** use the 2MB Nasdaq `download=true` screener for Flt — CORS proxies cannot deliver it, which leaves the whole Flt column blank.
   - Never `floats.json` / cross-poll float cache. Never use Nasdaq % for displayed %Chg.
   - Flt must not kill the quote poll; a single symbol may blank, but the column must not be systematically empty.
4. Poll ~every **3s**; on quote-poll failure show RECONNECTING and clear rows. Never fall back to `live.json` / `floats.json`.

---

## Stack notes

- Next.js static export (`output: "export"`), `basePath` `/day-trading-stock-scanner` when `GITHUB_PAGES=true`.
- Deploy: `.github/workflows/deploy-pages.yml`.
- `scripts/fetch-live.mjs` may still build `live.json` / `floats.json` for offline/debug/build — **the client live UI must not depend on them for gainers/premarket/Flt.**
- `scripts/verify-flt.mjs` — run after Flt changes (direct APIs). Still verify the live Pages URL.

---

## Before every PR / push checklist

- [ ] Read this file again
- [ ] Client gainers path does not call or fall back to `live.json` or `floats.json`
- [ ] %Chg recomputes from same quote’s last + prevClose
- [ ] Price, volume, %Chg, and Flt come from the live poll — not cross-poll caches
- [ ] Failed live poll does not paint snapshot/cached movers as LIVE (rows cleared)
- [ ] Failed `day_gainers` does not paint Most Advanced / spark-only as the gainers board
- [ ] **VERIFY YOUR WORK:** live Pages Gainers table shows numeric Flt for most top runners; LIVE not stuck RECONNECTING
- [ ] Deployed Pages link verified after change
- [ ] If user asked for a second-agent visual check: use **another Grok agent**, not another provider
