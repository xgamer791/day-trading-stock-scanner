# iOS app — build, verify, ship

The scanner ships as a native iOS app (Capacitor 8) **and** as the existing GitHub
Pages site, from one codebase. This document is the operational half; the rules that
govern the data feed live in [`STOCK_SCANNER_APP_MEMORY.md`](../STOCK_SCANNER_APP_MEMORY.md)
and apply to the iOS build unchanged.

---

## Why native, in one paragraph

On GitHub Pages every market call has to be laundered through free public CORS
proxies, because Yahoo and Nasdaq do not send `Access-Control-Allow-Origin` for a
`github.io` origin. That proxy chain is the app's single largest source of
user-visible failure — Safari `Load failed` every ~20s, the board cycling between two
different identities, a blank `Flt` column. Native `URLSession` has no same-origin
policy, so inside the app those APIs are called **directly**, with a real
`User-Agent` and a real cookie jar. The proxy ladder is still there as a fallback,
but on a healthy device it is never used.

---

## Prerequisites

| | |
|---|---|
| macOS + Xcode 15+ | required to build, run and archive |
| Node 22 | matches CI |
| Apple Developer account | required for TestFlight ($99/yr) |
| CocoaPods | **not needed** — Capacitor 8 uses Swift Package Manager |

---

## Build

```bash
npm ci
cp .env.example .env.local     # then fill in NEXT_PUBLIC_POLYGON_API_KEY — see below
npm run build:ios              # static export (no basePath) → out/ → ios/App/App/public
npm run ios:open               # opens ios/App/App.xcodeproj in Xcode
```

> **Set the Polygon key before you build.** The Pages workflow injects it from an Actions
> secret, but a local iOS build has no such source: without `.env.local` the key compiles
> to `""`, `hasClientPolygonKey()` is false, and there is **no fallback behind Yahoo** —
> a single Yahoo failure clears the entire board. Confirm it landed with
> **Menu ▸ Connection** in the app.

`build:ios` deliberately does three things:

1. Sets `CAPACITOR_BUILD=true`, so `next.config.ts` emits **no `basePath`** — Capacitor
   serves from the scheme root and `/day-trading-stock-scanner/...` would 404.
2. Deletes `out/data` and `out/news-mockups` before sync. The mockups are 3MB of design
   JPEGs with no business in an app binary, and dropping `out/data` makes the top
   ZERO-CACHING rule **structurally unbreakable on iOS**: `live.json` and `floats.json`
   are not in the bundle, so no future change can accidentally read them.
3. Calls `next build` directly rather than `npm run build`, so the `prebuild` hook
   (`fetch:live`, which needs network) never runs. The iOS build is fully offline.

The web build is untouched: `npm run build` and the Pages workflow behave exactly as
before.

### First run in Xcode

1. Select the **App** target → Signing & Capabilities.
2. Set your Team. Signing is already `Automatic`; the bundle ID is
   `com.xgamer791.stockscanner` (change it in `capacitor.config.ts` **and** the Xcode
   target if you want a different one, then re-run `npx cap sync ios`).
3. Xcode resolves the Swift packages on first open. No `pod install`.

---

## Verify before you claim it works

`STOCK_SCANNER_APP_MEMORY.md` forbids reporting a fix as done without proof. There are
two gates.

### 1. The native data path — automated

```bash
npm run verify:native      # run during US market hours
```

Node's `fetch` runs under the same conditions as `URLSession` — no CORS, real UA, real
cookie jar — so this is a genuine proof of the native transport, not a simulation. It
asserts:

- every runtime endpoint is reachable with **no proxy**
- the ranked board builds from Yahoo `day_gainers` alone
- `%Chg` recomputes from the **same payload's** last + prevClose on every row
- `Flt` is populated for **≥70%** of the top 15 ranked gainers

Exit 0 = proven. Non-zero = do not claim the port works. Note that a failure here means
*degraded to the web proxy path*, not a broken app — `corsTransport.ts` still falls back.

> This cannot be run from a restricted CI/agent sandbox: the market-data hosts are
> usually blocked there (`403 Host not in allowlist`). Run it on your Mac.

### 1b. Menu ▸ Connection — on-device transport report

When the board is empty and the badge reads RECONNECTING, open the drawer and tap
**Connection**. It probes each transport in turn — native direct, native + Yahoo crumb,
Nasdaq direct, and the proxy ladder — and reports status, latency and the actual error for
each, plus whether the Polygon key made it into the build. Tap **Copy report** to paste it
somewhere useful.

This is a one-shot probe: it never feeds the board and never stores a quote.

### 2. On-device — manual

During market hours, on a real device (not just the Simulator):

- [ ] Status pill reads **LIVE**, not stuck on RECONNECTING
- [ ] Price, %Chg and Vol tick every ~3s
- [ ] `Flt` is numeric for most visible rows, not `—`
- [ ] All four tabs correct: News / Premarket / Gainers / After Hours
- [ ] After Hours only populates 16:00–20:00 ET
- [ ] Pull-to-refresh fires one extra poll, with haptic feedback
- [ ] Killing the network shows the error strip and **clears** the rows (never stale prices)
- [ ] Backgrounding then resuming refetches rather than showing pre-background prices
- [ ] https://xgamer791.github.io/day-trading-stock-scanner/ still works, unchanged

---

## TestFlight

Already configured:

- `ITSAppUsesNonExemptEncryption=false` — skips the export-compliance questionnaire on
  **every** upload
- `PrivacyInfo.xcprivacy` — wired into the target's Copy Bundle Resources phase.
  Declares no tracking, no data collection, and the four accessed-API reasons
  (UserDefaults `CA92.1`, file timestamp `C617.1`, boot time `35F9.1`, disk space `E174.1`)
- Portrait-only, dark UI, light status bar
- ATS: no exceptions — every upstream is HTTPS

Steps: bump `CURRENT_PROJECT_VERSION` → Product ▸ Archive → Distribute App ▸ App Store
Connect ▸ Upload.

**App Review note.** Financial-data apps get extra scrutiny. The app shows public market
data, has no account, no purchases, and collects nothing. If asked, the data sources are
Yahoo Finance, Nasdaq and Polygon public endpoints.

---

## Native behaviour worth knowing

| Behaviour | Where | Note |
|---|---|---|
| Direct API calls | `src/lib/nativeHttp.ts`, `corsTransport.ts` | one extra `native-direct` attempt, prepended only when `isNativeApp()` |
| Yahoo cookie+crumb | `nativeHttp.ts` | lazy — only after a 401/`Invalid Crumb` |
| Wider request pool | `corsTransport.ts` | `MAX_ACTIVE` 2→6 on native. The **reserved critical slot is preserved** — deleting it would reintroduce the documented starvation bug the moment we fell back to proxies |
| Pause on background | `ScannerBoard.tsx` | stops polling **and** clears rows, so pre-background prices can never paint as LIVE on resume |
| Keep awake | `nativeUi.ts` | only while foregrounded and the session is open |
| Alerts | `src/lib/alerts.ts` | evaluated against each successful poll |
| News links | `Panels.tsx` | in-app Safari view, so you keep your place on the board |

### Alerts: what iOS actually allows

While the app is **foregrounded**, alerts fire instantly and reliably. Once iOS suspends
the WebView, JavaScript stops — there is no way around this from a WebView app.
Real-time alerts with the app closed would need a server pushing via APNs, which this
app does not have. The Settings sheet says "Notifies while the app is open" for exactly
this reason; don't promise more in the UI.

### Optional: self-host the fonts

The three webfonts load from `api.fontshare.com`. `globals.css` declares full
`-apple-system` / `ui-monospace` fallbacks, so nothing breaks without it — but to remove
the network dependency entirely:

```bash
npm run fetch:fonts     # needs unrestricted network
```

then follow the two steps it prints.

### Regenerating the app icon

The icon is generated from an inline SVG, so there is no binary design dependency:

```bash
npm run ios:icon        # → assets/*.png
npm run ios:assets      # expands into every required size
```
