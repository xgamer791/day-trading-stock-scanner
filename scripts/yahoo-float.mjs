/**
 * Yahoo Finance share-count for Realtime Screener Flt column parity.
 *
 * Realtime's Flt tracks Yahoo impliedSharesOutstanding (ADR / diluted share
 * count), NOT narrow floatShares — e.g. YXT ≈ 6M, JLHL ≈ 21M, RITR ≈ 62M.
 * Fallback: sharesOutstanding → floatShares.
 * Returns millions of shares.
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function mergeCookies(existing, res) {
  const map = new Map();
  for (const part of String(existing || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq > 0) map.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const setCookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [];
  for (const c of setCookies) {
    const pair = c.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) map.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function rawShares(v) {
  const n = typeof v === "object" && v != null ? Number(v.raw) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Pick Realtime-parity share count from Yahoo defaultKeyStatistics. */
export function realtimeFloatShares(ks) {
  if (!ks || typeof ks !== "object") return null;
  return (
    rawShares(ks.impliedSharesOutstanding) ??
    rawShares(ks.sharesOutstanding) ??
    rawShares(ks.floatShares)
  );
}

export async function createYahooSession() {
  let cookie = "";
  for (const url of ["https://fc.yahoo.com", "https://finance.yahoo.com/"]) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html,*/*" },
        redirect: "follow",
      });
      cookie = mergeCookies(cookie, res);
      await res.arrayBuffer().catch(() => {});
    } catch {
      /* seed best-effort */
    }
  }

  const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: {
      "User-Agent": UA,
      Accept: "text/plain,*/*",
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  cookie = mergeCookies(cookie, crumbRes);
  if (!crumbRes.ok) {
    throw new Error(`Yahoo crumb HTTP ${crumbRes.status}`);
  }
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.length > 40 || crumb.includes("<")) {
    throw new Error("Yahoo crumb invalid");
  }
  return { cookie, crumb };
}

/** @returns {Promise<Map<string, number>>} symbol → float millions (Realtime Flt) */
export async function fetchFloatMillions(symbols, session) {
  const uniq = [...new Set(symbols.map((s) => String(s || "").toUpperCase()).filter(Boolean))];
  const out = new Map();
  const queue = [...uniq];
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const sym = queue.shift();
      if (!sym) break;
      try {
        const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
          sym,
        )}?modules=defaultKeyStatistics&crumb=${encodeURIComponent(session.crumb)}`;
        const res = await fetch(url, {
          headers: {
            "User-Agent": UA,
            Accept: "application/json",
            Cookie: session.cookie,
          },
        });
        if (res.status === 401 || res.status === 403) {
          queue.length = 0;
          break;
        }
        if (!res.ok) continue;
        const data = await res.json();
        const ks = data?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
        const raw = realtimeFloatShares(ks);
        if (raw != null) out.set(sym, raw / 1_000_000);
      } catch {
        /* skip symbol */
      }
    }
  });
  await Promise.all(workers);
  return out;
}
