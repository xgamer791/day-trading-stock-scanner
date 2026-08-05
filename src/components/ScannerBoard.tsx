"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { NewsFeed, PanelHeader, StockTable } from "@/components/Panels";
import { ScannerHeader, type ScannerTab } from "@/components/ScannerHeader";
import { fetchLiveScannerClient } from "@/lib/liveClient";
import { getMarketSession } from "@/lib/market";
import type { MarketSession, ScannerPayload } from "@/lib/types";

export function ScannerBoard() {
  const [data, setData] = useState<ScannerPayload | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<ScannerTab>("mkt");
  const [clockSession, setClockSession] = useState<MarketSession>(() => getMarketSession());
  const inFlight = useRef(false);

  useEffect(() => {
    const id = setInterval(() => setClockSession(getMarketSession()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        // LIVE ONLY — never live.json / snapshot (APP_MEMORY.md)
        const live = await fetchLiveScannerClient();
        if (cancelled) return;

        if (
          !live.gainers.length &&
          !live.premarket.length &&
          getMarketSession() === "regular"
        ) {
          throw new Error("Live market data returned no top gainers");
        }

        setData(live);
        setConnected(true);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setConnected(false);
        setError(err instanceof Error ? err.message : "Failed to load live data");
        // APP_MEMORY: on failure show RECONNECTING/error — do NOT paint stale last-tick rows.
        setData(null);
      } finally {
        inFlight.current = false;
      }
    };

    tick();
    const id = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const session = data?.session ?? clockSession;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <ScannerHeader
        activeTab={mobileTab}
        onTabChange={setMobileTab}
        connected={connected}
      />

      {error && (
        <div
          style={{
            padding: "10px 16px",
            background: "var(--red-dim)",
            color: "var(--red)",
            fontSize: 13,
            fontWeight: 600,
            borderBottom: "1px solid var(--border)",
          }}
        >
          Live data error: {error}
        </div>
      )}

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
            title="Premarket"
            subtitle="Live top gainers / gaps — entire US market"
            count={data?.premarket.length ?? 0}
          />
          <StockTable
            rows={data?.premarket ?? []}
            emptyText={error ? "Live data error" : "No premarket gainers right now"}
          />
        </section>

        <section
          className={`panel ${mobileTab === "mkt" ? "mobile-show" : "mobile-hide"}`}
          style={panelStyle}
        >
          <PanelHeader
            title="Market Top Gainers"
            subtitle={
              session === "premarket"
                ? "Opens 9:30 AM ET — live open-market gainers"
                : "Live top 50 % gainers — entire US market"
            }
            count={data?.gainers.length ?? 0}
          />
          <StockTable
            rows={data?.gainers ?? []}
            emptyText={
              error
                ? "Live data error"
                : session === "premarket"
                  ? "Market not open yet"
                  : session === "closed"
                    ? "Market closed"
                    : "Scanning live…"
            }
          />
        </section>
      </main>
    </div>
  );
}

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: "calc(100vh - 96px)",
  background: "var(--bg-panel)",
};
