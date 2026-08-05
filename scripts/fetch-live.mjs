#!/usr/bin/env node
/**
 * Fetch live US equity gainers + news from Yahoo Finance (no API key).
 * Writes public/data/live.json for the static GitHub Pages app.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "public", "data", "live.json");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const HOD_TOLERANCE_PCT = 0.5;

function sessionNow(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  if (["Sat", "Sun"].includes(weekday)) return "closed";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const mins = hour * 60 + minute;
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "premarket";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "regular";
  if (mins >= 16 * 60 && mins < 20 * 60) return "afterhours";
  return "closed";
}

async function yahooGet(url, attempt = 1) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json,text/plain,*/*",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (res.status === 429 && attempt < 4) {
    await new Promise((r) => setTimeout(r, attempt * 1500));
    return yahooGet(url, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Yahoo ${res.status}: ${body.slice(0, 180)}`);
  }
  return res.json();
}

async function fetchScreener(scrId, count = 50) {
  const url = `https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=${count}&scrIds=${encodeURIComponent(scrId)}&formatted=false`;
  const data = await yahooGet(url);
  const result = data?.finance?.result?.[0];
  if (!result?.quotes) {
    const err = data?.finance?.error?.description || "no quotes";
    throw new Error(`Screener ${scrId}: ${err}`);
  }
  return result.quotes;
}

async function fetchNews(count = 40) {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=stocks&newsCount=${count}&quotesCount=0&listsCount=0`;
  const data = await yahooGet(url);
  return (data.news || []).map((n, i) => ({
    id: n.uuid || `news-${i}`,
    title: n.title,
    publisher: n.publisher || "Yahoo Finance",
    publishedAt: n.providerPublishTime
      ? new Date(n.providerPublishTime * 1000).toISOString()
      : new Date().toISOString(),
    url: n.link || "https://finance.yahoo.com/news/",
    tickers: (n.relatedTickers || []).slice(0, 6),
    summary: n.summary,
  }));
}

function toMover(q, mode) {
  const symbol = q.symbol;
  if (!symbol) return null;

  const prevClose = Number(q.regularMarketPreviousClose) || 0;
  const dayHigh = Number(q.regularMarketDayHigh) || 0;
  const dayLow = Number(q.regularMarketDayLow) || 0;
  const volume = Number(q.regularMarketVolume) || 0;

  let price;
  let changePct;
  let change;

  if (mode === "premarket" && q.preMarketPrice != null) {
    price = Number(q.preMarketPrice);
    changePct = Number(q.preMarketChangePercent) || 0;
    change = Number(q.preMarketChange) || price - prevClose;
  } else if (mode === "afterhours" && q.postMarketPrice != null) {
    price = Number(q.postMarketPrice);
    changePct = Number(q.postMarketChangePercent) || 0;
    change = Number(q.postMarketChange) || 0;
  } else {
    price = Number(q.regularMarketPrice) || 0;
    changePct = Number(q.regularMarketChangePercent) || 0;
    change = Number(q.regularMarketChange) || 0;
  }

  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(prevClose) || prevClose <= 0) return null;

  const high = Math.max(dayHigh || 0, price);
  const hodDistancePct = high > 0 ? ((high - price) / high) * 100 : 0;
  const atHod = hodDistancePct <= HOD_TOLERANCE_PCT;

  return {
    symbol,
    name: q.displayName || q.shortName || q.longName,
    price,
    changePct,
    change,
    volume,
    dayHigh: high,
    dayLow: dayLow || price,
    prevClose,
    hodDistancePct,
    atHod,
    updatedAt: new Date().toISOString(),
  };
}

function rankMovers(quotes, mode, opts = {}) {
  const {
    minChangePct = 1,
    minPrice = 0.5,
    maxPrice = 1000,
    minVolume = 1000,
    preferHod = false,
    topN = 50,
  } = opts;

  const movers = quotes
    .map((q) => toMover(q, mode))
    .filter(Boolean)
    .filter(
      (m) =>
        m.changePct >= minChangePct &&
        m.price >= minPrice &&
        m.price <= maxPrice &&
        m.volume >= minVolume,
    );

  movers.sort((a, b) => {
    if (preferHod && a.atHod !== b.atHod) return a.atHod ? -1 : 1;
    return b.changePct - a.changePct;
  });

  return movers.slice(0, topN);
}

async function main() {
  const session = sessionNow();
  console.log(`Fetching Yahoo live data (session=${session})…`);

  const [gainersQuotes, activesQuotes, news] = await Promise.all([
    fetchScreener("day_gainers", 50),
    fetchScreener("most_actives", 50).catch(() => []),
    fetchNews(40).catch(() => []),
  ]);

  // Universe for both panels — real Yahoo movers
  const universe = [...gainersQuotes, ...activesQuotes];
  const seen = new Set();
  const deduped = [];
  for (const q of universe) {
    if (!q?.symbol || seen.has(q.symbol)) continue;
    seen.add(q.symbol);
    deduped.push(q);
  }

  // Premarket panel: rank by premarket % when quotes have it; else regular % in the daytrade price band.
  const hasPremarket = deduped.some((q) => q.preMarketPrice != null);
  const premarket = rankMovers(deduped, hasPremarket ? "premarket" : "regular", {
    minChangePct: hasPremarket ? 1 : 3,
    maxPrice: 150,
    preferHod: false,
    topN: 50,
  });

  // Market panel: always Yahoo "Day Gainers" using regular session stats (matches Yahoo / reference scanners)
  const gainers = rankMovers(gainersQuotes, "regular", {
    minChangePct: 1,
    preferHod: false,
    topN: 50,
  });

  if (gainers.length === 0) {
    throw new Error("No live gainers returned from Yahoo — aborting demo fallback");
  }

  const payload = {
    session,
    updatedAt: new Date().toISOString(),
    source: "yahoo",
    news,
    premarket,
    gainers,
  };

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log(
    `Wrote ${OUT} — news=${news.length} premarket=${premarket.length} gainers=${gainers.length}`,
  );
  console.log(
    "Top gainers:",
    gainers
      .slice(0, 8)
      .map((m) => `${m.symbol} ${m.changePct.toFixed(1)}%${m.atHod ? " HOD" : ""}`)
      .join(", "),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
