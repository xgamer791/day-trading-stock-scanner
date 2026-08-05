/**
 * LIVE-ONLY client feed (APP_MEMORY.md — read before every edit).
 *
 * Every ~3s poll (no mover-row cache):
 *  1) Nasdaq Most Advanced (discovery)
 *  2) Yahoo day_gainers — price, prevClose, volume, impliedSharesOutstanding
 *     from the SAME live payload
 *  3) Yahoo spark ONLY for Most Advanced symbols missing from day_gainers (≤30)
 *  4) Rank by same-quote % — top 50
 *
 * FORBIDDEN: live.json, floats.json, last-tick-as-LIVE, localStorage, etc.
 * Flt comes from the live day_gainers quote each poll (Realtime parity field).
 */
import type { NewsItem, ScannerPayload, StockMover } from "@/lib/types";

const FEED_LIMIT = 50;

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
 * Primary live quote source each poll.
 * Price, prevClose, volume, and Flt share counts come from this payload —
 * no floats.json / in-memory float cache.
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

/**
 * Live Flt fill for this poll only (spark rows). No cross-poll cache / floats.json.
 * Caps requests so proxies stay healthy.
 */
async function fetchLiveFloatThisPoll(symbols: string[]): Promise<Map<string, number>> {
  const need = [...new Set(symbols.map((s) => s.toUpperCase()).filter(Boolean))].slice(0, 10);
  const out = new Map<string, number>();
  if (!need.length) return out;

  let crumb: string | null = null;
  try {
    await fetchTextViaProxy("https://fc.yahoo.com", 4000).catch(() => "");
    const text = (await fetchTextViaProxy("https://query2.finance.yahoo.com/v1/test/getcrumb", 5000)).trim();
    if (text && text.length <= 40 && !text.includes("<") && !text.includes("{")) crumb = text;
  } catch {
    return out;
  }
  if (!crumb) return out;

  await Promise.all(
    need.map(async (sym) => {
      try {
        const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
          sym,
        )}?modules=defaultKeyStatistics&crumb=${encodeURIComponent(crumb)}`;
        const data = (await fetchViaProxy(url, 6000)) as {
          quoteSummary?: { result?: Array<{ defaultKeyStatistics?: Record<string, unknown> }> };
        };
        const ks = data?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
        if (!ks) return;
        const pick = (v: unknown): number | null => {
          const n = typeof v === "object" && v != null ? Number((v as { raw?: number }).raw) : Number(v);
          return Number.isFinite(n) && n > 0 ? n / 1_000_000 : null;
        };
        const m =
          pick(ks.impliedSharesOutstanding) ?? pick(ks.sharesOutstanding) ?? pick(ks.floatShares);
        if (m != null) out.set(sym, m);
      } catch {
        /* leave empty this poll */
      }
    }),
  );
  return out;
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

/** Live scan — no live.json, no floats.json, no last-tick paint. */
export async function fetchLiveScannerClient(): Promise<ScannerPayload> {
  const session = sessionNow();

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

  const missing = advanced.map((s) => s.symbol).filter((s) => !quotes.has(s));
  if (missing.length) {
    const spark = await fetchYahooSpark(missing);
    for (const [sym, q] of spark) quotes.set(sym, q);
  }

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

  let movers = [...quotes.values()]
    .map(toMover)
    .filter((m) => {
      const recomputed = ((m.price - m.prevClose) / m.prevClose) * 100;
      return Math.abs(recomputed - m.changePct) < 0.05;
    })
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, FEED_LIMIT);

  // Live Flt for spark-only rows missing share count — this poll only, not cached.
  const needFlt = movers.filter((m) => m.floatMillions == null).map((m) => m.symbol);
  if (needFlt.length) {
    const liveFlt = await fetchLiveFloatThisPoll(needFlt);
    if (liveFlt.size) {
      movers = movers.map((m) =>
        m.floatMillions != null
          ? m
          : { ...m, floatMillions: liveFlt.get(m.symbol.toUpperCase()) ?? null },
      );
    }
  }

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
