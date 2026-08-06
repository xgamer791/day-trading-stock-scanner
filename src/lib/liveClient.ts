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
import { currentTradingDayStartEt } from "@/lib/market";
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

/* ------------------------------------------------------------------ *
 * Trading-day freshness
 *
 * Yahoo keeps `preMarketPrice` / `postMarketPrice` in the payload after their
 * sessions end, which is what lets a finished board stay on screen without any
 * caching on our side. But "still present" is not the same as "from today" —
 * a stale field left over from a previous day must not be painted as this day's
 * board. Every board is therefore gated on its own `*Time` stamp falling inside
 * the current trading day (04:00 ET → next 04:00 ET, weekends roll back).
 *
 * This reads a timestamp out of a freshly-fetched payload. It is not a cache.
 * ------------------------------------------------------------------ */

/** Yahoo `*Time` fields are epoch seconds; tolerate ms and ISO strings too. */
function quoteTimeMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  // < 1e12 means seconds, not milliseconds.
  return n < 1e12 ? n * 1000 : n;
}

/**
 * True when this quote's session timestamp belongs to the current trading day.
 *
 * Missing timestamp → treated as fresh. Yahoo omits `*Time` on some rows, and
 * blanking an otherwise valid board because one field is absent is worse than
 * showing it; the price fields themselves are still validated downstream.
 */
function sessionTimeOk(q: Record<string, unknown>, field: string): boolean {
  const ms = quoteTimeMs(q[field]);
  if (ms == null) return true;
  return ms >= currentTradingDayStartEt().getTime();
}

/**
 * Premarket top gainers: % from the prior regular close → preMarketPrice.
 *
 * Mirror of `afterHoursQuoteFromRaw`. In both windows `regularMarketPrice` is the
 * most recent completed regular-session close, so it is the correct baseline:
 * during premarket it is yesterday's close, during post-market it is today's.
 *
 * This is the board the Premarket tab should always have shown. It previously
 * reused the regular-session ranking, whose % during premarket is yesterday's
 * move, not this morning's.
 */
function preMarketQuoteFromRaw(q: Record<string, unknown>): LiveQuote | null {
  const symbol = String(q.symbol || "")
    .replace("/", "-")
    .toUpperCase();
  const name = String(q.shortName || q.longName || symbol);
  if (!symbol || isJunk(symbol, name)) return null;
  if (!sessionTimeOk(q, "preMarketTime")) return null;

  const pre = Number(q.preMarketPrice) || 0;
  const regular = Number(q.regularMarketPrice) || 0;
  if (!(pre > 0) || !(regular > 0)) return null;

  // Same-payload math — never Yahoo's own preMarketChangePercent field.
  const changePct = ((pre - regular) / regular) * 100;
  if (!(changePct > 0)) return null;

  return {
    symbol,
    name,
    last: pre,
    prevClose: regular,
    dayHigh: Math.max(regular, pre),
    dayLow: Math.min(regular, pre),
    volume: Number(q.preMarketVolume) || Number(q.regularMarketVolume) || 0,
    changePct,
    floatMillions: liveFloatMillions(q),
  };
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

  if (!sessionTimeOk(q, "postMarketTime")) return null;

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

/**
 * Broaden beyond day_gainers.
 *
 * Premarket and after-hours winners are frequently flat or down on the regular
 * session, so neither board can be built from day_gainers alone. Both need the
 * same widened symbol set, so this is fetched **once per poll** and shared —
 * three extra screener calls total, not three per board.
 */
async function fetchExtraScreenerRaw(): Promise<Array<Record<string, unknown>>> {
  const extraIds = ["most_actives", "day_losers", "small_cap_gainers"] as const;
  const extras = await Promise.allSettled(
    extraIds.map((id) => fetchYahooScreenerRaw(id, 100, 16000, "normal")),
  );
  const out: Array<Record<string, unknown>> = [];
  for (const res of extras) {
    if (res.status === "fulfilled") out.push(...res.value);
  }
  return out;
}

/**
 * Merge day_gainers with the widened set, preferring whichever quote actually
 * carries a price for the session being built.
 */
function mergeRawBySession(
  dayGainerRaw: Array<Record<string, unknown>>,
  extraRaw: Array<Record<string, unknown>>,
  priceField: "preMarketPrice" | "postMarketPrice",
): Map<string, Record<string, unknown>> {
  const rawMap = new Map<string, Record<string, unknown>>();
  for (const q of dayGainerRaw) {
    const s = String(q.symbol || "")
      .replace("/", "-")
      .toUpperCase();
    if (s) rawMap.set(s, q);
  }
  for (const q of extraRaw) {
    const s = String(q.symbol || "")
      .replace("/", "-")
      .toUpperCase();
    if (!s) continue;
    const prev = rawMap.get(s);
    if (!prev || (Number(q[priceField]) > 0 && !(Number(prev[priceField]) > 0))) {
      rawMap.set(s, q);
    }
  }
  return rawMap;
}

function buildPreMarketQuotes(
  dayGainerRaw: Array<Record<string, unknown>>,
  extraRaw: Array<Record<string, unknown>>,
): Map<string, LiveQuote> {
  const map = new Map<string, LiveQuote>();
  for (const q of mergeRawBySession(dayGainerRaw, extraRaw, "preMarketPrice").values()) {
    const row = preMarketQuoteFromRaw(q);
    if (row) map.set(row.symbol, row);
  }
  return map;
}

function buildAfterHoursQuotes(
  dayGainerRaw: Array<Record<string, unknown>>,
  extraRaw: Array<Record<string, unknown>>,
): Map<string, LiveQuote> {
  const map = new Map<string, LiveQuote>();
  for (const q of mergeRawBySession(dayGainerRaw, extraRaw, "postMarketPrice").values()) {
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

export type ScannerBoardId = "premarket" | "gainers" | "afterhours";

export type LiveScanOptions = {
  /**
   * Which boards are on screen this poll. Defaults to all three for callers that
   * do not care; ScannerBoard passes just the visible tab.
   *
   * This is NOT a cache — it simply does not fetch a board nothing is displaying.
   * Premarket and After Hours share one widened screener fetch, but that is still
   * 3 extra Yahoo calls plus up to 12 Nasdaq /summary calls per poll on top of the
   * ranked board; running those every 3s unconditionally is what caused the
   * 2026-08-05 proxy starvation.
   */
  boards?: ScannerBoardId[];
};

/** Live scan — no live.json, no floats.json, no last-tick paint. */
export async function fetchLiveScannerClient(
  opts: LiveScanOptions = {},
): Promise<ScannerPayload> {
  const { boards = ["premarket", "gainers", "afterhours"] } = opts;
  const wantPre = boards.includes("premarket");
  const wantAh = boards.includes("afterhours");
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

  /*
   * Premarket + After Hours boards.
   *
   * Built whenever their tab is on screen and their data belongs to the current
   * trading day — NOT only during their live window. Yahoo keeps preMarketPrice /
   * postMarketPrice in the payload after the session ends, so a finished board keeps
   * rendering from each fresh poll rather than from anything we stored. The
   * per-row `sessionTimeOk` guard is what clears them at the next 04:00 ET premarket
   * open. Both soft-fail: neither may ever kill the ranked Gainers board.
   */
  let premarketMovers: StockMover[] = [];
  let afterhoursMovers: StockMover[] = [];

  if (wantPre || wantAh) {
    try {
      // One widened fetch shared by both session boards.
      const extraRaw = await fetchExtraScreenerRaw();

      if (wantPre) {
        premarketMovers = rankMovers(buildPreMarketQuotes(dayGainerRaw, extraRaw).values());
      }
      if (wantAh) {
        afterhoursMovers = rankMovers(buildAfterHoursQuotes(dayGainerRaw, extraRaw).values());
      }

      // Flt enrichment for whichever session boards are on screen, under the
      // existing shared wall-clock budget.
      const sessionNeed = [...premarketMovers, ...afterhoursMovers]
        .filter((m) => m.floatMillions == null)
        .map((m) => m.symbol);
      if (sessionNeed.length) {
        try {
          const marketCaps = await fetchLiveMarketCaps(sessionNeed);
          if (premarketMovers.length) {
            premarketMovers = applyLiveFloatFromMcap(premarketMovers, marketCaps);
          }
          if (afterhoursMovers.length) {
            afterhoursMovers = applyLiveFloatFromMcap(afterhoursMovers, marketCaps);
          }
        } catch {
          /* leave blank */
        }
      }
    } catch {
      premarketMovers = [];
      afterhoursMovers = [];
    }
  }

  if (session !== "premarket" && session !== "closed" && movers.length < 3) {
    throw new Error(`Live quotes unavailable (${movers.length})`);
  }

  // News is polled separately in ScannerBoard (live, soft-fail) so the 3s
  // gainers path does not burn proxies on multi-query news fetches.
  const news: NewsItem[] = [];

  /*
   * All three boards stay populated for the whole trading day.
   *
   * The Gainers board is gated on the regular session having actually happened
   * today — before 09:30 the day_gainers % is still yesterday's move, and showing
   * that as "today's gainers" was the old premarket bug in reverse.
   */
  const regularToday = dayGainerRaw.some((q) => sessionTimeOk(q, "regularMarketTime"));
  const showGainers = session !== "premarket" && regularToday;

  return {
    session,
    updatedAt: new Date().toISOString(),
    source: sourceLabel,
    feedLimit: FEED_LIMIT,
    news,
    premarket: premarketMovers,
    gainers: showGainers ? movers : [],
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
