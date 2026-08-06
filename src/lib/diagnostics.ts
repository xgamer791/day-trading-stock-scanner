/**
 * On-device transport diagnostics.
 *
 * When the board is empty and the badge says RECONNECTING, the useful question is
 * *which* transport failed and with what error — and that is invisible from the UI.
 * Rather than requiring Safari Web Inspector, this runs each path the live feed
 * depends on and reports the result on screen.
 *
 * Everything here is a one-shot probe triggered by the user. It never runs on the
 * poll loop, never feeds the board, and never stores a quote.
 */
import { fetchTextViaCors } from "@/lib/corsTransport";
import { hasClientPolygonKey } from "@/lib/clientPolygonLive";
import { isNativeApp, nativeGetText, nativePlatform, withYahooCrumb } from "@/lib/nativeHttp";

export type ProbeStatus = "ok" | "fail" | "info";

export type ProbeResult = {
  label: string;
  status: ProbeStatus;
  ms: number;
  detail: string;
};

const YAHOO_GAINERS =
  "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=100&scrIds=day_gainers&formatted=false";
const NASDAQ_MOVERS = "https://api.nasdaq.com/api/marketmovers?assetclass=stocks&limit=50";

function summarise(text: string): string {
  const head = text.trimStart();
  if (head.startsWith("<")) return `HTML response, ${text.length}B (blocked or error page)`;
  try {
    const j = JSON.parse(text);
    const quotes = j?.finance?.result?.[0]?.quotes;
    if (Array.isArray(quotes)) {
      if (!quotes.length) return "0 quotes — payload parsed but empty";
      const withPre = quotes.filter((q: Record<string, unknown>) => Number(q.preMarketPrice) > 0).length;
      const withPost = quotes.filter((q: Record<string, unknown>) => Number(q.postMarketPrice) > 0).length;
      return `${quotes.length} quotes · pre ${withPre} · post ${withPost} · top ${quotes[0]?.symbol}`;
    }
    if (j?.finance?.error) return `Yahoo error: ${JSON.stringify(j.finance.error).slice(0, 90)}`;
    const rows = j?.data?.STOCKS?.MostAdvanced?.table?.rows;
    if (Array.isArray(rows)) return `${rows.length} Most Advanced rows`;
    return `parsed JSON, keys: ${Object.keys(j).slice(0, 5).join(", ")}`;
  } catch {
    return `${text.length}B non-JSON: ${text.slice(0, 70).replace(/\s+/g, " ")}`;
  }
}

async function probe(
  label: string,
  fn: () => Promise<string>,
): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const text = await fn();
    return { label, status: "ok", ms: Date.now() - t0, detail: summarise(text) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { label, status: "fail", ms: Date.now() - t0, detail: msg || "unknown error" };
  }
}

/** Run the full transport probe. Sequential so results are attributable. */
export async function runDiagnostics(): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  const native = isNativeApp();

  out.push({
    label: "Build",
    status: "info",
    ms: 0,
    detail: process.env.NEXT_PUBLIC_BUILD_STAMP || "unknown",
  });

  out.push({
    label: "Platform",
    status: "info",
    ms: 0,
    detail: native
      ? `native (${nativePlatform()}) — direct calls available`
      : "web — all calls must go through CORS proxies",
  });

  out.push({
    label: "Polygon fallback key",
    status: hasClientPolygonKey() ? "ok" : "fail",
    ms: 0,
    detail: hasClientPolygonKey()
      ? "present — Polygon can carry the board if Yahoo fails"
      : "MISSING — no fallback behind Yahoo, so any Yahoo failure clears the board",
  });

  if (native) {
    out.push(
      await probe("Yahoo day_gainers · native direct", () => nativeGetText(YAHOO_GAINERS, 15000)),
    );
    out.push(
      await probe("Yahoo day_gainers · native + crumb", async () =>
        nativeGetText(await withYahooCrumb(YAHOO_GAINERS), 15000),
      ),
    );
    out.push(await probe("Nasdaq movers · native direct", () => nativeGetText(NASDAQ_MOVERS, 15000)));
  }

  // The proxy ladder is the fallback on native and the only path on web.
  out.push(
    await probe("Yahoo day_gainers · proxy ladder", () =>
      fetchTextViaCors(YAHOO_GAINERS, 20000, "critical", { queue: false }),
    ),
  );

  return out;
}
