/**
 * Live news poll for the News tab (STOCK_SCANNER_APP_MEMORY.md).
 * Progressive: quick sources first, then full registry. Soft-fail.
 */
import { enrichNewsWithQuotes, fetchLiveNews, fetchLiveNewsQuick } from "@/lib/liveNews";
import type { NewsItem } from "@/lib/types";

function bust(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const PROXY_BUILDERS: Array<(enc: string) => string> = [
  (enc) => `https://api.allorigins.win/raw?url=${enc}`,
  (enc) => `https://api.codetabs.com/v1/proxy?quest=${enc}`,
  (enc) => `https://corsproxy.io/?${enc}`,
];

async function fetchJson(url: string): Promise<unknown> {
  const live = bust(url);
  const enc = encodeURIComponent(live);
  let lastErr: Error | null = null;
  for (const b of PROXY_BUILDERS) {
    try {
      const res = await fetch(b(enc), {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) {
        lastErr = new Error(`proxy ${res.status}`);
        continue;
      }
      const text = await res.text();
      if (text.trimStart().startsWith("<")) {
        lastErr = new Error("html");
        continue;
      }
      return JSON.parse(text);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr || new Error("quote proxy failed");
}

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
  const data = (await fetchJson(url)) as SparkPayload;
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
