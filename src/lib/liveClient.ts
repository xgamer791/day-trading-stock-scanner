/**
 * LIVE-ONLY client feed (APP_MEMORY.md).
 *
 * Hot path every ~3s (keeps CORS proxies alive):
 *  1) Discover candidates: Nasdaq Most Advanced + Yahoo day_gainers
 *     (+ occasional Nasdaq download for breadth beyond Most Advanced's ~20)
 *  2) Yahoo spark batches (last + prevClose from same meta)
 *  3) Rank by same-quote % — top 50
 *
 * Full 10k screener is NOT polled every tick (rate-limits proxies ~20s in).
 * NEVER reads live.json for mover rows.
 * Discovery candidate list is NOT painted as LIVE % — only used to choose symbols to quote.
 */
import type { NewsItem, ScannerPayload, StockMover } from "@/lib/types";

const FEED_LIMIT = 50;
const SPARK_BATCH = 40;
const MAX_QUOTE_SYMBOLS = 120;
/** How often to refresh broad screener symbol candidates (discovery only). */
const CANDIDATE_REFRESH_MS = 45_000;

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
async function fetchViaProxy(url: string, timeoutMs = 7000): Promise<unknown> {
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
      return JSON.parse(text);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr || new Error("All live proxies failed");
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

type Seed = { symbol: string; name: string; priority: number };

async function fetchMostAdvanced(): Promise<Seed[]> {
  const data = (await fetchViaProxy(
    "https://api.nasdaq.com/api/marketmovers?assetclass=stocks&limit=50",
    7000,
  )) as {
    data?: { STOCKS?: { MostAdvanced?: { table?: { rows?: Array<Record<string, string>> } } } };
  };
  const rows = data?.data?.STOCKS?.MostAdvanced?.table?.rows || [];
  const out: Seed[] = [];
  let i = 0;
  for (const r of rows) {
    if (isJunk(r.symbol, r.name)) continue;
    if (!(parseMoney(r.change) > 0)) continue;
    out.push({
      symbol: String(r.symbol).replace("/", "-").toUpperCase(),
      name: r.name || r.symbol,
      // Highest priority — these are the live runners Most Advanced surfaces.
      priority: 1_000_000 - i,
    });
    i += 1;
  }
  return out;
}

/** Backup + breadth: Yahoo predefined day_gainers (up to 100). */
async function fetchYahooDayGainerSymbols(): Promise<Seed[]> {
  const data = (await fetchViaProxy(
    "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=100&scrIds=day_gainers&formatted=false",
    7000,
  )) as {
    finance?: {
      result?: Array<{
        quotes?: Array<{
          symbol?: string;
          shortName?: string;
          longName?: string;
          regularMarketChangePercent?: number;
        }>;
      }>;
    };
  };
  const quotes = data?.finance?.result?.[0]?.quotes || [];
  return quotes
    .map((q) => ({
      symbol: String(q.symbol || "")
        .replace("/", "-")
        .toUpperCase(),
      name: q.shortName || q.longName || q.symbol || "",
      priority: Number(q.regularMarketChangePercent) || 0,
    }))
    .filter((s) => s.symbol && !isJunk(s.symbol, s.name));
}

/**
 * Broad US screener for symbols beyond Most Advanced's ~20-name cap.
 * pctchange is used ONLY to prioritize which symbols to quote — never displayed.
 */
async function fetchNasdaqDownloadCandidates(): Promise<Seed[]> {
  const data = (await fetchViaProxy(
    "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true",
    14000,
  )) as {
    data?: { rows?: Array<Record<string, string>> };
  };
  const rows = data?.data?.rows || [];
  const seeds: Seed[] = [];
  for (const r of rows) {
    const symbol = String(r.symbol || "")
      .replace("/", "-")
      .toUpperCase();
    const name = r.name || symbol;
    if (!symbol || isJunk(symbol, name)) continue;
    const pct = parseMoney(r.pctchange);
    if (!(pct > 0)) continue;
    seeds.push({ symbol, name, priority: pct });
  }
  seeds.sort((a, b) => b.priority - a.priority);
  return seeds.slice(0, MAX_QUOTE_SYMBOLS);
}

/** Discovery-only candidate pool (not painted as LIVE %). */
let broadCandidates: Seed[] = [];
let broadCandidatesAt = 0;

async function refreshBroadCandidatesIfNeeded(): Promise<void> {
  const stale = Date.now() - broadCandidatesAt > CANDIDATE_REFRESH_MS;
  if (!stale && broadCandidates.length >= FEED_LIMIT) return;
  try {
    const next = await fetchNasdaqDownloadCandidates();
    if (next.length) {
      broadCandidates = next;
      broadCandidatesAt = Date.now();
    }
  } catch {
    /* keep prior discovery candidates; quotes stay live */
  }
}

async function discoverSymbols(): Promise<Seed[]> {
  const bySym = new Map<string, Seed>();

  const merge = (seeds: Seed[]) => {
    for (const s of seeds) {
      const prev = bySym.get(s.symbol);
      if (!prev || s.priority > prev.priority) bySym.set(s.symbol, s);
    }
  };

  // Hot discovery every poll (Most Advanced ≈ 20 names).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const advanced = await fetchMostAdvanced();
      if (advanced.length) {
        merge(advanced);
        break;
      }
    } catch {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
    }
  }

  try {
    merge(await fetchYahooDayGainerSymbols());
  } catch {
    /* optional breadth */
  }

  // Occasional full-screener symbol list so we can fill top 50 beyond Most Advanced.
  await refreshBroadCandidatesIfNeeded();
  merge(broadCandidates);

  const seeds = [...bySym.values()].sort((a, b) => b.priority - a.priority);
  if (!seeds.length) throw new Error("Live discovery returned no US gainers");
  return seeds.slice(0, MAX_QUOTE_SYMBOLS);
}

type SparkQuote = {
  symbol: string;
  name: string;
  last: number;
  prevClose: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  changePct: number;
};

async function fetchYahooSparkBatch(symbols: string[]): Promise<Map<string, SparkQuote>> {
  const uniq = [...new Set(symbols)].filter(Boolean);
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
  if (!data) throw new Error("Live Yahoo spark failed");

  const map = new Map<string, SparkQuote>();
  for (const item of data.spark?.result || []) {
    const meta = item.response?.[0]?.meta;
    if (!meta) continue;
    const symbol = String(item.symbol || meta.symbol || "").toUpperCase();
    const last = Number(meta.regularMarketPrice) || 0;
    const prevClose = Number(meta.previousClose ?? meta.chartPreviousClose) || 0;
    if (!(last > 0) || !(prevClose > 0)) continue;
    const dayHigh = Number(meta.regularMarketDayHigh) || last;
    const dayLow = Number(meta.regularMarketDayLow) || last;
    const volume = Number(meta.regularMarketVolume) || 0;
    const changePct = ((last - prevClose) / prevClose) * 100;
    if (!(changePct > 0)) continue;
    map.set(symbol, {
      symbol,
      name: String(meta.shortName || meta.longName || symbol),
      last,
      prevClose,
      dayHigh: Math.max(dayHigh, last),
      dayLow,
      volume,
      changePct,
    });
  }
  return map;
}

async function fetchYahooSpark(symbols: string[]): Promise<Map<string, SparkQuote>> {
  const uniq = [...new Set(symbols)].filter(Boolean).slice(0, MAX_QUOTE_SYMBOLS);
  const map = new Map<string, SparkQuote>();
  for (let i = 0; i < uniq.length; i += SPARK_BATCH) {
    const chunk = uniq.slice(i, i + SPARK_BATCH);
    const part = await fetchYahooSparkBatch(chunk);
    for (const [k, v] of part) map.set(k, v);
  }
  if (!map.size) throw new Error("Live Yahoo spark failed");
  return map;
}

function toMover(q: SparkQuote): StockMover {
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
  const seeds = await discoverSymbols();
  const quotes = await fetchYahooSpark(seeds.map((s) => s.symbol));

  for (const s of seeds) {
    const q = quotes.get(s.symbol);
    if (q && (!q.name || q.name === q.symbol) && s.name) q.name = s.name;
  }

  const movers = [...quotes.values()]
    .map(toMover)
    .filter((m) => {
      const recomputed = ((m.price - m.prevClose) / m.prevClose) * 100;
      return Math.abs(recomputed - m.changePct) < 0.05;
    })
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, FEED_LIMIT);

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
