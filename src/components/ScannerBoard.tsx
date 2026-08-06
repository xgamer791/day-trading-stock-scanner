"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { NewsFeed, PanelHeader, StockTable } from "@/components/Panels";
import { ScannerHeader, type ScannerTab } from "@/components/ScannerHeader";
import { fetchLiveNewsFeed, fetchLiveNewsFeedQuick } from "@/lib/fetchLiveNewsFeed";
import { fetchLiveScannerClient } from "@/lib/liveClient";
import { getMarketSession } from "@/lib/market";
import {
  boardQuality,
  clearHeldBoards,
  readHeldBoard,
  shouldReplaceHeldBoard,
  writeHeldBoard,
} from "@/lib/sessionBoardHold";
import type { MarketSession, NewsItem, ScannerPayload, StockMover } from "@/lib/types";

/**
 * Prefer the stronger board so a weak/partial poll cannot flip the UI off a
 * Realtime-parity list (Premarket CLRO-class, Gainers YXT-class, AH micros).
 */
function preferStrongerBoard(
  live: StockMover[] | undefined,
  held: StockMover[],
): StockMover[] {
  const incoming = live ?? [];
  if (!incoming.length) return held;
  if (!held.length) return incoming;
  return boardQuality(incoming) >= boardQuality(held) * 0.7 ? incoming : held;
}

/** Live window for each board — outside it the tab is prior-session hold-only. */
function isLiveWindow(kind: "premarket" | "gainers" | "afterhours", session: MarketSession): boolean {
  if (kind === "premarket") return session === "premarket";
  if (kind === "gainers") return session === "regular";
  return session === "afterhours";
}

export function ScannerBoard() {
  const [data, setData] = useState<ScannerPayload | null>(null);
  const [heldPremarket, setHeldPremarket] = useState<StockMover[]>(() =>
    readHeldBoard("premarket"),
  );
  const [heldGainers, setHeldGainers] = useState<StockMover[]>(() =>
    readHeldBoard("gainers"),
  );
  const [heldAfterhours, setHeldAfterhours] = useState<StockMover[]>(() =>
    readHeldBoard("afterhours"),
  );
  const [news, setNews] = useState<NewsItem[]>([]);
  const [newsLoading, setNewsLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newsError, setNewsError] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<ScannerTab>("mkt");
  const [clockSession, setClockSession] = useState<MarketSession>(() => getMarketSession());
  const inFlight = useRef(false);
  const newsInFlight = useRef(false);
  const newsRef = useRef<NewsItem[]>([]);
  newsRef.current = news;
  /** Ensures we wipe once per premarket window (transition or cold-start). */
  const clearedForPremarketRef = useRef(false);
  /**
   * Overnight closed: only build AH when that tab is on screen (hold covers the
   * rest). During the live afterhours window we always fetch AH so the hold is
   * written even if the user never opened the tab.
   */
  const ahTabRef = useRef(false);
  ahTabRef.current = mobileTab === "ah";

  // Refs so poll catch can see latest held boards without stale closures.
  const heldPremarketRef = useRef(heldPremarket);
  const heldGainersRef = useRef(heldGainers);
  const heldAfterhoursRef = useRef(heldAfterhours);
  heldPremarketRef.current = heldPremarket;
  heldGainersRef.current = heldGainers;
  heldAfterhoursRef.current = heldAfterhours;

  // Static export SSR cannot read sessionStorage — useState(() => readHeldBoard())
  // baked [] into the hydrated client. Re-read on mount so Premarket/Gainers/AH
  // prior-session boards survive refresh (until next 4am ET).
  useEffect(() => {
    const pm = readHeldBoard("premarket");
    const g = readHeldBoard("gainers");
    const ah = readHeldBoard("afterhours");
    if (pm.length) {
      heldPremarketRef.current = pm;
      setHeldPremarket(pm);
    }
    if (g.length) {
      heldGainersRef.current = g;
      setHeldGainers(g);
    }
    if (ah.length) {
      heldAfterhoursRef.current = ah;
      setHeldAfterhours(ah);
    }
  }, []);

  useEffect(() => {
    const id = setInterval(() => setClockSession(getMarketSession()), 1000);
    return () => clearInterval(id);
  }, []);

  // New trading morning: wipe PRIOR-DAY holds at premarket open (4:00 AM ET).
  useEffect(() => {
    if (clockSession !== "premarket") {
      clearedForPremarketRef.current = false;
      return;
    }
    if (clearedForPremarketRef.current) return;
    clearedForPremarketRef.current = true;

    clearHeldBoards();
    heldPremarketRef.current = [];
    heldGainersRef.current = [];
    heldAfterhoursRef.current = [];
    setHeldPremarket([]);
    setHeldGainers([]);
    setHeldAfterhours([]);
    setData((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        session: "premarket",
        gainers: [],
        afterhours: [],
        premarket: [],
      };
    });
  }, [clockSession]);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const sess = getMarketSession();
        // LIVE ONLY — never live.json / snapshot (STOCK_SCANNER_APP_MEMORY.md)
        // Afterhours window: always fetch AH so hold is seeded without visiting the tab.
        // Overnight closed: AH fetch only when that tab is visible (hold otherwise).
        const live = await fetchLiveScannerClient({
          includeAfterHours: sess === "afterhours" || ahTabRef.current,
        });
        if (cancelled) return;

        if (
          !live.gainers.length &&
          !live.premarket.length &&
          !live.afterhours.length &&
          getMarketSession() === "regular"
        ) {
          throw new Error("Live market data returned no top gainers");
        }

        const nowSession = getMarketSession();
        const payload =
          nowSession === "premarket"
            ? {
                ...live,
                session: "premarket" as const,
                gainers: [] as StockMover[],
                afterhours: [] as StockMover[],
                premarket: live.premarket,
              }
            : live;

        // Empty successful payload: reconnect signal but do not wipe holds.
        const emptyLive =
          !payload.premarket.length &&
          !payload.gainers.length &&
          !payload.afterhours.length;
        if (emptyLive) {
          setConnected(false);
          setError("Live feed reconnecting (quote transport)…");
          return;
        }

        // Quality-gate every session board — weak/partial polls must not
        // overwrite a strong same-session hold.
        let nextPremarket = heldPremarketRef.current;
        let nextGainers = heldGainersRef.current;
        let nextAfterhours = heldAfterhoursRef.current;

        if (payload.premarket.length) {
          if (shouldReplaceHeldBoard(payload.premarket, nextPremarket)) {
            writeHeldBoard("premarket", payload.premarket);
            nextPremarket = payload.premarket;
            heldPremarketRef.current = payload.premarket;
            setHeldPremarket(payload.premarket);
          }
        }
        // Gainers hold writes during regular (live) and afterhours/closed
        // (still-updating prior session / last good ranked board).
        if (nowSession !== "premarket" && payload.gainers.length) {
          if (shouldReplaceHeldBoard(payload.gainers, nextGainers)) {
            writeHeldBoard("gainers", payload.gainers);
            nextGainers = payload.gainers;
            heldGainersRef.current = payload.gainers;
            setHeldGainers(payload.gainers);
          }
        }
        if (
          (nowSession === "afterhours" || nowSession === "closed") &&
          payload.afterhours.length
        ) {
          if (shouldReplaceHeldBoard(payload.afterhours, nextAfterhours)) {
            writeHeldBoard("afterhours", payload.afterhours);
            nextAfterhours = payload.afterhours;
            heldAfterhoursRef.current = payload.afterhours;
            setHeldAfterhours(payload.afterhours);
          }
        }

        // Always preferStrongerBoard for all three — never paint forced [] into
        // data while a hold exists (display layer gates which tabs show rows).
        setData({
          ...payload,
          premarket: preferStrongerBoard(payload.premarket, nextPremarket),
          gainers: preferStrongerBoard(payload.gainers, nextGainers),
          afterhours: preferStrongerBoard(payload.afterhours, nextAfterhours),
        });
        setConnected(true);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setConnected(false);
        const raw = err instanceof Error ? err.message : "Failed to load live data";
        const msg =
          /load failed|failed to fetch|networkerror|aborted|unavailable/i.test(raw)
            ? "Live feed reconnecting (quote transport)…"
            : raw;
        setError(msg);
        // Keep ANY prior-session / same-session strong hold on screen.
        // Premarket after 9:30, Gainers after 16:00, AH after 20:00 are hold-only
        // until next 4:00 AM ET — a transport miss must not setData(null).
        const hasHold =
          heldPremarketRef.current.length > 0 ||
          heldGainersRef.current.length > 0 ||
          heldAfterhoursRef.current.length > 0;
        if (!hasHold) {
          setData(null);
        }
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

  // Live news: quick paint first, then deepen from full source registry.
  useEffect(() => {
    let cancelled = false;

    const tickNews = async () => {
      if (newsInFlight.current) return;
      newsInFlight.current = true;
      const empty = newsRef.current.length === 0;
      if (empty) setNewsLoading(true);

      try {
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

  const session = clockSession;

  // All three boards: quality-gate live vs held. Cleared together at 4:00 AM ET.
  // After each window ends, the tab keeps showing the held board until clear.
  const premarketRows = preferStrongerBoard(data?.premarket, heldPremarket);

  const gainersRows =
    session === "premarket"
      ? []
      : preferStrongerBoard(data?.gainers, heldGainers);

  const afterhoursRows =
    session === "premarket" || session === "regular"
      ? []
      : preferStrongerBoard(data?.afterhours, heldAfterhours);

  const premarketHolding = !isLiveWindow("premarket", session) && premarketRows.length > 0;
  const gainersHolding = !isLiveWindow("gainers", session) && gainersRows.length > 0;
  const afterhoursHolding = !isLiveWindow("afterhours", session) && afterhoursRows.length > 0;
  const reconnectingWithBoard =
    !!error && (premarketRows.length > 0 || gainersRows.length > 0 || afterhoursRows.length > 0);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <ScannerHeader
        activeTab={mobileTab}
        onTabChange={setMobileTab}
        connected={connected}
      />

      {error && !premarketRows.length && !gainersRows.length && !afterhoursRows.length && (
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
      {reconnectingWithBoard && (
        <div
          style={{
            padding: "8px 16px",
            background: "var(--bg-panel)",
            color: "var(--text-dim)",
            fontSize: 12,
            fontWeight: 600,
            borderBottom: "1px solid var(--border)",
          }}
        >
          {error}
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
            subtitle={
              premarketHolding
                ? "Last premarket session — clears at next 4:00 AM ET"
                : "Live top gainers / gaps — entire US market"
            }
            count={premarketRows.length}
          />
          <StockTable
            rows={premarketRows}
            emptyText={
              isLiveWindow("premarket", session)
                ? error && !premarketRows.length
                  ? "Live data error"
                  : "Scanning premarket…"
                : "No premarket board yet (fills 4:00–9:30 AM ET)"
            }
          />
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
                : gainersHolding
                  ? "Last regular session — clears at next 4:00 AM ET"
                  : "Live top 50 % gainers — entire US market"
            }
            count={gainersRows.length}
          />
          <StockTable
            rows={gainersRows}
            emptyText={
              isLiveWindow("gainers", session)
                ? error && !gainersRows.length
                  ? "Live data error"
                  : "Scanning live…"
                : session === "premarket"
                  ? "Market not open yet"
                  : "No regular-session board yet (fills 9:30 AM–4:00 PM ET)"
            }
          />
        </section>

        <section
          className={`panel ${mobileTab === "ah" ? "mobile-show" : "mobile-hide"}`}
          style={panelStyle}
        >
          <PanelHeader
            title="After Hours"
            subtitle={
              afterhoursHolding
                ? "Last after-hours session — clears at next 4:00 AM ET"
                : "Live post-market top % gainers vs regular close"
            }
            count={afterhoursRows.length}
          />
          <StockTable
            rows={afterhoursRows}
            emptyText={
              isLiveWindow("afterhours", session)
                ? error && !afterhoursRows.length
                  ? "Live data error"
                  : "Scanning after-hours…"
                : session === "closed"
                  ? "No after-hours board yet"
                  : session === "premarket"
                    ? "Clears at premarket — next session 4:00 PM ET"
                    : "After hours starts at 4:00 PM ET"
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
