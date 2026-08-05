#!/usr/bin/env node
/**
 * Live US equity scanner for day-trade HOD / premarket runners.
 *
 * Primary universe: Nasdaq.com full stock screener (no $2B market-cap floor).
 * Yahoo "day_gainers" is intentionally NOT used — it requires marketCap >= $2B
 * and price >= $5, which hides the low-float runners day-trading apps show.
 *
 * Enrichment: Yahoo quote batch for day high / premarket / float when available.
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
    throw new Error(`HTTP ${res.status} ${url}: ${body.slice(0, 160)}`);
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
  // Typical warrant/unit tickers: EOSEW, SHFSW, XXXWW
  if (/(WW|WS|WT|W)$/.test(sym) && sym.length >= 5) return false;
  if (sym.endsWith("U") && name.includes("unit")) return false;
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
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Nasdaq screener returned no rows");
  }
  return rows
    .filter(isCommonEquity)
    .map((r) => ({
      symbol: r.symbol,
      name: r.name,
      price: parseMoney(r.lastsale),
      changePct: parseMoney(r.pctchange),
      change: parseMoney(r.netchange),
      volume: parseMoney(r.volume),
      marketCap: parseMoney(r.marketCap),
    }))
    .filter((r) => r.symbol && r.price > 0);
}

async function fetchYahooQuotes(symbols) {
  if (!symbols.length) return new Map();
  const map = new Map();
  const targets = symbols.slice(0, 30);

  const fetchOne = async (symbol) => {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
    const data = await getJson(url);
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return;
    const highs = result?.indicators?.quote?.[0]?.high?.filter((n) => n != null) || [];
    const lows = result?.indicators?.quote?.[0]?.low?.filter((n) => n != null) || [];
    map.set(symbol, {
      symbol,
      regularMarketPrice: meta.regularMarketPrice,
      regularMarketPreviousClose: meta.previousClose ?? meta.chartPreviousClose,
      regularMarketDayHigh: highs.length ? Math.max(...highs) : meta.regularMarketPrice,
      regularMarketDayLow: lows.length ? Math.min(...lows) : meta.regularMarketPrice,
      regularMarketVolume: meta.regularMarketVolume,
      preMarketPrice: meta.preMarketPrice,
      preMarketChangePercent: meta.preMarketChangePercent,
      postMarketPrice: meta.postMarketPrice,
      postMarketChangePercent: meta.postMarketChangePercent,
    });
  };

  // Limited concurrency to avoid rate limits
  for (let i = 0; i < targets.length; i += 8) {
    const chunk = targets.slice(i, i + 8);
    await Promise.all(chunk.map((s) => fetchOne(s).catch(() => null)));
  }
  return map;
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
  } catch (err) {
    console.warn("News fetch failed:", err.message);
    return [];
  }
}

function enrichMover(base, yahoo, mode) {
  const y = yahoo?.get(base.symbol);
  let price = base.price;
  let changePct = base.changePct;
  let change = base.change;
  let volume = base.volume;
  let dayHigh = price;
  let dayLow = price;
  let prevClose = price / (1 + changePct / 100);
  let floatMillions = null;

  if (y) {
    prevClose = Number(y.regularMarketPreviousClose) || prevClose;
    dayHigh = Number(y.regularMarketDayHigh) || dayHigh;
    dayLow = Number(y.regularMarketDayLow) || dayLow;
    volume = Number(y.regularMarketVolume) || volume;
    if (y.floatShares) floatMillions = Number(y.floatShares) / 1e6;

    if (mode === "premarket" && y.preMarketPrice != null) {
      price = Number(y.preMarketPrice);
      changePct = Number(y.preMarketChangePercent) || changePct;
      change = Number(y.preMarketChange) || price - prevClose;
    } else if (mode === "afterhours" && y.postMarketPrice != null) {
      price = Number(y.postMarketPrice);
      changePct = Number(y.postMarketChangePercent) || changePct;
    } else if (y.regularMarketPrice != null) {
      price = Number(y.regularMarketPrice);
      // Keep Nasdaq % as primary for ranking consistency with full-market movers;
      // fall back to Yahoo % only if Nasdaq missing
      if (!Number.isFinite(changePct) || changePct === 0) {
        changePct =
          ((price - prevClose) / prevClose) * 100 ||
          Number(y.regularMarketChangePercent) ||
          0;
      }
    }
    dayHigh = Math.max(dayHigh, price);
  }

  const hodDistancePct = dayHigh > 0 ? ((dayHigh - price) / dayHigh) * 100 : 0;
  const atHod = hodDistancePct <= HOD_TOLERANCE_PCT;

  return {
    symbol: base.symbol,
    name: base.name || y?.shortName,
    price,
    changePct,
    change,
    volume,
    dayHigh,
    dayLow,
    prevClose,
    floatMillions,
    hodDistancePct,
    atHod,
    updatedAt: new Date().toISOString(),
  };
}

function rank(list, { minChangePct = 3, minPrice = 0.5, maxPrice = 100, minVolume = 1000, topN = 50 } = {}) {
  return list
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

async function main() {
  const session = sessionNow();
  console.log(`Fetching full-market movers (session=${session})…`);

  const [universe, news] = await Promise.all([fetchNasdaqUniverse(), fetchNews(40)]);

  // Top candidates by Nasdaq % — includes micro/low-float names Yahoo hides
  const candidates = [...universe]
    .filter((r) => r.changePct >= 3 && r.price >= 0.5 && r.price <= 150)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 120);

  if (candidates.length === 0) {
    throw new Error("No live gainers found in Nasdaq universe");
  }

  const yahoo = await fetchYahooQuotes(candidates.map((c) => c.symbol));

  const preMode = session === "premarket" ? "premarket" : "regular";
  const enriched = candidates.map((c) => enrichMover(c, yahoo, preMode));

  // Premarket panel: use premarket quotes when available, else Nasdaq %
  const premarketEnriched = candidates.map((c) =>
    enrichMover(c, yahoo, session === "premarket" ? "premarket" : "regular"),
  );

  const gainers = rank(enriched, {
    minChangePct: 5,
    minPrice: 0.5,
    maxPrice: 100,
    minVolume: 1000,
    topN: 50,
  });

  const premarket = rank(premarketEnriched, {
    minChangePct: session === "premarket" ? 2 : 5,
    minPrice: 0.5,
    maxPrice: 50,
    minVolume: 500,
    topN: 50,
  });

  if (gainers.length === 0) {
    throw new Error("No live gainers after filters");
  }

  const payload = {
    session,
    updatedAt: new Date().toISOString(),
    source: "nasdaq",
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
      .slice(0, 10)
      .map(
        (m) =>
          `${m.symbol} ${m.changePct.toFixed(1)}%${m.atHod ? " HOD" : ""}${m.floatMillions ? ` flt=${m.floatMillions.toFixed(1)}M` : ""}`,
      )
      .join(", "),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
