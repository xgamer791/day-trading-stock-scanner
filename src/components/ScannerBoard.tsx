"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { NewsFeed, PanelHeader, SessionBadge, StockTable } from "@/components/Panels";
import type { ScannerPayload } from "@/lib/types";

function liveDataUrl(): string {
  const base = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
  return `${base}/data/live.json?t=${Date.now()}`;
}

async function loadScanner(): Promise<ScannerPayload> {
  const key = process.env.NEXT_PUBLIC_POLYGON_API_KEY;
  if (key) {
    const [newsRes, gainersRes] = await Promise.all([
      fetch(
        `https://api.polygon.io/v2/reference/news?limit=40&order=desc&sort=published_utc&apiKey=${key}`,
      ),
      fetch(
        `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${key}`,
      ),
    ]);
    if (!newsRes.ok || !gainersRes.ok) {
      throw new Error(
        `Polygon live data failed (news ${newsRes.status}, gainers ${gainersRes.status})`,
      );
    }
    const { buildFromPolygon } = await import("@/lib/clientPolygon");
    return buildFromPolygon(await newsRes.json(), await gainersRes.json());
  }

  const res = await fetch(liveDataUrl(), { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Live market data unavailable (${res.status})`);
  }
  const payload = (await res.json()) as ScannerPayload;
  if (!payload.gainers?.length && !payload.premarket?.length) {
    throw new Error("Live market data returned no movers");
  }
  return payload;
}

export function ScannerBoard() {
  const [data, setData] = useState<ScannerPayload | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"news" | "pre" | "mkt">("pre");

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      try {
        const payload = await loadScanner();
        if (cancelled) return;
        setData(payload);
        setConnected(true);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setConnected(false);
        setError(err instanceof Error ? err.message : "Failed to load live data");
      }
    };

    tick();
    const id = setInterval(tick, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const updatedLabel = data?.updatedAt
    ? new Date(data.updatedAt).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone: "America/New_York",
      })
    : "—";

  const sourceLabel = data?.source === "polygon" ? "POLYGON" : "YAHOO LIVE";

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          padding: "14px 20px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg)",
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
          <div>
            <div
              style={{
                fontFamily: "var(--font-display)",
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: "-0.03em",
                lineHeight: 1,
              }}
            >
              HOD Scanner
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: "var(--text-dim)" }}>
              High-of-day peaking stocks · US equities
            </div>
          </div>
          <SessionBadge session={data?.session ?? "closed"} />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-dim)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              className={connected ? "live-dot" : undefined}
              style={{
                width: 8,
                height: 8,
                background: connected ? "var(--green)" : "var(--red)",
                display: "inline-block",
              }}
            />
            {connected ? "LIVE" : "RECONNECTING"}
          </span>
          <span>ET {updatedLabel}</span>
          <span
            style={{
              border: "1px solid var(--border-strong)",
              padding: "4px 8px",
              color: "var(--hod)",
            }}
          >
            {data ? sourceLabel : "LOADING"}
          </span>
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: "14px 20px",
            background: "var(--red-dim)",
            color: "var(--red)",
            fontSize: 14,
            fontWeight: 600,
            borderBottom: "1px solid var(--border)",
          }}
        >
          Live data error: {error}
        </div>
      )}

      <div className="mobile-tabs">
        {(
          [
            ["news", "News"],
            ["pre", "Premarket"],
            ["mkt", "Gainers"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setMobileTab(id)}
            style={{
              background: mobileTab === id ? "var(--bg-row)" : "transparent",
              color: mobileTab === id ? "var(--text)" : "var(--text-dim)",
              border: "none",
              borderRight: "1px solid var(--border)",
              padding: "12px 8px",
              fontWeight: 700,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <main className="scanner-grid">
        <section
          className={`panel ${mobileTab === "news" ? "mobile-show" : "mobile-hide"}`}
          style={panelStyle}
        >
          <PanelHeader
            title="Breaking News"
            subtitle="Most recent market headlines tied to active tickers"
            count={data?.news.length ?? 0}
          />
          <NewsFeed items={data?.news ?? []} />
        </section>

        <section
          className={`panel ${mobileTab === "pre" ? "mobile-show" : "mobile-hide"}`}
          style={{
            ...panelStyle,
            borderLeft: "1px solid var(--border)",
            borderRight: "1px solid var(--border)",
          }}
        >
          <PanelHeader
            title="Premarket HOD Gainers"
            subtitle="Live premarket / early runners — HOD peaks flagged"
            count={data?.premarket.length ?? 0}
          />
          <StockTable
            rows={data?.premarket ?? []}
            emptyText={error ? "Live data error" : "Loading live premarket movers…"}
          />
        </section>

        <section
          className={`panel ${mobileTab === "mkt" ? "mobile-show" : "mobile-hide"}`}
          style={panelStyle}
        >
          <PanelHeader
            title="Market Top Gainers"
            subtitle="Live day gainers — stocks at/near high of day flagged"
            count={data?.gainers.length ?? 0}
          />
          <StockTable
            rows={data?.gainers ?? []}
            emptyText={error ? "Live data error" : "Loading live market gainers…"}
          />
        </section>
      </main>
    </div>
  );
}

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: "calc(100vh - 70px)",
  background: "var(--bg-panel)",
};
