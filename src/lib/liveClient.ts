/**
 * LIVE-ONLY client feed (APP_MEMORY.md).
 *
 * Hot path every ~3s (keeps CORS proxies alive):
 *  1) Nasdaq Most Advanced (small discovery — Realtime runners)
 *  2) Yahoo day_gainers (up to 100) — last + prevClose from SAME payload
 *  3) Yahoo spark ONLY for Most Advanced symbols missing from day_gainers
 *  4) Rank by same-quote % — top 50
 *  5) Attach Flt (Yahoo impliedSharesOutstanding → millions; Realtime parity)
 *
 * Do NOT multi-batch spark 100+ symbols or download the 10k screener every tick —
 * that rate-limits CORS proxies and surfaces "Live Yahoo spark failed".
 * NEVER reads live.json for mover price/%Chg/volume rows.
 * floats.json is allowed for the Flt column only (fundamentals, not a price cache).
 */
import type { NewsItem, ScannerPayload, StockMover } from "@/lib/types";

const FEED_LIMIT = 50;
const FLOAT_FILE_REFRESH_MS = 30_000;

function bust(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function proxyUrls(url: string): string[] {
  const live = bust(url);
  const enc = encodeURIComponent(live);
  return [
    `https://corsproxy.io/?${enc}`,
    `https://api.allorigins.win/raw?url=${enc}`,
    `https://api.codetabs.com/v1/proxy?quest=${enc}`,
  ];
}

/** Sequential proxies — racing all three every 3s burns quota and dies ~20s in. */
async function fetchTextViaProxy(url: string, timeoutMs = 7000): Promise<string> {
  let lastErr: Error | null = null;
  for (const p of proxyUrls(url)) {
    try {
      const res = await fetch(p, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        lastErr = new Error(`proxy ${res.status}`);
        continue;
      }
      const text = await res.text();
      if (text.trimStart().startsWith("<")) {
        lastErr = new Error("proxy HTML");
        continue;
      }
      return text;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr || new Error("All live proxies failed");
}

async function fetchViaProxy(url: string, timeoutMs = 7000): Promise<unknown> {
  return JSON.parse(await fetchTextViaProxy(url, timeoutMs));
}

/** In-memory Realtime-parity Flt (millions). Fundamentals — not used as live price/%. */
const floatCache = new Map<string, number>();
let floatFileAt = 0;
let floatFileSource: string | null = null;
let yahooCrumb: string | null = null;
let yahooCrumbAt = 0;

function rawShares(v: unknown): number | null {
  const n = typeof v === "object" && v != null ? Number((v as { raw?: number }).raw) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Realtime Flt: impliedSharesOutstanding → sharesOutstanding → floatShares. */
function realtimeFloatShares(ks: Record<string, unknown> | undefined): number | null {
  if (!ks) return null;
  return (
    rawShares(ks.impliedSharesOutstanding) ??
    rawShares(ks.sharesOutstanding) ??
    rawShares(ks.floatShares)
  );
}

function floatsJsonUrl(): string {
  const base = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
  return `${base}/data/floats.json?t=${Date.now()}`;
}

async function refreshFloatFile(): Promise<void> {
  if (
    Date.now() - floatFileAt < FLOAT_FILE_REFRESH_MS &&
    floatCache.size &&
    floatFileSource === "yahoo-impliedSharesOutstanding"
  ) {
    return;
  }
  try {
    const res = await fetch(floatsJsonUrl(), {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { floats?: Record<string, number>; source?: string };
    // Ignore legacy floatShares file so ADR floats are not stuck understated.
    if (data?.source && data.source !== "yahoo-impliedSharesOutstanding") return;
    const floats = data?.floats || {};
    floatCache.clear();
    for (const [sym, v] of Object.entries(floats)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) floatCache.set(String(sym).toUpperCase(), n);
    }
    floatFileAt = Date.now();
    floatFileSource = data?.source || "yahoo-impliedSharesOutstanding";
  } catch {
    /* floats file optional until Actions publishes it */
  }
}

async function ensureYahooCrumb(): Promise<string | null> {
  if (yahooCrumb && Date.now() - yahooCrumbAt < 10 * 60_000) return yahooCrumb;
  try {
    // Seed cookies on the proxy hop (best-effort; some proxies strip Set-Cookie).
    await fetchTextViaProxy("https://fc.yahoo.com", 5000).catch(() => "");
    const crumb = (await fetchTextViaProxy("https://query2.finance.yahoo.com/v1/test/getcrumb", 6000)).trim();
    if (!crumb || crumb.length > 40 || crumb.includes("<") || crumb.includes("{")) {
      return null;
    }
    yahooCrumb = crumb;
    yahooCrumbAt = Date.now();
    return crumb;
  } catch {
    yahooCrumb = null;
    return null;
  }
}

/** Live Yahoo Flt for symbols missing from floats.json (max few per poll). */
async function fetchMissingFloats(symbols: string[]): Promise<void> {
  const need = [...new Set(symbols.map((s) => s.toUpperCase()))].filter((s) => !floatCache.has(s)).slice(0, 8);
  if (!need.length) return;

  const crumb = await ensureYahooCrumb();
  if (!crumb) return;

  await Promise.all(
    need.map(async (sym) => {
      try {
        const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
          sym,
        )}?modules=defaultKeyStatistics&crumb=${encodeURIComponent(crumb)}`;
        const data = (await fetchViaProxy(url, 7000)) as {
          quoteSummary?: {
            result?: Array<{ defaultKeyStatistics?: Record<string, unknown> }>;
          };
        };
        const ks = data?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
        const raw = realtimeFloatShares(ks);
        if (raw != null) floatCache.set(sym, raw / 1_000_000);
      } catch {
        /* keep empty for this symbol */
      }
    }),
  );
}

async function attachFloats(movers: StockMover[]): Promise<StockMover[]> {
  await refreshFloatFile();
  await fetchMissingFloats(movers.map((m) => m.symbol));
  return movers.map((m) => ({
    ...m,
    floatMillions: floatCache.get(m.symbol.toUpperCase()) ?? m.floatMillions ?? null,
  }));
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
};

function quoteFromLastPrev(
  symbol: string,
  name: string,
  last: number,
  prevClose: number,
  dayHigh: number,
  dayLow: number,
  volume: number,
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
  };
}

async function fetchMostAdvanced(): Promise<Seed[]> {
  const data = (await fetchViaProxy(
    "https://api.nasdaq.com/api/marketmovers?assetclass=stocks&limit=50",
    7000,
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
 * Primary quote source: Yahoo day_gainers includes last + previousClose
 * on the same payload — %Chg matches TradingView/Realtime math without spark.
 */
async function fetchYahooDayGainerQuotes(): Promise<Map<string, LiveQuote>> {
  const data = (await fetchViaProxy(
    "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=100&scrIds=day_gainers&formatted=false",
    8000,
  )) as {
    finance?: {
      result?: Array<{
        quotes?: Array<Record<string, unknown>>;
      }>;
    };
  };
  const quotes = data?.finance?.result?.[0]?.quotes || [];
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
    const row = quoteFromLastPrev(symbol, name, last, prevClose, dayHigh, dayLow, volume);
    if (row) map.set(symbol, row);
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
      data = (await fetchViaProxy(url, 8000)) as SparkPayload;
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
    const row = quoteFromLastPrev(
      symbol,
      String(meta.shortName || meta.longName || symbol),
      last,
      prevClose,
      dayHigh,
      dayLow,
      volume,
    );
    if (row) map.set(symbol, row);
  }
  return map;
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
    floatMillions: null,
    hodDistancePct,
    hodGainPct: ((q.dayHigh - q.prevClose) / q.prevClose) * 100,
    atHod: hodDistancePct <= 2,
    updatedAt: new Date().toISOString(),
  };
}

/** Live scan — no live.json. */
export async function fetchLiveScannerClient(): Promise<ScannerPayload> {
  const session = sessionNow();

  // Prefer day_gainers quotes (one request, up to 100 same-quote rows).
  // Most Advanced in parallel for runner discovery only.
  let advanced: Seed[] = [];
  let quotes = new Map<string, LiveQuote>();
  let yahooErr: Error | null = null;
  let advancedErr: Error | null = null;

  const [advRes, yahooRes] = await Promise.allSettled([
    fetchMostAdvanced(),
    fetchYahooDayGainerQuotes(),
  ]);

  if (advRes.status === "fulfilled") advanced = advRes.value;
  else advancedErr = advRes.reason instanceof Error ? advRes.reason : new Error(String(advRes.reason));

  if (yahooRes.status === "fulfilled") quotes = yahooRes.value;
  else yahooErr = yahooRes.reason instanceof Error ? yahooRes.reason : new Error(String(yahooRes.reason));

  // Fill runners Yahoo's day_gainers list omitted (small spark ≤30 symbols).
  const missing = advanced.map((s) => s.symbol).filter((s) => !quotes.has(s));
  if (missing.length) {
    const spark = await fetchYahooSpark(missing);
    for (const [sym, q] of spark) quotes.set(sym, q);
  }

  // If day_gainers failed entirely, spark Most Advanced so the board still lives.
  if (!quotes.size && advanced.length) {
    quotes = await fetchYahooSpark(advanced.map((s) => s.symbol));
  }

  for (const s of advanced) {
    const q = quotes.get(s.symbol);
    if (q && (!q.name || q.name === q.symbol) && s.name) q.name = s.name;
  }

  if (!quotes.size) {
    throw yahooErr || advancedErr || new Error("Live Yahoo spark failed");
  }

  const ranked = [...quotes.values()]
    .map(toMover)
    .filter((m) => {
      const recomputed = ((m.price - m.prevClose) / m.prevClose) * 100;
      return Math.abs(recomputed - m.changePct) < 0.05;
    })
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, FEED_LIMIT);

  // Flt = Yahoo impliedSharesOutstanding (Realtime parity), millions.
  const movers = await attachFloats(ranked);

  if (session !== "premarket" && session !== "closed" && movers.length < 3) {
    throw new Error(`Live quotes unavailable (${movers.length})`);
  }

  const news: NewsItem[] = [];

  return {
    session,
    updatedAt: new Date().toISOString(),
    source: "full-us-realtime",
    feedLimit: FEED_LIMIT,
    news,
    premarket: session === "closed" ? [] : movers,
    gainers: session === "premarket" || session === "closed" ? [] : movers,
  };
}

/** @deprecated Do not use for live gainers UI — violates APP_MEMORY.md */
export function liveJsonUrl(): string {
  const base = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
  return `${base}/data/live.json?t=${Date.now()}`;
}

/** @deprecated Do not use for live gainers UI — violates APP_MEMORY.md */
export async function fetchSnapshotFeed(): Promise<ScannerPayload> {
  throw new Error("Snapshot feed disabled — live API only (APP_MEMORY.md)");
}
