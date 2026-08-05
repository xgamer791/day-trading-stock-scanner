/**
 * LIVE-ONLY top-gainers scanner for GitHub Pages.
 *
 * Primary feed: Nasdaq.com Most Advanced + full US screener (live last + %).
 * Optional Yahoo enrich when CORS proxies work (TradingView-accurate prevClose).
 * Never depends on Yahoo for the board to stay up — that caused reconnect loops.
 */
import type { NewsItem, ScannerPayload, StockMover } from "@/lib/types";

const FEED_LIMIT = 20;
const MOVERS_TTL_MS = 8_000;

type LiveSeed = {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
  volume: number;
  dayHigh?: number;
  dayLow?: number;
  prevClose?: number;
};

let moversCache: { rows: LiveSeed[]; at: number } | null = null;

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

async function fetchViaProxy(url: string, timeoutMs = 6000): Promise<Response> {
  const jobs = proxyUrls(url).map((p) => {
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
    return await Promise.any(jobs.map((j) => j.promise));
  } catch {
    throw new Error("All live proxies failed");
  } finally {
    for (const j of jobs) j.ac.abort();
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

async function fetchMostAdvancedLive(): Promise<LiveSeed[]> {
  const url = "https://api.nasdaq.com/api/marketmovers?assetclass=stocks&limit=50";
  const res = await fetchViaProxy(url, 7000);
  const data = await res.json();
  const rows = data?.data?.STOCKS?.MostAdvanced?.table?.rows || [];
  const out: LiveSeed[] = [];
  for (const r of rows) {
    if (isJunk(r.symbol, r.name)) continue;
    const changePct = parseMoney(r.change);
    const price = parseMoney(r.lastSalePrice);
    if (!(changePct > 0) || !(price > 0)) continue;
    out.push({
      symbol: String(r.symbol).replace("/", "-").toUpperCase(),
      name: r.name || r.symbol,
      price,
      changePct,
      volume: parseMoney(r.volume),
      prevClose: price / (1 + changePct / 100),
    });
  }
  return out;
}

async function fetchFullUsScreenerLive(): Promise<LiveSeed[]> {
  const url =
    "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true";
  const res = await fetchViaProxy(url, 12000);
  const data = await res.json();
  const rows = data?.data?.rows || [];
  return rows
    .filter((r: { symbol: string; name: string }) => !isJunk(r.symbol, r.name))
    .map((r: { symbol: string; name: string; lastsale: string; pctchange: string; volume: string }) => {
      const price = parseMoney(r.lastsale);
      const changePct = parseMoney(r.pctchange);
      return {
        symbol: String(r.symbol).replace("/", "-").toUpperCase(),
        name: r.name || r.symbol,
        price,
        changePct,
        volume: parseMoney(r.volume),
        prevClose: changePct > -100 ? price / (1 + changePct / 100) : undefined,
      } satisfies LiveSeed;
    })
    .filter((r: LiveSeed) => r.changePct > 0 && r.price > 0)
    .sort((a: LiveSeed, b: LiveSeed) => b.changePct - a.changePct)
    .slice(0, 40);
}

function mergeLive(...lists: LiveSeed[][]): LiveSeed[] {
  const map = new Map<string, LiveSeed>();
  // Later lists overwrite earlier (Most Advanced should win over screener)
  for (const list of lists) {
    for (const row of list) {
      const prev = map.get(row.symbol);
      if (!prev || row.changePct >= prev.changePct) {
        map.set(row.symbol, { ...prev, ...row, volume: row.volume || prev?.volume || 0 });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.changePct - a.changePct);
}

async function loadLiveMovers(): Promise<LiveSeed[]> {
  // Prefer a very fresh movers pull; allow short in-memory reuse only to ride out a single proxy blip
  if (moversCache && Date.now() - moversCache.at < MOVERS_TTL_MS && moversCache.rows.length >= 5) {
    // Still try a fresh pull; fall back to this if it fails
    try {
      return await pullFreshMovers();
    } catch {
      return moversCache.rows;
    }
  }
  return pullFreshMovers();
}

async function pullFreshMovers(): Promise<LiveSeed[]> {
  const results = await Promise.allSettled([fetchMostAdvancedLive(), fetchFullUsScreenerLive()]);
  const advanced = results[0].status === "fulfilled" ? results[0].value : [];
  const screener = results[1].status === "fulfilled" ? results[1].value : [];

  // Most Advanced wins on overlap (fresher live %)
  const merged = mergeLive(screener, advanced);
  if (merged.length >= 3) {
    moversCache = { rows: merged, at: Date.now() };
    return merged;
  }
  if (moversCache?.rows.length) return moversCache.rows;

  const err =
    results.find((r) => r.status === "rejected") &&
    ((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as Error)
      ?.message;
  throw new Error(err || "Live Nasdaq movers unavailable");
}

type YahooQuote = {
  symbol: string;
  last: number;
  prevClose: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  dayChangePct: number;
};

async function fetchYahooQuote(symbol: string): Promise<YahooQuote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`;
  const res = await fetchViaProxy(url, 4000);
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  const quote = data?.chart?.result?.[0]?.indicators?.quote?.[0] || {};
  if (!meta) return null;
  const highs = (quote.high || []).filter((n: number | null) => n != null) as number[];
  const lows = (quote.low || []).filter((n: number | null) => n != null) as number[];
  const prevClose = Number(meta.previousClose ?? meta.chartPreviousClose) || 0;
  const last = Number(meta.regularMarketPrice) || 0;
  if (!(last > 0) || !(prevClose > 0)) return null;
  const metaHigh = Number(meta.regularMarketDayHigh) || 0;
  const metaLow = Number(meta.regularMarketDayLow) || 0;
  const dayHigh = Math.max(last, metaHigh, ...(highs.length ? highs : [0]));
  const dayLow =
    lows.length || metaLow
      ? Math.min(last, metaLow || last, ...(lows.length ? lows : [last]))
      : last;
  return {
    symbol,
    last,
    prevClose,
    dayHigh,
    dayLow,
    volume: Number(meta.regularMarketVolume) || 0,
    dayChangePct: ((last - prevClose) / prevClose) * 100,
  };
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    out.push(...(await Promise.all(items.slice(i, i + concurrency).map(fn))));
  }
  return out;
}

function seedToMover(seed: LiveSeed, y?: YahooQuote | null): StockMover {
  // Prefer Yahoo when available (matches TradingView). Else Nasdaq live last+% together.
  const price = y?.last && y.last > 0 ? y.last : seed.price;
  const prevClose =
    y?.prevClose && y.prevClose > 0
      ? y.prevClose
      : seed.prevClose && seed.prevClose > 0
        ? seed.prevClose
        : price / (1 + seed.changePct / 100);
  const changePct = y ? ((price - prevClose) / prevClose) * 100 : seed.changePct;
  const dayHigh = y?.dayHigh && y.dayHigh > 0 ? Math.max(y.dayHigh, price) : Math.max(seed.dayHigh || 0, price);
  const dayLow = y?.dayLow && y.dayLow > 0 ? y.dayLow : seed.dayLow || price;
  const volume = y?.volume && y.volume > 0 ? y.volume : seed.volume || 0;
  const hodDistancePct = dayHigh > 0 ? ((dayHigh - price) / dayHigh) * 100 : 0;

  return {
    symbol: seed.symbol,
    name: seed.name,
    price,
    changePct,
    change: price - prevClose,
    volume,
    dayHigh,
    dayLow,
    prevClose,
    floatMillions: null,
    hodDistancePct,
    hodGainPct: prevClose > 0 ? ((dayHigh - prevClose) / prevClose) * 100 : changePct,
    atHod: hodDistancePct <= 2,
    updatedAt: new Date().toISOString(),
  };
}

function topGainers(rows: StockMover[]): StockMover[] {
  return [...rows]
    .filter((m) => m.changePct > 0 && m.price > 0)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, FEED_LIMIT);
}

/** Live scan — Nasdaq movers always sufficient; Yahoo is optional enrich. */
export async function fetchLiveScannerClient(): Promise<ScannerPayload> {
  const session = sessionNow();
  const seeds = await loadLiveMovers();
  if (!seeds.length) throw new Error("Live Nasdaq movers returned no US gainers");

  const head = seeds.slice(0, FEED_LIMIT);
  // Best-effort Yahoo enrich (do not fail the tick if proxies flake)
  const yahoo = await mapPool(head.slice(0, 12), 4, async (s) => {
    try {
      return await fetchYahooQuote(s.symbol);
    } catch {
      return null;
    }
  });
  const yMap = new Map(
    yahoo.filter(Boolean).map((q) => [q!.symbol, q!] as const),
  );

  const rows = head.map((s) => seedToMover(s, yMap.get(s.symbol) ?? null));
  const ranked = topGainers(rows);

  let premarket: StockMover[] = [];
  let gainers: StockMover[] = [];

  if (session === "premarket") {
    premarket = ranked;
  } else if (session !== "closed") {
    gainers = ranked;
    premarket = ranked; // gap panel uses same live leaders until dedicated gap feed
  }

  if (session !== "premarket" && session !== "closed" && !gainers.length) {
    throw new Error("No live top gainers");
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
