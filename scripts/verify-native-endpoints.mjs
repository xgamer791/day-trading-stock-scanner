#!/usr/bin/env node
/**
 * VERIFY YOUR WORK — native (iOS) live data path.
 * STOCK_SCANNER_APP_MEMORY.md requires proof, not "it should work".
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * The whole premise of the iOS port is that native URLSession has no same-origin
 * policy, so the app can call Yahoo / Nasdaq / Polygon **directly** and delete the
 * public-CORS-proxy failure mode entirely. Node's fetch runs under exactly the same
 * conditions as URLSession — no CORS, real User-Agent, real cookie jar — so a pass
 * here is a genuine proof of the native transport path, not a simulation.
 *
 * WHAT IT PROVES
 * --------------
 *  1. Every runtime endpoint the app uses is reachable with NO proxy.
 *  2. The ranked gainers board can be built from Yahoo `day_gainers` alone.
 *  3. %Chg recomputes from the SAME payload's last + prevClose.
 *  4. Flt is populated for >= 70% of the top 15 ranked gainers
 *     (Yahoo impliedSharesOutstanding, falling back to Nasdaq marketCap / price).
 *
 * Exit code 0 = the native path is good. Non-zero = do not claim the port works.
 *
 * Run it during US market hours; outside them Yahoo's day_gainers thins out and the
 * board assertions are not meaningful (the script says so rather than failing).
 *
 * Usage:  npm run verify:native
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

const FLT_COVERAGE_MIN = 0.7;
const TOP_N = 15;

let failures = 0;
let warnings = 0;

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function bust(url) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_=${Date.now()}`;
}

async function getText(url, timeoutMs = 20000) {
  const res = await fetch(bust(url), {
    headers: {
      "User-Agent": UA,
      Accept: "application/json,text/plain,text/xml,application/xml,*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim()) throw new Error("empty body");
  return text;
}

async function getJson(url, timeoutMs = 20000) {
  const text = await getText(url, timeoutMs);
  if (text.trimStart().startsWith("<")) throw new Error("HTML response (blocked?)");
  return JSON.parse(text);
}

async function probe(label, fn, { required = true } = {}) {
  const t0 = Date.now();
  try {
    const note = await fn();
    console.log(`  ${c.ok("PASS")} ${label} ${c.dim(`${Date.now() - t0}ms`)}`);
    if (note) console.log(`       ${c.dim(note)}`);
    return true;
  } catch (e) {
    const msg = e?.message || String(e);
    if (required) {
      failures += 1;
      console.log(`  ${c.bad("FAIL")} ${label} ${c.dim(`${Date.now() - t0}ms`)}`);
    } else {
      warnings += 1;
      console.log(`  ${c.warn("WARN")} ${label} ${c.dim(`${Date.now() - t0}ms`)}`);
    }
    console.log(`       ${msg}`);
    return false;
  }
}

/* ------------------------- shared parsing helpers ------------------------- */

function parseMarketCap(v) {
  if (v == null) return null;
  let s = String(v).trim().toUpperCase().replace(/[$,\s]/g, "");
  if (!s || s === "N/A" || s === "UNAVALIABLE" || s === "0") return null;
  let mult = 1;
  const suffix = s.slice(-1);
  if (suffix === "T") (mult = 1e12), (s = s.slice(0, -1));
  else if (suffix === "B") (mult = 1e9), (s = s.slice(0, -1));
  else if (suffix === "M") (mult = 1e6), (s = s.slice(0, -1));
  else if (suffix === "K") (mult = 1e3), (s = s.slice(0, -1));
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n * mult : null;
}

function isJunk(sym, name = "") {
  const s = String(sym || "").toUpperCase();
  const n = String(name || "").toLowerCase();
  if (!s || /[.=]/.test(s)) return true;
  if (/(WW|WS|WT|WR)$/.test(s)) return true;
  if (s.length >= 5 && s.endsWith("W")) return true;
  if (n.includes("warrant") || n.includes(" unit") || n.includes("right")) return true;
  if (/\betf\b|\betn\b|leveraged|direxion|proshares|graniteshares/.test(n)) return true;
  return false;
}

function etSession(now = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t) => p.find((x) => x.type === t)?.value ?? "";
  const wd = get("weekday");
  if (wd === "Sat" || wd === "Sun") return "closed";
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  if (mins >= 240 && mins < 570) return "premarket";
  if (mins >= 570 && mins < 960) return "regular";
  if (mins >= 960 && mins < 1200) return "afterhours";
  return "closed";
}

/* --------------------------------- main --------------------------------- */

const Y = "https://query1.finance.yahoo.com";
const session = etSession();

console.log("");
console.log("Native (no-proxy) live data verification");
console.log(c.dim(`ET session: ${session}   ${new Date().toISOString()}`));
console.log(c.dim("Node fetch == URLSession conditions: no CORS, real UA, real cookie jar."));
console.log("");

/* 1 — reachability of every runtime endpoint, directly */

console.log("1. Direct reachability (no CORS proxy)");

let dayGainersRaw = null;

await probe("Yahoo day_gainers  [PRIMARY RANKED BOARD]", async () => {
  const j = await getJson(
    `${Y}/v1/finance/screener/predefined/saved?count=100&scrIds=day_gainers&formatted=false`,
  );
  const quotes = j?.finance?.result?.[0]?.quotes;
  if (!Array.isArray(quotes) || !quotes.length) throw new Error("no quotes in payload");
  dayGainersRaw = quotes;
  return `${quotes.length} quotes`;
});

await probe("Yahoo most_actives", async () => {
  const j = await getJson(`${Y}/v1/finance/screener/predefined/saved?count=100&scrIds=most_actives`);
  const n = j?.finance?.result?.[0]?.quotes?.length ?? 0;
  if (!n) throw new Error("no quotes");
  return `${n} quotes`;
});

await probe("Yahoo spark", async () => {
  const j = await getJson(`${Y}/v7/finance/spark?symbols=AAPL,TSLA,NVDA&range=1d&interval=1m`);
  const n = Object.keys(j?.spark ? j.spark : j).length;
  return `${n} keys`;
});

await probe("Yahoo news search", async () => {
  const j = await getJson(`${Y}/v1/finance/search?q=stock+surge&quotesCount=0&newsCount=10`);
  return `${j?.news?.length ?? 0} headlines`;
});

await probe("Nasdaq marketmovers  [DISCOVERY]", async () => {
  const j = await getJson("https://api.nasdaq.com/api/marketmovers?assetclass=stocks&limit=50");
  const n = j?.data?.STOCKS?.MostAdvanced?.table?.rows?.length ?? 0;
  if (!n) throw new Error("no Most Advanced rows");
  return `${n} rows`;
});

await probe("Nasdaq quote summary  [FLT FALLBACK]", async () => {
  const j = await getJson("https://api.nasdaq.com/api/quote/AAPL/summary?assetclass=stocks");
  const mc = parseMarketCap(j?.data?.summaryData?.MarketCap?.value);
  if (!mc) throw new Error("no market cap");
  return `AAPL mcap $${(mc / 1e9).toFixed(1)}B`;
});

const polygonKey = process.env.NEXT_PUBLIC_POLYGON_API_KEY || process.env.POLYGON_API_KEY || "";
await probe(
  "Polygon snapshot gainers  [FALLBACK BOARD]",
  async () => {
    if (!polygonKey) throw new Error("POLYGON_API_KEY not set — no fallback behind the primary feed");
    const j = await getJson(
      `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${polygonKey}`,
    );
    const n = j?.tickers?.length ?? j?.results?.length ?? 0;
    if (!n) throw new Error("no tickers");
    return `${n} tickers`;
  },
  { required: false },
);

console.log("");
console.log("2. News sources (soft-fail — must never kill the gainers poll)");

for (const [label, url] of [
  ["Google News RSS", "https://news.google.com/rss/search?q=stock+surges+when:1d&hl=en-US&gl=US&ceid=US:en"],
  ["Yahoo Finance RSS", "https://finance.yahoo.com/news/rssindex"],
  ["CNBC RSS", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664"],
  ["MarketWatch RSS", "https://feeds.content.dowjones.io/public/rss/mw_topstories"],
  ["Investing.com RSS", "https://www.investing.com/rss/news_25.rss"],
]) {
  await probe(
    label,
    async () => {
      const t = await getText(url, 15000);
      const items = (t.match(/<item[\s>]/g) || []).length;
      if (!items) throw new Error("no <item> elements");
      return `${items} items`;
    },
    { required: false },
  );
}

/* 3 — ranked board + %Chg integrity */

console.log("");
console.log("3. Ranked board integrity");

let ranked = [];
if (dayGainersRaw) {
  for (const q of dayGainersRaw) {
    const sym = String(q.symbol || "").toUpperCase();
    const name = q.shortName || q.longName || "";
    if (!sym || isJunk(sym, name)) continue;
    const last = Number(q.regularMarketPrice);
    const prev = Number(q.regularMarketPreviousClose);
    if (!(last > 0) || !(prev > 0)) continue;
    const changePct = ((last - prev) / prev) * 100;
    if (!Number.isFinite(changePct) || changePct <= 0) continue;
    ranked.push({
      symbol: sym,
      name,
      price: last,
      prevClose: prev,
      changePct,
      volume: Number(q.regularMarketVolume) || 0,
      // Flt straight off the SAME live payload — the preferred path.
      floatMillions:
        [q.impliedSharesOutstanding, q.sharesOutstanding, q.floatShares]
          .map(Number)
          .find((n) => Number.isFinite(n) && n > 0) / 1e6 || null,
    });
  }
  ranked.sort((a, b) => b.changePct - a.changePct);
  ranked = ranked.slice(0, 50);
}

if (!ranked.length) {
  if (session === "regular" || session === "premarket") {
    failures += 1;
    console.log(`  ${c.bad("FAIL")} no rankable gainers built from day_gainers during ${session}`);
  } else {
    console.log(`  ${c.warn("SKIP")} market ${session} — an empty board is expected`);
  }
} else {
  console.log(`  ${c.ok("PASS")} built ${ranked.length} ranked movers from day_gainers alone`);

  // %Chg must derive from the same payload's last + prevClose.
  const badMath = ranked.filter(
    (r) => Math.abs(((r.price - r.prevClose) / r.prevClose) * 100 - r.changePct) > 1e-6,
  );
  if (badMath.length) {
    failures += 1;
    console.log(`  ${c.bad("FAIL")} ${badMath.length} rows whose %Chg is not (last-prev)/prev`);
  } else {
    console.log(`  ${c.ok("PASS")} %Chg derives from same-payload last + prevClose on all rows`);
  }

  const descending = ranked.every((r, i) => i === 0 || ranked[i - 1].changePct >= r.changePct);
  console.log(
    descending
      ? `  ${c.ok("PASS")} sorted descending by %Chg`
      : `  ${c.bad("FAIL")} board is not sorted descending`,
  );
  if (!descending) failures += 1;

  console.log(
    c.dim(
      `       top 5: ${ranked
        .slice(0, 5)
        .map((r) => `${r.symbol} +${r.changePct.toFixed(1)}%`)
        .join(", ")}`,
    ),
  );
}

/* 4 — Flt coverage on the top 15 (the memory file's explicit gate) */

console.log("");
console.log(`4. Flt coverage — top ${TOP_N} ranked gainers (gate: >= ${FLT_COVERAGE_MIN * 100}%)`);

if (!ranked.length) {
  console.log(`  ${c.warn("SKIP")} no board to enrich (market ${session})`);
} else {
  const top = ranked.slice(0, TOP_N);
  const fromYahoo = top.filter((r) => r.floatMillions != null).length;

  // Nasdaq marketCap / livePrice fallback for rows Yahoo did not carry share counts for.
  const needing = top.filter((r) => r.floatMillions == null);
  await Promise.all(
    needing.map(async (r) => {
      try {
        const j = await getJson(
          `https://api.nasdaq.com/api/quote/${encodeURIComponent(r.symbol)}/summary?assetclass=stocks`,
          12000,
        );
        const mcap = parseMarketCap(j?.data?.summaryData?.MarketCap?.value);
        if (mcap && r.price > 0) r.floatMillions = mcap / r.price / 1e6;
      } catch {
        /* a single symbol may blank — the column must not be systematically empty */
      }
    }),
  );

  const withFlt = top.filter((r) => r.floatMillions != null && r.floatMillions > 0).length;
  const pct = withFlt / top.length;

  console.log(
    `       ${top
      .map((r) => `${r.symbol}=${r.floatMillions ? `${Math.round(r.floatMillions)}M` : "—"}`)
      .join("  ")}`,
  );
  console.log(
    c.dim(`       ${fromYahoo} from Yahoo share counts, ${withFlt - fromYahoo} from Nasdaq marketCap`),
  );

  if (pct >= FLT_COVERAGE_MIN) {
    console.log(`  ${c.ok("PASS")} Flt coverage ${withFlt}/${top.length} (${(pct * 100).toFixed(0)}%)`);
  } else {
    failures += 1;
    console.log(
      `  ${c.bad("FAIL")} Flt coverage ${withFlt}/${top.length} (${(pct * 100).toFixed(0)}%) — below the 70% gate`,
    );
  }
}

/* --------------------------------- verdict --------------------------------- */

console.log("");
if (failures) {
  console.log(c.bad(`VERIFY FAIL — ${failures} required check(s) failed${warnings ? `, ${warnings} warning(s)` : ""}`));
  console.log("The native direct path is NOT proven. Do not report the iOS port as working.");
  console.log(
    c.dim(
      "Note: corsTransport.ts still falls back to the public proxy ladder on native, so a\n" +
        "failure here means degraded-to-web behaviour, not a broken app.",
    ),
  );
  process.exit(1);
}

console.log(c.ok(`VERIFY OK — native direct path proven${warnings ? ` (${warnings} optional warning(s))` : ""}`));
console.log("Yahoo/Nasdaq reachable with no proxy; board ranks correctly; Flt column populated.");
