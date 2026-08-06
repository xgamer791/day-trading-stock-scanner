/**
 * Shared transport (STOCK_SCANNER_APP_MEMORY.md).
 *
 * Two lanes, same ladder:
 *
 *  - **iOS / Capacitor** — `native-direct` calls the upstream API straight through
 *    native URLSession. No same-origin policy, so no proxy is needed at all. This is
 *    tried first and, thanks to the sticky-preference logic below, becomes the only
 *    path attempted once it succeeds.
 *  - **Browser (GitHub Pages)** — public proxies are flaky, so this module:
 *      - Prefers allorigins `/get` (unwraps `{ contents }`) — `/raw` often 500s
 *      - Sticky proxy preference (transport only — not quote data)
 *      - Priority queue so News cannot stampede the 3s gainers poll
 *      - Optional owned proxy via NEXT_PUBLIC_QUOTE_PROXY_URL
 *
 * The native attempts are only ever *added* (see `buildAttempts`), so the browser
 * build's behaviour is unchanged: on web `isNativeApp()` is false and the attempt
 * list is identical to before. If a native direct call ever fails, its circuit trips
 * and the app falls back to the exact proxy ladder it uses today — degraded, never
 * broken.
 *
 * Proxies return live upstream payloads only — never live.json.
 */
import {
  isNativeApp,
  looksLikeYahooCrumbFailure,
  nativeGetText,
  resetYahooCrumb,
  withYahooCrumb,
} from "@/lib/nativeHttp";

export type TransportPriority = "critical" | "normal" | "low";

type ProxyKind =
  | "native-direct"
  | "native-crumb"
  | "owned"
  | "allorigins-get"
  | "allorigins-raw"
  | "corsproxy"
  | "codetabs";

type ProxyAttempt = {
  kind: ProxyKind;
  url: string;
  /** Response is `{ contents: string, status?: { http_code?: number } }` */
  unwrapContents?: boolean;
};

function isNativeKind(kind: ProxyKind): boolean {
  return kind === "native-direct" || kind === "native-crumb";
}

function bust(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function ownedProxyBase(): string | null {
  const raw = (process.env.NEXT_PUBLIC_QUOTE_PROXY_URL || "").trim().replace(/\/$/, "");
  return raw || null;
}

/** Sticky transport preference only (allowed by STOCK_SCANNER_APP_MEMORY). */
let preferredKind: ProxyKind | null = null;

/** Soft circuit: skip a proxy for a short window after repeated failures. */
const circuitUntil = new Map<ProxyKind, number>();
const failCounts = new Map<ProxyKind, number>();

function markSuccess(kind: ProxyKind) {
  preferredKind = kind;
  failCounts.set(kind, 0);
  circuitUntil.delete(kind);
}

function markFailure(kind: ProxyKind) {
  const n = (failCounts.get(kind) || 0) + 1;
  failCounts.set(kind, n);
  // Soft circuit — don't exile the main paths for long.
  // `native-direct` is the iOS happy path and a transient upstream blip must not
  // banish it in favour of the (much worse) public proxies, so it cools fastest.
  let threshold = 2;
  let coolMs = 20_000;
  if (isNativeKind(kind)) {
    threshold = 3;
    coolMs = 5_000;
  } else if (kind === "allorigins-get" || kind === "owned") {
    threshold = 3;
    coolMs = 8_000;
  }
  if (n >= threshold) {
    circuitUntil.set(kind, Date.now() + coolMs);
  }
}

function isOpen(kind: ProxyKind): boolean {
  const until = circuitUntil.get(kind) || 0;
  return Date.now() < until;
}

function buildAttempts(targetUrl: string): ProxyAttempt[] {
  const live = bust(targetUrl);
  const enc = encodeURIComponent(live);
  const owned = ownedProxyBase();

  const all: ProxyAttempt[] = [];

  // iOS/Capacitor: hit the upstream API directly through native URLSession.
  // There is no CORS to work around, so a proxy would only add latency and a
  // third-party failure mode. On web this block is skipped entirely, which is why
  // the browser attempt list is byte-for-byte what it was before.
  if (isNativeApp()) {
    all.push({ kind: "native-direct", url: live });
    // Yahoo periodically starts demanding a cookie+crumb. Only reachable if
    // `native-direct` failed first, and the crumb itself is established lazily.
    if (/\.yahoo\.com/i.test(targetUrl)) {
      all.push({ kind: "native-crumb", url: live });
    }
  }

  if (owned) {
    all.push({ kind: "owned", url: `${owned}?url=${enc}` });
  }
  all.push(
    {
      kind: "allorigins-get",
      url: `https://api.allorigins.win/get?url=${enc}`,
      unwrapContents: true,
    },
    { kind: "allorigins-raw", url: `https://api.allorigins.win/raw?url=${enc}` },
    { kind: "corsproxy", url: `https://corsproxy.io/?${enc}` },
    { kind: "codetabs", url: `https://api.codetabs.com/v1/proxy?quest=${enc}` },
  );

  // Sticky first, then skip open circuits (unless everything is open).
  const ordered = preferredKind
    ? [
        ...all.filter((a) => a.kind === preferredKind),
        ...all.filter((a) => a.kind !== preferredKind),
      ]
    : all;

  const available = ordered.filter((a) => !isOpen(a.kind));
  return available.length ? available : ordered;
}

function unwrapProxyText(text: string, attempt: ProxyAttempt): string {
  if (!attempt.unwrapContents) return text;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    throw new Error("allorigins unwrap: not JSON");
  }
  const parsed = JSON.parse(trimmed) as {
    contents?: unknown;
    status?: { http_code?: number };
  };
  const code = parsed.status?.http_code;
  if (typeof code === "number" && code >= 400) {
    throw new Error(`upstream ${code}`);
  }
  if (typeof parsed.contents !== "string") {
    throw new Error("allorigins unwrap: missing contents");
  }
  return parsed.contents;
}

type QueueJob<T> = {
  priority: TransportPriority;
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  /** When the job entered the queue — used to drop superseded work. */
  queuedAt: number;
};

const PRIORITY_RANK: Record<TransportPriority, number> = {
  critical: 0,
  normal: 1,
  low: 2,
};

const queue: QueueJob<unknown>[] = [];
let active = 0;
let activeNonCritical = 0;

/**
 * Concurrency lanes.
 *
 * Previously this was a single slot (MAX_ACTIVE = 1), which meant one *already
 * running* low-priority job (a 12s Nasdaq /summary Flt call, a 16s news fetch)
 * held the only slot while the 3s `day_gainers` poll waited behind it. Priority
 * sorting does not help once a job is active — there is no preemption. That
 * starvation is what surfaced as Safari "Load failed" every ~20s.
 *
 * Now: a small total pool, with slots *reserved* for critical work so the ranked
 * gainers poll can always start immediately.
 */
const MAX_ACTIVE_WEB = 2;
/**
 * Non-critical work may never occupy more than this many slots, which leaves at
 * least one slot permanently available to `critical`. The original comment here
 * ("keep concurrency at 1 for proxy stability") was right that public proxies
 * punish parallelism — so the fix is the *reservation*, not raw concurrency.
 * Two total is the smallest pool that can guarantee critical never blocks.
 */
const MAX_NONCRITICAL_ACTIVE_WEB = 1;

/**
 * Native lanes.
 *
 * The tiny web pool exists because free public proxies punish parallelism — that
 * constraint simply does not exist for native URLSession talking straight to Yahoo
 * and Nasdaq, so Flt enrichment and news no longer have to trickle.
 *
 * The pool is widened but NOT removed, and the reserved-critical-slot invariant
 * (`MAX_NONCRITICAL_ACTIVE < MAX_ACTIVE`) is preserved. Both matter: if a native
 * direct call ever fails and the app falls back to the proxy ladder, the queue is
 * the only thing standing between us and the documented starvation bug.
 */
const MAX_ACTIVE_NATIVE = 6;
const MAX_NONCRITICAL_ACTIVE_NATIVE = 4;

function maxActive(): number {
  return isNativeApp() ? MAX_ACTIVE_NATIVE : MAX_ACTIVE_WEB;
}

function maxNonCriticalActive(): number {
  return isNativeApp() ? MAX_NONCRITICAL_ACTIVE_NATIVE : MAX_NONCRITICAL_ACTIVE_WEB;
}

/**
 * A queued non-critical job older than this is for a superseded poll — drop it
 * rather than spending a proxy round-trip (and rate-limit budget) on stale work.
 */
const STALE_QUEUE_MS = 20_000;

function canStart(job: QueueJob<unknown>): boolean {
  if (active >= maxActive()) return false;
  if (job.priority === "critical") return true;
  return activeNonCritical < maxNonCriticalActive();
}

function pumpQueue() {
  if (!queue.length) return;
  queue.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);

  // Walk the queue rather than only considering the head: a blocked low-priority
  // job must not prevent a critical job behind it from starting.
  for (let i = 0; i < queue.length; ) {
    const job = queue[i];

    if (job.priority !== "critical" && Date.now() - job.queuedAt > STALE_QUEUE_MS) {
      queue.splice(i, 1);
      job.reject(new Error("transport: dropped stale queued request"));
      continue;
    }

    if (!canStart(job)) {
      i += 1;
      continue;
    }

    queue.splice(i, 1);
    active += 1;
    const nonCritical = job.priority !== "critical";
    if (nonCritical) activeNonCritical += 1;

    job
      .run()
      .then(job.resolve, job.reject)
      .finally(() => {
        active -= 1;
        if (nonCritical) activeNonCritical -= 1;
        pumpQueue();
      });

    if (active >= maxActive()) return;
  }
}

function enqueue<T>(priority: TransportPriority, run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      priority,
      run: run as () => Promise<unknown>,
      resolve: resolve as (v: unknown) => void,
      reject,
      queuedAt: Date.now(),
    });
    pumpQueue();
  });
}

/**
 * Run one attempt and return its raw body.
 *
 * Native attempts go out through URLSession (no CORS, real UA, real cookie jar);
 * proxy attempts use browser `fetch` exactly as before.
 */
async function runAttempt(attempt: ProxyAttempt, budget: number): Promise<string> {
  if (attempt.kind === "native-direct") {
    return nativeGetText(attempt.url, budget);
  }
  if (attempt.kind === "native-crumb") {
    const url = await withYahooCrumb(attempt.url);
    try {
      return await nativeGetText(url, budget);
    } catch (e) {
      // A crumb that stopped working must not be reused for the next 3s poll.
      if (looksLikeYahooCrumbFailure(e)) resetYahooCrumb();
      throw e;
    }
  }

  const res = await fetch(attempt.url, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
    signal: AbortSignal.timeout(budget),
  });
  if (!res.ok) {
    throw new Error(`${attempt.kind} ${res.status}`);
  }
  return res.text();
}

async function fetchTextUnqueued(targetUrl: string, timeoutMs: number): Promise<string> {
  let lastErr: Error | null = null;
  const attempts = buildAttempts(targetUrl);

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    // allorigins/get often needs >10s; don't abort early on the preferred path.
    // Native is a direct call to the origin — it should be fast, and giving it the
    // full budget would delay the proxy fallback when a host rejects direct calls.
    const budget = isNativeKind(attempt.kind)
      ? Math.min(timeoutMs, 12_000)
      : attempt.kind === "allorigins-get" || attempt.kind === "owned"
        ? timeoutMs
        : Math.min(timeoutMs, i === 0 ? timeoutMs : Math.max(3500, Math.floor(timeoutMs * 0.5)));

    try {
      const raw = await runAttempt(attempt, budget);
      if (!raw.trim()) {
        lastErr = new Error(`${attempt.kind} empty`);
        markFailure(attempt.kind);
        continue;
      }
      let text: string;
      try {
        text = unwrapProxyText(raw, attempt);
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        markFailure(attempt.kind);
        continue;
      }
      if (!text.trim()) {
        lastErr = new Error(`${attempt.kind} empty body`);
        markFailure(attempt.kind);
        continue;
      }
      if (text.trimStart().startsWith("<!DOCTYPE") || text.trimStart().startsWith("<html")) {
        lastErr = new Error(`${attempt.kind} HTML`);
        markFailure(attempt.kind);
        continue;
      }
      markSuccess(attempt.kind);
      return text;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      markFailure(attempt.kind);
    }
  }

  throw lastErr || new Error("All live proxies failed");
}

/**
 * Fetch upstream URL via CORS proxies. Returns response text (JSON or XML/RSS).
 * `priority: "critical"` for day_gainers / quotes; `"low"` for news.
 */
export function fetchTextViaCors(
  targetUrl: string,
  timeoutMs = 16000,
  priority: TransportPriority = "normal",
  opts?: { queue?: boolean },
): Promise<string> {
  const run = () => fetchTextUnqueued(targetUrl, timeoutMs);
  if (opts?.queue === false) return run();
  return enqueue(priority, run);
}

export async function fetchJsonViaCors(
  targetUrl: string,
  timeoutMs = 16000,
  priority: TransportPriority = "normal",
  opts?: { queue?: boolean },
): Promise<unknown> {
  const text = await fetchTextViaCors(targetUrl, timeoutMs, priority, opts);
  if (text.trimStart().startsWith("<")) {
    throw new Error("proxy HTML");
  }
  return JSON.parse(text);
}

/**
 * Direct fetch, no proxy — for APIs that send ACAO (e.g. Polygon), and for every
 * API once we're inside the native shell.
 */
export async function fetchJsonDirect(
  url: string,
  timeoutMs = 12000,
): Promise<unknown> {
  if (isNativeApp()) {
    // URLSession: no CORS, so this works for Yahoo/Nasdaq too, not just Polygon.
    const text = await nativeGetText(bust(url), timeoutMs);
    if (text.trimStart().startsWith("<")) throw new Error("native HTML response");
    return JSON.parse(text);
  }

  const res = await fetch(bust(url), {
    cache: "no-store",
    headers: { Accept: "application/json", "Cache-Control": "no-cache", Pragma: "no-cache" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`direct ${res.status}: ${body.slice(0, 160)}`);
  }
  return res.json();
}
