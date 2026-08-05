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
  /** Distance from high of day as a fraction (0 = at HOD) */
  hodDistancePct: number;
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
  source: "full-market-hod" | "live" | "nasdaq" | "yahoo" | "polygon";
  news: NewsItem[];
  premarket: StockMover[];
  gainers: StockMover[];
};
