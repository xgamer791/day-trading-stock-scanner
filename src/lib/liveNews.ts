/**
 * Live market news for the News tab (STOCK_SCANNER_APP_MEMORY.md).
 * Soft-fail — must never kill the gainers poll.
 * Pulls every enabled source in newsSources.ts each scan.
 * Newest → oldest, prefers today's ET breaking news, up to 100.
 * LIVE ONLY — no TTL cache, no live.json, no filler rows.
 */
import { etWallTimeToUtc } from "@/lib/market";
import {
  getEnabledNewsSources,
  tickerNewsSources,
  type NewsSource,
} from "@/lib/newsSources";
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
  weight: number;
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

async function fetchJsonViaProxy(url: string, timeoutMs = 9000): Promise<unknown> {
  const text = await fetchTextViaProxy(url, timeoutMs);
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

const STOP = new Set([
  "THE", "AND", "FOR", "WITH", "FROM", "THIS", "THAT", "CEO", "IPO", "FDA", "ETF",
  "AI", "US", "USA", "UK", "EU", "CFO", "SEC", "FED", "NYSE", "Q1", "Q2", "Q3", "Q4",
  "YOY", "QOQ", "USD", "INC", "LTD", "PLC", "NEW", "AFTER", "BEFORE", "OVER", "UNDER",
  "STOCK", "SHARES", "MARKET", "NEWS", "UPDATE", "CALL", "HIGHLIGHTS", "GOOGLE",
]);

function tickersFromTitle(title: string): string[] {
  const out: string[] = [];
  const paren = title.match(/\(([A-Z]{1,5})\)/g) || [];
  for (const p of paren) {
    const t = p.replace(/[()]/g, "");
    if (!STOP.has(t)) out.push(t);
  }
  const lead = title.match(/^([A-Z]{1,5})\b/);
  if (lead && !STOP.has(lead[1])) out.push(lead[1]);
  const dollar = title.match(/\$([A-Z]{1,5})\b/g) || [];
  for (const d of dollar) {
    const t = d.slice(1);
    if (!STOP.has(t)) out.push(t);
  }
  return [...new Set(out)];
}

function startOfTodayEtMs(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);
  return etWallTimeToUtc(year, month, day, 0, 0, 0).getTime();
}

function parseRssItems(xml: string, fallbackPublisher: string, weight: number): RawNews[] {
  const out: RawNews[] = [];
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of items) {
    const title = pickTag(block, "title");
    // Google News often puts the real URL in <link> or guid; strip tracking when possible.
    let link = pickTag(block, "link") || pickTag(block, "guid");
    if (!title || !link) continue;
    // Drop Google News channel title row
    if (/^"?\.+"?\s*-\s*Google News$/i.test(title) || title.includes(" - Google News") && title.startsWith('"')) {
      /* keep article titles like `Headline - Publisher` */
    }
    if (/^".+" - Google News$/.test(title) && !title.includes(" - ")) continue;

    const pub = pickTag(block, "pubDate") || pickTag(block, "dc:date");
    let publishedMs = pub ? Date.parse(pub) : NaN;
    if (!Number.isFinite(publishedMs)) publishedMs = Date.now();

    const sourceName = pickTag(block, "source") || fallbackPublisher;
    // Google titles look like: "Headline here - Publisher Name"
    let cleanTitle = title;
    let publisher = sourceName || fallbackPublisher;
    const dash = title.lastIndexOf(" - ");
    if (dash > 20 && fallbackPublisher === "Google News") {
      cleanTitle = title.slice(0, dash).trim();
      publisher = title.slice(dash + 3).trim() || publisher;
    }

    const tickers = tickersFromTitle(cleanTitle);
    out.push({
      id: link,
      title: cleanTitle,
      publisher,
      publishedAt: new Date(publishedMs).toISOString(),
      url: link,
      tickers,
      publishedMs,
      weight,
    });
  }
  return out;
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

function mapYahooNews(
  n: NonNullable<YahooSearchNews["news"]>[number],
  weight: number,
): RawNews | null {
  if (!n.title || !n.link) return null;
  const sec = n.providerPublishTime || 0;
  if (!(sec > 0)) return null;
  const ms = sec * 1000;
  const tickers = [
    ...(n.relatedTickers || []).map((t) => String(t).replace("/", "-").toUpperCase()),
    ...tickersFromTitle(n.title),
  ].filter((t) => t && !STOP.has(t) && /^[A-Z]{1,5}(-[A-Z])?$/.test(t));
  return {
    id: n.uuid || n.link,
    title: n.title,
    publisher: n.publisher || "Yahoo Finance",
    publishedAt: new Date(ms).toISOString(),
    url: n.link,
    tickers: [...new Set(tickers)],
    publishedMs: ms,
    weight,
  };
}

async function fetchSource(source: NewsSource): Promise<RawNews[]> {
  const weight = source.weight ?? 1;
  if (source.kind === "rss") {
    const xml = await fetchTextViaProxy(source.target, 14000);
    return parseRssItems(xml, source.label, weight);
  }
  const data = (await fetchJsonViaProxy(
    `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(source.target)}&quotesCount=0&newsCount=40&listsCount=0`,
    9000,
  )) as YahooSearchNews;
  const out: RawNews[] = [];
  for (const n of data.news || []) {
    const row = mapYahooNews(n, weight);
    if (row) out.push(row);
  }
  return out;
}

async function fetchDayGainerSymbols(): Promise<string[]> {
  try {
    const data = (await fetchJsonViaProxy(
      "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=40&scrIds=day_gainers&formatted=false",
      9000,
    )) as { finance?: { result?: Array<{ quotes?: Array<{ symbol?: string }> }> } };
    return (data.finance?.result?.[0]?.quotes || [])
      .map((q) => String(q.symbol || "").replace("/", "-").toUpperCase())
      .filter(Boolean)
      .slice(0, 40);
  } catch {
    return [];
  }
}

function mergeNews(rows: RawNews[]): RawNews[] {
  const map = new Map<string, RawNews>();
  for (const n of rows) {
    const key = n.id || n.url;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, n);
      continue;
    }
    const newer = n.publishedMs >= prev.publishedMs ? n : prev;
    const older = newer === n ? prev : n;
    map.set(key, {
      ...newer,
      tickers: [...new Set([...newer.tickers, ...older.tickers])],
      weight: Math.max(newer.weight, older.weight),
    });
  }
  return [...map.values()];
}

function rankForDay(rows: RawNews[]): RawNews[] {
  const dayStart = startOfTodayEtMs();
  const today = rows.filter((n) => n.publishedMs >= dayStart);
  // Prefer full trading day; if sparse, keep last 36h so the board still fills.
  const pool =
    today.length >= 20
      ? today
      : rows.filter((n) => n.publishedMs >= Date.now() - 36 * 60 * 60 * 1000);
  return pool.sort((a, b) => b.publishedMs - a.publishedMs).slice(0, NEWS_LIMIT);
}

async function runSources(sources: NewsSource[]): Promise<RawNews[]> {
  const out: RawNews[] = [];
  // Parallel batches of 6 to stay current without serializing every feed.
  for (let i = 0; i < sources.length; i += 6) {
    const chunk = sources.slice(i, i + 6);
    const parts = await Promise.allSettled(chunk.map((s) => fetchSource(s)));
    for (const p of parts) {
      if (p.status === "fulfilled") out.push(...p.value);
    }
  }
  return out;
}

/**
 * Today's breaking news from all registered sources — newest → oldest ≤100.
 */
export async function fetchLiveNews(limit = NEWS_LIMIT): Promise<NewsItem[]> {
  const base = getEnabledNewsSources();
  const symbols = await fetchDayGainerSymbols();
  const sources = [...base, ...tickerNewsSources(symbols)];

  const collected = await runSources(sources);
  const ranked = rankForDay(mergeNews(collected)).slice(0, limit);
  if (!ranked.length) throw new Error("Live news returned zero headlines");

  return ranked.map(({ publishedMs: _ms, weight: _w, ...item }) => ({
    ...item,
    price: null,
    changePct: null,
  }));
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
    return {
      ...n,
      tickers: [sym, ...n.tickers.filter((t) => t.toUpperCase() !== sym)],
      price: q.last,
      changePct: q.changePct,
    };
  });
}
