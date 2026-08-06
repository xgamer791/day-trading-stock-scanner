"use client";

import { useEffect, useState } from "react";
import { getMarketCountdown } from "@/lib/market";
import { hapticTap } from "@/lib/nativeUi";

export type ScannerTab = "news" | "pre" | "mkt" | "ah";

const TABS: { id: ScannerTab; label: string }[] = [
  { id: "news", label: "News" },
  { id: "pre", label: "Premarket" },
  { id: "mkt", label: "Gainers" },
  { id: "ah", label: "After Hours" },
];

function IconMenu() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
      <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconFilter() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 7h16M7 12h10M10 17h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M19.4 13.5a1.6 1.6 0 0 0 .32 1.76l.06.06a1.9 1.9 0 1 1-2.69 2.69l-.06-.06a1.6 1.6 0 0 0-1.76-.32 1.6 1.6 0 0 0-.97 1.46V19.2a1.9 1.9 0 1 1-3.8 0v-.09a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.76.32l-.06.06a1.9 1.9 0 1 1-2.69-2.69l.06-.06a1.6 1.6 0 0 0 .32-1.76 1.6 1.6 0 0 0-1.46-.97H4.8a1.9 1.9 0 1 1 0-3.8h.09a1.6 1.6 0 0 0 1.46-1.05 1.6 1.6 0 0 0-.32-1.76l-.06-.06a1.9 1.9 0 1 1 2.69-2.69l.06.06a1.6 1.6 0 0 0 1.76.32h.08a1.6 1.6 0 0 0 .97-1.46V4.8a1.9 1.9 0 1 1 3.8 0v.09a1.6 1.6 0 0 0 .97 1.46 1.6 1.6 0 0 0 1.76-.32l.06-.06a1.9 1.9 0 1 1 2.69 2.69l-.06.06a1.6 1.6 0 0 0-.32 1.76v.08a1.6 1.6 0 0 0 1.46.97H19.2a1.9 1.9 0 1 1 0 3.8h-.09a1.6 1.6 0 0 0-1.46.97Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconSpeaker({ muted }: { muted: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 10.5v3a1.5 1.5 0 0 0 1.5 1.5H8l4.2 3.15A1 1 0 0 0 14 17.35V6.65a1 1 0 0 0-1.8-.7L8 9H5.5A1.5 1.5 0 0 0 4 10.5Z"
        fill="currentColor"
      />
      {muted ? (
        <path d="M17 9.5l4.5 5M21.5 9.5l-4.5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      ) : (
        <path
          d="M17 9.5a3.5 3.5 0 0 1 0 5M19.2 7.2a6.5 6.5 0 0 1 0 9.6"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

/** ET wall-clock for the status pill — same timezone the whole app reasons in. */
function etClock(iso?: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

type Props = {
  activeTab: ScannerTab;
  onTabChange: (tab: ScannerTab) => void;
  connected: boolean;
  /** `updatedAt` from the last successful live poll — null while disconnected. */
  lastUpdated: string | null;
  search: string;
  onSearchChange: (v: string) => void;
  onOpenMenu: () => void;
  onOpenSettings: () => void;
  soundOn: boolean;
  onToggleSound: () => void;
  filterActive: boolean;
};

export function ScannerHeader({
  activeTab,
  onTabChange,
  connected,
  lastUpdated,
  search,
  onSearchChange,
  onOpenMenu,
  onOpenSettings,
  soundOn,
  onToggleSound,
  filterActive,
}: Props) {
  const [countdown, setCountdown] = useState(() => getMarketCountdown());
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const tick = () => setCountdown(getMarketCountdown());
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, []);

  const closeSearch = () => {
    setSearchOpen(false);
    onSearchChange("");
  };

  return (
    <header className="rts-header" role="banner">
      <div className="rts-header__top">
        <button
          type="button"
          className="rts-icon-btn"
          aria-label="Menu"
          onClick={() => {
            void hapticTap();
            onOpenMenu();
          }}
        >
          <IconMenu />
        </button>

        <div className="rts-headline">
          <div className="rts-countdown" aria-live="polite">
            {countdown.label}
          </div>

          {/*
            Restored LIVE / RECONNECTING indicator.

            This was previously only a `title` tooltip, which meant the user's sole
            signal that the feed had dropped was the red error strip. On a board where
            a failed poll deliberately clears every row (ZERO CACHING), an explicit
            connection state is safety-critical, not decoration.
          */}
          <span
            className={`rts-status ${connected ? "rts-status--live" : "rts-status--down"}`}
            role="status"
            aria-live="polite"
            title={connected ? "Live feed connected" : "Reconnecting to live feed"}
          >
            <span className={`rts-status__dot${connected ? " live-dot" : ""}`} />
            {connected ? "LIVE" : "RECONNECTING"}
            {connected && <span className="rts-status__time">{etClock(lastUpdated)} ET</span>}
          </span>

          <span className="rts-nocache" title="No cached or delayed quotes — live polls only">
            NO CACHE
          </span>
        </div>

        <div className="rts-header__actions">
          <button
            type="button"
            className={`rts-icon-btn${searchOpen ? " rts-icon-btn--on" : ""}`}
            aria-label="Search symbols"
            aria-pressed={searchOpen}
            onClick={() => {
              void hapticTap();
              if (searchOpen) closeSearch();
              else setSearchOpen(true);
            }}
          >
            <IconSearch />
          </button>
          <button
            type="button"
            className={`rts-icon-btn${filterActive ? " rts-icon-btn--on" : ""}`}
            aria-label="View filter"
            onClick={() => {
              void hapticTap();
              onOpenSettings();
            }}
          >
            <IconFilter />
          </button>
          <button
            type="button"
            className="rts-icon-btn"
            aria-label="Settings"
            onClick={() => {
              void hapticTap();
              onOpenSettings();
            }}
          >
            <IconSettings />
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="rts-search">
          <input
            className="rts-search__field"
            placeholder="Filter visible rows by symbol"
            value={search}
            autoFocus
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            onChange={(e) => onSearchChange(e.target.value)}
          />
          <button type="button" className="rts-search__cancel" onClick={closeSearch}>
            Cancel
          </button>
        </div>
      )}

      {/* Desktop-only tab strip. Hidden ≤960px, where the iOS bottom tab bar takes over. */}
      <div className="rts-header__tabs-row">
        <button
          type="button"
          className="rts-speaker"
          aria-label={soundOn ? "Alert sound on" : "Alert sound off"}
          aria-pressed={soundOn}
          title={soundOn ? "Alert sound on" : "Alert sound off"}
          onClick={() => {
            void hapticTap();
            onToggleSound();
          }}
        >
          <IconSpeaker muted={!soundOn} />
        </button>

        <nav className="rts-tabs" aria-label="Scanner views">
          {TABS.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                className={`rts-tab${active ? " rts-tab--active" : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={() => onTabChange(tab.id)}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
