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
   - In-memory “last good tick” reused **during an active session** after a failed poll as if still LIVE (clear the live payload instead)
   - LocalStorage / IndexedDB for quotes (sessionStorage is only allowed for prior-session board hold until next premarket — see Allowed)
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
   - **Prior-session board hold until next premarket:** after Premarket / Gainers / After Hours ends, keep showing that session’s last live board (in-memory + `sessionStorage` keyed by trading day via `sessionBoardHold.ts`) until the next weekday **4:00 AM ET premarket**. Cleared on premarket open. This is **not** a mid-session LIVE fallback when a poll fails during an active window.
   - **Same-session board identity stability:** quality-gate (`boardQuality` / `shouldReplaceHeldBoard`) so a weak/partial/empty poll cannot replace a strong Premarket / Gainers / After Hours board for the *current* window. On transport failure: show RECONNECTING but **keep** the last strong same-session rows on screen (do not flash empty then a different weak list). Still never `live.json` / floats.json.
4. **On live fetch failure (active session):** show RECONNECTING. Clear the live payload **only** when there is no same-session strong hold to display. Do **not** substitute snapshot/`live.json`. Do **not** paint a weaker alternate board identity as if it were a fresh LIVE ranked list.
5. **%Chg math (must match TradingView / Realtime):**  
   `(last − previousClose) / previousClose` from the **same quote payload**. Never pair Yahoo last with Nasdaq screener %.
6. If GitHub Pages CORS forces a proxy: proxies are for transport only. They must still return **current** API payloads. A proxy is not a license to serve `live.json` or `floats.json`.

### Safari “Load failed” / durable browser transport

- Public proxies (`corsproxy.io` `/raw`, etc.) are unreliable; Safari often surfaces `TypeError: Load failed`.
- Client transport: `src/lib/corsTransport.ts` — prefer **allorigins `/get` + unwrap `contents`**, sticky preference, circuit breaker, quote priority queue. Optional `NEXT_PUBLIC_QUOTE_PROXY_URL` (see `workers/quote-proxy/`).
- **Polygon** (`NEXT_PUBLIC_POLYGON_API_KEY` from Actions secret `POLYGON_API_KEY`) is the durable no-proxy path — Polygon reflects ACAO for the Pages origin. Prefer Yahoo `day_gainers` when the proxy path works; if it fails, use Polygon live gainers. **Never** paint Nasdaq Most Advanced alone.
- Pages builds must not ship an empty `NEXT_PUBLIC_POLYGON_API_KEY` if Polygon is expected — set the Actions secret.

---

## Premarket / session board identity — fixed 2026-08-06

**Was OPEN:** Premarket cycled correct (CLRO…) → `Live premarket quotes unavailable` → wrong weak list → correct.

**Root cause:** public CORS chart fan-out + throw/clear + no quality-gate on Premarket writes.

**Fix landed:**
1. Same-session **quality-gate** for Premarket / Gainers / After Hours (`shouldReplaceHeldBoard`); display always `preferStrongerBoard`.
2. Transport miss / empty Premarket: **soft** — RECONNECTING, keep strong same-session rows (no empty→wrong flash).
3. Premarket chart fan-out capped (~20, discovery+sticky first); AH fan-out reduced.
4. Pages build accepts optional `QUOTE_PROXY_URL` secret → `NEXT_PUBLIC_QUOTE_PROXY_URL`.

**Do not reintroduce:** throwing `Live premarket quotes unavailable` on empty, `setData(null)` while a strong same-session hold exists, or unbounded Premarket chart storms.

### Hold durability after 9:30 ET (fixed again 2026-08-06 afternoon)

**Symptom:** Premarket tab empty with “Live data error” / reconnecting during RTH even after a good morning board.

**Root causes (both required):**
1. Static export SSR: `useState(() => readHeldBoard())` runs with no `sessionStorage` → `[]`, and React never re-ran the initializer on the client — **must rehydrate holds in a mount `useEffect`**.
2. Poll `catch` `hasHold` only counted Premarket during `premarket` session — during `regular`, a Gainers transport miss called `setData(null)` even when `heldPremarket` existed. During RTH, live returns `premarket: []` by design; **Premarket is hold-only after 9:30** — any hold must block `setData(null)`.
3. Premarket `emptyText` must not show “Live data error” outside the premarket window (Gainers reconnect is not a Premarket board failure).

**Do not reintroduce:** session-narrow `hasHold`, or relying on `useState(readHeldBoard)` alone under `output: "export"`.

---

## Product rules

- **Only ranking filter:** top % gainers (positive change). No HOD / min-price / min-volume gates for inclusion.
- **Feeds:** top 50.
- **Markets:** full US listed equities (NASDAQ, NYSE, AMEX/Arca, etc.).
- **Junk filter OK:** warrants / units / rights / preferreds / leveraged ETFs (retail screener parity).
- **Premarket tab ≠ Gainers tab ≠ After Hours tab** (session-aware).
- **Premarket tab (4:00–9:30 ET):** live gaps via Yahoo `includePrePost` charts — extended last vs `previousClose`. Discovery via `ah-discovery.json` (symbols only) + Nasdaq movers + universe slice. **Never** paint Yahoo `day_gainers` / Nasdaq Most Advanced regular-session % as Premarket (that is yesterday’s board — YXT-class).
- **After Hours tab:** post-market % vs regular-session close during 16:00–20:00 ET (and overnight while `closed`). Discovery is wider than Yahoo `day_gainers` alone: Nasdaq movers + `public/data/ah-discovery.json` (symbols only, from Actions/universe chart scan) + live Yahoo `includePrePost` quotes. Never paste regular `day_gainers` ranking into this tab; never treat `ah-discovery.json` as a priced board.
- **Prior-session hold:** Premarket / Gainers / After Hours keep their last session board after the window ends until next **4:00 AM ET premarket**, then clear.
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

## Before every PR / push checklist

- [ ] Read this file again
- [ ] Client gainers path does not call or fall back to `live.json` or `floats.json`
- [ ] %Chg recomputes from same quote’s last + prevClose
- [ ] Price, volume, %Chg, and Flt come from the live poll — not cross-poll caches
- [ ] Failed live poll does not paint snapshot/cached movers as LIVE (rows cleared)
- [ ] Failed `day_gainers` does not paint Most Advanced / spark-only as the gainers board (Polygon live OK; Most Advanced alone not OK)
- [ ] Premarket/Gainers/AH: weak or empty poll does not replace a strong same-session board (quality-gate / no empty flash)
- [ ] **VERIFY YOUR WORK:** live Pages Gainers table shows numeric Flt for most top runners; LIVE not stuck RECONNECTING / “Load failed”
- [ ] Deployed Pages link verified after change
- [ ] If user asked for a second-agent visual check: use **another Grok agent**, not another provider
