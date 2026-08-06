"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { NewsFeed, PanelHeader, StockTable } from "@/components/Panels";
import { PullToRefresh } from "@/components/PullToRefresh";
import { ScannerHeader, type ScannerTab } from "@/components/ScannerHeader";
import { SideMenu } from "@/components/SideMenu";
import {
  EMPTY_VIEW_FILTER,
  SettingsSheet,
  viewFilterActive,
  type ViewFilter,
} from "@/components/SettingsSheet";
import { TabBar } from "@/components/TabBar";
import {
  DEFAULT_SETTINGS,
  evaluateAlerts,
  loadAlertRules,
  loadSettings,
  resetFiredAlerts,
  saveAlertRules,
  saveSettings,
  type AlertRule,
  type AppSettings,
} from "@/lib/alerts";
import { fetchLiveNewsFeed, fetchLiveNewsFeedQuick } from "@/lib/fetchLiveNewsFeed";
import { fetchLiveScannerClient } from "@/lib/liveClient";
import { getMarketSession } from "@/lib/market";
import { isNativeApp } from "@/lib/nativeHttp";
import { initNativeChrome, onAppStateChange, setHapticsEnabled, setKeepAwake } from "@/lib/nativeUi";
import type { MarketSession, NewsItem, ScannerPayload, StockMover } from "@/lib/types";

/**
 * Apply the user's display-only filters.
 *
 * These run AFTER ranking and never change what qualifies for the board — the only
 * ranking filter remains "top 50 by % gain across the whole US market"
 * (STOCK_SCANNER_APP_MEMORY.md, Product rules). This just hides rows the user does
 * not want to look at, and is off by default.
 */
function applyViewFilters(rows: StockMover[], search: string, f: ViewFilter): StockMover[] {
  const q = search.trim().toUpperCase();
  if (!q && !viewFilterActive(f)) return rows;
  return rows.filter((r) => {
    if (q && !r.symbol.toUpperCase().includes(q)) return false;
    if (f.minPrice != null && r.price < f.minPrice) return false;
    if (f.maxPrice != null && r.price > f.maxPrice) return false;
    if (f.minVolume != null && r.volume < f.minVolume) return false;
    if (f.maxFloatMillions != null) {
      // A row with unknown float is not proof it passes — exclude it when the user
      // has explicitly asked for a float ceiling.
      if (r.floatMillions == null || r.floatMillions > f.maxFloatMillions) return false;
    }
    return true;
  });
}

export function ScannerBoard() {
  const [data, setData] = useState<ScannerPayload | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [newsLoading, setNewsLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newsError, setNewsError] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<ScannerTab>("mkt");
  const [clockSession, setClockSession] = useState<MarketSession>(() => getMarketSession());
  const [search, setSearch] = useState("");
  const [viewFilter, setViewFilter] = useState<ViewFilter>(EMPTY_VIEW_FILTER);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [rules, setRules] = useState<AlertRule[]>([]);

  const inFlight = useRef(false);
  const newsInFlight = useRef(false);
  const newsRef = useRef<NewsItem[]>([]);
  newsRef.current = news;
  /**
   * Only build the After Hours board while that tab is on screen.
   *
   * A ref (not a dep) so switching tabs does not tear down and restart the 3s
   * poll interval. AH costs 3 extra Yahoo screener calls plus up to 12 Nasdaq
   * /summary calls per poll — running it every 3s behind the ranked board is
   * what saturates the public proxies during 16:00–20:00 ET.
   */
  const ahTabRef = useRef(false);
  ahTabRef.current = mobileTab === "ah";

  /** Alert inputs, read inside the poll without making it a dep. */
  const rulesRef = useRef<AlertRule[]>([]);
  rulesRef.current = rules;
  const settingsRef = useRef<AppSettings>(settings);
  settingsRef.current = settings;

  /** Set while the app is backgrounded — the poll must not paint into a hidden app. */
  const pausedRef = useRef(false);
  const tickRef = useRef<() => Promise<void>>(async () => {});

  /* ------------------------- load persisted prefs ------------------------- */

  useEffect(() => {
    void initNativeChrome();
    void (async () => {
      const [s, r] = await Promise.all([loadSettings(), loadAlertRules()]);
      setSettings(s);
      setRules(r);
      setHapticsEnabled(s.hapticsEnabled);
    })();
  }, []);

  useEffect(() => {
    setHapticsEnabled(settings.hapticsEnabled);
  }, [settings.hapticsEnabled]);

  /* ------------------------------- clock ------------------------------- */

  useEffect(() => {
    const id = setInterval(() => setClockSession(getMarketSession()), 1000);
    return () => clearInterval(id);
  }, []);

  /* ---------------------------- quote polling ---------------------------- */

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      if (inFlight.current || pausedRef.current) return;
      inFlight.current = true;
      try {
        // LIVE ONLY — never live.json / snapshot (STOCK_SCANNER_APP_MEMORY.md)
        const live = await fetchLiveScannerClient({
          includeAfterHours: ahTabRef.current,
        });
        if (cancelled || pausedRef.current) return;

        if (
          !live.gainers.length &&
          !live.premarket.length &&
          !live.afterhours.length &&
          getMarketSession() === "regular"
        ) {
          throw new Error("Live market data returned no top gainers");
        }

        setData(live);
        setConnected(true);
        setError(null);

        // Alerts are evaluated only against this freshly-fetched payload.
        void evaluateAlerts(live, rulesRef.current, settingsRef.current);
      } catch (err) {
        if (cancelled) return;
        setConnected(false);
        const raw = err instanceof Error ? err.message : "Failed to load live data";
        // Safari often surfaces opaque TypeError "Load failed" for proxy/CORS failures.
        const msg =
          /load failed|failed to fetch|networkerror|aborted/i.test(raw)
            ? "Live feed reconnecting (quote transport)…"
            : raw;
        setError(msg);
        // STOCK_SCANNER_APP_MEMORY: on failure show RECONNECTING/error — do NOT paint stale last-tick rows.
        setData(null);
      } finally {
        inFlight.current = false;
      }
    };

    tickRef.current = tick;
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  /* -------------------------- news polling -------------------------- */

  // Live news: quick paint first, then deepen from full source registry.
  useEffect(() => {
    let cancelled = false;

    const tickNews = async () => {
      if (newsInFlight.current || pausedRef.current) return;
      newsInFlight.current = true;
      const empty = newsRef.current.length === 0;
      if (empty) setNewsLoading(true);

      try {
        // Phase 1 — fast sources so we never stick on Loading…
        try {
          const quick = await fetchLiveNewsFeedQuick();
          if (cancelled) return;
          if (quick.length) {
            setNews(quick);
            setNewsError(null);
            setNewsLoading(false);
          }
        } catch {
          /* fall through to full scan */
        }

        // Phase 2 — all registered sources (hard deadline inside fetchLiveNews)
        const full = await fetchLiveNewsFeed();
        if (cancelled) return;
        setNews(full);
        setNewsError(null);
      } catch (err) {
        if (cancelled) return;
        if (newsRef.current.length === 0) {
          setNews([]);
          setNewsError(err instanceof Error ? err.message : "Live news unavailable");
        }
      } finally {
        if (!cancelled) setNewsLoading(false);
        newsInFlight.current = false;
      }
    };

    tickNews();
    const id = setInterval(tickNews, 45000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  /* --------------------------- app lifecycle --------------------------- */

  /**
   * Pause polling while backgrounded; refetch immediately on resume.
   *
   * This is NOT a caching violation. Two things are true and both matter:
   *  - While hidden we simply decline to fetch (iOS suspends timers anyway, and
   *    hammering Yahoo from a backgrounded app is what gets a client rate-limited).
   *  - We `setData(null)` on the way out, so there is no possibility of the board
   *    painting pre-background prices as LIVE on resume. The first thing a resumed
   *    app does is a fresh live poll, exactly like a cold start.
   */
  useEffect(() => {
    return onAppStateChange((active) => {
      pausedRef.current = !active;
      if (active) {
        void tickRef.current();
      } else {
        setConnected(false);
        setData(null);
        void setKeepAwake(false);
      }
    });
  }, []);

  const session = data?.session ?? clockSession;

  /* ---------------------------- keep awake ---------------------------- */

  useEffect(() => {
    const shouldHold = settings.keepAwakeEnabled && session !== "closed" && !pausedRef.current;
    void setKeepAwake(shouldHold);
    return () => {
      void setKeepAwake(false);
    };
  }, [settings.keepAwakeEnabled, session]);

  /* ------------------------------ handlers ------------------------------ */

  const refreshNow = useCallback(() => tickRef.current(), []);

  const persistSettings = useCallback((next: AppSettings) => {
    setSettings(next);
    void saveSettings(next);
  }, []);

  const persistRules = useCallback((next: AlertRule[]) => {
    setRules(next);
    resetFiredAlerts();
    void saveAlertRules(next);
  }, []);

  const filtered = useMemo(
    () => ({
      premarket: applyViewFilters(data?.premarket ?? [], search, viewFilter),
      gainers: applyViewFilters(data?.gainers ?? [], search, viewFilter),
      afterhours: applyViewFilters(data?.afterhours ?? [], search, viewFilter),
    }),
    [data, search, viewFilter],
  );

  const filtersOn = search.trim().length > 0 || viewFilterActive(viewFilter);

  const emptyFor = (base: string) =>
    error ? "Live data error" : filtersOn ? "No rows match your filter" : base;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <ScannerHeader
        activeTab={mobileTab}
        onTabChange={setMobileTab}
        connected={connected}
        lastUpdated={data?.updatedAt ?? null}
        search={search}
        onSearchChange={setSearch}
        onOpenMenu={() => setMenuOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        soundOn={settings.soundEnabled}
        onToggleSound={() => persistSettings({ ...settings, soundEnabled: !settings.soundEnabled })}
        filterActive={filtersOn}
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
          style={{ ...panelStyle, background: "#000" }}
        >
          <NewsFeed items={news} loading={newsLoading} />
          {newsError && news.length === 0 && (
            <div
              style={{
                padding: "10px 16px",
                color: "var(--red)",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Live news error: {newsError}
            </div>
          )}
        </section>

        <section
          className={`panel ${mobileTab === "pre" ? "mobile-show" : "mobile-hide"}`}
          style={{
            ...panelStyle,
            borderLeft: "1px solid var(--border)",
          }}
        >
          <PanelHeader
            title="Premarket"
            subtitle="Live top gainers / gaps — entire US market"
            count={filtered.premarket.length}
          />
          <PullToRefresh onRefresh={refreshNow}>
            <StockTable
              rows={filtered.premarket}
              emptyText={emptyFor("No premarket gainers right now")}
            />
          </PullToRefresh>
        </section>

        <section
          className={`panel ${mobileTab === "mkt" ? "mobile-show" : "mobile-hide"}`}
          style={{
            ...panelStyle,
            borderLeft: "1px solid var(--border)",
          }}
        >
          <PanelHeader
            title="Market Top Gainers"
            subtitle={
              session === "premarket"
                ? "Opens 9:30 AM ET — live open-market gainers"
                : "Live top 50 % gainers — entire US market"
            }
            count={filtered.gainers.length}
          />
          <PullToRefresh onRefresh={refreshNow}>
            <StockTable
              rows={filtered.gainers}
              emptyText={emptyFor(
                session === "premarket"
                  ? "Market not open yet"
                  : session === "closed"
                    ? "Market closed"
                    : "Scanning live…",
              )}
            />
          </PullToRefresh>
        </section>

        <section
          className={`panel ${mobileTab === "ah" ? "mobile-show" : "mobile-hide"}`}
          style={panelStyle}
        >
          <PanelHeader
            title="After Hours"
            subtitle="Live post-market top % gainers vs regular close"
            count={filtered.afterhours.length}
          />
          <PullToRefresh onRefresh={refreshNow}>
            <StockTable
              rows={filtered.afterhours}
              emptyText={emptyFor(
                session === "afterhours"
                  ? "Scanning after-hours…"
                  : session === "closed"
                    ? "After hours ended (4:00–8:00 PM ET)"
                    : "After hours starts at 4:00 PM ET",
              )}
            />
          </PullToRefresh>
        </section>
      </main>

      <TabBar
        activeTab={mobileTab}
        onTabChange={setMobileTab}
        counts={{
          news: news.length,
          pre: filtered.premarket.length,
          mkt: filtered.gainers.length,
          ah: filtered.afterhours.length,
        }}
      />

      <SideMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        activeTab={mobileTab}
        onTabChange={setMobileTab}
        onOpenSettings={() => setSettingsOpen(true)}
        onRefresh={refreshNow}
        connected={connected}
        counts={{
          news: news.length,
          pre: filtered.premarket.length,
          mkt: filtered.gainers.length,
          ah: filtered.afterhours.length,
        }}
      />

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSettingsChange={persistSettings}
        rules={rules}
        onRulesChange={persistRules}
        viewFilter={viewFilter}
        onViewFilterChange={setViewFilter}
      />
    </div>
  );
}

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: "calc(100vh - 96px)",
  background: "var(--bg-panel)",
};

/** Exported for the native shell to detect at runtime (used in tests/debug only). */
export const runningNative = isNativeApp;
