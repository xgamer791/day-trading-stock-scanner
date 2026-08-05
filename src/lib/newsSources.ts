/**
 * Reusable live news source registry for the stock scanner News tab.
 * Add/adjust sources here — fetchLiveNews reads this on every scan.
 * (Config only — not a market-data cache; STOCK_SCANNER_APP_MEMORY.md)
 */

export type NewsSourceKind = "yahoo-search" | "rss";

export type NewsSource = {
  /** Stable id for logs / future weighting */
  id: string;
  kind: NewsSourceKind;
  /** Human label stored as publisher fallback */
  label: string;
  /**
   * For yahoo-search: search query string.
   * For rss: full feed URL.
   */
  target: string;
  /** Prefer higher first when merging near-duplicates (optional). */
  weight?: number;
  enabled?: boolean;
};

/** Broad + breaking queries (Yahoo Finance search JSON). */
export const YAHOO_SEARCH_SOURCES: NewsSource[] = [
  { id: "ys-market-today", kind: "yahoo-search", label: "Yahoo Finance", target: "stock market today", weight: 3 },
  { id: "ys-breaking", kind: "yahoo-search", label: "Yahoo Finance", target: "breaking stock news", weight: 3 },
  { id: "ys-nasdaq", kind: "yahoo-search", label: "Yahoo Finance", target: "nasdaq today", weight: 2 },
  { id: "ys-nyse", kind: "yahoo-search", label: "Yahoo Finance", target: "NYSE movers", weight: 2 },
  { id: "ys-earnings", kind: "yahoo-search", label: "Yahoo Finance", target: "earnings today", weight: 3 },
  { id: "ys-wallst", kind: "yahoo-search", label: "Yahoo Finance", target: "wall street today", weight: 2 },
  { id: "ys-dow", kind: "yahoo-search", label: "Yahoo Finance", target: "dow jones today", weight: 2 },
  { id: "ys-spx", kind: "yahoo-search", label: "Yahoo Finance", target: "S&P 500 news", weight: 2 },
  { id: "ys-premarket", kind: "yahoo-search", label: "Yahoo Finance", target: "premarket movers", weight: 2 },
  { id: "ys-surge", kind: "yahoo-search", label: "Yahoo Finance", target: "stock surge", weight: 2 },
  { id: "ys-plunge", kind: "yahoo-search", label: "Yahoo Finance", target: "stock plunges", weight: 2 },
  { id: "ys-fda", kind: "yahoo-search", label: "Yahoo Finance", target: "FDA approval stock", weight: 2 },
  { id: "ys-merger", kind: "yahoo-search", label: "Yahoo Finance", target: "merger acquisition stock", weight: 2 },
  { id: "ys-ipo", kind: "yahoo-search", label: "Yahoo Finance", target: "IPO listing", weight: 1 },
  { id: "ys-biotech", kind: "yahoo-search", label: "Yahoo Finance", target: "biotech stock", weight: 1 },
  { id: "ys-semi", kind: "yahoo-search", label: "Yahoo Finance", target: "semiconductor stock", weight: 1 },
  { id: "ys-fed", kind: "yahoo-search", label: "Yahoo Finance", target: "federal reserve stocks", weight: 1 },
  { id: "ys-oil", kind: "yahoo-search", label: "Yahoo Finance", target: "oil prices stocks", weight: 1 },
  { id: "ys-banks", kind: "yahoo-search", label: "Yahoo Finance", target: "bank stocks", weight: 1 },
  { id: "ys-tech", kind: "yahoo-search", label: "Yahoo Finance", target: "tech stocks rally", weight: 1 },
  { id: "ys-afterhours", kind: "yahoo-search", label: "Yahoo Finance", target: "after hours movers", weight: 2 },
  { id: "ys-smallcap", kind: "yahoo-search", label: "Yahoo Finance", target: "small cap gainer", weight: 2 },
];

/**
 * RSS / Atom feeds — Google News + wire + trade press.
 * `when:1d` keeps Google results on the current day.
 */
export const RSS_NEWS_SOURCES: NewsSource[] = [
  {
    id: "gn-stocks-1d",
    kind: "rss",
    label: "Google News",
    target:
      "https://news.google.com/rss/search?q=stocks%20when:1d&hl=en-US&gl=US&ceid=US:en",
    weight: 4,
  },
  {
    id: "gn-stock-market-1d",
    kind: "rss",
    label: "Google News",
    target:
      "https://news.google.com/rss/search?q=stock%20market%20when:1d&hl=en-US&gl=US&ceid=US:en",
    weight: 4,
  },
  {
    id: "gn-earnings-1d",
    kind: "rss",
    label: "Google News",
    target:
      "https://news.google.com/rss/search?q=earnings%20stock%20when:1d&hl=en-US&gl=US&ceid=US:en",
    weight: 3,
  },
  {
    id: "gn-nasdaq-1d",
    kind: "rss",
    label: "Google News",
    target:
      "https://news.google.com/rss/search?q=nasdaq%20when:1d&hl=en-US&gl=US&ceid=US:en",
    weight: 3,
  },
  {
    id: "gn-nyse-1d",
    kind: "rss",
    label: "Google News",
    target:
      "https://news.google.com/rss/search?q=NYSE%20when:1d&hl=en-US&gl=US&ceid=US:en",
    weight: 2,
  },
  {
    id: "gn-breaking-1d",
    kind: "rss",
    label: "Google News",
    target:
      "https://news.google.com/rss/search?q=%22breaking%22%20(stock%20OR%20shares)%20when:1d&hl=en-US&gl=US&ceid=US:en",
    weight: 4,
  },
  {
    id: "gn-wallstreet-1d",
    kind: "rss",
    label: "Google News",
    target:
      "https://news.google.com/rss/search?q=wall%20street%20when:1d&hl=en-US&gl=US&ceid=US:en",
    weight: 2,
  },
  {
    id: "gn-premarket-1d",
    kind: "rss",
    label: "Google News",
    target:
      "https://news.google.com/rss/search?q=premarket%20stocks%20when:1d&hl=en-US&gl=US&ceid=US:en",
    weight: 3,
  },
  {
    id: "yahoo-rssindex",
    kind: "rss",
    label: "Yahoo Finance",
    target: "https://finance.yahoo.com/news/rssindex",
    weight: 3,
  },
  {
    id: "cnbc-finance",
    kind: "rss",
    label: "CNBC",
    target:
      "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664",
    weight: 3,
  },
  {
    id: "cnbc-earnings",
    kind: "rss",
    label: "CNBC",
    target:
      "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839135",
    weight: 2,
  },
  {
    id: "cnbc-markets",
    kind: "rss",
    label: "CNBC",
    target:
      "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258",
    weight: 2,
  },
  {
    id: "investing-stocks",
    kind: "rss",
    label: "Investing.com",
    target: "https://www.investing.com/rss/news_25.rss",
    weight: 2,
  },
  {
    id: "marketwatch-top",
    kind: "rss",
    label: "MarketWatch",
    target: "https://feeds.content.dowjones.io/public/rss/mw_topstories",
    weight: 2,
  },
];

/** All enabled sources used by each news scan. */
export function getEnabledNewsSources(): NewsSource[] {
  return [...RSS_NEWS_SOURCES, ...YAHOO_SEARCH_SOURCES].filter((s) => s.enabled !== false);
}

/** First-paint sources — must return fast so News isn’t stuck on loading. */
export const QUICK_NEWS_SOURCE_IDS = [
  "gn-stocks-1d",
  "gn-stock-market-1d",
  "cnbc-finance",
  "ys-market-today",
  "ys-breaking",
  "ys-earnings",
  "yahoo-rssindex",
] as const;

export function getQuickNewsSources(): NewsSource[] {
  const want = new Set<string>(QUICK_NEWS_SOURCE_IDS);
  return getEnabledNewsSources().filter((s) => want.has(s.id));
}

/** Build yahoo-search sources for live day_gainer tickers (extra breaking coverage). */
export function tickerNewsSources(symbols: string[]): NewsSource[] {
  return symbols.slice(0, 40).map((sym) => ({
    id: `ys-ticker-${sym}`,
    kind: "yahoo-search" as const,
    label: "Yahoo Finance",
    target: sym,
    weight: 2,
  }));
}
