import type { MarketSession, StockMover } from "./types";

/** Informational only — HOD is displayed, not used as a hard filter. */
export const HOD_TOLERANCE_PCT = 2.0;

const ET = "America/New_York";

type EtParts = {
  weekday: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function getEtParts(now: Date): EtParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const grab = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";

  return {
    weekday: grab("weekday"),
    year: Number(grab("year")),
    month: Number(grab("month")),
    day: Number(grab("day")),
    hour: Number(grab("hour")),
    minute: Number(grab("minute")),
    second: Number(grab("second")),
  };
}

/** Instant for a wall-clock time in America/New_York on an ET calendar date. */
export function etWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const et = getEtParts(guess);
  const asEtMs = Date.UTC(et.year, et.month - 1, et.day, et.hour, et.minute, et.second);
  const wantMs = Date.UTC(year, month - 1, day, hour, minute, second);
  return new Date(guess.getTime() + (wantMs - asEtMs));
}

function addEtCalendarDays(
  year: number,
  month: number,
  day: number,
  delta: number,
): { year: number; month: number; day: number; weekday: string } {
  // Noon ET avoids DST edge ambiguity when stepping calendar days.
  const noon = etWallTimeToUtc(year, month, day, 12, 0, 0);
  const shifted = new Date(noon.getTime() + delta * 24 * 60 * 60 * 1000);
  const p = getEtParts(shifted);
  return { year: p.year, month: p.month, day: p.day, weekday: p.weekday };
}

function isWeekend(weekday: string): boolean {
  return weekday === "Sat" || weekday === "Sun";
}

/** Next regular-session open (09:30 ET) on a weekday. */
export function nextRegularOpen(now = new Date()): Date {
  const p = getEtParts(now);
  const openToday = etWallTimeToUtc(p.year, p.month, p.day, 9, 30, 0);
  if (!isWeekend(p.weekday) && now.getTime() < openToday.getTime()) {
    return openToday;
  }

  let cursor = { year: p.year, month: p.month, day: p.day, weekday: p.weekday };
  for (let i = 0; i < 8; i++) {
    cursor = addEtCalendarDays(cursor.year, cursor.month, cursor.day, 1);
    if (!isWeekend(cursor.weekday)) {
      return etWallTimeToUtc(cursor.year, cursor.month, cursor.day, 9, 30, 0);
    }
  }
  return openToday;
}

/** Premarket opens at 04:00 ET — the start of a trading day for this app. */
export const PREMARKET_OPEN_HOUR = 4;

/**
 * Start of the current trading day: 04:00 ET of the most recent trading day.
 *
 * This is the boundary at which every board clears. A trading day runs from one
 * premarket open to the next, so the day's premarket / regular / after-hours boards
 * all stay on screen until the *next* premarket session begins.
 *
 * Before 04:00 ET the day hasn't started yet, so we roll back to the previous
 * trading day. Weekends roll back to Friday, which is why Friday's final boards
 * stay up all weekend rather than blanking on Saturday morning.
 *
 * Note this is a session boundary, not a data cache: it only decides whether a
 * timestamp in a freshly-fetched payload belongs to today.
 */
export function currentTradingDayStartEt(now = new Date()): Date {
  const p = getEtParts(now);

  let cursor = { year: p.year, month: p.month, day: p.day, weekday: p.weekday };
  // Before premarket opens, today's session hasn't begun — step back a day.
  if (p.hour < PREMARKET_OPEN_HOUR) {
    cursor = addEtCalendarDays(cursor.year, cursor.month, cursor.day, -1);
  }
  // Walk back to the most recent weekday (Sat/Sun → Friday).
  for (let i = 0; i < 8 && isWeekend(cursor.weekday); i++) {
    cursor = addEtCalendarDays(cursor.year, cursor.month, cursor.day, -1);
  }

  return etWallTimeToUtc(cursor.year, cursor.month, cursor.day, PREMARKET_OPEN_HOUR, 0, 0);
}

/** Today's regular close (16:00 ET), or null if not a weekday session day. */
export function todaysRegularClose(now = new Date()): Date | null {
  const p = getEtParts(now);
  if (isWeekend(p.weekday)) return null;
  return etWallTimeToUtc(p.year, p.month, p.day, 16, 0, 0);
}

export type MarketCountdown = {
  kind: "opens" | "closes";
  /** Zero-padded Realtime-style clock: MM:SS or H:MM:SS */
  clock: string;
  label: string;
  msRemaining: number;
};

function formatCountdownClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

/**
 * Realtime Scanners–style market open/close countdown (US equities, ET).
 * Regular session: CLOSES IN until 16:00. Otherwise OPENS IN until next 09:30 weekday.
 */
export function getMarketCountdown(now = new Date()): MarketCountdown {
  const session = getMarketSession(now);
  if (session === "regular") {
    const close = todaysRegularClose(now);
    const ms = Math.max(0, (close?.getTime() ?? now.getTime()) - now.getTime());
    const clock = formatCountdownClock(ms);
    return { kind: "closes", clock, label: `CLOSES IN ${clock}`, msRemaining: ms };
  }
  const open = nextRegularOpen(now);
  const ms = Math.max(0, open.getTime() - now.getTime());
  const clock = formatCountdownClock(ms);
  return { kind: "opens", clock, label: `OPENS IN ${clock}`, msRemaining: ms };
}

export function getMarketSession(now = new Date()): MarketSession {
  const p = getEtParts(now);
  if (isWeekend(p.weekday)) return "closed";

  const mins = p.hour * 60 + p.minute;

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
  const { minChangePct = 0, limit = 50 } = opts;
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
  // Realtime-style whole units: 6M, 21M, 86M, 86K
  if (n >= 1000) return `${(n / 1000).toFixed(1)}B`;
  if (n >= 1) return `${Math.round(n)}M`;
  return `${Math.round(n * 1000)}K`;
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
