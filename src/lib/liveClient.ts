/**
 * Client data loader for GitHub Pages.
 *
 * PRIMARY (reliable): same-origin /data/live.json rebuilt every minute by
 * GitHub Actions from live Nasdaq + Yahoo (no CORS).
 *
 * OPTIONAL: browser CORS-proxy upgrade. Never required for the board to work.
 */
import type { NewsItem, ScannerPayload, StockMover } from "@/lib/types";

const FEED_LIMIT = 20;

export function liveJsonUrl(): string {
  const base = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
  return `${base}/data/live.json?t=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Same-origin Actions feed — always works on GitHub Pages. */
export async function fetchSnapshotFeed(): Promise<ScannerPayload> {
  const res = await fetch(liveJsonUrl(), {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
  });
  if (!res.ok) throw new Error(`Live feed unavailable (${res.status})`);
  const data = (await res.json()) as ScannerPayload;
  if (!data || (!data.gainers?.length && !data.premarket?.length && data.session === "regular")) {
    // Still return payload (may be closed/premarket empty)
  }
  return data;
}

function bust(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function proxyUrls(url: string): string[] {
  const live = bust(url);
  const enc = encodeURIComponent(live);
  return [
    `https://corsproxy.io/?${enc}`,
    `https://api.allorigins.win/raw?url=${enc}`,
  ];
}

async function fetchViaProxy(url: string, timeoutMs = 3500): Promise<Response> {
  const jobs = proxyUrls(url).map((p) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const promise = fetch(p, {
      cache: "no-store",
      signal: ac.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`proxy ${res.status}`);
        const text = await res.text();
        if (text.trimStart().startsWith("<")) throw new Error("proxy HTML");
        JSON.parse(text);
        return new Response(text, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
      .finally(() => clearTimeout(timer));
    return { ac, promise };
  });
  try {
    return await Promise.any(jobs.map((j) => j.promise));
  } catch {
    throw new Error("proxies failed");
  } finally {
    for (const j of jobs) j.ac.abort();
  }
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
  if (n.includes("preferred")) return true;
  if (/\betf\b|\betn\b|direxion|proshares/.test(n)) return true;
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
  price: number;
  changePct: number;
  volume: number;
};

async function fetchMostAdvanced(): Promise<Seed[]> {
  const res = await fetchViaProxy(
    "https://api.nasdaq.com/api/marketmovers?assetclass=stocks&limit=50",
    4000,
  );
  const data = await res.json();
  const rows = data?.data?.STOCKS?.MostAdvanced?.table?.rows || [];
  const out: Seed[] = [];
  for (const r of rows) {
    if (isJunk(r.symbol, r.name)) continue;
    const changePct = parseMoney(r.change);
    const price = parseMoney(r.lastSalePrice);
    if (!(changePct > 0) || !(price > 0)) continue;
    out.push({
      symbol: String(r.symbol).replace("/", "-").toUpperCase(),
      name: r.name || r.symbol,
      price,
      changePct,
      volume: parseMoney(r.volume),
    });
  }
  return out;
}

function toMover(seed: Seed): StockMover {
  const prevClose = seed.price / (1 + seed.changePct / 100);
  return {
    symbol: seed.symbol,
    name: seed.name,
    price: seed.price,
    changePct: seed.changePct,
    change: seed.price - prevClose,
    volume: seed.volume,
    dayHigh: seed.price,
    dayLow: seed.price,
    prevClose,
    floatMillions: null,
    hodDistancePct: 0,
    hodGainPct: seed.changePct,
    atHod: true,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Optional browser-side Nasdaq Most Advanced upgrade.
 * Safe to fail — caller must keep the Actions feed.
 */
export async function fetchLiveScannerClient(): Promise<ScannerPayload> {
  const session = sessionNow();
  const seeds = await fetchMostAdvanced();
  if (seeds.length < 3) throw new Error("Live movers thin");

  const ranked = [...seeds]
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, FEED_LIMIT)
    .map(toMover);

  const news: NewsItem[] = [];
  return {
    session,
    updatedAt: new Date().toISOString(),
    source: "full-us-realtime",
    feedLimit: FEED_LIMIT,
    news,
    premarket: session === "premarket" ? ranked : ranked,
    gainers: session === "premarket" || session === "closed" ? [] : ranked,
  };
}

export function rowSynced(m: { price: number; prevClose: number; changePct: number }): boolean {
  if (!(m.price > 0) || !(m.prevClose > 0) || !Number.isFinite(m.changePct)) return false;
  const recomputed = ((m.price - m.prevClose) / m.prevClose) * 100;
  return Math.abs(recomputed - m.changePct) < 1.5;
}
