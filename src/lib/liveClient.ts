/**
 * Browser-side full-US-market top-gainers scanner.
 * Mirrors Realtime Screener: Nasdaq Most Advanced + full composite screener,
 * ranked by % gain only (no HOD / price / volume gates).
 */
import type { NewsItem, ScannerPayload, StockMover } from "@/lib/types";

const FEED_LIMIT = 20;

function proxies(url: string): string[] {
  const enc = encodeURIComponent(url);
  return [
    `https://corsproxy.io/?${enc}`,
    `https://api.allorigins.win/raw?url=${enc}`,
  ];
}

async function fetchViaProxy(url: string): Promise<Response> {
  let lastErr: Error | null = null;
  for (const p of proxies(url)) {
    try {
      const res = await fetch(p, {
        cache: "no-store",
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) {
        lastErr = new Error(`proxy ${res.status}`);
        continue;
      }
      const text = await res.text();
      if (text.trimStart().startsWith("<!DOCTYPE") || text.trimStart().startsWith("<html")) {
        lastErr = new Error("proxy returned HTML");
        continue;
      }
      return new Response(text, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr || new Error("All proxies failed");
}

function parseMoney(v: unknown): number {
  if (v == null) return 0;
  const n = Number(String(v).replace(/[$,%+]/g, "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function isJunk(sym: string, name = ""): boolean {
  const s = (sym || "").toUpperCase();
  const n = (name || "").toLowerCase();
  if (!s || /[.=]/.test(s)) return true;
  if (/(WW|WS|WT|WR)$/.test(s)) return true;
  if (s.length >= 5 && s.endsWith("W")) return true;
  if (n.includes("warrant") || n.includes(" unit") || n.includes("right")) return true;
  if (n.includes("preferred") || n.includes(" preference")) return true;
  if (/\betf\b|\betn\b|leveraged|direxion|proshares|graniteshares/.test(n)) return true;
  if (s.length >= 5 && s.endsWith("Z") && !n.includes("ordinary") && !n.includes("common")) {
    return true;
  }
  return false;
}

function sessionNow(): ScannerPayload["session"] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
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

type Seed = {
  symbol: string;
  name: string;
  changePct: number;
  price: number;
  volume: number;
};

async function fetchMostAdvanced(): Promise<Seed[]> {
  const url = "https://api.nasdaq.com/api/marketmovers?assetclass=stocks&limit=50";
  const res = await fetchViaProxy(url);
  const data = await res.json();
  const rows = data?.data?.STOCKS?.MostAdvanced?.table?.rows || [];
  const out: Seed[] = [];
  for (const r of rows) {
    if (isJunk(r.symbol, r.name)) continue;
    const changePct = parseMoney(r.change);
    if (!(changePct > 0)) continue;
    out.push({
      symbol: String(r.symbol).replace("/", "-").toUpperCase(),
      name: r.name || r.symbol,
      changePct,
      price: parseMoney(r.lastSalePrice),
      volume: parseMoney(r.volume),
    });
  }
  return out;
}

/** Full composite US screener (all exchanges) — best-effort via CORS proxy. */
async function fetchFullUsScreener(): Promise<Seed[]> {
  const url =
    "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true";
  const res = await fetchViaProxy(url);
  const data = await res.json();
  const rows = data?.data?.rows || [];
  const out: Seed[] = [];
  for (const r of rows) {
    if (isJunk(r.symbol, r.name)) continue;
    const changePct = parseMoney(r.pctchange);
    if (!(changePct > 0)) continue;
    out.push({
      symbol: String(r.symbol).replace("/", "-").toUpperCase(),
      name: r.name || r.symbol,
      changePct,
      price: parseMoney(r.lastsale),
      volume: parseMoney(r.volume),
    });
  }
  return out;
}

async function fetchYahooQuote(symbol: string): Promise<{
  symbol: string;
  name: string;
  last: number;
  prevClose: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  dayChangePct: number;
  gapPct: number;
  prePct: number | null;
  prePrice: number | null;
  hodDistancePct: number;
} | null> {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`;
  const res = await fetchViaProxy(url);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result?.meta) return null;
  const meta = result.meta;
  const quote = result.indicators?.quote?.[0] || {};
  const opens = (quote.open || []).filter((n: number | null) => n != null) as number[];
  const highs = (quote.high || []).filter((n: number | null) => n != null) as number[];
  const lows = (quote.low || []).filter((n: number | null) => n != null) as number[];
  const volumes = (quote.volume || []).filter((n: number | null) => n != null) as number[];

  const prevClose = Number(meta.previousClose ?? meta.chartPreviousClose) || 0;
  const last = Number(meta.regularMarketPrice) || 0;
  const sessionOpen = opens.length ? Number(opens[0]) : last;
  const dayHigh = highs.length ? Math.max(...highs, last) : last;
  const dayLow = lows.length ? Math.min(...lows, last) : last;
  const volume = Number(meta.regularMarketVolume) || volumes.reduce((a, b) => a + b, 0) || 0;
  if (last <= 0 || prevClose <= 0) return null;

  const prePrice = meta.preMarketPrice != null ? Number(meta.preMarketPrice) : null;
  const prePct =
    meta.preMarketChangePercent != null
      ? Number(meta.preMarketChangePercent)
      : prePrice
        ? ((prePrice - prevClose) / prevClose) * 100
        : null;

  const dayChangePct = ((last - prevClose) / prevClose) * 100;
  const gapPct = ((sessionOpen - prevClose) / prevClose) * 100;
  const hodDistancePct = dayHigh > 0 ? ((dayHigh - last) / dayHigh) * 100 : 0;

  return {
    symbol,
    name: meta.shortName || meta.longName || symbol,
    last,
    prevClose,
    dayHigh,
    dayLow,
    volume,
    dayChangePct,
    gapPct,
    prePct,
    prePrice,
    hodDistancePct,
  };
}

function seedToMover(seed: Seed, q: Awaited<ReturnType<typeof fetchYahooQuote>>): StockMover {
  const price = q?.last && q.last > 0 ? q.last : seed.price;
  const prevClose =
    q?.prevClose && q.prevClose > 0 ? q.prevClose : price / (1 + seed.changePct / 100 || 1);
  const dayHigh = q?.dayHigh && q.dayHigh > 0 ? Math.max(q.dayHigh, price) : price;
  const dayLow = q?.dayLow && q.dayLow > 0 ? q.dayLow : price;
  const volume = q?.volume && q.volume > 0 ? q.volume : seed.volume || 0;
  const hodDistancePct = dayHigh > 0 ? ((dayHigh - price) / dayHigh) * 100 : 0;

  return {
    symbol: seed.symbol,
    name: q?.name || seed.name,
    price,
    changePct: seed.changePct,
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

function topGainers(rows: StockMover[]): StockMover[] {
  return [...rows]
    .filter((m) => m.changePct > 0 && m.price > 0)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, FEED_LIMIT);
}

function mergeSeeds(full: Seed[], advanced: Seed[]): Seed[] {
  const map = new Map<string, Seed>();
  for (const s of full) map.set(s.symbol, s);
  for (const s of advanced) {
    const prev = map.get(s.symbol);
    map.set(s.symbol, { ...(prev || s), ...s, volume: s.volume || prev?.volume || 0 });
  }
  return [...map.values()].sort((a, b) => b.changePct - a.changePct);
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    out.push(...(await Promise.all(chunk.map(fn))));
  }
  return out;
}

/** Live scan across the entire US composite market. */
export async function fetchLiveScannerClient(): Promise<ScannerPayload> {
  const session = sessionNow();

  let advanced: Seed[] = [];
  let full: Seed[] = [];

  try {
    advanced = await fetchMostAdvanced();
  } catch {
    /* snapshot fallback upstream */
  }

  // Full screener is large; try briefly, Most Advanced alone still covers top runners
  try {
    full = await Promise.race([
      fetchFullUsScreener(),
      new Promise<Seed[]>((_, rej) => setTimeout(() => rej(new Error("screener timeout")), 2200)),
    ]);
  } catch {
    full = [];
  }

  const merged = mergeSeeds(full, advanced);
  if (!merged.length) throw new Error("No US market gainers from Nasdaq");

  const candidates = merged.slice(0, 40);
  const quotes = await mapPool(candidates, 6, async (seed) => {
    try {
      return await fetchYahooQuote(seed.symbol);
    } catch {
      return null;
    }
  });
  const quoteMap = new Map(
    quotes.filter(Boolean).map((q) => [q!.symbol, q!] as const),
  );

  let premarket: StockMover[] = [];
  let gainers: StockMover[] = [];

  if (session === "premarket") {
    premarket = topGainers(
      candidates.map((seed) => {
        const q = quoteMap.get(seed.symbol);
        if (q && q.prePct != null) {
          return seedToMover(
            { ...seed, changePct: q.prePct, price: q.prePrice ?? q.last },
            { ...q, last: q.prePrice ?? q.last },
          );
        }
        return seedToMover(seed, q ?? null);
      }),
    );
  } else if (session !== "closed") {
    gainers = topGainers(candidates.map((seed) => seedToMover(seed, quoteMap.get(seed.symbol) ?? null)));
    premarket = topGainers(
      candidates.map((seed) => {
        const q = quoteMap.get(seed.symbol);
        if (q) return seedToMover({ ...seed, changePct: q.gapPct }, q);
        return seedToMover(seed, null);
      }),
    );
  }

  const news: NewsItem[] = [];

  return {
    session,
    updatedAt: new Date().toISOString(),
    source: "full-us-realtime",
    news,
    premarket,
    gainers,
  };
}

export function liveJsonUrl(): string {
  const base = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
  return `${base}/data/live.json?t=${Date.now()}`;
}
