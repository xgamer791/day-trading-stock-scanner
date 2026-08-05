#!/usr/bin/env node
/**
 * VERIFY YOUR WORK — Flt data path (APP_MEMORY.md).
 * Uses direct APIs (no CORS proxy) to prove marketCap/price float math
 * for current Most Advanced runners. Exit 1 if coverage is too low.
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function parseMoney(v) {
  if (v == null) return 0;
  const n = Number(String(v).replace(/[$,%+]/g, "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function parseMarketCap(v) {
  if (v == null) return null;
  let s = String(v).trim().toUpperCase().replace(/[$,\s]/g, "");
  if (!s || s === "N/A" || s === "0") return null;
  let mult = 1;
  if (s.endsWith("T")) {
    mult = 1e12;
    s = s.slice(0, -1);
  } else if (s.endsWith("B")) {
    mult = 1e9;
    s = s.slice(0, -1);
  } else if (s.endsWith("M")) {
    mult = 1e6;
    s = s.slice(0, -1);
  } else if (s.endsWith("K")) {
    mult = 1e3;
    s = s.slice(0, -1);
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n * mult : null;
}

function isJunk(sym, name = "") {
  const s = String(sym || "").toUpperCase();
  const n = String(name || "").toLowerCase();
  if (!s || /[.=]/.test(s)) return true;
  if (/(WW|WS|WT|WR)$/.test(s)) return true;
  if (s.length >= 5 && s.endsWith("W")) return true;
  if (n.includes("warrant") || n.includes(" unit") || n.includes("right")) return true;
  return false;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function main() {
  const movers = await getJson(
    "https://api.nasdaq.com/api/marketmovers?assetclass=stocks&limit=50",
  );
  const rows = movers?.data?.STOCKS?.MostAdvanced?.table?.rows || [];
  const seeds = [];
  for (const r of rows) {
    if (isJunk(r.symbol, r.name)) continue;
    if (!(parseMoney(r.change) > 0)) continue;
    seeds.push({
      symbol: String(r.symbol).replace("/", "-").toUpperCase(),
      price: parseMoney(r.lastSalePrice),
    });
  }
  const top = seeds.filter((s) => s.price > 0).slice(0, 15);
  if (top.length < 5) throw new Error(`Too few Most Advanced seeds (${top.length})`);

  let withFlt = 0;
  const samples = [];
  for (const s of top) {
    try {
      const d = await getJson(
        `https://api.nasdaq.com/api/quote/${encodeURIComponent(s.symbol)}/summary?assetclass=stocks`,
      );
      const mcap = parseMarketCap(d?.data?.summaryData?.MarketCap?.value);
      const flt = mcap && s.price > 0 ? mcap / s.price / 1e6 : null;
      if (flt != null && flt > 0) {
        withFlt += 1;
        samples.push(`${s.symbol}=${Math.round(flt)}M`);
      } else {
        samples.push(`${s.symbol}=—`);
      }
    } catch {
      samples.push(`${s.symbol}=ERR`);
    }
  }

  const pct = withFlt / top.length;
  console.log(`Flt coverage: ${withFlt}/${top.length} (${(pct * 100).toFixed(0)}%)`);
  console.log("Samples:", samples.join(", "));
  if (pct < 0.7) {
    console.error("VERIFY FAIL: Flt coverage < 70% for top Most Advanced runners");
    process.exit(1);
  }
  console.log("VERIFY OK: Flt data path produces numeric floats for Most Advanced runners");
}

main().catch((e) => {
  console.error("VERIFY FAIL:", e.message || e);
  process.exit(1);
});
