/**
 * LIVE-ONLY client feed (STOCK_SCANNER_APP_MEMORY.md — read before every edit).
 *
 * Every ~3s poll (no mover-row cache):
 *  1) Nasdaq Most Advanced (discovery only — never the ranked board alone)
 *  2) Yahoo day_gainers — preferred primary quotes (price, prevClose, vol, Flt)
 *     via resilient CORS transport (allorigins `/get` unwrap, queued)
 *  3) Polygon snapshot gainers — durable direct-CORS fallback / parallel live
 *     board when Yahoo proxies fail (NOT Nasdaq Most Advanced, NOT live.json)
 *  4) Yahoo spark for Most Advanced symbols missing from the ranked board (≤30)
 *     + small unqueued chart fill for names spark still missed (regular last/prev)
 *  5) Live Flt for ranked spark/Polygon rows via small Nasdaq quote summary
 *  6) Rank by same-quote % — top 50
 *  7) Premarket (4:00–9:30 ET): live gaps via Yahoo includePrePost charts
 *     (extended last vs previousClose). Discovery via ah-discovery.json symbols
 *     + Nasdaq movers + universe slice. NEVER rank Yahoo day_gainers /
 *     yesterday's regular Most Advanced as the Premarket board.
 *  8) After Hours (16:00–20:00 ET + overnight closed): post/extended last vs
 *     regular close. Wide discovery via ah-discovery.json (symbols only) +
 *     Nasdaq movers + Yahoo includePrePost charts — not day_gainers ranking.
 *     Gated behind the AH tab; soft-fail so Gainers never breaks.
 *
 * If BOTH Yahoo day_gainers and Polygon fail (regular/AH): throw / RECONNECTING.
 * Do NOT substitute Nasdaq Most Advanced alone as “top gainers”.
 *
 * FORBIDDEN: live.json, floats.json, last-tick-as-LIVE, localStorage, etc.
 * Never use Nasdaq % with Yahoo/Polygon last.
 */
import {
  fetchPolygonGainerQuotes,
  hasClientPolygonKey,
} from "@/lib/clientPolygonLive";
import { fetchJsonDirect, fetchJsonViaCors } from "@/lib/corsTransport";
import type { NewsItem, ScannerPayload, StockMover } from "@/lib/types";

const FEED_LIMIT = 50;
/** Keep Flt fills small — too many summary proxy hits kill day_gainers (~20s). */
const FLOAT_SYMBOL_MAX = 12;
const FLOAT_BATCH = 4;
/** Whole-Flt-fill wall-clock ceiling, so enrichment can never own the poll. */
const FLOAT_TOTAL_BUDGET_MS = 5_000;

/**
 * Prefer direct fetch (Node / non-CORS contexts), then resilient CORS proxies
 * for the GitHub Pages browser. Never reads live.json.
 */
async function fetchViaProxy(
  url: string,
  timeoutMs = 16000,
  priority: "critical" | "normal" | "low" = "critical",
): Promise<unknown> {
  try {
    return await fetchJsonDirect(url, Math.min(timeoutMs, 10000));
  } catch {
    /* browser CORS — fall through to public / owned proxies */
  }
  return fetchJsonViaCors(url, timeoutMs, priority);
}

function parseMoney(v: unknown): number {
  if (v == null) return 0;
  const n = Number(String(v).replace(/[$,%+]/g, "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function isJunk(sym: string, name = ""): boolean {
  const s = (sym || "").toUpperCase();
  const n = (name || "").toLowerCase();
  if (!s || /[.=]/.test(s)) return true;
  if (/(WW|WS|WT|WR)$/.test(s)) return true;
  if (s.length >= 5 && s.endsWith("W")) return true;
  if (n.includes("warrant") || n.includes(" unit") || n.includes("right")) return true;
  if (n.includes("preferred") || n.includes(" preference")) return true;
  if (/\betf\b|\betn\b|leveraged|direxion|proshares|graniteshares/.test(n)) return true;
  if (s.length >= 5 && s.endsWith("Z") && !n.includes("ordinary") && !n.includes("common")) {
    return true;
  }
  return false;
}

function sessionNow(): ScannerPayload["session"] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  if (["Sat", "Sun"].includes(weekday)) return "closed";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const mins = hour * 60 + minute;
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "premarket";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "regular";
  if (mins >= 16 * 60 && mins < 20 * 60) return "afterhours";
  return "closed";
}

type Seed = { symbol: string; name: string };

type LiveQuote = {
  symbol: string;
  name: string;
  last: number;
  prevClose: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  changePct: number;
  /** Realtime Flt — millions; from same live payload when available. */
  floatMillions: number | null;
};

function sharesToMillions(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || !(n > 0)) return null;
  return n / 1_000_000;
}

/** Realtime Flt field order from a live Yahoo quote object. */
function liveFloatMillions(q: Record<string, unknown>): number | null {
  return (
    sharesToMillions(q.impliedSharesOutstanding) ??
    sharesToMillions(q.sharesOutstanding) ??
    sharesToMillions(q.floatShares)
  );
}

function quoteFromLastPrev(
  symbol: string,
  name: string,
  last: number,
  prevClose: number,
  dayHigh: number,
  dayLow: number,
  volume: number,
  floatMillions: number | null = null,
): LiveQuote | null {
  if (!(last > 0) || !(prevClose > 0)) return null;
  const changePct = ((last - prevClose) / prevClose) * 100;
  if (!(changePct > 0)) return null;
  return {
    symbol,
    name: name || symbol,
    last,
    prevClose,
    dayHigh: Math.max(dayHigh || last, last),
    dayLow: dayLow || last,
    volume: volume || 0,
    changePct,
    floatMillions,
  };
}

async function fetchMostAdvanced(): Promise<Seed[]> {
  const parse = (data: {
    data?: { STOCKS?: { MostAdvanced?: { table?: { rows?: Array<Record<string, string>> } } } };
  }): Seed[] => {
    const rows = data?.data?.STOCKS?.MostAdvanced?.table?.rows || [];
    const out: Seed[] = [];
    for (const r of rows) {
      if (isJunk(r.symbol, r.name)) continue;
      if (!(parseMoney(r.change) > 0 || parseMoney(r.pctchange) > 0)) continue;
      out.push({
        symbol: String(r.symbol).replace("/", "-").toUpperCase(),
        name: r.name || r.symbol,
      });
    }
    return out;
  };

  const url = "https://api.nasdaq.com/api/marketmovers?assetclass=stocks&limit=50";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = (await fetchViaProxy(url, 14000, "critical")) as Parameters<typeof parse>[0];
      const out = parse(data);
      if (out.length) return out;
    } catch {
      /* retry / fallback */
    }
  }
  // Unqueued fallback — AH chart traffic must not permanently starve discovery.
  try {
    const data = (await fetchAhTransport(url, 12000)) as Parameters<typeof parse>[0];
    return parse(data);
  } catch {
    return [];
  }
}

/**
 * Primary live quote source each poll.
 * Price, prevClose, volume, and Flt share counts come from this payload —
 * no floats.json / in-memory float cache.
 */
async function fetchYahooScreenerRaw(
  scrId: string,
  count: number,
  timeoutMs: number,
  priority: "critical" | "normal" | "low",
): Promise<Array<Record<string, unknown>>> {
  type ScreenerPayload = {
    finance?: {
      result?: Array<{
        quotes?: Array<Record<string, unknown>>;
      }>;
    };
  };
  const data = (await fetchViaProxy(
    `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=${count}&scrIds=${encodeURIComponent(scrId)}&formatted=false`,
    timeoutMs,
    priority,
  )) as ScreenerPayload;
  return data?.finance?.result?.[0]?.quotes || [];
}

async function fetchYahooDayGainerQuotes(
  forPremarket = false,
): Promise<{
  map: Map<string, LiveQuote>;
  raw: Array<Record<string, unknown>>;
}> {
  // allorigins/get often needs ~10–16s — do not use a short timeout (Safari Load failed).
  // Retry: public proxies flake; one miss must not blank the whole Gainers board.
  let lastErr: Error | null = null;
  let quotes: Array<Record<string, unknown>> = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      quotes = await fetchYahooScreenerRaw("day_gainers", 100, 18000, "critical");
      if (quotes.length > 0) break;
      lastErr = new Error("day_gainers empty");
      quotes = [];
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      quotes = [];
      if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  if (!quotes.length) throw lastErr || new Error("Live Yahoo day_gainers unavailable");

  const map = new Map<string, LiveQuote>();
  for (const q of quotes) {
    const symbol = String(q.symbol || "")
      .replace("/", "-")
      .toUpperCase();
    const name = String(q.shortName || q.longName || symbol);
    if (!symbol || isJunk(symbol, name)) continue;
    const prevClose = Number(q.regularMarketPreviousClose) || 0;
    // Premarket board: prefer preMarketPrice vs prior close (Realtime gap %).
    // Fall back to regularMarketPrice when Yahoo has not stamped premarket yet.
    const pre = Number(q.preMarketPrice) || 0;
    const regular = Number(q.regularMarketPrice) || 0;
    const last = forPremarket && pre > 0 ? pre : regular;
    if (!(last > 0)) continue;
    const dayHigh = Math.max(Number(q.regularMarketDayHigh) || 0, last);
    const dayLow = Number(q.regularMarketDayLow) || last;
    const volume =
      (forPremarket ? Number(q.preMarketVolume) || 0 : 0) ||
      Number(q.regularMarketVolume) ||
      0;
    const row = quoteFromLastPrev(
      symbol,
      name,
      last,
      prevClose,
      dayHigh,
      dayLow,
      volume,
      liveFloatMillions(q),
    );
    if (row) map.set(symbol, row);
  }
  return { map, raw: quotes };
}

/**
 * After-hours top gainers: % from regular-session close → postMarket / extended
 * last. NOT regular day_gainers ranking. Live Yahoo payloads only
 * (STOCK_SCANNER_APP_MEMORY).
 */
function afterHoursQuoteFromRaw(q: Record<string, unknown>): LiveQuote | null {
  const symbol = String(q.symbol || "")
    .replace("/", "-")
    .toUpperCase();
  const name = String(q.shortName || q.longName || symbol);
  if (!symbol || isJunk(symbol, name)) return null;

  const post = Number(q.postMarketPrice) || 0;
  const regular = Number(q.regularMarketPrice) || 0;
  if (!(post > 0) || !(regular > 0)) return null;

  // AH % vs regular close (same-payload math). Prefer recomputed over Yahoo's field.
  const changePct = ((post - regular) / regular) * 100;
  if (!(changePct > 0)) return null;

  const dayHigh = Math.max(Number(q.regularMarketDayHigh) || 0, post);
  const dayLow = Number(q.regularMarketDayLow) || Math.min(regular, post);
  const volume = Number(q.postMarketVolume) || Number(q.regularMarketVolume) || 0;

  return {
    symbol,
    name,
    last: post,
    prevClose: regular,
    dayHigh,
    dayLow,
    volume,
    changePct,
    floatMillions: liveFloatMillions(q),
  };
}

/** AH board only — bypass the gainers proxy queue so charts cannot starve day_gainers. */
async function fetchAhTransport(url: string, timeoutMs = 10000): Promise<unknown> {
  try {
    return await fetchJsonDirect(url, Math.min(timeoutMs, 8000));
  } catch {
    /* browser CORS */
  }
  return fetchJsonViaCors(url, timeoutMs, "low", { queue: false });
}

function afterHoursQuoteFromChart(symbol: string, payload: unknown): LiveQuote | null {
  const result = (payload as {
    chart?: {
      result?: Array<{
        meta?: Record<string, unknown>;
        indicators?: { quote?: Array<{ close?: Array<number | null> }> };
      }>;
    };
  })?.chart?.result?.[0];
  if (!result) return null;
  const meta = result.meta || {};
  const closes = result.indicators?.quote?.[0]?.close || [];
  let last = 0;
  for (let i = closes.length - 1; i >= 0; i--) {
    const c = Number(closes[i]);
    if (Number.isFinite(c) && c > 0) {
      last = c;
      break;
    }
  }
  const regular = Number(meta.regularMarketPrice) || 0;
  if (!(last > 0) || !(regular > 0)) return null;
  const changePct = ((last - regular) / regular) * 100;
  if (!(changePct > 0)) return null;

  const dayHigh = Math.max(Number(meta.regularMarketDayHigh) || 0, last);
  const dayLow = Number(meta.regularMarketDayLow) || Math.min(regular, last);
  const volume = Number(meta.regularMarketVolume) || 0;
  const name = String(meta.shortName || meta.longName || symbol);
  if (isJunk(symbol, name)) return null;

  return {
    symbol,
    name,
    last,
    prevClose: regular,
    dayHigh,
    dayLow,
    volume,
    changePct,
    floatMillions: null,
  };
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  deadlineMs: number,
  fn: (item: T) => Promise<R | null>,
): Promise<R[]> {
  const out: R[] = [];
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (idx < items.length && Date.now() < deadlineMs) {
      const item = items[idx++];
      try {
        const row = await fn(item);
        if (row != null) out.push(row);
      } catch {
        /* skip */
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/** Sticky AH discovery symbols only — never prices (STOCK_SCANNER_APP_MEMORY allowed). */
const ahHotSymbols = new Set<string>();
/** Sticky Premarket discovery symbols only — never prices. */
const pmHotSymbols = new Set<string>();
let universeSymbols: string[] | null = null;
let universeCursor = 0;
let pmUniverseCursor = 0;
let ahDiscoverySymbols: string[] | null = null;
/** ET calendar day we last wiped extended-hours sticky sets (once per premarket day). */
let extendedHotClearedDay: string | null = null;

async function loadUniverseSymbols(): Promise<string[]> {
  if (universeSymbols) return universeSymbols;
  const base = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
  const candidates = [
    `${base}/data/universe.json`,
    "https://xgamer791.github.io/day-trading-stock-scanner/data/universe.json",
  ];
  for (const url of candidates) {
    try {
      // Same-origin on Pages — no CORS proxy needed for the first URL.
      const data = (await fetchJsonDirect(url, 12000)) as { symbols?: string[] };
      universeSymbols = (data.symbols || [])
        .map((s) => String(s).replace("/", "-").toUpperCase())
        .filter((s) => s && !isJunk(s));
      if (universeSymbols.length) return universeSymbols;
    } catch {
      /* try next */
    }
  }
  universeSymbols = [];
  return universeSymbols;
}

/** Symbols-only AH discovery file from Actions/build — never priced rows. */
async function loadAhDiscoverySymbols(): Promise<string[]> {
  if (ahDiscoverySymbols) return ahDiscoverySymbols;

  const parse = (data: { symbols?: string[] } | null): string[] =>
    (data?.symbols || [])
      .map((s) => String(s).replace("/", "-").toUpperCase())
      .filter((s) => s && !isJunk(s));

  // Node / verify scripts: read the committed file directly.
  if (typeof window === "undefined") {
    try {
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const raw = readFileSync(resolve("public/data/ah-discovery.json"), "utf8");
      ahDiscoverySymbols = parse(JSON.parse(raw) as { symbols?: string[] });
      if (ahDiscoverySymbols.length) return ahDiscoverySymbols;
    } catch {
      /* fall through to HTTP */
    }
  }

  const base = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
  const candidates = [
    `${base}/data/ah-discovery.json`,
    "https://xgamer791.github.io/day-trading-stock-scanner/data/ah-discovery.json",
  ];
  for (const url of candidates) {
    try {
      const sep = url.includes("?") ? "&" : "?";
      const data = (await fetchJsonDirect(`${url}${sep}_=${Date.now()}`, 8000)) as {
        symbols?: string[];
      };
      ahDiscoverySymbols = parse(data);
      if (ahDiscoverySymbols.length) return ahDiscoverySymbols;
    } catch {
      /* try next */
    }
  }
  ahDiscoverySymbols = [];
  return ahDiscoverySymbols;
}

async function fetchNasdaqDiscoverySymbols(): Promise<string[]> {
  try {
    const data = (await fetchAhTransport(
      "https://api.nasdaq.com/api/marketmovers?assetclass=stocks&limit=50",
      10000,
    )) as {
      data?: {
        STOCKS?: Record<string, { table?: { rows?: Array<Record<string, string>> } }>;
      };
    };
    const out: string[] = [];
    const tables = data?.data?.STOCKS || {};
    for (const key of [
      "MostAdvanced",
      "MostDeclined",
      "MostActiveByShareVolume",
      "MostActiveByDollarVolume",
    ]) {
      for (const r of tables[key]?.table?.rows || []) {
        const s = String(r.symbol || "")
          .replace("/", "-")
          .toUpperCase();
        if (s && !isJunk(s, r.name || "")) out.push(s);
      }
    }
    return [...new Set(out)];
  } catch {
    return [];
  }
}

const AH_CHART_MAX = 32;
const AH_CHART_CONCURRENCY = 4;
const AH_CHART_BUDGET_MS = 12_000;
const AH_UNIVERSE_SLICE = 24;

/**
 * Wide AH discovery: Yahoo screeners (postMarket*) + Nasdaq movers + sticky hits
 * + rotating universe slice, then chart includePrePost for names Yahoo screeners miss
 * (Realtime-parity micros like CLRO/SURG). Soft-fail; never throws into Gainers.
 */
async function fetchAfterHoursGainerQuotes(
  dayGainerRaw: Array<Record<string, unknown>>,
  extraSeeds: string[] = [],
): Promise<Map<string, LiveQuote>> {
  const extraIds = [
    "most_actives",
    "day_losers",
    "small_cap_gainers",
    "aggressive_small_caps",
  ] as const;

  const [extrasSettled, nasdaqSeeds, universe, discoverySeeds] = await Promise.all([
    Promise.allSettled(extraIds.map((id) => fetchYahooScreenerRaw(id, 100, 16000, "normal"))),
    fetchNasdaqDiscoverySymbols(),
    loadUniverseSymbols(),
    loadAhDiscoverySymbols(),
  ]);

  const rawMap = new Map<string, Record<string, unknown>>();
  for (const q of dayGainerRaw) {
    const s = String(q.symbol || "")
      .replace("/", "-")
      .toUpperCase();
    if (s) rawMap.set(s, q);
  }
  for (const res of extrasSettled) {
    if (res.status !== "fulfilled") continue;
    for (const q of res.value) {
      const s = String(q.symbol || "")
        .replace("/", "-")
        .toUpperCase();
      if (!s) continue;
      const prev = rawMap.get(s);
      if (!prev || (Number(q.postMarketPrice) > 0 && !(Number(prev.postMarketPrice) > 0))) {
        rawMap.set(s, q);
      }
    }
  }

  const map = new Map<string, LiveQuote>();
  for (const q of rawMap.values()) {
    const row = afterHoursQuoteFromRaw(q);
    if (row) map.set(row.symbol, row);
  }

  // Discovery seeds for chart fill — names often absent from Yahoo postMarket screeners.
  // ah-discovery.json (symbols only) is highest priority for Realtime-parity micros.
  const needChart = new Set<string>();
  for (const s of [...discoverySeeds, ...extraSeeds, ...nasdaqSeeds, ...ahHotSymbols]) {
    const sym = s.toUpperCase();
    if (!sym || isJunk(sym) || map.has(sym)) continue;
    needChart.add(sym);
  }
  // Screener names with no postMarket* still need an extended-hours chart quote.
  for (const [sym, q] of rawMap) {
    if (map.has(sym)) continue;
    if (!(Number(q.postMarketPrice) > 0)) needChart.add(sym);
  }

  const firstWave = ahHotSymbols.size < 8;
  const chartMax = firstWave ? 40 : AH_CHART_MAX;

  if (universe.length) {
    if (firstWave) {
      // Spread across the full tape so micros aren't stuck behind A–B alphabet.
      const step = Math.max(1, Math.floor(universe.length / chartMax));
      for (let i = 0; i < chartMax; i++) {
        const sym = universe[(i * step) % universe.length];
        if (sym && !map.has(sym) && !isJunk(sym)) needChart.add(sym);
      }
    } else {
      const slice = Math.min(AH_UNIVERSE_SLICE, universe.length);
      for (let i = 0; i < slice; i++) {
        const sym = universe[(universeCursor + i) % universe.length];
        if (sym && !map.has(sym) && !isJunk(sym)) needChart.add(sym);
      }
      universeCursor = (universeCursor + slice) % universe.length;
    }
  }

  const chartList = [...needChart].slice(0, chartMax);
  if (chartList.length) {
    const deadline = Date.now() + AH_CHART_BUDGET_MS;
    const chartRows = await mapPool(chartList, AH_CHART_CONCURRENCY, deadline, async (symbol) => {
      const payload = await fetchAhTransport(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`,
        9000,
      );
      return afterHoursQuoteFromChart(symbol, payload);
    });
    for (const row of chartRows) {
      if (!map.has(row.symbol) || row.changePct > (map.get(row.symbol)?.changePct || 0)) {
        map.set(row.symbol, row);
      }
      if (row.changePct >= 1) ahHotSymbols.add(row.symbol);
    }
  }

  // Keep sticky set bounded.
  if (ahHotSymbols.size > 120) {
    const ranked = [...map.values()]
      .filter((r) => ahHotSymbols.has(r.symbol))
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 80)
      .map((r) => r.symbol);
    ahHotSymbols.clear();
    for (const s of ranked) ahHotSymbols.add(s);
  }

  return map;
}

/**
 * Premarket quote from Yahoo chart includePrePost.
 * % = (extended last − previousClose) / previousClose — NOT regularMarketPrice
 * (that field is still yesterday's regular close during PRE and paints day_gainers).
 */
function premarketQuoteFromChart(symbol: string, payload: unknown): LiveQuote | null {
  const result = (payload as {
    chart?: {
      result?: Array<{
        meta?: Record<string, unknown>;
        indicators?: {
          quote?: Array<{ close?: Array<number | null>; volume?: Array<number | null> }>;
        };
      }>;
    };
  })?.chart?.result?.[0];
  if (!result) return null;
  const meta = result.meta || {};
  const closes = result.indicators?.quote?.[0]?.close || [];
  const volumes = result.indicators?.quote?.[0]?.volume || [];
  let last = 0;
  let volSum = 0;
  for (let i = 0; i < closes.length; i++) {
    const c = Number(closes[i]);
    const v = Number(volumes[i]);
    if (Number.isFinite(v) && v > 0) volSum += v;
    if (Number.isFinite(c) && c > 0) last = c;
  }
  const prevClose = Number(meta.previousClose ?? meta.chartPreviousClose) || 0;
  const preMeta = Number(meta.preMarketPrice) || 0;
  // Prefer last includePrePost bar; fall back to stamped preMarketPrice.
  const price = last > 0 ? last : preMeta;
  if (!(price > 0) || !(prevClose > 0)) return null;
  const changePct = ((price - prevClose) / prevClose) * 100;
  if (!(changePct > 0)) return null;

  const dayHigh = Math.max(Number(meta.regularMarketDayHigh) || 0, price);
  const dayLow = Number(meta.regularMarketDayLow) || Math.min(prevClose, price);
  const volume =
    Number(meta.preMarketVolume) || volSum || Number(meta.regularMarketVolume) || 0;
  const name = String(meta.shortName || meta.longName || symbol);
  if (isJunk(symbol, name)) return null;

  return {
    symbol,
    name,
    last: price,
    prevClose,
    dayHigh,
    dayLow,
    volume,
    changePct,
    floatMillions: null,
  };
}

const PM_CHART_MAX = 20;
const PM_CHART_CONCURRENCY = 3;
const PM_CHART_BUDGET_MS = 12_000;
const PM_UNIVERSE_SLICE = 8;

/** Premarket row from Yahoo screener when preMarketPrice is stamped (same-payload %). */
function premarketQuoteFromScreener(q: Record<string, unknown>): LiveQuote | null {
  const symbol = String(q.symbol || "")
    .replace("/", "-")
    .toUpperCase();
  const name = String(q.shortName || q.longName || symbol);
  if (!symbol || isJunk(symbol, name)) return null;
  const pre = Number(q.preMarketPrice) || 0;
  const prevClose = Number(q.regularMarketPreviousClose) || 0;
  if (!(pre > 0) || !(prevClose > 0)) return null;
  const changePct = ((pre - prevClose) / prevClose) * 100;
  if (!(changePct > 0)) return null;
  const dayHigh = Math.max(Number(q.regularMarketDayHigh) || 0, pre);
  const dayLow = Number(q.regularMarketDayLow) || Math.min(prevClose, pre);
  const volume = Number(q.preMarketVolume) || Number(q.regularMarketVolume) || 0;
  return {
    symbol,
    name,
    last: pre,
    prevClose,
    dayHigh,
    dayLow,
    volume,
    changePct,
    floatMillions: liveFloatMillions(q),
  };
}

/**
 * Live Premarket board — Realtime gap parity.
 *
 * NEVER rank Yahoo day_gainers / Nasdaq Most Advanced regular-session % here:
 * those are yesterday's board (YXT-class) and stay elevated overnight.
 *
 * Fan-out is deliberately small: public CORS proxies cannot sustain 36–80
 * chart calls per 3s poll (that caused correct→error→wrong cycling). Quote
 * ah-discovery + sticky hot names first; only a tiny universe slice after.
 */
async function fetchPremarketGainerQuotes(): Promise<Map<string, LiveQuote>> {
  const [nasdaqSeeds, universe, discoverySeeds, screenerSeeds] = await Promise.all([
    fetchNasdaqDiscoverySymbols(),
    loadUniverseSymbols(),
    loadAhDiscoverySymbols(),
    Promise.allSettled([
      fetchYahooScreenerRaw("most_actives", 50, 12000, "critical"),
      fetchYahooScreenerRaw("small_cap_gainers", 50, 12000, "normal"),
    ]),
  ]);

  const map = new Map<string, LiveQuote>();

  // Screener rows with a real preMarketPrice only — never regularMarketPrice.
  for (const res of screenerSeeds) {
    if (res.status !== "fulfilled") continue;
    for (const q of res.value) {
      const row = premarketQuoteFromScreener(q);
      if (!row) continue;
      if (!map.has(row.symbol) || row.changePct > (map.get(row.symbol)?.changePct || 0)) {
        map.set(row.symbol, row);
      }
      if (row.changePct >= 1) pmHotSymbols.add(row.symbol);
    }
  }

  // Chart list: discovery + sticky first. Skip huge screener/universe storms.
  const prioritized: string[] = [];
  for (const s of [...discoverySeeds, ...pmHotSymbols, ...nasdaqSeeds]) {
    const sym = String(s).toUpperCase();
    if (!sym || isJunk(sym) || map.has(sym)) continue;
    prioritized.push(sym);
  }

  // Tiny rotating universe fill only after we already have some hot names
  // (or on the very first wave so we can discover). Cap hard.
  const chartMax = PM_CHART_MAX;
  if (universe.length && prioritized.length < chartMax) {
    const need = chartMax - prioritized.length;
    const slice = Math.min(need, PM_UNIVERSE_SLICE, universe.length);
    for (let i = 0; i < slice; i++) {
      const sym = universe[(pmUniverseCursor + i) % universe.length];
      if (sym && !isJunk(sym) && !map.has(sym)) prioritized.push(sym);
    }
    pmUniverseCursor = (pmUniverseCursor + slice) % universe.length;
  }

  const chartList = [...new Set(prioritized)].slice(0, chartMax);

  if (chartList.length) {
    const deadline = Date.now() + PM_CHART_BUDGET_MS;
    // First 8 discovery charts are critical; the rest are normal so they
    // cannot monopolize both queue slots and starve the next poll.
    const chartRows = await mapPool(chartList, PM_CHART_CONCURRENCY, deadline, async (symbol) => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`;
      const idx = chartList.indexOf(symbol);
      const priority = idx >= 0 && idx < 8 ? "critical" : "normal";
      let payload: unknown;
      try {
        payload = await fetchViaProxy(url, 10000, priority);
      } catch {
        try {
          payload = await fetchAhTransport(url, 8000);
        } catch {
          return null;
        }
      }
      return premarketQuoteFromChart(symbol, payload);
    });
    for (const row of chartRows) {
      if (!map.has(row.symbol) || row.changePct > (map.get(row.symbol)?.changePct || 0)) {
        map.set(row.symbol, row);
      }
      if (row.changePct >= 1) pmHotSymbols.add(row.symbol);
    }
  }

  if (pmHotSymbols.size > 80) {
    const ranked = [...map.values()]
      .filter((r) => pmHotSymbols.has(r.symbol))
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 48)
      .map((r) => r.symbol);
    pmHotSymbols.clear();
    for (const s of ranked) pmHotSymbols.add(s);
  }

  return map;
}

/** Small spark fill-in for Most Advanced runners Yahoo day_gainers missed. */
async function fetchYahooSpark(
  symbols: string[],
  forPremarket = false,
): Promise<Map<string, LiveQuote>> {
  const uniq = [...new Set(symbols)].filter(Boolean).slice(0, 30);
  if (!uniq.length) return new Map();

  const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(uniq.join(","))}&range=1d&interval=1m`;
  type SparkPayload = {
    spark?: {
      result?: Array<{
        symbol: string;
        response?: Array<{ meta?: Record<string, unknown> }>;
      }>;
    };
  };

  let data: SparkPayload | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      data = (await fetchViaProxy(url, 16000, attempt === 0 ? "critical" : "normal")) as SparkPayload;
      break;
    } catch {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 350));
    }
  }
  if (!data) {
    // Unqueued last try — do not leave Most Advanced unquoted overnight.
    try {
      data = (await fetchAhTransport(url, 12000)) as SparkPayload;
    } catch {
      return new Map();
    }
  }

  const map = new Map<string, LiveQuote>();
  for (const item of data.spark?.result || []) {
    const meta = item.response?.[0]?.meta;
    if (!meta) continue;
    const symbol = String(item.symbol || meta.symbol || "").toUpperCase();
    const prevClose = Number(meta.previousClose ?? meta.chartPreviousClose) || 0;
    const pre = Number(meta.preMarketPrice) || 0;
    const regular = Number(meta.regularMarketPrice) || 0;
    const last = forPremarket && pre > 0 ? pre : regular;
    const dayHigh = Math.max(Number(meta.regularMarketDayHigh) || 0, last);
    const dayLow = Number(meta.regularMarketDayLow) || last;
    const volume = Number(meta.regularMarketVolume) || 0;
    // Spark meta has no share count — Flt filled live below for ranked rows only.
    const row = quoteFromLastPrev(
      symbol,
      String(meta.shortName || meta.longName || symbol),
      last,
      prevClose,
      dayHigh,
      dayLow,
      volume,
      null,
    );
    if (row) map.set(symbol, row);
  }
  return map;
}

/** Regular-session quote from Yahoo chart meta (last vs previousClose — not AH). */
function regularQuoteFromChart(symbol: string, payload: unknown): LiveQuote | null {
  const meta = (
    payload as {
      chart?: { result?: Array<{ meta?: Record<string, unknown> }> };
    }
  )?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  const name = String(meta.shortName || meta.longName || symbol);
  if (isJunk(symbol, name)) return null;
  const last = Number(meta.regularMarketPrice) || 0;
  const prevClose = Number(meta.previousClose ?? meta.chartPreviousClose) || 0;
  const dayHigh = Number(meta.regularMarketDayHigh) || last;
  const dayLow = Number(meta.regularMarketDayLow) || last;
  const volume = Number(meta.regularMarketVolume) || 0;
  return quoteFromLastPrev(symbol, name, last, prevClose, dayHigh, dayLow, volume, null);
}

/**
 * Chart fill for Most Advanced symbols spark missed. Unqueued + small budget so
 * we do not starve day_gainers, but still recover YXT-class runners overnight.
 */
async function fetchRegularChartQuotes(symbols: string[]): Promise<Map<string, LiveQuote>> {
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()).filter(Boolean))].slice(0, 12);
  const map = new Map<string, LiveQuote>();
  if (!uniq.length) return map;

  const deadline = Date.now() + 6_000;
  const rows = await mapPool(uniq, 4, deadline, async (symbol) => {
    const payload = await fetchAhTransport(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`,
      8000,
    );
    return regularQuoteFromChart(symbol, payload);
  });
  for (const row of rows) map.set(row.symbol, row);
  return map;
}

/** Parse Nasdaq screener / summary marketCap values. */
function parseMarketCapDollars(v: unknown): number | null {
  if (v == null) return null;
  let s = String(v).trim().toUpperCase().replace(/[$,\s]/g, "");
  if (!s || s === "N/A" || s === "UNAVALIABLE" || s === "UNAVAILABLE" || s === "0") return null;
  let mult = 1;
  if (s.endsWith("T")) {
    mult = 1e12;
    s = s.slice(0, -1);
  } else if (s.endsWith("B")) {
    mult = 1e9;
    s = s.slice(0, -1);
  } else if (s.endsWith("M")) {
    mult = 1e6;
    s = s.slice(0, -1);
  } else if (s.endsWith("K")) {
    mult = 1e3;
    s = s.slice(0, -1);
  }
  const n = Number(s);
  if (!Number.isFinite(n) || !(n > 0)) return null;
  return n * mult;
}

/**
 * Live marketCap ($) for spark/Most-Advanced runners via small Nasdaq /summary
 * JSON (NOT the 2MB download — CORS proxies cannot carry it). Soft-fail.
 */
async function fetchLiveMarketCaps(symbols: string[]): Promise<Map<string, number>> {
  const need = [...new Set(symbols.map((s) => s.toUpperCase()).filter(Boolean))].slice(
    0,
    FLOAT_SYMBOL_MAX,
  );
  const out = new Map<string, number>();
  if (!need.length) return out;

  // Hard wall-clock budget for the whole Flt fill. Without this, 12 symbols in
  // batches of 4 at a 12s timeout each could add ~36s to a poll that is supposed
  // to complete in ~3s — the poll then overruns its own interval forever and the
  // board reads as stuck / RECONNECTING. Flt is enrichment: it must degrade, not
  // dominate. Soft-fail per symbol is already the contract (app memory §Flt).
  const deadline = Date.now() + FLOAT_TOTAL_BUDGET_MS;

  for (let i = 0; i < need.length; i += FLOAT_BATCH) {
    if (Date.now() >= deadline) break;
    const chunk = need.slice(i, i + FLOAT_BATCH);
    const remaining = Math.max(1500, deadline - Date.now());
    await Promise.all(
      chunk.map(async (symbol) => {
        try {
          const data = (await fetchViaProxy(
            `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/summary?assetclass=stocks`,
            Math.min(12000, remaining),
            "low",
          )) as {
            data?: { summaryData?: { MarketCap?: { value?: string } } };
          };
          const mcap = parseMarketCapDollars(data?.data?.summaryData?.MarketCap?.value);
          if (mcap != null) out.set(symbol, mcap);
        } catch {
          /* skip symbol */
        }
      }),
    );
  }
  return out;
}

/** Flt millions = live marketCap / this poll's live price (Realtime implied-share parity). */
function applyLiveFloatFromMcap(
  movers: StockMover[],
  marketCaps: Map<string, number>,
): StockMover[] {
  if (!marketCaps.size) return movers;
  return movers.map((m) => {
    if (m.floatMillions != null) return m;
    const mcap = marketCaps.get(m.symbol.toUpperCase());
    if (mcap == null || !(m.price > 0)) return m;
    const millions = mcap / m.price / 1_000_000;
    if (!Number.isFinite(millions) || !(millions > 0)) return m;
    return { ...m, floatMillions: millions };
  });
}

function toMover(q: LiveQuote): StockMover {
  const hodDistancePct = q.dayHigh > 0 ? ((q.dayHigh - q.last) / q.dayHigh) * 100 : 0;
  return {
    symbol: q.symbol,
    name: q.name,
    price: q.last,
    changePct: q.changePct,
    change: q.last - q.prevClose,
    volume: q.volume,
    dayHigh: q.dayHigh,
    dayLow: q.dayLow,
    prevClose: q.prevClose,
    floatMillions: q.floatMillions,
    hodDistancePct,
    hodGainPct: ((q.dayHigh - q.prevClose) / q.prevClose) * 100,
    atHod: hodDistancePct <= 2,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Rank live quotes into the displayed board.
 *
 * The previous inline filter compared `m.changePct` against a recomputation of
 * `(price - prevClose) / prevClose` — but every constructor here (`quoteFromLastPrev`,
 * `afterHoursQuoteFromRaw`, Polygon) *defines* `changePct` as exactly that expression
 * and `toMover` passes it through untouched. The comparison was therefore always
 * true: a no-op wearing the costume of a data-integrity check.
 *
 * The genuine risk it was meant to catch (STOCK_SCANNER_APP_MEMORY: "never pair a
 * Yahoo last with a Nasdaq %") is a row whose inputs are incoherent, so validate
 * the inputs themselves.
 */
function rankMovers(quotes: Iterable<LiveQuote>): StockMover[] {
  return [...quotes]
    .map(toMover)
    .filter((m) => {
      if (!(m.price > 0) || !(m.prevClose > 0)) return false;
      if (!Number.isFinite(m.changePct) || !(m.changePct > 0)) return false;
      // Guard against a % that did not come from this row's own last/prevClose.
      const recomputed = ((m.price - m.prevClose) / m.prevClose) * 100;
      return Math.abs(recomputed - m.changePct) < 0.05;
    })
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, FEED_LIMIT);
}

function polygonToLiveQuotes(
  poly: Awaited<ReturnType<typeof fetchPolygonGainerQuotes>>,
): Map<string, LiveQuote> {
  const map = new Map<string, LiveQuote>();
  for (const [sym, q] of poly) {
    map.set(sym, {
      symbol: q.symbol,
      name: q.name,
      last: q.last,
      prevClose: q.prevClose,
      dayHigh: q.dayHigh,
      dayLow: q.dayLow,
      volume: q.volume,
      changePct: q.changePct,
      floatMillions: q.floatMillions,
    });
  }
  return map;
}

export type LiveScanOptions = {
  /**
   * Build the After Hours board this poll. Defaults to true for callers that do
   * not care, but ScannerBoard passes `false` unless the AH tab is visible.
   *
   * This is NOT a cache — it simply does not fetch a board that is not on screen.
   * Building AH costs 3 extra Yahoo screener calls plus up to 12 Nasdaq /summary
   * calls per poll; running that every 3s behind the ranked board is the single
   * largest source of proxy pressure during the 16:00–20:00 ET window.
   */
  includeAfterHours?: boolean;
};

/** Live scan — no live.json, no floats.json, no last-tick paint. */
export async function fetchLiveScannerClient(
  opts: LiveScanOptions = {},
): Promise<ScannerPayload> {
  const { includeAfterHours = true } = opts;
  const session = sessionNow();

  // Once per trading morning: drop sticky extended-hours discovery so
  // yesterday's runners do not seed today's Premarket / AH boards.
  if (session === "premarket") {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    const dayKey = `${y}-${m}-${d}`;
    if (extendedHotClearedDay !== dayKey) {
      ahHotSymbols.clear();
      pmHotSymbols.clear();
      extendedHotClearedDay = dayKey;
    }
  }

  const news: NewsItem[] = [];

  // ── Premarket: dedicated live-gap board (NOT day_gainers / Most Advanced) ──
  if (session === "premarket") {
    const pmMap = await fetchPremarketGainerQuotes();
    let premarketMovers = rankMovers(pmMap.values());
    // Soft-empty: do NOT throw. UI keeps the last strong same-session board
    // instead of flashing error → wrong partial list (OPEN BUG cycle).
    if (premarketMovers.length) {
      const pmNeed = premarketMovers
        .filter((m) => m.floatMillions == null)
        .map((m) => m.symbol);
      if (pmNeed.length) {
        try {
          const marketCaps = await fetchLiveMarketCaps(pmNeed);
          premarketMovers = applyLiveFloatFromMcap(premarketMovers, marketCaps);
        } catch {
          /* leave blank */
        }
      }
    }
    return {
      session,
      updatedAt: new Date().toISOString(),
      source: "full-us-realtime",
      feedLimit: FEED_LIMIT,
      news,
      premarket: premarketMovers,
      gainers: [],
      afterhours: [],
    };
  }

  let advanced: Seed[] = [];
  let dayGainers = new Map<string, LiveQuote>();
  let dayGainerRaw: Array<Record<string, unknown>> = [];
  let yahooErr: Error | null = null;
  let polygonErr: Error | null = null;
  let sourceLabel: ScannerPayload["source"] = "full-us-realtime";

  const usePolygon = hasClientPolygonKey();

  // Ranked board first — do not let Most Advanced discovery occupy the proxy
  // queue ahead of Yahoo day_gainers (Safari Load failed / slow first paint).
  const [yahooRes, polyRes] = await Promise.allSettled([
    fetchYahooDayGainerQuotes(false),
    usePolygon ? fetchPolygonGainerQuotes(FEED_LIMIT) : Promise.resolve(null),
  ]);

  if (yahooRes.status === "fulfilled") {
    dayGainers = yahooRes.value.map;
    dayGainerRaw = yahooRes.value.raw;
  } else {
    yahooErr =
      yahooRes.reason instanceof Error
        ? yahooRes.reason
        : new Error(String(yahooRes.reason));
  }

  let polygonGainers = new Map<string, LiveQuote>();
  if (usePolygon) {
    if (polyRes.status === "fulfilled" && polyRes.value) {
      polygonGainers = polygonToLiveQuotes(polyRes.value);
    } else if (polyRes.status === "rejected") {
      polygonErr =
        polyRes.reason instanceof Error
          ? polyRes.reason
          : new Error(String(polyRes.reason));
    }
  }

  // Prefer Yahoo day_gainers when available (Flt + product parity).
  // If Yahoo CORS proxies fail: Polygon live gainers (direct CORS).
  // NEVER paint Most Advanced / spark-only as the ranked board.
  // During afterhours/closed: soft-empty Gainers (UI holds last board) so AH
  // can still seed — do not throw away the whole poll.
  let quotes: Map<string, LiveQuote> = new Map();
  if (dayGainers.size) {
    quotes = new Map(dayGainers);
    sourceLabel = "full-us-realtime";
  } else if (polygonGainers.size) {
    quotes = new Map(polygonGainers);
    sourceLabel = "polygon";
  } else if (session === "regular") {
    const detail = [yahooErr?.message, polygonErr?.message].filter(Boolean).join(" | ");
    throw new Error(
      detail ? `Live gainers unavailable: ${detail}` : "Live Yahoo day_gainers unavailable",
    );
  }

  try {
    advanced = await fetchMostAdvanced();
  } catch {
    /* discovery optional */
  }

  const missing = advanced.map((s) => s.symbol).filter((s) => !quotes.has(s));
  if (missing.length) {
    // Spark only — Flt summaries wait until after rank (fewer proxy hits).
    try {
      const spark = await fetchYahooSpark(missing, false);
      for (const [sym, q] of spark) quotes.set(sym, q);
    } catch {
      /* ranked board still valid without spark fill */
    }
  }

  // Chart fill for Most Advanced still missing after spark (proxy flake overnight).
  const stillMissing = advanced.map((s) => s.symbol).filter((s) => !quotes.has(s));
  if (stillMissing.length) {
    try {
      const charts = await fetchRegularChartQuotes(stillMissing);
      for (const [sym, q] of charts) quotes.set(sym, q);
    } catch {
      /* ranked board still valid */
    }
  }

  for (const s of advanced) {
    const q = quotes.get(s.symbol);
    if (q && (!q.name || q.name === q.symbol) && s.name) q.name = s.name;
  }

  let movers = rankMovers(quotes.values());

  // Flt for ranked rows missing share counts (spark / Polygon).
  const stillNeed = movers.filter((m) => m.floatMillions == null).map((m) => m.symbol);
  if (stillNeed.length) {
    try {
      const marketCaps = await fetchLiveMarketCaps(stillNeed);
      movers = applyLiveFloatFromMcap(movers, marketCaps);
    } catch {
      /* leave blank */
    }
  }

  // After Hours board — during 16:00–20:00 ET and overnight closed until the
  // next premarket (Yahoo still carries postMarket* on the prior session).
  // Ranked by post-market % vs regular close, not regular day_gainers %.
  // Soft-fail (never kill Gainers). Always build during the afterhours window
  // so the prior-session hold is written even if the AH tab was never opened;
  // during overnight closed, only fetch when the AH tab is on screen (hold covers the rest).
  let afterhoursMovers: StockMover[] = [];
  const wantAfterHours =
    session === "afterhours" ||
    (includeAfterHours && session === "closed");
  if (wantAfterHours) {
    try {
      const ahMap = await fetchAfterHoursGainerQuotes(
        dayGainerRaw,
        advanced.map((s) => s.symbol),
      );
      afterhoursMovers = rankMovers(ahMap.values());

      const ahNeed = afterhoursMovers
        .filter((m) => m.floatMillions == null)
        .map((m) => m.symbol);
      if (ahNeed.length) {
        try {
          const marketCaps = await fetchLiveMarketCaps(ahNeed);
          afterhoursMovers = applyLiveFloatFromMcap(afterhoursMovers, marketCaps);
        } catch {
          /* leave blank */
        }
      }
    } catch {
      afterhoursMovers = [];
    }
  }

  // During regular: require a real ranked board. During afterhours/closed the
  // Gainers tab is prior-session hold territory — soft-empty so AH can still
  // seed/refresh and UI keeps held Gainers rows (do not throw away the day).
  if (session === "regular" && movers.length < 3) {
    throw new Error(`Live quotes unavailable (${movers.length})`);
  }

  // News is polled separately in ScannerBoard (live, soft-fail) so the 3s
  // gainers path does not burn proxies on multi-query news fetches.

  return {
    session,
    updatedAt: new Date().toISOString(),
    source: sourceLabel,
    feedLimit: FEED_LIMIT,
    news,
    // Premarket is built on the early-return path above during 4:00–9:30 ET.
    premarket: [],
    // Gainers: regular live; afterhours/closed may be empty (UI holds last board).
    gainers: movers,
    // After Hours also clears at premarket — do not carry overnight AH into 4:00 AM.
    afterhours: afterhoursMovers,
  };
}

/** @deprecated Do not use for live gainers UI — violates STOCK_SCANNER_APP_MEMORY.md */
export function liveJsonUrl(): string {
  const base = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
  return `${base}/data/live.json?t=${Date.now()}`;
}

/** @deprecated Do not use for live gainers UI — violates STOCK_SCANNER_APP_MEMORY.md */
export async function fetchSnapshotFeed(): Promise<ScannerPayload> {
  throw new Error("Snapshot feed disabled — live API only (STOCK_SCANNER_APP_MEMORY.md)");
}
