/**
 * Live news poll for the News tab (STOCK_SCANNER_APP_MEMORY.md).
 * Progressive: quick sources first, then full registry. Soft-fail.
 */
import { enrichNewsWithQuotes, fetchLiveNews, fetchLiveNewsQuick } from "@/lib/liveNews";
import { fetchJsonViaCors } from "@/lib/corsTransport";
import type { NewsItem } from "@/lib/types";

async function sparkQuotes(
  symbols: string[],
): Promise<Map<string, { last: number; changePct: number }>> {
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()).filter(Boolean))].slice(0, 30);
  const out = new Map<string, { last: number; changePct: number }>();
  if (!uniq.length) return out;

  const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(uniq.join(","))}&range=1d&interval=1m`;
  type SparkPayload = {
    spark?: {
      result?: Array<{
        symbol: string;
        response?: Array<{ meta?: Record<string, unknown> }>;
      }>;
    };
  };
  // Soft enrichment only — never block / burn the gainers queue.
  const data = (await fetchJsonViaCors(url, 12000, "low", { queue: false })) as SparkPayload;
  for (const item of data.spark?.result || []) {
    const meta = item.response?.[0]?.meta;
    if (!meta) continue;
    const symbol = String(item.symbol || meta.symbol || "").toUpperCase();
    const last = Number(meta.regularMarketPrice) || 0;
    const prev = Number(meta.previousClose ?? meta.chartPreviousClose) || 0;
    if (!(last > 0) || !(prev > 0)) continue;
    out.set(symbol, { last, changePct: ((last - prev) / prev) * 100 });
  }
  return out;
}

async function withQuotes(raw: NewsItem[]): Promise<NewsItem[]> {
  const tickers = [
    ...new Set(raw.flatMap((n) => n.tickers).map((t) => t.toUpperCase()).filter(Boolean)),
  ];
  if (!tickers.length) return enrichNewsWithQuotes(raw, new Map());
  try {
    const quotes = await Promise.race([
      sparkQuotes(tickers),
      new Promise<Map<string, { last: number; changePct: number }>>((resolve) =>
        setTimeout(() => resolve(new Map()), 5000),
      ),
    ]);
    return enrichNewsWithQuotes(raw, quotes);
  } catch {
    return enrichNewsWithQuotes(raw, new Map());
  }
}

/** Fast first paint — do not block the News tab on the full registry. */
export async function fetchLiveNewsFeedQuick(): Promise<NewsItem[]> {
  return withQuotes(await fetchLiveNewsQuick(100));
}

/** Full multi-source scan (deadline-capped inside fetchLiveNews). */
export async function fetchLiveNewsFeed(): Promise<NewsItem[]> {
  return withQuotes(await fetchLiveNews(100));
}
