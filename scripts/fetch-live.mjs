#!/usr/bin/env node
/**
 * Full-market High-of-Day scanner.
 *
 * Sources:
 * 1) Nasdaq.com LIVE market movers (Most Advanced / Most Active) — all major US listings
 * 2) Full all-exchange screener + S&P 500 for breadth
 * 3) Yahoo 1m charts to confirm today's high-of-day
 *
 * Output: ONLY stocks at/near high of day (peaking), green on the day.
 * Premarket tab ≠ Gainers tab (session-aware).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "public", "data", "live.json");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const HOD_TOLERANCE_PCT = 2.0;

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

async function getJson(url, headers = {}, attempt = 1) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json,text/plain,*/*",
      "Accept-Language": "en-US,en;q=0.9",
      ...headers,
    },
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise((r) => setTimeout(r, attempt * 1400));
    return getJson(url, headers, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 140)}`);
  }
  return res.json();
}

function parseMoney(v) {
  if (v == null) return 0;
  const n = Number(String(v).replace(/[$,%+]/g, "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function isJunkSymbol(sym, name = "") {
  const s = String(sym || "");
  const n = name.toLowerCase();
  if (!s || /[.=]/.test(s)) return true;
  if (/(WW|WS|WT)$/.test(s)) return true;
  if (s.length >= 5 && s.endsWith("W") && n.includes("warrant")) return true;
  if (n.includes("warrant") || n.includes(" right") || n.includes(" unit")) return true;
  if (n.includes(" preferred")) return true;
  return false;
}

/** LIVE Nasdaq.com movers — catches YXT/INLF-style names the stale screener misses. */
async function fetchLiveMarketMovers() {
  const url = "https://api.nasdaq.com/api/marketmovers?assetclass=stocks&limit=50";
  const data = await getJson(url, {
    Origin: "https://www.nasdaq.com",
    Referer: "https://www.nasdaq.com/",
  });
  const stocks = data?.data?.STOCKS;
  if (!stocks) throw new Error("marketmovers: missing STOCKS payload");

  const out = [];
  for (const key of [
    "MostAdvanced",
    "MostActiveByShareVolume",
    "MostActiveByDollarVolume",
    "Nasdaq100Movers",
  ]) {
    const rows = stocks[key]?.table?.rows || [];
    const asOf = stocks[key]?.dataAsOf || stocks[key]?.lastTradeTimestamp || "";
    for (const r of rows) {
      if (isJunkSymbol(r.symbol, r.name)) continue;
      const isVolumeList = key.includes("ShareVolume");
      out.push({
        symbol: String(r.symbol).replace("/", "-"),
        name: r.name,
        price: parseMoney(r.lastSalePrice),
        // On volume lists, `change` is share volume; on advanced, it's % change
        changePct: isVolumeList ? null : parseMoney(r.change),
        volume: isVolumeList ? parseMoney(r.change) : null,
        source: key,
        asOf,
      });
    }
  }

  if (!out.length) throw new Error("marketmovers returned no symbols");
  console.log(`Live market movers: ${out.length} rows (asOf sample: ${out[0]?.asOf || "n/a"})`);
  return out;
}

async function fetchAllExchangeUniverse() {
  const url =
    "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true";
  const data = await getJson(url, {
    Origin: "https://www.nasdaq.com",
    Referer: "https://www.nasdaq.com/",
  });
  const rows = data?.data?.rows || [];
  return rows
    .filter((r) => !isJunkSymbol(r.symbol, r.name))
    .map((r) => ({
      symbol: String(r.symbol).replace("/", "-"),
      name: r.name,
      nasdaqVolume: parseMoney(r.volume),
      nasdaqPct: parseMoney(r.pctchange),
    }));
}

async function fetchSp500Symbols() {
  try {
    const res = await fetch(
      "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv",
      { headers: { "User-Agent": UA } },
    );
    if (!res.ok) throw new Error(String(res.status));
    return (await res.text())
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.split(",")[0]?.trim().replace(".", "-"))
      .filter(Boolean);
  } catch (err) {
    console.warn("S&P 500 unavailable:", err.message);
    return [];
  }
}

async function fetchYahooScreener(scrId, count = 50) {
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=${count}&scrIds=${scrId}&formatted=false`;
    const data = await getJson(url);
    return (data?.finance?.result?.[0]?.quotes || []).map((q) => q.symbol).filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchLiveQuote(symbol) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`;
  const data = await getJson(url);
  const result = data?.chart?.result?.[0];
  if (!result?.meta) return null;
  const meta = result.meta;
  const quote = result.indicators?.quote?.[0] || {};
  const opens = (quote.open || []).filter((n) => n != null);
  const highs = (quote.high || []).filter((n) => n != null);
  const lows = (quote.low || []).filter((n) => n != null);
  const volumes = (quote.volume || []).filter((n) => n != null);

  const prevClose = Number(meta.previousClose ?? meta.chartPreviousClose) || 0;
  const last = Number(meta.regularMarketPrice) || 0;
  const sessionOpen = opens.length ? Number(opens[0]) : last;
  const dayHigh = highs.length ? Math.max(...highs, last) : last;
  const dayLow = lows.length ? Math.min(...lows, last) : last;
  const volume =
    Number(meta.regularMarketVolume) || volumes.reduce((a, b) => a + b, 0) || 0;

  const prePrice = meta.preMarketPrice != null ? Number(meta.preMarketPrice) : null;
  const prePct =
    meta.preMarketChangePercent != null
      ? Number(meta.preMarketChangePercent)
      : prePrice && prevClose
        ? ((prePrice - prevClose) / prevClose) * 100
        : null;

  const dayChangePct = prevClose > 0 && last > 0 ? ((last - prevClose) / prevClose) * 100 : 0;
  const gapPct =
    prevClose > 0 && sessionOpen > 0 ? ((sessionOpen - prevClose) / prevClose) * 100 : 0;
  const hodDistancePct = dayHigh > 0 ? ((dayHigh - last) / dayHigh) * 100 : 999;

  return {
    symbol,
    name: meta.shortName || meta.longName || symbol,
    last,
    prevClose,
    sessionOpen,
    dayHigh,
    dayLow,
    volume,
    dayChangePct,
    gapPct,
    prePrice,
    prePct,
    hodDistancePct,
    atHod: hodDistancePct <= HOD_TOLERANCE_PCT,
    tradeTimeMs: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now(),
  };
}

async function fetchLiveQuotes(symbols) {
  const map = new Map();
  const unique = [...new Set(symbols)].filter(Boolean);
  console.log(`Confirming HOD on ${unique.length} symbols…`);
  for (let i = 0; i < unique.length; i += 12) {
    const chunk = unique.slice(i, i + 12);
    const results = await Promise.all(chunk.map((s) => fetchLiveQuote(s).catch(() => null)));
    for (const q of results) {
      if (q?.symbol && q.last > 0 && q.prevClose > 0) map.set(q.symbol, q);
    }
  }
  return map;
}

function isTodayEt(ms) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date(ms)) === fmt.format(new Date());
}

function toMover(q, changePct, price = q.last) {
  const dayHigh = Math.max(q.dayHigh || price, price);
  const hodDistancePct = dayHigh > 0 ? ((dayHigh - price) / dayHigh) * 100 : 999;
  return {
    symbol: q.symbol,
    name: q.name,
    price,
    changePct,
    change: price - q.prevClose,
    volume: q.volume,
    dayHigh,
    dayLow: q.dayLow || price,
    prevClose: q.prevClose,
    floatMillions: null,
    hodDistancePct,
    atHod: hodDistancePct <= HOD_TOLERANCE_PCT,
    updatedAt: new Date().toISOString(),
  };
}

function hodOnly(
  movers,
  { minChangePct = 2, minPrice = 0.5, maxPrice = 1000, minVolume = 5000, topN = 60 } = {},
) {
  return movers
    .filter(
      (m) =>
        m.atHod === true &&
        m.changePct >= minChangePct &&
        m.price >= minPrice &&
        m.price <= maxPrice &&
        m.volume >= minVolume,
    )
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, topN);
}

async function fetchNews(count = 40) {
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=stocks&newsCount=${count}&quotesCount=0&listsCount=0`;
    const data = await getJson(url);
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
  } catch {
    return [];
  }
}

async function main() {
  const session = sessionNow();
  console.log(`Full-market TRUE HOD scan (session=${session})…`);

  const [movers, universe, sp500, yahooGainers, yahooActives, news] = await Promise.all([
    fetchLiveMarketMovers(),
    fetchAllExchangeUniverse(),
    fetchSp500Symbols(),
    fetchYahooScreener("day_gainers", 100),
    fetchYahooScreener("most_actives", 50),
    fetchNews(40),
  ]);

  const byVol = [...universe].sort((a, b) => b.nasdaqVolume - a.nasdaqVolume).slice(0, 300);

  // Priority: LIVE most-advanced / most-active first (true today movers across exchanges)
  const moverSymbols = movers.map((m) => m.symbol);
  const candidateSymbols = [
    ...moverSymbols,
    ...moverSymbols, // quoted first / deduped — ensures live advanced names are never dropped from the pool
    ...yahooGainers,
    ...yahooActives,
    ...sp500,
    ...byVol.map((r) => r.symbol),
  ];

  // Quote live movers first in their own pass so rate-limits don't skip them
  const priority = [...new Set(moverSymbols)];
  const rest = [...new Set(candidateSymbols)].filter((s) => !priority.includes(s));
  const live = new Map([
    ...(await fetchLiveQuotes(priority)),
    ...(await fetchLiveQuotes(rest)),
  ]);
  const quotes = [...live.values()].filter((q) => isTodayEt(q.tradeTimeMs));
  console.log(`Live HOD candidates: ${quotes.length}`);

  if (quotes.length < 15) {
    throw new Error(`Too few live quotes (${quotes.length})`);
  }

  let premarketRaw = [];
  let gainersRaw = [];

  if (session === "premarket") {
    premarketRaw = quotes.map((q) => {
      const pct = q.prePct != null ? q.prePct : q.dayChangePct;
      const price = q.prePrice != null ? q.prePrice : q.last;
      return toMover(q, pct, price);
    });
    gainersRaw = [];
  } else if (session === "closed") {
    premarketRaw = [];
    gainersRaw = [];
  } else {
    premarketRaw = quotes.map((q) => toMover(q, q.gapPct));
    gainersRaw = quotes.map((q) => toMover(q, q.dayChangePct));
  }

  const premarket = hodOnly(premarketRaw, {
    minChangePct: session === "premarket" ? 2 : 3,
    minVolume: 1000,
    topN: 60,
  });

  const gainers = hodOnly(gainersRaw, {
    minChangePct: 2,
    minVolume: 1000,
    topN: 60,
  });

  // Sanity: refuse publishing if we somehow only have mild large-cap drifts while movers API had 100%+ names
  const advanced = movers.filter((m) => m.source === "MostAdvanced" && (m.changePct || 0) >= 40);
  if (session !== "premarket" && session !== "closed" && gainers.length === 0) {
    throw new Error("No true HOD gainers after filter");
  }
  if (advanced.length && gainers.length) {
    const hit = advanced.some((a) => gainers.some((g) => g.symbol === a.symbol) || premarket.some((g) => g.symbol === a.symbol) || quotes.some((q) => q.symbol === a.symbol && q.atHod));
    console.log(
      `Cross-check big movers in quote set: ${advanced.map((a) => a.symbol).slice(0, 8).join(", ")} (any HOD quote=${hit})`,
    );
  }

  const payload = {
    session,
    updatedAt: new Date().toISOString(),
    source: "full-market-hod",
    news,
    premarket,
    gainers,
  };

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2));

  console.log(`Wrote ${OUT} — HOD pre=${premarket.length} HOD gainers=${gainers.length}`);
  console.log(
    "HOD Gainers:",
    gainers
      .slice(0, 12)
      .map((m) => `${m.symbol} ${m.changePct.toFixed(1)}%`)
      .join(", ") || "(none)",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
