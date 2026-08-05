"use client";

import { useEffect, useState } from "react";
import { getMarketCountdown } from "@/lib/market";

export type ScannerTab = "news" | "pre" | "mkt";

const TABS: { id: ScannerTab; label: string }[] = [
  { id: "pre", label: "Premarket" },
  { id: "mkt", label: "Gainers" },
  { id: "news", label: "News" },
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

function IconSpeaker() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 10.5v3a1.5 1.5 0 0 0 1.5 1.5H8l4.2 3.15A1 1 0 0 0 14 17.35V6.65a1 1 0 0 0-1.8-.7L8 9H5.5A1.5 1.5 0 0 0 4 10.5Z"
        fill="currentColor"
      />
      <path
        d="M17 9.5a3.5 3.5 0 0 1 0 5M19.2 7.2a6.5 6.5 0 0 1 0 9.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

type Props = {
  activeTab: ScannerTab;
  onTabChange: (tab: ScannerTab) => void;
  connected: boolean;
};

export function ScannerHeader({ activeTab, onTabChange, connected }: Props) {
  const [countdown, setCountdown] = useState(() => getMarketCountdown());

  useEffect(() => {
    const tick = () => setCountdown(getMarketCountdown());
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="rts-header" role="banner">
      <div className="rts-header__top">
        <button type="button" className="rts-icon-btn" aria-label="Menu">
          <IconMenu />
        </button>

        <div className="rts-countdown" aria-live="polite">
          {countdown.label}
        </div>

        <div className="rts-header__actions">
          <button type="button" className="rts-icon-btn" aria-label="Search">
            <IconSearch />
          </button>
          <button type="button" className="rts-icon-btn" aria-label="Filter">
            <IconFilter />
          </button>
          <button type="button" className="rts-icon-btn" aria-label="Settings">
            <IconSettings />
          </button>
        </div>
      </div>

      <div className="rts-header__tabs-row">
        <button
          type="button"
          className="rts-speaker"
          aria-label={connected ? "Audio alerts on" : "Reconnecting"}
          title={connected ? "LIVE" : "RECONNECTING"}
        >
          <IconSpeaker />
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
