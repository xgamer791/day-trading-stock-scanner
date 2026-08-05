/**
 * Browser Polygon client (STOCK_SCANNER_APP_MEMORY.md).
 *
 * Polygon sends Access-Control-Allow-Origin for the Pages host — no CORS proxy.
 * Used as the durable live ranked-gainers path when Yahoo day_gainers proxies fail,
 * and as a parallel live source when NEXT_PUBLIC_POLYGON_API_KEY is present.
 *
 * LIVE ONLY — never live.json / floats.json / last-tick paint.
 */
import { fetchJsonDirect } from "@/lib/corsTransport";

export type PolygonLiveQuote = {
  symbol: string;
  name: string;
  last: number;
  prevClose: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  changePct: number;
  floatMillions: number | null;
};

type SnapshotTicker = {
  ticker?: string;
  todaysChangePerc?: number;
  day?: { c?: number; h?: number; l?: number; v?: number; o?: number };
  prevDay?: { c?: number };
  min?: { c?: number; h?: number; l?: number; v?: number };
  lastTrade?: { p?: number };
};

type SnapshotResponse = { tickers?: SnapshotTicker[]; status?: string };

function clientPolygonKey(): string {
  return (process.env.NEXT_PUBLIC_POLYGON_API_KEY || "").trim();
}

export function hasClientPolygonKey(): boolean {
  return Boolean(clientPolygonKey());
}

function isJunk(sym: string): boolean {
  const s = (sym || "").toUpperCase();
  if (!s || /[.=]/.test(s)) return true;
  if (/(WW|WS|WT|WR)$/.test(s)) return true;
  if (s.length >= 5 && s.endsWith("W")) return true;
  return false;
}

/**
 * Live US top gainers via Polygon snapshot (direct CORS — no public proxy).
 * %Chg = (last − prevClose) / prevClose from the same payload.
 */
export async function fetchPolygonGainerQuotes(
  limit = 50,
): Promise<Map<string, PolygonLiveQuote>> {
  const key = clientPolygonKey();
  if (!key) throw new Error("NEXT_PUBLIC_POLYGON_API_KEY missing");

  const data = (await fetchJsonDirect(
    `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${encodeURIComponent(key)}`,
    12000,
  )) as SnapshotResponse;

  const map = new Map<string, PolygonLiveQuote>();
  for (const t of data.tickers || []) {
    const symbol = String(t.ticker || "")
      .replace("/", "-")
      .toUpperCase();
    if (!symbol || isJunk(symbol)) continue;

    const last = Number(t.min?.c || t.lastTrade?.p || t.day?.c) || 0;
    const prevClose = Number(t.prevDay?.c) || 0;
    if (!(last > 0) || !(prevClose > 0)) continue;

    const changePct = ((last - prevClose) / prevClose) * 100;
    if (!(changePct > 0)) continue;

    const dayHigh = Math.max(Number(t.day?.h) || 0, Number(t.min?.h) || 0, last);
    const dayLow = Number(t.day?.l || t.min?.l) || last;
    const volume = Number(t.day?.v || t.min?.v) || 0;

    map.set(symbol, {
      symbol,
      name: symbol,
      last,
      prevClose,
      dayHigh,
      dayLow,
      volume,
      changePct,
      floatMillions: null,
    });

    if (map.size >= limit) break;
  }
  return map;
}
