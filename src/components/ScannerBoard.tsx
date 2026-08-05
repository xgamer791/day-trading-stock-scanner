"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { NewsFeed, PanelHeader, SessionBadge, StockTable } from "@/components/Panels";
import { fetchLiveScannerClient, liveJsonUrl } from "@/lib/liveClient";
import type { MarketSession, ScannerPayload } from "@/lib/types";

function localSession(): MarketSession {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  if (["Sat", "Sun"].includes(weekday)) return "closed";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const mins = hour * 60 + minute;
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "premarket";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "regular";
  if (mins >= 16 * 60 && mins < 20 * 60) return "afterhours";
  return "closed";
}

async function fetchSnapshot(): Promise<ScannerPayload> {
  const res = await fetch(liveJsonUrl(), { cache: "no-store" });
  if (!res.ok) throw new Error(`Snapshot unavailable (${res.status})`);
  return (await res.json()) as ScannerPayload;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function loadScanner(): Promise<ScannerPayload> {
  // Fast path: same-origin snapshot (always works on GitHub Pages)
  const snapshot = await fetchSnapshot();

  // Best-effort realtime upgrade (CORS proxies). Must not block UI.
  try {
    const live = await withTimeout(fetchLiveScannerClient(), 4000);
    if (live.gainers.length || live.premarket.length) {
      return {
        ...live,
        news: live.news.length ? live.news : snapshot.news,
      };
    }
  } catch {
    /* keep snapshot */
  }

  if (
    !snapshot.gainers?.length &&
    !snapshot.premarket?.length &&
    localSession() === "regular"
  ) {
    throw new Error("Live market data returned no HOD movers");
  }
  return snapshot;
}

export function ScannerBoard() {
  const [data, setData] = useState<ScannerPayload | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"news" | "pre" | "mkt">("mkt");
  const [clockSession, setClockSession] = useState<MarketSession>(localSession);

  useEffect(() => {
    const id = setInterval(() => setClockSession(localSession()), 1000);
    return () => clearInterval(id);
  }, []);

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
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const session = data?.session ?? clockSession;

  const updatedLabel = data?.updatedAt
    ? new Date(data.updatedAt).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone: "America/New_York",
      })
    : "—";

  const sourceLabel =
    data?.source === "full-us-realtime"
      ? "US ALL-MKTS"
      : data?.source === "polygon"
        ? "POLYGON"
        : data
          ? "HOD LIVE"
          : "LOADING";

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
            High-of-day only · Top 20 · Full US markets
            </div>
          </div>
          <SessionBadge session={session} />
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
            {sourceLabel}
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
            title="Premarket"
            subtitle={
              session === "premarket"
                ? "Top 20 premarket HOD peaks — all US markets"
                : "Top 20 gap plays still at high of day"
            }
            count={data?.premarket.length ?? 0}
          />
          <StockTable
            rows={data?.premarket ?? []}
            emptyText={error ? "Live data error" : "No premarket HOD peaks right now"}
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
                ? "Opens 9:30 AM ET — top 20 open-market HOD"
                : "Top 20 open-market HOD peaks — full US"
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
                    : "Loading HOD gainers…"
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
  minHeight: "calc(100vh - 70px)",
  background: "var(--bg-panel)",
};
