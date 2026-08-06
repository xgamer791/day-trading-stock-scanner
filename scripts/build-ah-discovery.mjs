#!/usr/bin/env node
/**
 * Build After Hours discovery symbol list (STOCK_SCANNER_APP_MEMORY.md).
 *
 * Writes public/data/ah-discovery.json with SYMBOLS ONLY (no prices).
 * Browser uses these as discovery seeds, then live-quotes extended hours.
 * Never used as a priced live feed / live.json substitute.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const UNIVERSE = path.join(ROOT, "public", "data", "universe.json");
const OUT = path.join(ROOT, "public", "data", "ah-discovery.json");

const CONCURRENCY = 24;
const BUDGET_MS = Number(process.env.AH_DISCOVERY_BUDGET_MS || 50_000);
const TOP_N = 100;

function isJunk(sym) {
  const s = String(sym || "").toUpperCase();
  if (!s || /[.=]/.test(s)) return true;
  if (/(WW|WS|WT|WR)$/.test(s)) return true;
  if (s.length >= 5 && s.endsWith("W")) return true;
  return false;
}

async function chartAh(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  if (!r) return null;
  const reg = Number(r.meta?.regularMarketPrice) || 0;
  const closes = r.indicators?.quote?.[0]?.close || [];
  let last = 0;
  for (let i = closes.length - 1; i >= 0; i--) {
    const c = Number(closes[i]);
    if (Number.isFinite(c) && c > 0) {
      last = c;
      break;
    }
  }
  if (!(last > 0) || !(reg > 0)) return null;
  const changePct = ((last - reg) / reg) * 100;
  if (!(changePct > 0.5)) return null;
  return { symbol, changePct, last, reg };
}

async function mapPool(items, concurrency, deadline, fn) {
  const out = [];
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < items.length && Date.now() < deadline) {
      const item = items[idx++];
      try {
        const row = await fn(item);
        if (row) out.push(row);
      } catch {
        /* skip */
      }
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const raw = JSON.parse(await readFile(UNIVERSE, "utf8"));
  const symbols = (raw.symbols || []).map((s) => String(s).toUpperCase()).filter((s) => !isJunk(s));
  const deadline = Date.now() + BUDGET_MS;
  console.log(`AH discovery scan: ${symbols.length} symbols, budget ${BUDGET_MS}ms`);

  const hits = await mapPool(symbols, CONCURRENCY, deadline, chartAh);
  hits.sort((a, b) => b.changePct - a.changePct);
  const top = hits.slice(0, TOP_N);
  await mkdir(path.dirname(OUT), { recursive: true });
  const payload = {
    updatedAt: new Date().toISOString(),
    count: top.length,
    scanned: symbols.length,
    // SYMBOLS ONLY — client must live-quote; never treat as priced board.
    symbols: top.map((h) => h.symbol),
  };
  await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(
    `Wrote ${OUT} (${payload.count} symbols). Top:`,
    top.slice(0, 12).map((h) => `${h.symbol}:${h.changePct.toFixed(1)}%`).join(", "),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
