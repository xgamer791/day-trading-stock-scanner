/**
 * Browser-side full-US-market HOD scanner.
 * Pulls Nasdaq.com composite market movers (NYSE / NASDAQ / AMEX / etc.)
 * and confirms high-of-day with Yahoo 1m charts via CORS proxies.
 */
import type { NewsItem, ScannerPayload, StockMover } from "@/lib/types";

const HOD_TOLERANCE_PCT = 2.0;

function proxies(url: string): string[] {
  const enc = encodeURIComponent(url);
  return [
    `https://corsproxy.io/?${enc}`,
    `https://api.allorigins.win/raw?url=${enc}`,
  ];
}

async function fetchViaProxy(url: string): Promise<Response> {
  let lastErr: Error | null = null;
  for (const p of proxies(url)) {
    try {
      const res = await fetch(p, {
        cache: "no-store",
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) {
        lastErr = new Error(`proxy ${res.status}`);
        continue;
      }
      const text = await res.text();
      // corsproxy sometimes returns HTML interstitial
      if (text.trimStart().startsWith("<!DOCTYPE") || text.trimStart().startsWith("<html")) {
        lastErr = new Error("proxy returned HTML");
        continue;
      }
      return new Response(text, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr || new Error("All proxies failed");
}

function parseMoney(v: unknown): number {
  if (v == null) return 0;
  const n = Number(String(v).replace(/[$,%+]/g, "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function isJunk(sym: string, name = ""): boolean {
  const s = sym || "";
  const n = name.toLowerCase();
  if (!s || /[.=]/.test(s)) return true;
  if (/(WW|WS|WT)$/.test(s)) return true;
  if (s.length >= 5 && s.endsWith("W")) return true;
  if (n.includes("warrant") || n.includes(" unit") || n.includes("right")) return true;
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

type MoverSeed = { symbol: string; name: string; changePct: number | null };

async function fetchMarketMovers(): Promise<MoverSeed[]> {
  const url = "https://api.nasdaq.com/api/marketmovers?assetclass=stocks&limit=50";
  const res = await fetchViaProxy(url);
  const data = await res.json();
  const stocks = data?.data?.STOCKS;
  if (!stocks) throw new Error("No STOCKS in market movers");

  const out: MoverSeed[] = [];
  for (const key of [
    "MostAdvanced",
    "MostActiveByShareVolume",
    "MostActiveByDollarVolume",
    "Nasdaq100Movers",
  ] as const) {
    const rows = stocks[key]?.table?.rows || [];
    const isVol = key.includes("ShareVolume");
    for (const r of rows) {
      if (isJunk(r.symbol, r.name)) continue;
      out.push({
        symbol: String(r.symbol).replace("/", "-"),
        name: r.name || r.symbol,
        changePct: isVol ? null : parseMoney(r.change),
      });
    }
  }
  if (!out.length) throw new Error("Empty market movers");
  return out;
}

async function fetchYahooQuote(symbol: string): Promise<{
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
  atHod: boolean;
} | null> {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`;
  const res = await fetchViaProxy(url);
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
  const sessionOpen = opens.length ? Number(opens[0]) : last;
  const dayHigh = highs.length ? Math.max(...highs, last) : last;
  const dayLow = lows.length ? Math.min(...lows, last) : last;
  const volume = Number(meta.regularMarketVolume) || volumes.reduce((a, b) => a + b, 0) || 0;
  if (last <= 0 || prevClose <= 0) return null;

  const prePrice = meta.preMarketPrice != null ? Number(meta.preMarketPrice) : null;
  const prePct =
    meta.preMarketChangePercent != null
      ? Number(meta.preMarketChangePercent)
      : prePrice
        ? ((prePrice - prevClose) / prevClose) * 100
        : null;

  const dayChangePct = ((last - prevClose) / prevClose) * 100;
  const gapPct = ((sessionOpen - prevClose) / prevClose) * 100;
  const hodDistancePct = ((dayHigh - last) / dayHigh) * 100;

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
    atHod: hodDistancePct <= HOD_TOLERANCE_PCT,
  };
}

function toMover(
  q: NonNullable<Awaited<ReturnType<typeof fetchYahooQuote>>>,
  changePct: number,
  price = q.last,
): StockMover {
  const dayHigh = Math.max(q.dayHigh, price);
  const hodDistancePct = ((dayHigh - price) / dayHigh) * 100;
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
    atHod: hodDistancePct <= HOD_TOLERANCE_PCT,
    updatedAt: new Date().toISOString(),
  };
}

function hodRank(rows: StockMover[], minChangePct: number): StockMover[] {
  return rows
    .filter(
      (m) =>
        m.atHod &&
        m.changePct >= minChangePct &&
        m.price >= 0.5 &&
        m.price <= 1000 &&
        m.volume >= 1000,
    )
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 20);
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    out.push(...(await Promise.all(chunk.map(fn))));
  }
  return out;
}

/** Live scan across all US listings exposed by Nasdaq.com composite movers. */
export async function fetchLiveScannerClient(): Promise<ScannerPayload> {
  const session = sessionNow();
  const seeds = await fetchMarketMovers();
  const symbols = [...new Set(seeds.map((s) => s.symbol))].slice(0, 80);

  const quotes = (
    await mapPool(symbols, 6, async (sym) => {
      try {
        return await fetchYahooQuote(sym);
      } catch {
        return null;
      }
    })
  ).filter(Boolean) as NonNullable<Awaited<ReturnType<typeof fetchYahooQuote>>>[];

  if (quotes.length < 5) {
    throw new Error(`Live quote confirmation failed (${quotes.length} quotes)`);
  }

  let premarketRaw: StockMover[] = [];
  let gainersRaw: StockMover[] = [];

  if (session === "premarket") {
    premarketRaw = quotes.map((q) => {
      const pct = q.prePct != null ? q.prePct : q.dayChangePct;
      const price = q.prePrice != null ? q.prePrice : q.last;
      return toMover(q, pct, price);
    });
  } else if (session !== "closed") {
    premarketRaw = quotes.map((q) => toMover(q, q.gapPct));
    gainersRaw = quotes.map((q) => toMover(q, q.dayChangePct));
  }

  const news: NewsItem[] = [];

  return {
    session,
    updatedAt: new Date().toISOString(),
    source: "full-us-realtime",
    news,
    premarket: hodRank(premarketRaw, session === "premarket" ? 2 : 3),
    gainers: session === "premarket" || session === "closed" ? [] : hodRank(gainersRaw, 2),
  };
}

export function liveJsonUrl(): string {
  const base = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
  return `${base}/data/live.json?t=${Date.now()}`;
}
