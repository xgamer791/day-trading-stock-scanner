import type { CapacitorConfig } from "@capacitor/cli";

/**
 * iOS shell for the Day Trading Stock Scanner.
 *
 * STOCK_SCANNER_APP_MEMORY.md — ZERO CACHING IN LIVE FEED still applies here:
 *  - `webDir: "out"` is the static app shell only (explicitly allowed).
 *  - `npm run build:ios` deletes `out/data/` before sync, so live.json / floats.json
 *    are not even present in the app bundle.
 *  - No service worker, no WKWebView data cache for market payloads — every quote
 *    request goes out through CapacitorHttp with cache-busting (src/lib/nativeHttp.ts).
 */
const config: CapacitorConfig = {
  appId: "com.xgamer791.stockscanner",
  appName: "Top Gainers",
  webDir: "out",

  ios: {
    // The board is a dense table; let the web layer own safe-area insets so the
    // sticky header and the bottom tab bar can both sit under/over them correctly.
    contentInset: "never",
    backgroundColor: "#0b0d10",
    // Keep link taps (news rows) inside the app's own handling.
    limitsNavigationsToAppBoundDomains: false,
    scrollEnabled: true,
  },

  plugins: {
    /**
     * Deliberately DISABLED.
     *
     * This flag only controls whether Capacitor monkey-patches the *global*
     * `window.fetch` / `XMLHttpRequest`. `CapacitorHttp.request()` stays available
     * either way, and that is what src/lib/nativeHttp.ts calls explicitly.
     *
     * Global patching is wrong for this app: corsTransport.ts relies on
     * `AbortSignal.timeout()`, `cache: "no-store"` and real `Response` semantics that
     * the patched fetch reimplements imperfectly, and the patch would also intercept
     * Next.js's own internal fetches. Explicit calls keep the native path scoped and
     * testable, and keep the web build byte-for-byte unaffected.
     */
    CapacitorHttp: { enabled: false },

    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: "#0b0d10",
      showSpinner: false,
      iosSpinnerStyle: "small",
      splashFullScreen: true,
    },

    Keyboard: {
      resize: "none",
    },

    /**
     * Alerts fire while the app is open, so foreground presentation is what matters.
     * Without this, iOS silently swallows a notification delivered to a foregrounded
     * app. `sound` here plays the system default — the per-notification `sound` field
     * cannot, because it requires an audio file bundled in the app.
     */
    LocalNotifications: {
      presentationOptions: ["badge", "sound", "banner", "list"],
    },
  },
};

export default config;
