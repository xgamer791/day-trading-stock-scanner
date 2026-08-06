"use client";

import { useEffect, useState } from "react";
import { getMarketCountdown } from "@/lib/market";

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
