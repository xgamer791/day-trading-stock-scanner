/**
 * Optional owned CORS proxy for Yahoo / Nasdaq (STOCK_SCANNER_APP_MEMORY.md).
 *
 * Deploy to Cloudflare Workers (free tier), then set:
 *   NEXT_PUBLIC_QUOTE_PROXY_URL=https://YOUR_WORKER.workers.dev
 *
 * Proxies live upstream payloads only — never live.json / floats.json.
 */
export default {
  async fetch(request, _env, _ctx) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Cache-Control, Pragma",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get("url");
    if (!target) {
      return new Response(JSON.stringify({ error: "missing url" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return new Response(JSON.stringify({ error: "bad url" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const host = parsed.hostname.toLowerCase();
    const allowed =
      host.endsWith("yahoo.com") ||
      host === "api.nasdaq.com" ||
      host.endsWith(".nasdaq.com") ||
      host === "api.polygon.io";
    if (!allowed) {
      return new Response(JSON.stringify({ error: "host not allowed" }), {
        status: 403,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    try {
      const upstream = await fetch(parsed.toString(), {
        headers: {
          Accept: "application/json, text/xml, */*",
          "User-Agent":
            "Mozilla/5.0 (compatible; DayTradingStockScanner/1.0; +https://xgamer791.github.io/day-trading-stock-scanner/)",
        },
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      const body = await upstream.arrayBuffer();
      return new Response(body, {
        status: upstream.status,
        headers: {
          ...cors,
          "Content-Type": upstream.headers.get("Content-Type") || "application/json",
          "Cache-Control": "no-store",
        },
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: e instanceof Error ? e.message : "proxy failed" }),
        { status: 502, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }
  },
};
