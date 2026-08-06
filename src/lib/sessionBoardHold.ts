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

const PREFIX = "dts-session-board-v2:";

function storageKey(kind: SessionBoardKind): string {
  return `${PREFIX}${kind}`;
}

function canUseStorage(): boolean {
  return typeof sessionStorage !== "undefined";
}

/** Higher = more Realtime-like (extreme % runners present). */
export function boardQuality(rows: StockMover[]): number {
  if (!rows?.length) return 0;
  const top = Number(rows[0]?.changePct) || 0;
  const hot50 = rows.filter((r) => r.changePct >= 50).length;
  const hot100 = rows.filter((r) => r.changePct >= 100).length;
  return top + hot50 * 25 + hot100 * 50;
}

/** Do not let a weak Yahoo-only board overwrite a strong Most-Advanced-enriched hold. */
export function shouldReplaceHeldBoard(incoming: StockMover[], held: StockMover[]): boolean {
  if (!incoming.length) return false;
  if (!held.length) return true;
  const qIn = boardQuality(incoming);
  const qHeld = boardQuality(held);
  // Require incoming to be roughly as strong (allow small decay).
  return qIn >= qHeld * 0.7;
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
    // Also drop legacy v1 keys if a tab still has them.
    for (const kind of kinds) sessionStorage.removeItem(`dts-session-board-v1:${kind}`);
  } catch {
    /* ignore */
  }
}
