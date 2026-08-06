/**
 * Thin, SSR-safe wrappers around the Capacitor device plugins.
 *
 * Every export here is a no-op on the web build, so components can call them
 * unconditionally and the GitHub Pages bundle behaves exactly as it does today.
 * All plugin imports are dynamic — `next build` prerenders in Node, where touching
 * a Capacitor global at module scope would break the build.
 *
 * Nothing in this file stores market data. See STOCK_SCANNER_APP_MEMORY.md.
 */
import { isNativeApp } from "@/lib/nativeHttp";

/* ----------------------------- haptics ----------------------------- */

let hapticsEnabled = true;

/** User preference toggle — read by every haptic helper below. */
export function setHapticsEnabled(on: boolean) {
  hapticsEnabled = on;
}

export function getHapticsEnabled(): boolean {
  return hapticsEnabled;
}

/** Light tap — tab switches, button presses. */
export async function hapticTap(): Promise<void> {
  if (!isNativeApp() || !hapticsEnabled) return;
  try {
    const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    /* haptics are a nicety — never let them surface as an error */
  }
}

/** Medium thud — pull-to-refresh crossing its threshold. */
export async function hapticPull(): Promise<void> {
  if (!isNativeApp() || !hapticsEnabled) return;
  try {
    const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
    await Haptics.impact({ style: ImpactStyle.Medium });
  } catch {
    /* ignore */
  }
}

/** Success notification pattern — a price alert fired. */
export async function hapticAlert(): Promise<void> {
  if (!isNativeApp() || !hapticsEnabled) return;
  try {
    const { Haptics, NotificationType } = await import("@capacitor/haptics");
    await Haptics.notification({ type: NotificationType.Success });
  } catch {
    /* ignore */
  }
}

/* ---------------------------- keep awake ---------------------------- */

let keepAwakeOn = false;

/**
 * Hold the screen on while a live board is being watched.
 *
 * Called with `true` only when the app is foregrounded AND the market session is
 * not closed — a scanner you have to keep tapping to read is useless, but holding
 * the screen on overnight would just drain the battery.
 */
export async function setKeepAwake(on: boolean): Promise<void> {
  if (!isNativeApp()) return;
  if (on === keepAwakeOn) return;
  keepAwakeOn = on;
  try {
    const { KeepAwake } = await import("@capacitor-community/keep-awake");
    if (on) await KeepAwake.keepAwake();
    else await KeepAwake.allowSleep();
  } catch {
    /* ignore */
  }
}

/* --------------------------- app chrome --------------------------- */

/** Dark status bar + hide the launch splash once React has painted. */
export async function initNativeChrome(): Promise<void> {
  if (!isNativeApp()) return;
  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setOverlaysWebView({ overlay: false });
  } catch {
    /* ignore */
  }
  try {
    const { SplashScreen } = await import("@capacitor/splash-screen");
    await SplashScreen.hide();
  } catch {
    /* ignore */
  }
}

/* -------------------------- app lifecycle -------------------------- */

export type AppStateHandler = (active: boolean) => void;

/**
 * Subscribe to foreground/background transitions.
 *
 * Returns an unsubscribe function. On web this is a no-op that returns a no-op,
 * so callers need no platform branch.
 */
export function onAppStateChange(handler: AppStateHandler): () => void {
  if (!isNativeApp()) return () => {};
  let remove: (() => void) | null = null;
  let cancelled = false;

  void (async () => {
    try {
      const { App } = await import("@capacitor/app");
      const sub = await App.addListener("appStateChange", ({ isActive }) => {
        handler(isActive);
      });
      if (cancelled) void sub.remove();
      else remove = () => void sub.remove();
    } catch {
      /* ignore */
    }
  })();

  return () => {
    cancelled = true;
    remove?.();
  };
}

/** Open a URL in the in-app Safari view (news links) instead of ejecting to Safari. */
export async function openExternal(url: string): Promise<boolean> {
  if (!isNativeApp()) return false;
  try {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url, presentationStyle: "popover", toolbarColor: "#0b0d10" });
    return true;
  } catch {
    return false;
  }
}
