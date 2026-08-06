/**
 * Prior-session board hold (STOCK_SCANNER_APP_MEMORY.md).
 *
 * Allowed: keep the last Premarket / Gainers / After Hours board after that
 * session ends, until the next trading morning's premarket open (4:00 AM ET).
 *
 * NOT allowed: using this as a mid-session LIVE fallback when a poll fails
 * during an active window, or loading live.json / floats.json.
 */
import { sessionBoardTradingDayKey } from "@/lib/market";
import type { StockMover } from "@/lib/types";

export type SessionBoardKind = "premarket" | "gainers" | "afterhours";

type HeldBoard = {
  tradingDay: string;
  updatedAt: string;
  rows: StockMover[];
};

const PREFIX = "dts-session-board-v1:";

function storageKey(kind: SessionBoardKind): string {
  return `${PREFIX}${kind}`;
}

function canUseStorage(): boolean {
  return typeof sessionStorage !== "undefined";
}

export function readHeldBoard(kind: SessionBoardKind, now = new Date()): StockMover[] {
  const day = sessionBoardTradingDayKey(now);
  try {
    if (!canUseStorage()) return [];
    const raw = sessionStorage.getItem(storageKey(kind));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HeldBoard;
    if (!parsed || parsed.tradingDay !== day || !Array.isArray(parsed.rows)) return [];
    return parsed.rows.filter((r) => r && typeof r.symbol === "string" && r.price > 0);
  } catch {
    return [];
  }
}

export function writeHeldBoard(
  kind: SessionBoardKind,
  rows: StockMover[],
  now = new Date(),
): void {
  if (!rows.length) return;
  const payload: HeldBoard = {
    tradingDay: sessionBoardTradingDayKey(now),
    updatedAt: new Date().toISOString(),
    rows,
  };
  try {
    if (!canUseStorage()) return;
    sessionStorage.setItem(storageKey(kind), JSON.stringify(payload));
  } catch {
    /* quota / private mode */
  }
}

/** Wipe held boards at the start of the next premarket session. */
export function clearHeldBoards(kinds: SessionBoardKind[] = ["premarket", "gainers", "afterhours"]): void {
  try {
    if (!canUseStorage()) return;
    for (const kind of kinds) sessionStorage.removeItem(storageKey(kind));
  } catch {
    /* ignore */
  }
}
