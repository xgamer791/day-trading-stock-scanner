import { filterHodGainers, getMarketSession, toMover } from "./market";
import type { NewsItem, ScannerPayload, StockMover } from "./types";

const DEMO_SEED = [
  ["NVDA", "NVIDIA Corp", 128.42, 118.1, 128.55, 117.2, 48_200_000],
  ["SMCI", "Super Micro", 62.18, 51.4, 62.3, 50.9, 22_100_000],
  ["IONQ", "IonQ Inc", 18.75, 14.2, 18.82, 14.0, 31_400_000],
  ["SOUN", "SoundHound", 9.42, 7.1, 9.45, 6.95, 55_800_000],
  ["RKLB", "Rocket Lab", 24.1, 20.5, 24.18, 20.1, 18_600_000],
  ["PLTR", "Palantir", 41.05, 37.8, 41.2, 37.5, 62_000_000],
  ["MARA", "Marathon Digital", 22.6, 18.9, 22.7, 18.4, 40_200_000],
  ["RIOT", "Riot Platforms", 14.8, 12.4, 14.85, 12.1, 28_900_000],
  ["HOOD", "Robinhood", 38.2, 34.1, 38.35, 33.8, 19_500_000],
  ["ASTS", "AST SpaceMobile", 31.4, 24.6, 31.55, 24.2, 26_700_000],
  ["OPEN", "Opendoor", 2.85, 2.1, 2.87, 2.05, 120_000_000],
  ["ACHR", "Archer Aviation", 5.62, 4.4, 5.65, 4.3, 44_000_000],
] as const;

function jitter(n: number, pct = 0.004): number {
  return n * (1 + (Math.random() * 2 - 1) * pct);
}

function buildDemoMovers(atPeakRatio = 0.75): StockMover[] {
  const movers: StockMover[] = [];
  for (const [symbol, name, price, prev, high, low, vol] of DEMO_SEED) {
    const atPeak = Math.random() < atPeakRatio;
    const livePrice = atPeak
      ? jitter(high, 0.0015)
      : jitter(price * 0.97, 0.01);
    const m = toMover({
      symbol,
      name,
      price: livePrice,
      prevClose: prev,
      dayHigh: Math.max(high, livePrice),
      dayLow: low,
      volume: Math.round(jitter(vol, 0.05)),
      updatedAt: new Date().toISOString(),
    });
    if (m) movers.push(m);
  }
  // Add a few non-HOD gainers that should be filtered out
  const decoy = toMover({
    symbol: "FAKE",
    name: "Should Filter",
    price: 10,
    prevClose: 8,
    dayHigh: 12,
    dayLow: 8,
    volume: 5_000_000,
  });
  if (decoy) movers.push(decoy);
  return movers;
}

const DEMO_NEWS: Omit<NewsItem, "publishedAt" | "id">[] = [
  {
    title: "SMCI surges on AI server demand; analysts raise targets",
    publisher: "Reuters",
    url: "https://example.com/smci",
    tickers: ["SMCI"],
    summary: "Super Micro shares hit session highs as cloud customers expand GPU racks.",
  },
  {
    title: "IONQ jumps after quantum computing partnership rumor",
    publisher: "Bloomberg",
    url: "https://example.com/ionq",
    tickers: ["IONQ"],
  },
  {
    title: "SOUN gaps up on enterprise voice AI contract",
    publisher: "Benzinga",
    url: "https://example.com/soun",
    tickers: ["SOUN"],
  },
  {
    title: "ASTS climbs as satellite broadband demo approaches",
    publisher: "MarketWatch",
    url: "https://example.com/asts",
    tickers: ["ASTS"],
  },
  {
    title: "OPEN squeezes on short interest and housing data",
    publisher: "CNBC",
    url: "https://example.com/open",
    tickers: ["OPEN"],
  },
  {
    title: "Futures steady; traders watch CPI and Fed speakers",
    publisher: "Dow Jones",
    url: "https://example.com/macro",
    tickers: ["SPY", "QQQ"],
  },
  {
    title: "RKLB volume spikes ahead of launch window",
    publisher: "The Fly",
    url: "https://example.com/rklb",
    tickers: ["RKLB"],
  },
  {
    title: "MARA and RIOT track bitcoin rebound into the open",
    publisher: "CoinDesk",
    url: "https://example.com/crypto-miners",
    tickers: ["MARA", "RIOT"],
  },
];

export function getDemoScanner(): ScannerPayload {
  const all = buildDemoMovers();
  const hod = filterHodGainers(all, { minChangePct: 2, minVolume: 1000 });

  const news: NewsItem[] = DEMO_NEWS.map((n, i) => ({
    ...n,
    id: `demo-${i}`,
    publishedAt: new Date(Date.now() - i * 90_000 - Math.random() * 60_000).toISOString(),
  }));

  return {
    session: getMarketSession(),
    updatedAt: new Date().toISOString(),
    source: "demo",
    news,
    // Center: premarket-style HOD runners (lower price bias)
    premarket: hod.filter((m) => m.price < 80).slice(0, 25),
    // Right: broader market HOD top gainers
    gainers: hod.slice(0, 25),
  };
}
