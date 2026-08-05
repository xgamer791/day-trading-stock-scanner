export type MarketSession = "premarket" | "regular" | "afterhours" | "closed";

export type StockMover = {
  symbol: string;
  name?: string;
  price: number;
  changePct: number;
  change: number;
  volume: number;
  dayHigh: number;
  dayLow: number;
  prevClose: number;
  floatMillions?: number | null;
  /** % below day high (0 = at HOD) */
  hodDistancePct: number;
  /** % gain at day high vs previous close — true HOD % */
  hodGainPct?: number;
  /** True when price is at/near high of day */
  atHod: boolean;
  updatedAt: string;
};

export type NewsItem = {
  id: string;
  title: string;
  publisher: string;
  publishedAt: string;
  url: string;
  tickers: string[];
  summary?: string;
};

export type ScannerPayload = {
  session: MarketSession;
  updatedAt: string;
  source: "full-us-market" | "full-us-realtime" | "full-market-hod" | "live" | "nasdaq" | "yahoo" | "polygon";
  feedLimit?: number;
  universeCount?: number;
  marketsScreened?: string[];
  news: NewsItem[];
  premarket: StockMover[];
  gainers: StockMover[];
};
