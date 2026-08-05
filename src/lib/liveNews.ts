/**
 * Live market news for the News tab (STOCK_SCANNER_APP_MEMORY.md).
 * Soft-fail — must never kill the gainers poll.
 * Newest → oldest, up to 100.
 * LIVE ONLY each call — no TTL cache, no live.json, no filler rows.
 */
import type { NewsItem } from "@/lib/types";

const NEWS_LIMIT = 100;

type RawNews = {
  id: string;
  title: string;
  publisher: string;
  publishedAt: string;
  url: string;
  tickers: string[];
  publishedMs: number;
};

function bust(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const PROXY_BUILDERS: Array<(enc: string) => string> = [
  (enc) => `https://api.allorigins.win/raw?url=${enc}`,
  (enc) => `https://api.codetabs.com/v1/proxy?quest=${enc}`,
  (enc) => `https://corsproxy.io/?${enc}`,
];

async function fetchTextViaProxy(url: string, timeoutMs = 12000): Promise<string> {
  const live = bust(url);
  const enc = encodeURIComponent(live);
  let lastErr: Error | null = null;
  for (const b of PROXY_BUILDERS) {
    try {
      const res = await fetch(b(enc), {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        lastErr = new Error(`proxy ${res.status}`);
        continue;
      }
      const text = await res.text();
      if (!text.trim()) {
        lastErr = new Error("empty");
        continue;
      }
      return text;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr || new Error("All news proxies failed");
}

async function fetchJsonViaProxy(url: string): Promise<unknown> {
  const text = await fetchTextViaProxy(url);
  if (text.trimStart().startsWith("<")) throw new Error("proxy HTML");
  return JSON.parse(text);
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function pickTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  return m ? decodeXml(m[1].trim()) : "";
}

function parseRssItems(xml: string, fallbackPublisher: string): RawNews[] {
  const out: RawNews[] = [];
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of items) {
    const title = pickTag(block, "title");
    const link = pickTag(block, "link") || pickTag(block, "guid");
    if (!title || !link) continue;
    const pub = pickTag(block, "pubDate") || pickTag(block, "dc:date");
    const publishedMs = pub ? Date.parse(pub) : NaN;
    if (!Number.isFinite(publishedMs)) continue;
    const publisher =
      pickTag(block, "source") ||
      pickTag(block, "dc:creator") ||
      fallbackPublisher;
    const tickers: string[] = [];
    const catBlocks = block.match(/<category[^>]*>[\s\S]*?<\/category>/gi) || [];
    for (const c of catBlocks) {
      const raw = decodeXml(c.replace(/<\/?category[^>]*>/gi, "")).trim().toUpperCase();
      if (/^[A-Z]{1,5}$/.test(raw)) tickers.push(raw);
    }
    // Pull $TICKER mentions from titles when RSS has no categories.
    const titleHits = title.toUpperCase().match(/\b[A-Z]{1,5}\b/g) || [];
    for (const t of titleHits) {
      if (t.length >= 2 && !["THE", "AND", "FOR", "WITH", "FROM", "THIS", "THAT", "CEO", "IPO", "FDA", "ETF", "AI"].includes(t)) {
        /* keep only if later enriched; skip generic */
      }
    }
    out.push({
      id: link,
      title,
      publisher: publisher || fallbackPublisher,
      publishedAt: new Date(publishedMs).toISOString(),
      url: link,
      tickers,
      publishedMs,
    });
  }
  return out;
}

async function fetchYahooRssNews(): Promise<RawNews[]> {
  const xml = await fetchTextViaProxy("https://finance.yahoo.com/news/rssindex", 14000);
  return parseRssItems(xml, "Yahoo Finance");
}

async function fetchInvestingRssNews(): Promise<RawNews[]> {
  const xml = await fetchTextViaProxy("https://www.investing.com/rss/news_25.rss", 12000);
  return parseRssItems(xml, "Investing.com");
}

type YahooSearchNews = {
  news?: Array<{
    uuid?: string;
    title?: string;
    publisher?: string;
    link?: string;
    providerPublishTime?: number;
    relatedTickers?: string[];
  }>;
};

const SEARCH_QUERIES = [
  "stock market",
  "nasdaq",
  "earnings",
  "FDA",
  "IPO",
  "biotech",
  "semiconductor",
  "NYSE",
  "wall street",
  "merger",
  "dow jones",
  "S&P 500",
  "federal reserve",
  "oil stock",
  "bank stock",
  "tech stock",
  "retail stock",
  "crypto stock",
  "pharma",
  "EV stock",
];

const MAX_NEWS_AGE_MS = 14 * 24 * 60 * 60 * 1000;

async function fetchYahooSearchNews(): Promise<RawNews[]> {
  const out: RawNews[] = [];
  for (let i = 0; i < SEARCH_QUERIES.length; i += 2) {
    const chunk = SEARCH_QUERIES.slice(i, i + 2);
    const parts = await Promise.allSettled(
      chunk.map(async (q) => {
        const data = (await fetchJsonViaProxy(
          `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=20&listsCount=0`,
        )) as YahooSearchNews;
        return data.news || [];
      }),
    );
    for (const p of parts) {
      if (p.status !== "fulfilled") continue;
      for (const n of p.value) {
        if (!n.title || !n.link) continue;
        const sec = n.providerPublishTime || 0;
        if (!(sec > 0)) continue;
        const ms = sec * 1000;
        out.push({
          id: n.uuid || n.link,
          title: n.title,
          publisher: n.publisher || "Yahoo Finance",
          publishedAt: new Date(ms).toISOString(),
          url: n.link,
          tickers: (n.relatedTickers || []).map((t) => String(t).toUpperCase()),
          publishedMs: ms,
        });
      }
    }
  }
  return out;
}

function mergeNews(batches: RawNews[][]): NewsItem[] {
  const map = new Map<string, RawNews>();
  const cutoff = Date.now() - MAX_NEWS_AGE_MS;
  for (const batch of batches) {
    for (const n of batch) {
      if (!(n.publishedMs >= cutoff)) continue;
      const key = n.id || n.url;
      const prev = map.get(key);
      if (!prev || n.publishedMs > prev.publishedMs) {
        map.set(key, n);
      } else if (prev && n.tickers.length && !prev.tickers.length) {
        map.set(key, { ...prev, tickers: n.tickers });
      }
    }
  }
  return [...map.values()]
    .sort((a, b) => b.publishedMs - a.publishedMs)
    .slice(0, NEWS_LIMIT)
    .map(({ publishedMs: _ms, ...item }) => ({
      ...item,
      price: null,
      changePct: null,
    }));
}

/** Fresh live headlines each call — newest→oldest ≤100. No cache / filler. */
export async function fetchLiveNews(limit = NEWS_LIMIT): Promise<NewsItem[]> {
  const [rss, investing, search] = await Promise.allSettled([
    fetchYahooRssNews(),
    fetchInvestingRssNews(),
    fetchYahooSearchNews(),
  ]);
  const batches: RawNews[][] = [];
  if (rss.status === "fulfilled") batches.push(rss.value);
  if (investing.status === "fulfilled") batches.push(investing.value);
  if (search.status === "fulfilled") batches.push(search.value);
  if (!batches.length) throw new Error("Live news unavailable");
  return mergeNews(batches).slice(0, limit);
}

/** Attach live price/% from the current quote poll (same-tick enrichment). */
export function enrichNewsWithQuotes(
  news: NewsItem[],
  quotes: Map<string, { last: number; changePct: number }>,
): NewsItem[] {
  return news.map((n) => {
    const sym = n.tickers.map((t) => t.toUpperCase()).find((t) => quotes.has(t));
    if (!sym) return { ...n, price: null, changePct: null };
    const q = quotes.get(sym)!;
    return { ...n, tickers: [sym, ...n.tickers.filter((t) => t.toUpperCase() !== sym)], price: q.last, changePct: q.changePct };
  });
}
