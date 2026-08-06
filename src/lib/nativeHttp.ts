/**
 * Native HTTP transport for the iOS (Capacitor) build.
 *
 * Why this file exists
 * -------------------
 * On GitHub Pages every market call has to be laundered through free public CORS
 * proxies, because query1.finance.yahoo.com / api.nasdaq.com do not send ACAO for a
 * github.io origin. That proxy chain is the single largest source of user-visible
 * failure in this app (see STOCK_SCANNER_APP_MEMORY.md — "Transport starvation" and
 * the Safari `Load failed` notes).
 *
 * Inside the iOS app the requests are issued by native URLSession via CapacitorHttp.
 * URLSession has no same-origin policy, so the proxies are simply not needed: we call
 * the upstream APIs directly, with a real User-Agent and a real cookie jar.
 *
 * ZERO CACHING (STOCK_SCANNER_APP_MEMORY.md)
 * -----------------------------------------
 * This is a *transport*. It never persists a payload. Every request carries
 * no-cache headers and a cache-busting query param, exactly like the browser path.
 *
 * SSR safety
 * ----------
 * `next build` prerenders in Node where `window` does not exist. Nothing here may
 * touch a browser/Capacitor global at module scope — every accessor is lazy, and
 * `@capacitor/core` is only imported inside an async function.
 */

type CapacitorHttpResponse = {
  data: unknown;
  status: number;
  headers: Record<string, string>;
  url: string;
};

type CapacitorHttpPlugin = {
  request(options: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    params?: Record<string, string>;
    connectTimeout?: number;
    readTimeout?: number;
    responseType?: "text" | "json" | "blob" | "arraybuffer" | "document";
    webFetchExtra?: RequestInit;
    shouldEncodeUrlParams?: boolean;
  }): Promise<CapacitorHttpResponse>;
};

type CapacitorGlobal = {
  isNativePlatform(): boolean;
  getPlatform(): string;
};

/**
 * Safari-like UA. The browser cannot set this header; native can — and Nasdaq's API
 * in particular is picky about clients that do not look like a browser.
 */
export const NATIVE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

let cachedIsNative: boolean | null = null;
let httpPluginPromise: Promise<CapacitorHttpPlugin | null> | null = null;

/**
 * True only inside the Capacitor iOS/Android shell.
 *
 * Must never be called at module scope — see the SSR note above. The result is
 * memoised because it cannot change within a running app.
 */
export function isNativeApp(): boolean {
  if (cachedIsNative !== null) return cachedIsNative;
  if (typeof window === "undefined") return false; // prerender / Node
  try {
    const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
    cachedIsNative = Boolean(cap?.isNativePlatform?.());
  } catch {
    cachedIsNative = false;
  }
  return cachedIsNative;
}

/** "ios" | "android" | "web" (or "web" when not running under Capacitor at all). */
export function nativePlatform(): string {
  if (typeof window === "undefined") return "web";
  try {
    const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
    return cap?.getPlatform?.() ?? "web";
  } catch {
    return "web";
  }
}

async function loadHttpPlugin(): Promise<CapacitorHttpPlugin | null> {
  if (!httpPluginPromise) {
    httpPluginPromise = import("@capacitor/core")
      .then((m) => (m as unknown as { CapacitorHttp?: CapacitorHttpPlugin }).CapacitorHttp ?? null)
      .catch(() => null);
  }
  return httpPluginPromise;
}

/**
 * Absolute ceiling on any native call.
 *
 * `connectTimeout` / `readTimeout` are passed to URLSession, but a transport must
 * not depend on the callee honouring its own timeout: a native request that never
 * settles would leave the poll permanently in-flight — no data, no error, a
 * RECONNECTING badge forever. This race guarantees every native promise settles.
 */
function withHardTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} hard-timeout ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function toText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data == null) return "";
  // CapacitorHttp will hand back a parsed object when the upstream declares JSON,
  // even with responseType "text". Re-stringify so callers keep a uniform contract.
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

/**
 * GET a URL through native URLSession and return the raw body text.
 *
 * Works for JSON and for RSS/XML alike — the news feed parses text, so this cannot
 * assume JSON. Throws on non-2xx or on an empty body so the caller's existing
 * failure/fallback handling in corsTransport.ts applies unchanged.
 */
export async function nativeGetText(
  url: string,
  timeoutMs = 12_000,
  headers: Record<string, string> = {},
): Promise<string> {
  const http = await loadHttpPlugin();
  if (!http) throw new Error("native: CapacitorHttp unavailable");

  const res = await withHardTimeout(
    http.request({
    url,
    method: "GET",
    responseType: "text",
    connectTimeout: timeoutMs,
    readTimeout: timeoutMs,
    // Cache-busting is done by the caller (corsTransport `bust()`); these headers stop
    // URLSession/URLCache from serving a stored response. ZERO CACHING applies natively too.
    headers: {
      "User-Agent": NATIVE_USER_AGENT,
      Accept: "application/json,text/plain,text/xml,application/xml,*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache, no-store, max-age=0",
      Pragma: "no-cache",
      ...headers,
    },
    }),
    timeoutMs + 2_000,
    "native",
  );

  if (typeof res.status === "number" && (res.status < 200 || res.status >= 300)) {
    throw new Error(`native ${res.status}`);
  }

  const text = toText(res.data);
  if (!text.trim()) throw new Error("native empty body");
  return text;
}

/** Convenience wrapper: native GET + JSON parse, with an HTML-response guard. */
export async function nativeGetJson(url: string, timeoutMs = 12_000): Promise<unknown> {
  const text = await nativeGetText(url, timeoutMs);
  const head = text.trimStart();
  if (head.startsWith("<!DOCTYPE") || head.startsWith("<html")) {
    throw new Error("native HTML response");
  }
  return JSON.parse(text);
}

/* ------------------------------------------------------------------ *
 * Yahoo cookie + crumb
 *
 * Yahoo intermittently starts requiring a consent cookie plus a `crumb` on its
 * finance endpoints. The browser build can do nothing about this; native holds a
 * real cookie jar in URLSession, so we can establish a session the same way
 * scripts/yahoo-float.mjs already does for Node.
 *
 * Established lazily and ONLY after a 401/"Invalid Crumb" — it costs two extra
 * round-trips, so it must never be on the happy path of a 3s poll.
 * ------------------------------------------------------------------ */

let crumbPromise: Promise<string | null> | null = null;
let crumbValue: string | null = null;

export function looksLikeYahooCrumbFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /invalid crumb|unauthorized|native 401|native 403/i.test(msg);
}

async function establishYahooCrumb(): Promise<string | null> {
  const http = await loadHttpPlugin();
  if (!http) return null;
  try {
    // Seed cookies — the response bodies are irrelevant, the Set-Cookie headers are not.
    for (const seed of ["https://fc.yahoo.com/", "https://finance.yahoo.com/"]) {
      await withHardTimeout(
        http.request({
          url: seed,
          method: "GET",
          responseType: "text",
          connectTimeout: 5_000,
          readTimeout: 5_000,
          headers: { "User-Agent": NATIVE_USER_AGENT, Accept: "text/html,*/*" },
        }),
        6_000,
        "crumb-seed",
      ).catch(() => null);
    }
    const crumb = await nativeGetText(
      "https://query2.finance.yahoo.com/v1/test/getcrumb",
      6_000,
    );
    const trimmed = crumb.trim();
    return trimmed && trimmed.length < 64 ? trimmed : null;
  } catch {
    return null;
  }
}

/** Cached Yahoo crumb, established on first need. Reset with `resetYahooCrumb()`. */
export function getYahooCrumb(): Promise<string | null> {
  if (!crumbPromise) {
    crumbPromise = establishYahooCrumb().then((c) => {
      crumbValue = c;
      return c;
    });
  }
  return crumbPromise;
}

/**
 * Non-blocking crumb lookup for the transport ladder.
 *
 * Establishing a crumb costs three round-trips; awaiting that inside a ladder
 * attempt would let one slow Yahoo handshake eat the whole poll budget. Instead:
 * return the crumb if one is ready, and otherwise kick establishment off in the
 * background and fail this attempt fast — the *next* poll (3s later) finds it ready.
 */
export function peekYahooCrumb(): string | null {
  if (!crumbPromise) void getYahooCrumb();
  return crumbValue;
}

/** Drop a crumb that stopped working so the next failure re-establishes one. */
export function resetYahooCrumb(): void {
  crumbPromise = null;
  crumbValue = null;
}

/** Append `&crumb=…` to a Yahoo URL. */
export function appendYahooCrumb(url: string, crumb: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}crumb=${encodeURIComponent(crumb)}`;
}

/** Await-based variant for the diagnostics screen, which *wants* to wait. */
export async function withYahooCrumb(url: string): Promise<string> {
  if (!/\.yahoo\.com/i.test(url)) return url;
  const crumb = await getYahooCrumb();
  return crumb ? appendYahooCrumb(url, crumb) : url;
}
