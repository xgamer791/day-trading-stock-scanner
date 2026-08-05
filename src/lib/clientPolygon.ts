import { filterHodGainers, getMarketSession, toMover } from "@/lib/market";
import type { NewsItem, ScannerPayload, StockMover } from "@/lib/types";

type SnapshotTicker = {
  ticker: string;
  day?: { c?: number; h?: number; l?: number; v?: number };
  prevDay?: { c?: number };
  min?: { c?: number; h?: number; l?: number; v?: number; t?: number };
  lastTrade?: { p?: number };
  updated?: number;
};

type NewsResponse = {
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

type SnapshotResponse = { tickers?: SnapshotTicker[] };

function snapshotToMover(t: SnapshotTicker): StockMover | null {
  const price = t.min?.c || t.lastTrade?.p || t.day?.c || 0;
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

export function buildFromPolygon(
  newsJson: NewsResponse,
  gainersJson: SnapshotResponse,
): ScannerPayload {
  const movers = (gainersJson.tickers ?? [])
    .map(snapshotToMover)
    .filter((m): m is StockMover => Boolean(m));

  const session = getMarketSession();
  const top = filterHodGainers(movers, { minChangePct: 0, limit: 50 });

  const news: NewsItem[] = (newsJson.results ?? []).map((n) => ({
    id: n.id,
    title: n.title,
    publisher: n.publisher?.name || n.author || "News",
    publishedAt: n.published_utc,
    url: n.article_url,
    tickers: (n.tickers ?? []).map((t) => t.replace(/^.*:/, "")),
    summary: n.description,
  }));

  return {
    session,
    updatedAt: new Date().toISOString(),
    source: "polygon",
    news,
    premarket: top,
    gainers: top,
    afterhours: [],
  };
}
