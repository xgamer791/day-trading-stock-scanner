/**
 * LIVE-ONLY full US market top-gainers scanner.
 * Prices/% always from fresh quote APIs — never from live.json.
 *
 * Discovery (symbol list) refreshes ~every 45s to avoid CORS proxy rate limits.
 * Quotes refresh every poll (3s).
 */
import type { NewsItem, ScannerPayload, StockMover } from "@/lib/types";

const FEED_LIMIT = 20;
const DISCOVERY_TTL_MS = 45_000;

type Seed = { symbol: string; name: string };

let discoveryCache: { seeds: Seed[]; at: number } | null = null;

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

/** Race proxies — first valid JSON response wins (faster, less serial rate-limit pain). */
async function fetchViaProxy(url: string, timeoutMs = 5000): Promise<Response> {
  const controllers = proxyUrls(url).map((p) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const promise = fetch(p, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
      signal: ac.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`proxy ${res.status}`);
        const text = await res.text();
        const trimmed = text.trimStart();
        if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) {
          throw new Error("proxy HTML");
        }
        // Validate JSON early
        JSON.parse(text);
        return new Response(text, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
      .finally(() => clearTimeout(timer));
    return { ac, promise };
  });

  try {
    return await Promise.any(controllers.map((c) => c.promise));
  } catch {
    throw new Error("All live proxies failed");
  } finally {
    for (const c of controllers) c.ac.abort();
  }
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

async function fetchMostAdvanced(): Promise<Seed[]> {
  const url = "https://api.nasdaq.com/api/marketmovers?assetclass=stocks&limit=50";
  const res = await fetchViaProxy(url, 6000);
  const data = await res.json();
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

async function fetchFullUsTop(): Promise<Seed[]> {
  const url =
    "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true";
  const res = await fetchViaProxy(url, 10000);
  const data = await res.json();
  const rows = data?.data?.rows || [];
  return rows
    .filter((r: { symbol: string; name: string; pctchange: string }) => !isJunk(r.symbol, r.name))
    .map((r: { symbol: string; name: string; pctchange: string }) => ({
      symbol: String(r.symbol).replace("/", "-").toUpperCase(),
      name: r.name || r.symbol,
      pct: parseMoney(r.pctchange),
    }))
    .filter((r: { pct: number }) => r.pct > 0)
    .sort((a: { pct: number }, b: { pct: number }) => b.pct - a.pct)
    .slice(0, 60)
    .map(({ symbol, name }: Seed) => ({ symbol, name }));
}

async function fetchYahooDayGainers(): Promise<Seed[]> {
  const url =
    "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=50&scrIds=day_gainers&formatted=false";
  const res = await fetchViaProxy(url, 6000);
  const data = await res.json();
  const quotes = data?.finance?.result?.[0]?.quotes || [];
  return quotes
    .map((q: { symbol?: string; shortName?: string; longName?: string }) => ({
      symbol: String(q.symbol || "")
        .replace("/", "-")
        .toUpperCase(),
      name: q.shortName || q.longName || q.symbol || "",
    }))
    .filter((s: Seed) => s.symbol && !isJunk(s.symbol, s.name));
}

function mergeSeeds(...lists: Seed[][]): Seed[] {
  const seen = new Set<string>();
  const out: Seed[] = [];
  for (const list of lists) {
    for (const s of list) {
      if (seen.has(s.symbol)) continue;
      seen.add(s.symbol);
      out.push(s);
      if (out.length >= 50) return out;
    }
  }
  return out;
}

async function refreshDiscovery(): Promise<Seed[]> {
  const results = await Promise.allSettled([
    fetchMostAdvanced(),
    fetchYahooDayGainers(),
    fetchFullUsTop(),
  ]);

  const lists = results
    .filter((r): r is PromiseFulfilledResult<Seed[]> => r.status === "fulfilled")
    .map((r) => r.value);

  const merged = mergeSeeds(...lists);
  if (merged.length) {
    discoveryCache = { seeds: merged, at: Date.now() };
    return merged;
  }

  if (discoveryCache?.seeds.length) {
    // Keep prior discovery symbols briefly if every proxy failed this tick
    return discoveryCache.seeds;
  }

  const errs = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
  throw new Error(`Live discovery failed (${errs[0] || "empty"})`);
}

async function getDiscoverySeeds(): Promise<Seed[]> {
  if (discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS && discoveryCache.seeds.length) {
    return discoveryCache.seeds;
  }
  return refreshDiscovery();
}

type LiveQuote = {
  symbol: string;
  name: string;
  last: number;
  prevClose: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  dayChangePct: number;
  gapPct: number;
  prePct: number | null;
  prePrice: number | null;
  hodDistancePct: number;
  hodGainPct: number;
};

async function fetchYahooQuote(symbol: string): Promise<LiveQuote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`;
  const res = await fetchViaProxy(url, 5000);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result?.meta) return null;
  const meta = result.meta;
  const quote = result.indicators?.quote?.[0] || {};
  const opens = (quote.open || []).filter((n: number | null) => n != null) as number[];
  const highs = (quote.high || []).filter((n: number | null) => n != null) as number[];
  const lows = (quote.low || []).filter((n: number | null) => n != null) as number[];
  const volumes = (quote.volume || []).filter((n: number | null) => n != null) as number[];

  const prevClose = Number(meta.previousClose ?? meta.chartPreviousClose) || 0;
  const last = Number(meta.regularMarketPrice) || 0;
  if (last <= 0 || prevClose <= 0) return null;

  const sessionOpen = opens.length ? Number(opens[0]) : last;
  const metaHigh = Number(meta.regularMarketDayHigh) || 0;
  const metaLow = Number(meta.regularMarketDayLow) || 0;
  const dayHigh = Math.max(last, metaHigh, ...(highs.length ? highs : [0]));
  const dayLow =
    lows.length || metaLow
      ? Math.min(last, metaLow || last, ...(lows.length ? lows : [last]))
      : last;
  const volume =
    Number(meta.regularMarketVolume) || volumes.reduce((a: number, b: number) => a + b, 0) || 0;

  const prePrice = meta.preMarketPrice != null ? Number(meta.preMarketPrice) : null;
  const prePct =
    meta.preMarketChangePercent != null
      ? Number(meta.preMarketChangePercent)
      : prePrice
        ? ((prePrice - prevClose) / prevClose) * 100
        : null;

  const dayChangePct = ((last - prevClose) / prevClose) * 100;
  const gapPct = ((sessionOpen - prevClose) / prevClose) * 100;
  const hodDistancePct = dayHigh > 0 ? ((dayHigh - last) / dayHigh) * 100 : 0;
  const hodGainPct = ((dayHigh - prevClose) / prevClose) * 100;

  return {
    symbol,
    name: meta.shortName || meta.longName || symbol,
    last,
    prevClose,
    dayHigh,
    dayLow,
    volume,
    dayChangePct,
    gapPct,
    prePct,
    prePrice,
    hodDistancePct,
    hodGainPct,
  };
}

async function fetchNasdaqInfo(symbol: string): Promise<LiveQuote | null> {
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=stocks`;
  const res = await fetchViaProxy(url, 4500);
  const data = await res.json();
  const primary = data?.data?.primaryData;
  if (!primary) return null;
  const last = parseMoney(primary.lastSalePrice);
  const changePct = primary.percentageChange ? parseMoney(primary.percentageChange) : NaN;
  if (!(last > 0) || !(changePct > 0)) return null;
  const prevClose = last / (1 + changePct / 100);
  const range = String(data?.data?.keyStats?.dayrange?.value || "");
  const [lo, hi] = range.split(/\s*-\s*/).map((x: string) => parseMoney(x));
  const dayHigh = hi || last;
  const dayLow = lo || last;
  const hodDistancePct = dayHigh > 0 ? ((dayHigh - last) / dayHigh) * 100 : 0;
  return {
    symbol,
    name: data?.data?.companyName || symbol,
    last,
    prevClose,
    dayHigh,
    dayLow,
    volume: parseMoney(primary.volume),
    dayChangePct: changePct,
    gapPct: changePct,
    prePct: null,
    prePrice: null,
    hodDistancePct,
    hodGainPct: ((dayHigh - prevClose) / prevClose) * 100,
  };
}

async function liveQuoteFor(symbol: string): Promise<LiveQuote | null> {
  try {
    const y = await fetchYahooQuote(symbol);
    if (y) return y;
  } catch {
    /* nasdaq backup */
  }
  try {
    return await fetchNasdaqInfo(symbol);
  } catch {
    return null;
  }
}

function toMover(q: LiveQuote, changePct: number, price = q.last): StockMover {
  const dayHigh = Math.max(q.dayHigh, price);
  const hodDistancePct = dayHigh > 0 ? ((dayHigh - price) / dayHigh) * 100 : 0;
  return {
    symbol: q.symbol,
    name: q.name,
    price,
    changePct,
    change: price - q.prevClose,
    volume: q.volume,
    dayHigh,
    dayLow: q.dayLow,
    prevClose: q.prevClose,
    floatMillions: null,
    hodDistancePct,
    hodGainPct: q.prevClose > 0 ? ((dayHigh - q.prevClose) / q.prevClose) * 100 : changePct,
    atHod: hodDistancePct <= 2,
    updatedAt: new Date().toISOString(),
  };
}

function topGainers(rows: StockMover[]): StockMover[] {
  return [...rows]
    .filter((m) => m.changePct > 0 && m.price > 0 && m.prevClose > 0)
    .filter((m) => {
      const recomputed = ((m.price - m.prevClose) / m.prevClose) * 100;
      return Math.abs(recomputed - m.changePct) < 0.75;
    })
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, FEED_LIMIT);
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    out.push(...(await Promise.all(chunk.map(fn))));
  }
  return out;
}

/** Live scan — prices always fresh; discovery symbol list may reuse ~45s. */
export async function fetchLiveScannerClient(): Promise<ScannerPayload> {
  const session = sessionNow();
  const candidates = await getDiscoverySeeds();
  if (!candidates.length) throw new Error("Live discovery returned no US gainers");

  // Quote the top discovery names every tick (live prices)
  const quoteTargets = candidates.slice(0, 30);
  const quotes = (
    await mapPool(quoteTargets, 4, async (seed) => {
      try {
        return await liveQuoteFor(seed.symbol);
      } catch {
        return null;
      }
    })
  ).filter(Boolean) as LiveQuote[];

  if (quotes.length < 3) {
    throw new Error(`Live quotes unavailable (${quotes.length})`);
  }

  let premarket: StockMover[] = [];
  let gainers: StockMover[] = [];

  if (session === "premarket") {
    premarket = topGainers(
      quotes.map((q) => {
        const price = q.prePrice != null ? q.prePrice : q.last;
        const pct =
          q.prePct != null ? q.prePct : ((price - q.prevClose) / q.prevClose) * 100;
        return toMover(q, pct, price);
      }),
    );
  } else if (session !== "closed") {
    gainers = topGainers(quotes.map((q) => toMover(q, q.dayChangePct)));
    premarket = topGainers(quotes.map((q) => toMover(q, q.gapPct)));
  }

  if (session !== "premarket" && session !== "closed" && !gainers.length) {
    throw new Error("No live top gainers this tick");
  }

  const news: NewsItem[] = [];

  return {
    session,
    updatedAt: new Date().toISOString(),
    source: "full-us-realtime",
    feedLimit: FEED_LIMIT,
    news,
    premarket,
    gainers,
  };
}

export function liveJsonUrl(): string {
  const base = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
  return `${base}/data/live.json?t=${Date.now()}`;
}
