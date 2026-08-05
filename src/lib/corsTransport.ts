/**
 * Shared browser CORS transport (STOCK_SCANNER_APP_MEMORY.md).
 *
 * Public proxies are flaky; this module:
 *  - Prefers allorigins `/get` (unwraps `{ contents }`) — `/raw` often 500s
 *  - Sticky proxy preference (transport only — not quote data)
 *  - Priority queue so News cannot stampede the 3s gainers poll
 *  - Optional owned proxy via NEXT_PUBLIC_QUOTE_PROXY_URL
 *
 * Proxies return live upstream payloads only — never live.json.
 */

export type TransportPriority = "critical" | "normal" | "low";

type ProxyKind = "owned" | "allorigins-get" | "allorigins-raw" | "corsproxy" | "codetabs";

type ProxyAttempt = {
  kind: ProxyKind;
  url: string;
  /** Response is `{ contents: string, status?: { http_code?: number } }` */
  unwrapContents?: boolean;
};

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
  // Soft circuit — don't exile allorigins-get for long; it's the main public path.
  const threshold = kind === "allorigins-get" || kind === "owned" ? 3 : 2;
  const coolMs = kind === "allorigins-get" || kind === "owned" ? 8_000 : 20_000;
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
const MAX_ACTIVE = 2;
/**
 * Non-critical work may never occupy more than this many slots, which leaves at
 * least one slot permanently available to `critical`. The original comment here
 * ("keep concurrency at 1 for proxy stability") was right that public proxies
 * punish parallelism — so the fix is the *reservation*, not raw concurrency.
 * Two total is the smallest pool that can guarantee critical never blocks.
 */
const MAX_NONCRITICAL_ACTIVE = 1;

/**
 * A queued non-critical job older than this is for a superseded poll — drop it
 * rather than spending a proxy round-trip (and rate-limit budget) on stale work.
 */
const STALE_QUEUE_MS = 20_000;

function canStart(job: QueueJob<unknown>): boolean {
  if (active >= MAX_ACTIVE) return false;
  if (job.priority === "critical") return true;
  return activeNonCritical < MAX_NONCRITICAL_ACTIVE;
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

    if (active >= MAX_ACTIVE) return;
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

async function fetchTextUnqueued(targetUrl: string, timeoutMs: number): Promise<string> {
  let lastErr: Error | null = null;
  const attempts = buildAttempts(targetUrl);

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    // allorigins/get often needs >10s; don't abort early on the preferred path.
    const budget =
      attempt.kind === "allorigins-get" || attempt.kind === "owned"
        ? timeoutMs
        : Math.min(timeoutMs, i === 0 ? timeoutMs : Math.max(3500, Math.floor(timeoutMs * 0.5)));

    try {
      const res = await fetch(attempt.url, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
        signal: AbortSignal.timeout(budget),
      });
      if (!res.ok) {
        lastErr = new Error(`${attempt.kind} ${res.status}`);
        markFailure(attempt.kind);
        continue;
      }
      const raw = await res.text();
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

/** Direct browser fetch (no proxy) — for APIs that send ACAO (e.g. Polygon). */
export async function fetchJsonDirect(
  url: string,
  timeoutMs = 12000,
): Promise<unknown> {
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
