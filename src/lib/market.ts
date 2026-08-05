import type { MarketSession, StockMover } from "./types";

/** Informational only — HOD is displayed, not used as a hard filter. */
export const HOD_TOLERANCE_PCT = 2.0;

export function getMarketSession(now = new Date()): MarketSession {
  // US/Eastern approximations via Intl
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  if (["Sat", "Sun"].includes(weekday)) return "closed";

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const mins = hour * 60 + minute;

  // Premarket 4:00–9:30, regular 9:30–16:00, afterhours 16:00–20:00 ET
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "premarket";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "regular";
  if (mins >= 16 * 60 && mins < 20 * 60) return "afterhours";
  return "closed";
}

export function toMover(raw: {
  symbol: string;
  name?: string;
  price: number;
  prevClose: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  updatedAt?: string;
}): StockMover | null {
  if (!raw.symbol || !Number.isFinite(raw.price) || raw.price <= 0) return null;
  if (!Number.isFinite(raw.prevClose) || raw.prevClose <= 0) return null;

  const dayHigh = Math.max(raw.dayHigh || raw.price, raw.price);
  const hodDistancePct =
    dayHigh > 0 ? ((dayHigh - raw.price) / dayHigh) * 100 : 0;
  const atHod = hodDistancePct <= HOD_TOLERANCE_PCT;
  const change = raw.price - raw.prevClose;
  const changePct = (change / raw.prevClose) * 100;
  const hodGainPct = (dayHigh - raw.prevClose) / raw.prevClose * 100;

  return {
    symbol: raw.symbol.toUpperCase(),
    name: raw.name,
    price: raw.price,
    changePct,
    change,
    volume: raw.volume || 0,
    dayHigh,
    dayLow: raw.dayLow || raw.price,
    prevClose: raw.prevClose,
    hodDistancePct,
    hodGainPct,
    atHod,
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
  };
}

/** Top % gainers only — no HOD / price / volume gates. */
export function filterHodGainers(
  movers: StockMover[],
  opts: { minChangePct?: number; minVolume?: number; minPrice?: number; maxPrice?: number; limit?: number } = {},
): StockMover[] {
  const { minChangePct = 0, limit = 20 } = opts;
  void opts.minVolume;
  void opts.minPrice;
  void opts.maxPrice;

  return movers
    .filter((m) => m.changePct > minChangePct && m.price > 0)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, limit);
}

export function formatPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function formatPrice(n: number): string {
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(3);
  return n.toFixed(4);
}

export function formatVolume(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatFloat(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}B`;
  if (n >= 10) return `${n.toFixed(0)}M`;
  if (n >= 1) return `${n.toFixed(1)}M`;
  return `${(n * 1000).toFixed(0)}K`;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}
