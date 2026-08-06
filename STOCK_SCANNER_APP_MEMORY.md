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
   - **Polygon.io snapshot gainers** as a live ranked board when Yahoo `day_gainers` CORS transport fails (direct browser CORS — not a cache). Still must recompute % from same payload last+prevClose.
4. **On live fetch failure:** show RECONNECTING / error and **clear** mover rows. Do **not** substitute snapshot/cached gainers. Empty or error > wrong/stale numbers.
5. **%Chg math (must match TradingView / Realtime):**  
   `(last − previousClose) / previousClose` from the **same quote payload**. Never pair Yahoo last with Nasdaq screener %.
6. If GitHub Pages CORS forces a proxy: proxies are for transport only. They must still return **current** API payloads. A proxy is not a license to serve `live.json` or `floats.json`.

### Safari “Load failed” / durable browser transport

- Public proxies (`corsproxy.io` `/raw`, etc.) are unreliable; Safari often surfaces `TypeError: Load failed`.
- Client transport: `src/lib/corsTransport.ts` — prefer **allorigins `/get` + unwrap `contents`**, sticky preference, circuit breaker, quote priority queue. Optional `NEXT_PUBLIC_QUOTE_PROXY_URL` (see `workers/quote-proxy/`).
- **Polygon** (`NEXT_PUBLIC_POLYGON_API_KEY` from Actions secret `POLYGON_API_KEY`) is the durable no-proxy path — Polygon reflects ACAO for the Pages origin. Prefer Yahoo `day_gainers` when the proxy path works; if it fails, use Polygon live gainers. **Never** paint Nasdaq Most Advanced alone.
- Pages builds must not ship an empty `NEXT_PUBLIC_POLYGON_API_KEY` if Polygon is expected — set the Actions secret.

---

## Product rules

- **Only ranking filter:** top % gainers (positive change). No HOD / min-price / min-volume gates for inclusion.
- **Feeds:** top 50.
- **Markets:** full US listed equities (NASDAQ, NYSE, AMEX/Arca, etc.).
- **Junk filter OK:** warrants / units / rights / preferreds / leveraged ETFs (retail screener parity).
- **Premarket tab ≠ Gainers tab ≠ After Hours tab** (session-aware).
- **After Hours tab:** only 16:00–20:00 ET; ranked by live post-market % vs regular-session close — never paste regular `day_gainers` into this tab.
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
1. Discover via live **Nasdaq Most Advanced** each poll (runners / discovery only). Prefer primary quotes from **Yahoo day_gainers** — `regularMarketPrice`, `regularMarketPreviousClose`, `regularMarketVolume`, and Flt share counts (`impliedSharesOutstanding` → `sharesOutstanding`) on the **same live payload**. If Yahoo transport fails: **Polygon snapshot gainers** (live, direct CORS). Spark only fills Most Advanced symbols missing from the ranked board (≤30).
2. Rank by `(last − previousClose) / previousClose` from the **same** quote; show **top 50**. If both `day_gainers` and Polygon fail → error, do **not** substitute Most Advanced.
3. **Flt** each poll (live only):
   - Prefer Yahoo day_gainers `impliedSharesOutstanding` when the row came from that payload.
   - For Most Advanced / spark / Polygon runners missing share counts: live-fetch small Nasdaq `quote/.../summary` **marketCap** (batched) and compute `marketCap / livePrice / 1e6`.
   - **Do not** use the 2MB Nasdaq `download=true` screener for Flt — CORS proxies cannot deliver it, which leaves the whole Flt column blank.
   - Never `floats.json` / cross-poll float cache. Never use Nasdaq % for displayed %Chg.
   - Flt must not kill the quote poll; a single symbol may blank, but the column must not be systematically empty.
4. Poll ~every **3s**; on quote-poll failure show RECONNECTING and clear rows. Never fall back to `live.json` / `floats.json`.

---

## Transport starvation — never reintroduce (fixed 2026-08-05)

Symptom: "Live data error: Load failed" every ~20s, and the Gainers board cycling between
two *different* stock lists — sometimes day_gainers only, sometimes day_gainers plus the
Most Advanced / spark runners.

Root cause was **not** the proxies themselves. `corsTransport.ts` ran a single queue slot
(`MAX_ACTIVE = 1`). Priority sorting only orders *waiting* jobs — there is no preemption —
so one already-running low-priority call (a 12s Nasdaq `/summary` Flt lookup, a 16s news
fetch) held the only slot while the 3s `day_gainers` poll waited behind it. Whichever
optional call happened to win a given poll decided what the board looked like, which is why
the list flickered between two identities.

Rules going forward:

1. **Keep a slot reserved for `critical`.** `MAX_ACTIVE = 2` with `MAX_NONCRITICAL_ACTIVE = 1`.
   Do not "simplify" this back to a single shared slot — public proxies do punish parallelism,
   which is why the pool stays small, but the *reservation* is what keeps the ranked board alive.
2. **Enrichment must have a wall-clock ceiling.** `FLOAT_TOTAL_BUDGET_MS` caps the whole Flt
   fill. Without it, 12 symbols × 12s timeouts could add ~36s to a 3s poll.
3. **Do not build boards that are not on screen.** `fetchLiveScannerClient({ includeAfterHours })`
   — `ScannerBoard` passes `false` unless the After Hours tab is selected. AH costs 3 extra
   Yahoo screener calls plus up to 12 Nasdaq lookups per poll. This is **not** caching; it is
   declining to fetch data nothing is displaying. Note the consequence: on the desktop grid
   (>960px, all four panels visible) the AH panel stays empty until that tab is picked —
   accepted because the app is going iOS-only.
4. **`Math.abs(recomputed - changePct) < 0.05` alone proves nothing.** Every constructor here
   defines `changePct` as exactly that expression, so the comparison is always true. Validate
   the *inputs* (`price > 0`, `prevClose > 0`, finite positive %) — see `rankMovers()`.

**Polygon is load-bearing.** With `POLYGON_API_KEY` unset as an Actions secret,
`NEXT_PUBLIC_POLYGON_API_KEY` compiles to `""`, `hasClientPolygonKey()` is false, and there is
**no fallback at all** behind the free proxies — any proxy flake becomes a cleared board. Check
`gh secret list` before blaming the transport.

---

## News sources (News tab)

- Source registry: `src/lib/newsSources.ts` — **reuse / extend this file** for future news scans.
- Includes Google News RSS (today), Yahoo Finance search + RSS, CNBC, Investing.com, MarketWatch, plus per–day_gainer ticker Yahoo searches.
- Live fetch: `src/lib/liveNews.ts` + `src/lib/fetchLiveNewsFeed.ts` — newest→oldest ≤100, **no** news TTL cache / live.json / filler.
- Soft-fail: news must never kill the gainers poll.


---

## iOS / Capacitor build (added 2026-08-06)

The app now ships as a native iOS app **and** the GitHub Pages site from one codebase.
`CAPACITOR_BUILD=true` → no `basePath`; `GITHUB_PAGES=true` → Pages basePath. Operational
detail lives in `docs/IOS.md`. **Every rule above still applies inside the iOS app.**

### Native transport — do not "simplify" this

- `src/lib/nativeHttp.ts` wraps `CapacitorHttp` (native `URLSession`). No CORS, real
  User-Agent, real cookie jar.
- `corsTransport.ts` gains exactly **one** new attempt kind, `native-direct`, prepended
  only when `isNativeApp()`. The existing sticky-preference logic then stops attempting
  proxies once it succeeds.
- **The proxy ladder stays.** If a host ever rejects direct calls, native falls back to
  today's exact proxy chain — degraded, not broken. Do not delete it.
- `CapacitorHttp: { enabled: false }` in `capacitor.config.ts` is deliberate. That flag
  only controls *global* fetch monkey-patching; `CapacitorHttp.request()` is called
  explicitly. Enabling it would break the `AbortSignal.timeout` / `cache: "no-store"`
  semantics this transport depends on.
- Queue caps are raised on native (`MAX_ACTIVE` 2→6) but the **reserved-critical-slot
  invariant is preserved** (`MAX_NONCRITICAL_ACTIVE < MAX_ACTIVE`), as is
  `FLOAT_TOTAL_BUDGET_MS`. Removing the queue would reintroduce the 2026-08-05 starvation
  bug the moment the app fell back to proxies.
- `isNativeApp()` must only ever be called **lazily inside functions**. `next build`
  prerenders in Node; touching a Capacitor global at module scope breaks the build.

### ZERO CACHING on iOS

- `npm run build:ios` deletes `out/data` before sync, so `live.json` / `floats.json` are
  **not in the app bundle at all**. This is the rule made structurally unbreakable — do
  not re-add them.
- No service worker. No `URLCache` reuse: every native request sends no-cache headers
  plus the existing `bust()` param.
- **Alert rules and display settings in `@capacitor/preferences` are ALLOWED.** Those are
  user settings, not market data. The rule forbids persisting quotes / gainers / float —
  and nothing in `src/lib/alerts.ts` writes a price, %, volume or float anywhere. The
  fired-alert dedupe set is in memory only and must stay that way.
- **Pausing polling on background and calling `setData(null)` is COMPLIANT, not a
  violation.** It declines to fetch while invisible, and clearing rows is what guarantees
  pre-background prices can never repaint as LIVE on resume. The first act of a resumed
  app is a fresh live poll. Do not "optimise" this into retaining the last payload.
- The Search / view-filter controls filter **already-live rows after ranking**. They never
  change what qualifies for the board; the only ranking filter is still top 50 by % gain.

### Verifying the iOS build

`npm run verify:native` is the gate — it proves direct no-proxy reachability, same-payload
%Chg math, and ≥70% Flt coverage on the top 15. Node's fetch runs under the same
conditions as `URLSession`, so a pass is real proof.

It **cannot** run from a restricted agent sandbox — the market-data hosts return
`403 Host not in allowlist` there. That is an environment limit, not a failing app: say so
plainly rather than claiming verification you did not do.

---

## Before every PR / push checklist

- [ ] Read this file again
- [ ] Client gainers path does not call or fall back to `live.json` or `floats.json`
- [ ] %Chg recomputes from same quote’s last + prevClose
- [ ] Price, volume, %Chg, and Flt come from the live poll — not cross-poll caches
- [ ] Failed live poll does not paint snapshot/cached movers as LIVE (rows cleared)
- [ ] Failed `day_gainers` does not paint Most Advanced / spark-only as the gainers board (Polygon live OK; Most Advanced alone not OK)
- [ ] **VERIFY YOUR WORK:** live Pages Gainers table shows numeric Flt for most top runners; LIVE not stuck RECONNECTING / “Load failed”
- [ ] Deployed Pages link verified after change
- [ ] If user asked for a second-agent visual check: use **another Grok agent**, not another provider
- [ ] **iOS:** `npm run build:ios` succeeds and `out/data` is absent from the bundle
- [ ] **iOS:** `npm run verify:native` passes on an unrestricted machine (or is explicitly reported as un-run)
- [ ] **iOS:** web Pages build still emits the `/day-trading-stock-scanner` basePath
