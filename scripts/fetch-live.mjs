#!/usr/bin/env node
/**
 * Live US day-trade scanner.
 *
 * IMPORTANT:
 * - Nasdaq.com screener % can lag and still show YESTERDAY's winners after the open.
 *   We only use it as a symbol universe, then recompute TODAY's % from Yahoo live quotes.
 * - Premarket tab = today's premarket / gap movers only.
 * - Gainers tab = today's regular-session (open market) gainers only.
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
    await new Promise((r) => setTimeout(r, attempt * 1200));
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
  const n = Number(String(v).replace(/[$,%]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function isCommonEquity(row) {
  const sym = row.symbol || "";
  const name = (row.name || "").toLowerCase();
  if (!sym || /[.=]/.test(sym)) return false;
  if (
    name.includes("warrant") ||
    name.includes(" unit") ||
    name.includes("right") ||
    name.includes("preferred")
  ) {
    return false;
  }
  if (/(WW|WS|WT|W)$/.test(sym) && sym.length >= 5) return false;
  return true;
}

async function fetchNasdaqUniverse() {
  const url =
    "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true";
  const data = await getJson(url, {
    Origin: "https://www.nasdaq.com",
    Referer: "https://www.nasdaq.com/",
  });
  const rows = data?.data?.rows;
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error("Nasdaq screener returned no rows");
  }
  return rows.filter(isCommonEquity).map((r) => ({
    symbol: r.symbol,
    name: r.name,
    // NOTE: these Nasdaq fields can be prior-session stale — never rank by them alone
    nasdaqPrice: parseMoney(r.lastsale),
    nasdaqPct: parseMoney(r.pctchange),
    nasdaqVolume: parseMoney(r.volume),
  }));
}

async function fetchYahooDayGainers(count = 50) {
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=${count}&scrIds=day_gainers&formatted=false`;
    const data = await getJson(url);
    return (data?.finance?.result?.[0]?.quotes || []).map((q) => q.symbol).filter(Boolean);
  } catch (err) {
    console.warn("Yahoo day_gainers unavailable:", err.message);
    return [];
  }
}

async function fetchYahooMostActives(count = 50) {
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=${count}&scrIds=most_actives&formatted=false`;
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
    Number(meta.regularMarketVolume) ||
    volumes.reduce((a, b) => a + b, 0) ||
    0;

  // Premarket: Yahoo may expose preMarket* during extended hours; otherwise use live last vs prev before the open.
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

  // Timestamp sanity: regularMarketTime should be today ET
  const tradeTimeMs = meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now();

  return {
    symbol,
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
    tradeTimeMs,
    name: meta.shortName || meta.longName || symbol,
  };
}

async function fetchLiveQuotes(symbols) {
  const map = new Map();
  const unique = [...new Set(symbols)].filter(Boolean);
  for (let i = 0; i < unique.length; i += 10) {
    const chunk = unique.slice(i, i + 10);
    const results = await Promise.all(
      chunk.map((s) => fetchLiveQuote(s).catch(() => null)),
    );
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

function toMover(q, changePct) {
  const dayHigh = Math.max(q.dayHigh || q.last, q.last);
  const hodDistancePct = dayHigh > 0 ? ((dayHigh - q.last) / dayHigh) * 100 : 0;
  return {
    symbol: q.symbol,
    name: q.name,
    price: q.last,
    changePct,
    change: q.last - q.prevClose,
    volume: q.volume,
    dayHigh,
    dayLow: q.dayLow || q.last,
    prevClose: q.prevClose,
    floatMillions: null,
    hodDistancePct,
    atHod: hodDistancePct <= HOD_TOLERANCE_PCT,
    updatedAt: new Date().toISOString(),
  };
}

function rank(movers, { minChangePct = 3, minPrice = 0.5, maxPrice = 100, minVolume = 1000, topN = 50 } = {}) {
  return movers
    .filter(
      (m) =>
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
  console.log(`Building TODAY's scanner (session=${session})…`);

  const [universe, yahooGainers, yahooActives, news] = await Promise.all([
    fetchNasdaqUniverse(),
    fetchYahooDayGainers(50),
    fetchYahooMostActives(50),
    fetchNews(40),
  ]);

  // Candidate pool: high Nasdaq volume + extreme prior % (may be stale) + Yahoo live lists
  const byVol = [...universe].sort((a, b) => b.nasdaqVolume - a.nasdaqVolume).slice(0, 120);
  const byPct = [...universe]
    .filter((r) => r.nasdaqPct >= 5)
    .sort((a, b) => b.nasdaqPct - a.nasdaqPct)
    .slice(0, 120);

  const candidateSymbols = [
    ...yahooGainers,
    ...yahooActives,
    ...byVol.map((r) => r.symbol),
    ...byPct.map((r) => r.symbol),
  ];

  console.log(`Enriching ${new Set(candidateSymbols).size} symbols with live Yahoo quotes…`);
  const live = await fetchLiveQuotes(candidateSymbols);
  const quotes = [...live.values()].filter((q) => isTodayEt(q.tradeTimeMs));

  if (quotes.length < 10) {
    throw new Error(
      `Too few live quotes for today (got ${quotes.length}). Refusing to publish stale data.`,
    );
  }

  // --- Premarket tab: today's gap / premarket % only ---
  let premarketMovers = [];
  if (session === "premarket") {
    premarketMovers = quotes.map((q) => {
      const pct =
        q.prePct != null
          ? q.prePct
          : q.dayChangePct; // before open, last print is effectively extended-hours
      const price = q.prePrice != null ? q.prePrice : q.last;
      return toMover({ ...q, last: price }, pct);
    });
  } else {
    // After the open: Premarket tab shows TODAY's gap (open vs prior close), not day gainers
    premarketMovers = quotes.map((q) => toMover(q, q.gapPct));
  }

  // --- Gainers tab: open-market (regular session) only ---
  let gainerMovers = [];
  if (session === "premarket") {
    gainerMovers = []; // market not open yet
  } else if (session === "closed") {
    gainerMovers = [];
  } else {
    // regular / afterhours: today's change vs prior close from LIVE last price
    gainerMovers = quotes.map((q) => toMover(q, q.dayChangePct));
  }

  const premarket = rank(premarketMovers, {
    minChangePct: session === "premarket" ? 2 : 3,
    minPrice: 0.5,
    maxPrice: 80,
    minVolume: session === "premarket" ? 500 : 5000,
    topN: 50,
  });

  const gainers = rank(gainerMovers, {
    minChangePct: 3,
    minPrice: 0.5,
    maxPrice: 500,
    minVolume: 10000,
    topN: 50,
  });

  if (session !== "premarket" && gainers.length === 0) {
    throw new Error("No live open-market gainers found for today");
  }

  const payload = {
    session,
    updatedAt: new Date().toISOString(),
    source: "live",
    news,
    premarket,
    gainers,
  };

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2));

  console.log(
    `Wrote ${OUT} — premarket=${premarket.length} gainers=${gainers.length} news=${news.length}`,
  );
  console.log(
    "Gainers:",
    gainers
      .slice(0, 8)
      .map((m) => `${m.symbol} ${m.changePct.toFixed(1)}%`)
      .join(", ") || "(none — premarket)",
  );
  console.log(
    "Premarket/gaps:",
    premarket
      .slice(0, 8)
      .map((m) => `${m.symbol} ${m.changePct.toFixed(1)}%`)
      .join(", ") || "(none)",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
