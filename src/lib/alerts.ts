/**
 * Price alerts (iOS local notifications).
 *
 * ZERO CACHING compliance — read this before "fixing" anything here
 * ----------------------------------------------------------------
 * STOCK_SCANNER_APP_MEMORY.md forbids persisting **market data**: quotes, gainers,
 * float, last-tick maps, in localStorage / Preferences / IndexedDB / anywhere.
 *
 * This module persists *user alert rules* — a symbol and a % threshold the user
 * typed in. That is user settings, not a market feed, and none of it is ever
 * displayed as a price. Rules are evaluated only against the payload of a
 * **successful live poll**; nothing is remembered between polls except which alerts
 * already fired, and that dedupe set lives in memory only (it dies with the process,
 * exactly as intended).
 *
 * No quote, price, %, volume or float value is ever written to storage here.
 */
import { hapticAlert } from "@/lib/nativeUi";
import { isNativeApp } from "@/lib/nativeHttp";
import type { ScannerPayload, StockMover } from "@/lib/types";

const STORE_KEY = "scanner.alertRules.v1";
const SETTINGS_KEY = "scanner.settings.v1";

export type AlertRule = {
  id: string;
  /** Empty/undefined = applies to any symbol on the board. */
  symbol?: string;
  /** Fire when a row's %Chg is at or above this. */
  thresholdPct: number;
  enabled: boolean;
};

export type AppSettings = {
  alertsEnabled: boolean;
  soundEnabled: boolean;
  hapticsEnabled: boolean;
  keepAwakeEnabled: boolean;
};

export const DEFAULT_SETTINGS: AppSettings = {
  alertsEnabled: false,
  soundEnabled: true,
  hapticsEnabled: true,
  keepAwakeEnabled: true,
};

/* --------------------------- persistence --------------------------- */
/* Capacitor Preferences on native; plain in-memory on web (the web build has no
   settings UI surface for these, and we will not introduce localStorage here). */

let memRules: AlertRule[] | null = null;
let memSettings: AppSettings | null = null;

async function prefsGet(key: string): Promise<string | null> {
  if (!isNativeApp()) return null;
  try {
    const { Preferences } = await import("@capacitor/preferences");
    const { value } = await Preferences.get({ key });
    return value ?? null;
  } catch {
    return null;
  }
}

async function prefsSet(key: string, value: string): Promise<void> {
  if (!isNativeApp()) return;
  try {
    const { Preferences } = await import("@capacitor/preferences");
    await Preferences.set({ key, value });
  } catch {
    /* ignore */
  }
}

export async function loadAlertRules(): Promise<AlertRule[]> {
  if (memRules) return memRules;
  const raw = await prefsGet(STORE_KEY);
  if (!raw) {
    memRules = [];
    return memRules;
  }
  try {
    const parsed = JSON.parse(raw);
    memRules = Array.isArray(parsed)
      ? parsed.filter(
          (r): r is AlertRule =>
            r && typeof r.id === "string" && Number.isFinite(Number(r.thresholdPct)),
        )
      : [];
  } catch {
    memRules = [];
  }
  return memRules;
}

export async function saveAlertRules(rules: AlertRule[]): Promise<void> {
  memRules = rules;
  await prefsSet(STORE_KEY, JSON.stringify(rules));
}

export async function loadSettings(): Promise<AppSettings> {
  if (memSettings) return memSettings;
  const raw = await prefsGet(SETTINGS_KEY);
  if (!raw) {
    memSettings = { ...DEFAULT_SETTINGS };
    return memSettings;
  }
  try {
    memSettings = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    memSettings = { ...DEFAULT_SETTINGS };
  }
  return memSettings;
}

export async function saveSettings(s: AppSettings): Promise<void> {
  memSettings = s;
  await prefsSet(SETTINGS_KEY, JSON.stringify(s));
}

/* ---------------------------- permission ---------------------------- */

export async function ensureNotificationPermission(): Promise<boolean> {
  if (!isNativeApp()) return false;
  try {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    const status = await LocalNotifications.checkPermissions();
    if (status.display === "granted") return true;
    const asked = await LocalNotifications.requestPermissions();
    return asked.display === "granted";
  } catch {
    return false;
  }
}

/* ---------------------------- evaluation ---------------------------- */

/**
 * Alerts already fired this run, keyed `ruleId|SYMBOL`.
 *
 * In memory only and intentionally so: it is a notification-dedupe set, not a data
 * cache, and it must not survive a relaunch (a symbol that ran yesterday should
 * alert again today).
 */
const fired = new Set<string>();

let notificationId = 1;

function matches(rule: AlertRule, row: StockMover): boolean {
  if (!rule.enabled) return false;
  if (rule.symbol && rule.symbol.toUpperCase() !== row.symbol.toUpperCase()) return false;
  return row.changePct >= rule.thresholdPct;
}

/**
 * Evaluate rules against ONE successful live poll and fire any newly-crossed alerts.
 *
 * `payload` must be the freshly fetched payload — never a retained previous one.
 * Returns the rows that triggered, so the caller can surface them in-app too.
 */
export async function evaluateAlerts(
  payload: ScannerPayload,
  rules: AlertRule[],
  settings: AppSettings,
): Promise<StockMover[]> {
  if (!settings.alertsEnabled || !rules.length) return [];

  const rows: StockMover[] = [
    ...payload.gainers,
    ...payload.premarket,
    ...payload.afterhours,
  ];
  if (!rows.length) return [];

  const triggered: StockMover[] = [];
  const seenThisPass = new Set<string>();

  for (const rule of rules) {
    for (const row of rows) {
      if (!matches(rule, row)) continue;
      const key = `${rule.id}|${row.symbol.toUpperCase()}`;
      if (fired.has(key) || seenThisPass.has(key)) continue;
      seenThisPass.add(key);
      fired.add(key);
      triggered.push(row);
    }
  }

  if (!triggered.length) return [];

  // The in-hand signal. Banner + system sound are handled by iOS via
  // `presentationOptions`; this is the part the app controls at runtime.
  if (settings.soundEnabled) await hapticAlert();

  if (isNativeApp()) {
    try {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      await LocalNotifications.schedule({
        notifications: triggered.slice(0, 8).map((row) => ({
          id: notificationId++,
          title: `${row.symbol} +${row.changePct.toFixed(2)}%`,
          body: `${row.name || row.symbol} at $${row.price}`,
          // NOTE: do NOT set `sound` here. On iOS the per-notification `sound`
          // field maps to `UNNotificationSound(named:)`, which requires an audio
          // file bundled in the app — passing an arbitrary/empty string yields a
          // broken sound reference, not silence. Foreground alert sound is
          // controlled by `plugins.LocalNotifications.presentationOptions` in
          // capacitor.config.ts instead.
        })),
      });
    } catch {
      /* an alert that fails to schedule must never break the poll loop */
    }
  }

  return triggered;
}

/** Clear the fired-dedupe set — e.g. when the user edits rules. */
export function resetFiredAlerts(): void {
  fired.clear();
}
