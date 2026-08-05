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
 *  5) Live Flt for ranked spark/Polygon rows via small Nasdaq quote summary
 *  6) Rank by same-quote % — top 50
 *  7) After Hours (16:00–20:00 ET only): rank by post-market % vs regular close
 *     from live Yahoo screener payloads — NOT regular day_gainers %
 *
 * If BOTH Yahoo day_gainers and Polygon fail: throw / RECONNECTING.
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
  const data = (await fetchViaProxy(
    "https://api.nasdaq.com/api/marketmovers?assetclass=stocks&limit=50",
    14000,
    "normal",
  )) as {
    data?: { STOCKS?: { MostAdvanced?: { table?: { rows?: Array<Record<string, string>> } } } };
  };
  const rows = data?.data?.STOCKS?.MostAdvanced?.table?.rows || [];
  const out: Seed[] = [];
  for (const r of rows) {
    if (isJunk(r.symbol, r.name)) continue;
    if (!(parseMoney(r.change) > 0)) continue;
    out.push({
      symbol: String(r.symbol).replace("/", "-").toUpperCase(),
      name: r.name || r.symbol,
    });
  }
  return out;
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

async function fetchYahooDayGainerQuotes(): Promise<{
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
    const last = Number(q.regularMarketPrice) || 0;
    const prevClose = Number(q.regularMarketPreviousClose) || 0;
    const dayHigh = Number(q.regularMarketDayHigh) || last;
    const dayLow = Number(q.regularMarketDayLow) || last;
    const volume = Number(q.regularMarketVolume) || 0;
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
 * After-hours top gainers: % from regular-session close → postMarketPrice.
 * NOT regular day_gainers ranking. Live Yahoo payloads only (STOCK_SCANNER_APP_MEMORY).
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

async function fetchAfterHoursGainerQuotes(
  dayGainerRaw: Array<Record<string, unknown>>,
): Promise<Map<string, LiveQuote>> {
  // Broaden beyond day_gainers — AH winners are often flat/down on the day.
  const extraIds = ["most_actives", "day_losers", "small_cap_gainers"] as const;
  const extras = await Promise.allSettled(
    extraIds.map((id) => fetchYahooScreenerRaw(id, 100, 16000, "normal")),
  );

  const rawMap = new Map<string, Record<string, unknown>>();
  for (const q of dayGainerRaw) {
    const s = String(q.symbol || "")
      .replace("/", "-")
      .toUpperCase();
    if (s) rawMap.set(s, q);
  }
  for (const res of extras) {
    if (res.status !== "fulfilled") continue;
    for (const q of res.value) {
      const s = String(q.symbol || "")
        .replace("/", "-")
        .toUpperCase();
      if (!s) continue;
      const prev = rawMap.get(s);
      // Prefer the quote that carries a live postMarketPrice.
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
  return map;
}

/** Small spark fill-in for Most Advanced runners Yahoo day_gainers missed. */
async function fetchYahooSpark(symbols: string[]): Promise<Map<string, LiveQuote>> {
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
      data = (await fetchViaProxy(url, 16000, "normal")) as SparkPayload;
      break;
    } catch {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 350));
    }
  }
  if (!data) return new Map();

  const map = new Map<string, LiveQuote>();
  for (const item of data.spark?.result || []) {
    const meta = item.response?.[0]?.meta;
    if (!meta) continue;
    const symbol = String(item.symbol || meta.symbol || "").toUpperCase();
    const last = Number(meta.regularMarketPrice) || 0;
    const prevClose = Number(meta.previousClose ?? meta.chartPreviousClose) || 0;
    const dayHigh = Number(meta.regularMarketDayHigh) || last;
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

  for (let i = 0; i < need.length; i += FLOAT_BATCH) {
    const chunk = need.slice(i, i + FLOAT_BATCH);
    await Promise.all(
      chunk.map(async (symbol) => {
        try {
          const data = (await fetchViaProxy(
            `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/summary?assetclass=stocks`,
            12000,
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

/** Live scan — no live.json, no floats.json, no last-tick paint. */
export async function fetchLiveScannerClient(): Promise<ScannerPayload> {
  const session = sessionNow();

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
    fetchYahooDayGainerQuotes(),
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
  let quotes: Map<string, LiveQuote>;
  if (dayGainers.size) {
    quotes = new Map(dayGainers);
    sourceLabel = "full-us-realtime";
  } else if (polygonGainers.size) {
    quotes = new Map(polygonGainers);
    sourceLabel = "polygon";
  } else {
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
      const spark = await fetchYahooSpark(missing);
      for (const [sym, q] of spark) quotes.set(sym, q);
    } catch {
      /* ranked board still valid without spark fill */
    }
  }

  for (const s of advanced) {
    const q = quotes.get(s.symbol);
    if (q && (!q.name || q.name === q.symbol) && s.name) q.name = s.name;
  }

  let movers = [...quotes.values()]
    .map(toMover)
    .filter((m) => {
      const recomputed = ((m.price - m.prevClose) / m.prevClose) * 100;
      return Math.abs(recomputed - m.changePct) < 0.05;
    })
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, FEED_LIMIT);

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

  // After Hours board — only during 16:00–20:00 ET. Ranked by post-market %
  // vs regular close, not regular day_gainers %. Soft-fail (never kill Gainers).
  let afterhoursMovers: StockMover[] = [];
  if (session === "afterhours") {
    try {
      const ahMap = await fetchAfterHoursGainerQuotes(dayGainerRaw);
      afterhoursMovers = [...ahMap.values()]
        .map(toMover)
        .filter((m) => {
          const recomputed = ((m.price - m.prevClose) / m.prevClose) * 100;
          return Math.abs(recomputed - m.changePct) < 0.05;
        })
        .sort((a, b) => b.changePct - a.changePct)
        .slice(0, FEED_LIMIT);

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

  if (session !== "premarket" && session !== "closed" && movers.length < 3) {
    throw new Error(`Live quotes unavailable (${movers.length})`);
  }

  // News is polled separately in ScannerBoard (live, soft-fail) so the 3s
  // gainers path does not burn proxies on multi-query news fetches.
  const news: NewsItem[] = [];

  return {
    session,
    updatedAt: new Date().toISOString(),
    source: sourceLabel,
    feedLimit: FEED_LIMIT,
    news,
    // Premarket tab: live gaps/gainers during the premarket window only.
    premarket: session === "premarket" ? movers : [],
    // Gainers tab: regular-session day gainers (also visible into afterhours as the day's board).
    gainers: session === "premarket" || session === "closed" ? [] : movers,
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
