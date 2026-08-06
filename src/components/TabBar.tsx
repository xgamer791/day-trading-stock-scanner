"use client";

import type { ScannerTab } from "@/components/ScannerHeader";
import { hapticTap } from "@/lib/nativeUi";

/**
 * iOS-style bottom tab bar.
 *
 * Honest framing: this is a web-rendered bar styled to iOS conventions (translucent
 * blur, safe-area inset, SF-ish glyphs) plus *native* haptics on tap — not a
 * UIKit `UITabBar`. A real UITabBar would need a custom native plugin and would end
 * up fighting the WebView for control of the tab content; every production Capacitor
 * app does it this way.
 *
 * Rendered on native and on narrow web (≤960px), hidden on the desktop 4-column
 * grid where all panels are visible at once and tabs are meaningless.
 */

type Props = {
  activeTab: ScannerTab;
  onTabChange: (tab: ScannerTab) => void;
  /** Row counts per tab, shown as a small badge. */
  counts?: Partial<Record<ScannerTab, number>>;
};

function IconNews({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="5"
        width="18"
        height="14"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.7"
        fill={active ? "currentColor" : "none"}
        fillOpacity={active ? 0.15 : 0}
      />
      <path d="M6.5 9.5h7M6.5 12.5h11M6.5 15.5h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function IconPremarket({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle
        cx="12"
        cy="13.5"
        r="4.5"
        stroke="currentColor"
        strokeWidth="1.7"
        fill={active ? "currentColor" : "none"}
        fillOpacity={active ? 0.2 : 0}
      />
      <path
        d="M12 3.5v2.4M4.8 6.3l1.7 1.7M19.2 6.3l-1.7 1.7M3 13.5h2.2M18.8 13.5H21"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconGainers({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 16.5l4.5-4.8 3.4 3.2L20 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M15.4 7H20v4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {active && <path d="M4 20h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.4" />}
    </svg>
  );
}

function IconAfterHours({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
        fill={active ? "currentColor" : "none"}
        fillOpacity={active ? 0.18 : 0}
      />
    </svg>
  );
}

const ITEMS: {
  id: ScannerTab;
  label: string;
  Icon: (p: { active: boolean }) => React.ReactElement;
}[] = [
  { id: "news", label: "News", Icon: IconNews },
  { id: "pre", label: "Premarket", Icon: IconPremarket },
  { id: "mkt", label: "Gainers", Icon: IconGainers },
  { id: "ah", label: "After Hours", Icon: IconAfterHours },
];

export function TabBar({ activeTab, onTabChange, counts }: Props) {
  return (
    <nav className="ios-tabbar" role="tablist" aria-label="Scanner views">
      {ITEMS.map(({ id, label, Icon }) => {
        const active = activeTab === id;
        const count = counts?.[id] ?? 0;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            className={`ios-tabbar__item${active ? " ios-tabbar__item--active" : ""}`}
            onClick={() => {
              if (!active) void hapticTap();
              onTabChange(id);
            }}
          >
            <span className="ios-tabbar__icon">
              <Icon active={active} />
              {count > 0 && <span className="ios-tabbar__badge">{count > 99 ? "99+" : count}</span>}
            </span>
            <span className="ios-tabbar__label">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
