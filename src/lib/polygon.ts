import { filterHodGainers, getMarketSession, toMover } from "./market";
import type { NewsItem, ScannerPayload, StockMover } from "./types";

const POLYGON_BASE = "https://api.polygon.io";

function apiKey(): string | undefined {
  return process.env.POLYGON_API_KEY || process.env.MASSIVE_API_KEY;
}

async function polygonGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const key = apiKey();
  if (!key) throw new Error("POLYGON_API_KEY not configured");

  const url = new URL(path, POLYGON_BASE);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set("apiKey", key);

  const res = await fetch(url.toString(), {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Polygon ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

type SnapshotTicker = {
  ticker: string;
  todaysChangePerc?: number;
  todaysChange?: number;
  updated?: number;
  day?: { c?: number; h?: number; l?: number; o?: number; v?: number; vw?: number };
  prevDay?: { c?: number; h?: number; l?: number; o?: number; v?: number };
  min?: { c?: number; h?: number; l?: number; o?: number; v?: number; t?: number };
  lastTrade?: { p?: number; t?: number };
};

type SnapshotResponse = { tickers?: SnapshotTicker[]; status?: string };

function snapshotToMover(t: SnapshotTicker): StockMover | null {
  const price =
    t.min?.c ||
    t.lastTrade?.p ||
    t.day?.c ||
    0;
  const prevClose = t.prevDay?.c || 0;
  const dayHigh = Math.max(t.day?.h || 0, t.min?.h || 0, price);
  const dayLow = t.day?.l || t.min?.l || price;
  const volume = t.day?.v || t.min?.v || 0;
  const updatedAt = t.min?.t
    ? new Date(t.min.t).toISOString()
    : t.updated
      ? new Date(t.updated / 1_000_000).toISOString()
      : new Date().toISOString();

  return toMover({
    symbol: t.ticker,
    price,
    prevClose,
    dayHigh,
    dayLow,
    volume,
    updatedAt,
  });
}

export async function fetchGainersSnapshots(limit = 50): Promise<StockMover[]> {
  const data = await polygonGet<SnapshotResponse>(
    "/v2/snapshot/locale/us/markets/stocks/gainers",
  );
  const movers = (data.tickers ?? [])
    .map(snapshotToMover)
    .filter((m): m is StockMover => Boolean(m));
  return filterHodGainers(movers, { minChangePct: 0, limit }).slice(0, limit);
}

/** Premarket / session top gainers — % rank only. */
export async function fetchPremarketHod(limit = 50): Promise<StockMover[]> {
  const data = await polygonGet<SnapshotResponse>(
    "/v2/snapshot/locale/us/markets/stocks/gainers",
  );
  const movers = (data.tickers ?? [])
    .map(snapshotToMover)
    .filter((m): m is StockMover => Boolean(m));

  return filterHodGainers(movers, { minChangePct: 0, limit }).slice(0, limit);
}

type PolygonNews = {
  results?: Array<{
    id: string;
    title: string;
    author?: string;
    published_utc: string;
    article_url: string;
    description?: string;
    publisher?: { name?: string };
    tickers?: string[];
  }>;
};

export async function fetchBreakingNews(limit = 40): Promise<NewsItem[]> {
  const data = await polygonGet<PolygonNews>("/v2/reference/news", {
    limit: String(limit),
    order: "desc",
    sort: "published_utc",
  });

  return (data.results ?? []).map((n) => ({
    id: n.id,
    title: n.title,
    publisher: n.publisher?.name || n.author || "News",
    publishedAt: n.published_utc,
    url: n.article_url,
    tickers: (n.tickers ?? []).map((t) => t.replace(/^.*:/, "")),
    summary: n.description,
  }));
}

export function hasPolygonKey(): boolean {
  return Boolean(apiKey());
}

export async function fetchLiveScanner(): Promise<ScannerPayload> {
  const [news, premarket, gainers] = await Promise.all([
    fetchBreakingNews(40),
    fetchPremarketHod(40),
    fetchGainersSnapshots(40),
  ]);

  return {
    session: getMarketSession(),
    updatedAt: new Date().toISOString(),
    source: "polygon",
    news,
    premarket,
    gainers,
    afterhours: [],
  };
}
