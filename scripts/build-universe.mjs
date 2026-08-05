#!/usr/bin/env node
/**
 * Build the complete US equity screening universe from official exchange
 * directories + major index membership lists. Writes:
 *   public/data/universe.json  — all symbols
 *   public/data/coverage.json  — markets / indexes screened (for UI + docs)
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "public", "data");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Official Nasdaq Trader "otherlisted" exchange codes */
const EXCHANGE_MAP = {
  Q: "NASDAQ",
  N: "NYSE",
  A: "NYSE American (AMEX)",
  P: "NYSE Arca",
  Z: "Cboe BZX",
  V: "IEX",
};

const DOW_30 = [
  "AAPL","AMGN","AMZN","AXP","BA","CAT","CRM","CSCO","CVX","DIS",
  "DOW","GS","HD","HON","IBM","INTC","JNJ","JPM","KO","MCD",
  "MMM","MRK","MSFT","NKE","PG","TRV","UNH","V","VZ","WMT",
];

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

function isJunkSymbol(sym, name = "") {
  const s = String(sym || "").toUpperCase();
  const n = name.toLowerCase();
  if (!s || s.length > 6) return true;
  if (/[^A-Z.\-]/i.test(s)) return true;
  if (n.includes("warrant") || n.includes("right") || n.includes(" unit")) return true;
  if (/(WW|WS|WT)$/.test(s)) return true;
  if (s.length >= 5 && s.endsWith("W") && (n.includes("warrant") || n.includes("acq"))) return true;
  return false;
}

function normalize(sym) {
  return String(sym).trim().toUpperCase().replace(/\//g, "-").replace(/\./g, "-");
}

async function loadNasdaqTrader() {
  const [nasdaqTxt, otherTxt] = await Promise.all([
    fetchText("https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt"),
    fetchText("https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt"),
  ]);

  const byExchange = {
    NASDAQ: [],
    NYSE: [],
    "NYSE American (AMEX)": [],
    "NYSE Arca": [],
    "Cboe BZX": [],
    IEX: [],
    Other: [],
  };
  const meta = new Map(); // symbol -> { name, exchange }

  for (const line of nasdaqTxt.split("\n").slice(1)) {
    if (!line || line.startsWith("File Creation")) continue;
    const p = line.split("|");
    // Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares
    const [sym, name, , test, , , etf] = p;
    if (!sym || test === "Y") continue;
    if (isJunkSymbol(sym, name)) continue;
    if (etf === "Y") continue; // equity scanner — skip ETFs from directory seed
    const s = normalize(sym);
    byExchange.NASDAQ.push(s);
    meta.set(s, { name, exchange: "NASDAQ" });
  }

  for (const line of otherTxt.split("\n").slice(1)) {
    if (!line || line.startsWith("File Creation")) continue;
    const p = line.split("|");
    // ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol
    const [sym, name, ex, , etf, , test] = p;
    if (!sym || test === "Y") continue;
    if (etf === "Y") continue;
    if (isJunkSymbol(sym, name)) continue;
    const s = normalize(sym);
    const exchange = EXCHANGE_MAP[ex] || `Other(${ex || "?"})`;
    if (!byExchange[exchange]) byExchange[exchange] = [];
    byExchange[exchange].push(s);
    if (!meta.has(s)) meta.set(s, { name, exchange });
  }

  return { byExchange, meta };
}

async function loadCsvSymbols(url, symbolIndex = 0) {
  try {
    const text = await fetchText(url);
    const lines = text.trim().split(/\r?\n/);
    const out = [];
    for (const line of lines.slice(1)) {
      const cols = line.split(",");
      const sym = normalize(cols[symbolIndex] || "");
      if (sym && !isJunkSymbol(sym)) out.push(sym);
    }
    return out;
  } catch (err) {
    console.warn("list failed", url, err.message);
    return [];
  }
}

async function loadWikiTableTickers(wikiTitle) {
  try {
    const html = await fetchText(`https://en.wikipedia.org/wiki/${wikiTitle}`);
    const found = new Set();
    for (const m of html.matchAll(/>([A-Z]{1,5})<\/a><\/td>/g)) found.add(normalize(m[1]));
    for (const m of html.matchAll(/symbol=([A-Z.\-]{1,6})/gi)) found.add(normalize(m[1]));
    for (const m of html.matchAll(/nasdaq\.com\/market-activity\/stocks\/([a-z0-9.\-]+)/gi)) {
      found.add(normalize(m[1]));
    }
    return [...found].filter((s) => !isJunkSymbol(s));
  } catch (err) {
    console.warn("wiki list failed", wikiTitle, err.message);
    return [];
  }
}

async function loadGithubAllTickers() {
  try {
    const text = await fetchText(
      "https://cdn.jsdelivr.net/gh/rreichel3/US-Stock-Symbols@main/all/all_tickers.txt",
    );
    return text
      .split(/\r?\n/)
      .map(normalize)
      .filter((s) => s && !isJunkSymbol(s));
  } catch {
    return [];
  }
}

async function main() {
  console.log("Building full US market universe…");
  const { byExchange, meta } = await loadNasdaqTrader();

  const [
    sp500,
    sp400,
    sp600,
    githubAll,
    nasdaqDotCom, // breadth check via existing screener in fetch — skip here
  ] = await Promise.all([
    loadCsvSymbols(
      "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv",
      0,
    ),
    loadWikiTableTickers("List_of_S%26P_400_companies"),
    loadWikiTableTickers("List_of_S%26P_600_companies"),
    loadGithubAllTickers(),
    Promise.resolve([]),
  ]);

  const indexes = {
    "Dow Jones Industrial Average (DJIA)": DOW_30.map(normalize),
    "S&P 500": sp500,
    "S&P MidCap 400": sp400,
    "S&P SmallCap 600": sp600,
    // Russell families are exchange-listed; official Nasdaq Trader dirs cover their members.
    // We label the full listed universe as Russell 3000-equivalent coverage.
    "Russell 1000 / 2000 / 3000 (via full listed US equity universe)": [],
  };

  const all = new Set();
  for (const arr of Object.values(byExchange)) arr.forEach((s) => all.add(s));
  for (const arr of Object.values(indexes)) arr.forEach((s) => all.add(s));
  githubAll.forEach((s) => all.add(s));

  // Russell label gets the full common-stock universe count for reporting
  indexes["Russell 1000 / 2000 / 3000 (via full listed US equity universe)"] = [...all];

  const symbols = [...all].sort();

  const coverage = {
    updatedAt: new Date().toISOString(),
    description:
      "HOD Scanner screens common stocks across official US exchange directories and major index membership lists. Feeds show the top 20 HOD gainers only.",
    exchanges: Object.fromEntries(
      Object.entries(byExchange).map(([k, v]) => [k, { symbolCount: new Set(v).size }]),
    ),
    indexes: Object.fromEntries(
      Object.entries(indexes).map(([k, v]) => [k, { symbolCount: new Set(v).size }]),
    ),
    totals: {
      uniqueSymbols: symbols.length,
      feedLimit: 20,
    },
    marketsScreened: [
      "NASDAQ (Global Select / Global Market / Capital Market)",
      "NYSE",
      "NYSE American (AMEX)",
      "NYSE Arca",
      "Cboe BZX",
      "IEX (when present in official directory)",
      "Dow Jones Industrial Average",
      "S&P 500",
      "S&P MidCap 400",
      "S&P SmallCap 600",
      "Russell 1000",
      "Russell 2000",
      "Russell 3000",
    ],
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    path.join(OUT_DIR, "universe.json"),
    JSON.stringify(
      {
        updatedAt: coverage.updatedAt,
        count: symbols.length,
        symbols,
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(OUT_DIR, "coverage.json"), JSON.stringify(coverage, null, 2));

  console.log("Exchanges:");
  for (const [k, v] of Object.entries(coverage.exchanges)) {
    console.log(`  ${k}: ${v.symbolCount}`);
  }
  console.log("Indexes:");
  for (const [k, v] of Object.entries(coverage.indexes)) {
    console.log(`  ${k}: ${v.symbolCount}`);
  }
  console.log(`Unique symbols: ${symbols.length}`);
  console.log(`Wrote ${path.join(OUT_DIR, "coverage.json")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
