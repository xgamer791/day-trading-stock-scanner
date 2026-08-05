#!/usr/bin/env node
/**
 * Full US-market top-gainers scanner (Realtime Screener style).
 *
 * Sources:
 * 1) Nasdaq.com full all-exchange stock screener (~entire listed US equity market)
 * 2) Nasdaq.com LIVE Most Advanced movers (fresher % when available)
 * 3) Yahoo quotes for last / volume / day-high enrichment (display only)
 *
 * Ranking filter: top % gainers only. No HOD / price / volume gates.
 * Junk filter: warrants, units, rights, preferreds (same as typical retail screeners).
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "public", "data", "live.json");
const FEED_LIMIT = 20;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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

/** Drop warrants / units / rights / preferreds — keep common equities only. */
function isJunkSymbol(sym, name = "") {
  const s = String(sym || "").toUpperCase();
  const n = String(name || "").toLowerCase();
  if (!s || /[.=]/.test(s)) return true;
  if (/(WW|WS|WT|WR)$/.test(s)) return true;
  // 5+ char symbols ending in W are almost always warrants (ANSCW, MRNOW, …)
  if (s.length >= 5 && s.endsWith("W")) return true;
  if (s.length >= 5 && /[UZR]$/.test(s) && /(unit|right|warrant)/.test(n)) return true;
  if (n.includes("warrant") || n.includes(" right") || n.includes(" unit")) return true;
  if (n.includes("preferred") || n.includes(" preference")) return true;
  // Retail top-gainer screeners typically exclude ETFs / ETNs / funds
  if (/\betf\b|\betn\b|leveraged|direxion|proshares|graniteshares/.test(n)) return true;
  // Special share suffixes common on movers boards (e.g. HUBCZ)
  if (s.length >= 5 && s.endsWith("Z") && !n.includes("ordinary") && !n.includes("common")) {
    return true;
  }
  return false;
}

/**
 * Entire US listed equity market via Nasdaq.com composite screener
 * (NASDAQ + NYSE + NYSE American + Arca + etc.).
 */
async function fetchFullUsScreener() {
  const url =
    "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true";
  const data = await getJson(url, {
    Origin: "https://www.nasdaq.com",
    Referer: "https://www.nasdaq.com/",
  });
  const rows = data?.data?.rows || [];
  if (!rows.length) throw new Error("Full US screener returned 0 rows");

  const out = [];
  for (const r of rows) {
    if (isJunkSymbol(r.symbol, r.name)) continue;
    const changePct = parseMoney(r.pctchange);
    if (!Number.isFinite(changePct) || changePct <= 0) continue;
    out.push({
      symbol: String(r.symbol).replace("/", "-").toUpperCase(),
      name: r.name || String(r.symbol),
      price: parseMoney(r.lastsale),
      changePct,
      volume: parseMoney(r.volume),
      source: "full-us-screener",
    });
  }
  console.log(`Full US screener: ${rows.length} rows → ${out.length} common gainers`);
  return out;
}

/** Fresher Most Advanced list (same feed Realtime Screener mirrors). */
async function fetchMostAdvanced() {
  const url = "https://api.nasdaq.com/api/marketmovers?assetclass=stocks&limit=50";
  const data = await getJson(url, {
    Origin: "https://www.nasdaq.com",
    Referer: "https://www.nasdaq.com/",
  });
  const rows = data?.data?.STOCKS?.MostAdvanced?.table?.rows || [];
  const out = [];
  for (const r of rows) {
    if (isJunkSymbol(r.symbol, r.name)) continue;
    const changePct = parseMoney(r.change);
    if (!Number.isFinite(changePct) || changePct <= 0) continue;
    out.push({
      symbol: String(r.symbol).replace("/", "-").toUpperCase(),
      name: r.name || String(r.symbol),
      price: parseMoney(r.lastSalePrice),
      changePct,
      volume: parseMoney(r.volume),
      source: "most-advanced",
    });
  }
  console.log(`Most Advanced commons: ${out.length}`);
  return out;
}

async function fetchYahooQuote(symbol) {
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

  if (last <= 0 || prevClose <= 0) return null;

  const dayChangePct = ((last - prevClose) / prevClose) * 100;
  const gapPct = ((sessionOpen - prevClose) / prevClose) * 100;
  const hodDistancePct = dayHigh > 0 ? ((dayHigh - last) / dayHigh) * 100 : 0;

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
  };
}

async function fetchLiveQuotes(symbols) {
  const map = new Map();
  const unique = [...new Set(symbols)].filter(Boolean);
  console.log(`Enriching ${unique.length} top-gainer candidates…`);
  for (let i = 0; i < unique.length; i += 12) {
    const chunk = unique.slice(i, i + 12);
    const results = await Promise.all(chunk.map((s) => fetchYahooQuote(s).catch(() => null)));
    for (const q of results) {
      if (q?.symbol) map.set(q.symbol, q);
    }
  }
  return map;
}

function mergeUniverse(screener, advanced) {
  const bySym = new Map();
  // Full market first for breadth
  for (const r of screener) bySym.set(r.symbol, { ...r });
  // Live Most Advanced overwrites % / price when fresher
  for (const r of advanced) {
    const prev = bySym.get(r.symbol);
    bySym.set(r.symbol, {
      ...(prev || {}),
      ...r,
      volume: r.volume || prev?.volume || 0,
      name: r.name || prev?.name || r.symbol,
    });
  }
  return [...bySym.values()].sort((a, b) => b.changePct - a.changePct);
}

function toMover(seed, q = null) {
  const price = q?.last > 0 ? q.last : seed.price;
  const prevClose = q?.prevClose > 0 ? q.prevClose : price / (1 + seed.changePct / 100);
  const dayHigh = q?.dayHigh > 0 ? Math.max(q.dayHigh, price) : price;
  const dayLow = q?.dayLow > 0 ? q.dayLow : price;
  const volume = q?.volume > 0 ? q.volume : seed.volume || 0;
  const changePct =
    q && Number.isFinite(q.dayChangePct) && q.dayChangePct !== 0
      ? // Prefer Nasdaq screener/Most Advanced % for ranking parity with Realtime
        seed.changePct
      : seed.changePct;
  const hodDistancePct = dayHigh > 0 ? ((dayHigh - price) / dayHigh) * 100 : 0;

  return {
    symbol: seed.symbol,
    name: q?.name || seed.name,
    price,
    changePct,
    change: price - prevClose,
    volume,
    dayHigh,
    dayLow,
    prevClose,
    floatMillions: null,
    hodDistancePct,
    atHod: hodDistancePct <= 2,
    updatedAt: new Date().toISOString(),
  };
}

function topGainers(rows, limit = FEED_LIMIT) {
  return [...rows]
    .filter((m) => Number.isFinite(m.changePct) && m.changePct > 0 && m.price > 0)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, limit);
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
  console.log(`Full US top-gainers scan (session=${session})…`);

  const [screener, advanced, news] = await Promise.all([
    fetchFullUsScreener(),
    fetchMostAdvanced(),
    fetchNews(40),
  ]);

  const merged = mergeUniverse(screener, advanced);
  if (merged.length < 10) throw new Error(`Too few gainers after merge (${merged.length})`);

  // Pull enough headroom so Yahoo enrichment can't shrink the visible top 20
  const candidates = merged.slice(0, 60);
  const quotes = await fetchLiveQuotes(candidates.map((c) => c.symbol));

  let premarket = [];
  let gainers = [];

  if (session === "premarket") {
    const rows = candidates.map((seed) => {
      const q = quotes.get(seed.symbol);
      if (q && (q.prePct != null || q.dayChangePct != null)) {
        const pct = q.prePct != null ? q.prePct : q.dayChangePct;
        const price = q.prePrice != null ? q.prePrice : q.last;
        return toMover({ ...seed, changePct: pct, price }, { ...q, last: price, dayChangePct: pct });
      }
      return toMover(seed, q);
    });
    premarket = topGainers(rows);
    gainers = [];
  } else if (session === "closed") {
    premarket = [];
    gainers = [];
  } else {
    // Regular / after-hours: full-market top % gainers (Realtime Screener style)
    const rows = candidates.map((seed) => toMover(seed, quotes.get(seed.symbol)));
    gainers = topGainers(rows);

    // Premarket panel shows gap leaders from the same full-market set
    const gaps = candidates.map((seed) => {
      const q = quotes.get(seed.symbol);
      if (q) return toMover({ ...seed, changePct: q.gapPct, price: q.last }, q);
      return toMover(seed, null);
    });
    premarket = topGainers(gaps);
  }

  if (session !== "premarket" && session !== "closed" && gainers.length === 0) {
    throw new Error("No top gainers after full US scan");
  }

  let coverage = null;
  try {
    coverage = JSON.parse(
      await readFile(path.join(ROOT, "public", "data", "coverage.json"), "utf8"),
    );
  } catch {
    /* optional */
  }

  let universeCount = coverage?.totals?.uniqueSymbols || screener.length;
  try {
    const uni = JSON.parse(
      await readFile(path.join(ROOT, "public", "data", "universe.json"), "utf8"),
    );
    if (Array.isArray(uni.symbols)) universeCount = uni.symbols.length;
  } catch {
    /* optional */
  }

  const payload = {
    session,
    updatedAt: new Date().toISOString(),
    source: "full-us-market",
    feedLimit: FEED_LIMIT,
    universeCount,
    marketsScreened: coverage?.marketsScreened || [
      "NASDAQ",
      "NYSE",
      "NYSE American (AMEX)",
      "NYSE Arca",
      "Cboe BZX",
      "IEX",
    ],
    news,
    premarket,
    gainers,
  };

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2));

  console.log(`Wrote ${OUT} — top${FEED_LIMIT} gainers=${gainers.length} pre=${premarket.length}`);
  console.log(
    "Top gainers:",
    gainers.map((m) => `${m.symbol} ${m.changePct.toFixed(1)}%`).join(", ") || "(none)",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
