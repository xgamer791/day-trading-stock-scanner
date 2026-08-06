"use client";

import { useEffect, useRef, useState } from "react";
import type { ScannerTab } from "@/components/ScannerHeader";
import { hapticTap } from "@/lib/nativeUi";

/**
 * Full-height slide-in drawer from the left.
 *
 * Always mounted, driven purely by a transform class, so the *exit* animates as
 * smoothly as the entrance — unmounting on close would make it vanish instantly.
 * `visibility` is toggled at the end of the transition so a closed drawer cannot
 * swallow taps meant for the board underneath.
 *
 * Drag-left-to-close is wired with non-passive listeners (React attaches touch
 * handlers passively, which would make preventDefault a no-op and let the page
 * scroll while you drag).
 */

type Props = {
  open: boolean;
  onClose: () => void;
  activeTab: ScannerTab;
  onTabChange: (tab: ScannerTab) => void;
  onOpenSettings: () => void;
  onOpenDiagnostics: () => void;
  onRefresh: () => void;
  connected: boolean;
  counts: Partial<Record<ScannerTab, number>>;
};

const ITEMS: { id: ScannerTab; label: string; glyph: React.ReactNode }[] = [
  {
    id: "news",
    label: "News",
    glyph: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="3" y="5" width="18" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
        <path d="M6.5 9.5h7M6.5 12.5h11M6.5 15.5h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "pre",
    label: "Premarket",
    glyph: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="13.5" r="4.5" stroke="currentColor" strokeWidth="1.7" />
        <path
          d="M12 3.5v2.4M4.8 6.3l1.7 1.7M19.2 6.3l-1.7 1.7M3 13.5h2.2M18.8 13.5H21"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: "mkt",
    label: "Gainers",
    glyph: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M4 16.5l4.5-4.8 3.4 3.2L20 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M15.4 7H20v4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: "ah",
    label: "After Hours",
    glyph: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export function SideMenu({
  open,
  onClose,
  activeTab,
  onTabChange,
  onOpenSettings,
  onOpenDiagnostics,
  onRefresh,
  connected,
  counts,
}: Props) {
  const panelRef = useRef<HTMLElement | null>(null);
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);

  const startX = useRef(0);
  const armed = useRef(false);
  const dragRef = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      setDrag(0);
      dragRef.current = 0;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Drag left to dismiss.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const onStart = (e: TouchEvent) => {
      if (!openRef.current || e.touches.length !== 1) return;
      armed.current = true;
      startX.current = e.touches[0].clientX;
      setDragging(true);
    };

    const onMove = (e: TouchEvent) => {
      if (!armed.current) return;
      const dx = e.touches[0].clientX - startX.current;
      if (dx > 0) return; // only drags toward the closed edge count
      e.preventDefault();
      const next = Math.max(-panel.offsetWidth, dx);
      dragRef.current = next;
      setDrag(next);
    };

    const onEnd = () => {
      if (!armed.current) return;
      armed.current = false;
      setDragging(false);
      // Past a third of the way: let it go.
      const shouldClose = dragRef.current < -panel.offsetWidth / 3;
      dragRef.current = 0;
      setDrag(0);
      if (shouldClose) onCloseRef.current();
    };

    panel.addEventListener("touchstart", onStart, { passive: true });
    panel.addEventListener("touchmove", onMove, { passive: false });
    panel.addEventListener("touchend", onEnd, { passive: true });
    panel.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      panel.removeEventListener("touchstart", onStart);
      panel.removeEventListener("touchmove", onMove);
      panel.removeEventListener("touchend", onEnd);
      panel.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  const pick = (tab: ScannerTab) => {
    void hapticTap();
    onTabChange(tab);
    onClose();
  };

  return (
    <>
      <div
        className={`drawer-scrim${open ? " drawer-scrim--open" : ""}`}
        onClick={onClose}
        role="presentation"
      />

      <aside
        ref={panelRef}
        className={`drawer${open ? " drawer--open" : ""}`}
        style={{
          transform: drag ? `translateX(${drag}px)` : undefined,
          transition: dragging ? "none" : undefined,
        }}
        aria-hidden={!open}
        aria-label="Menu"
      >
        <div className="drawer__head">
          <div className="drawer__brand">Top Gainers</div>
          <div className={`drawer__status${connected ? " drawer__status--live" : ""}`}>
            <span className={`drawer__dot${connected ? " live-dot" : ""}`} />
            {connected ? "LIVE" : "RECONNECTING"}
          </div>
        </div>

        <nav className="drawer__nav">
          {ITEMS.map(({ id, label, glyph }) => {
            const active = activeTab === id;
            const n = counts[id] ?? 0;
            return (
              <button
                key={id}
                type="button"
                className={`drawer__item${active ? " drawer__item--active" : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={() => pick(id)}
              >
                <span className="drawer__glyph">{glyph}</span>
                <span className="drawer__label">{label}</span>
                {n > 0 && <span className="drawer__count">{n}</span>}
              </button>
            );
          })}
        </nav>

        <div className="drawer__rule" />

        <nav className="drawer__nav">
          <button
            type="button"
            className="drawer__item"
            onClick={() => {
              void hapticTap();
              onRefresh();
              onClose();
            }}
          >
            <span className="drawer__glyph">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M20 12a8 8 0 1 1-2.3-5.6"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
                <path d="M20 4v4.6h-4.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="drawer__label">Refresh now</span>
          </button>

          <button
            type="button"
            className="drawer__item"
            onClick={() => {
              void hapticTap();
              onClose();
              onOpenDiagnostics();
            }}
          >
            <span className="drawer__glyph">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M3 12h4l2.5-6 5 12 2.5-6h4" stroke="currentColor" strokeWidth="1.8"
                      strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="drawer__label">Connection</span>
          </button>

          <button
            type="button"
            className="drawer__item"
            onClick={() => {
              void hapticTap();
              onClose();
              onOpenSettings();
            }}
          >
            <span className="drawer__glyph">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" stroke="currentColor" strokeWidth="1.8" />
                <path
                  d="M19.4 13.5a1.6 1.6 0 0 0 .32 1.76l.06.06a1.9 1.9 0 1 1-2.69 2.69l-.06-.06a1.6 1.6 0 0 0-1.76-.32 1.6 1.6 0 0 0-.97 1.46V19.2a1.9 1.9 0 1 1-3.8 0v-.09a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.76.32l-.06.06a1.9 1.9 0 1 1-2.69-2.69l.06-.06a1.6 1.6 0 0 0 .32-1.76 1.6 1.6 0 0 0-1.46-.97H4.8a1.9 1.9 0 1 1 0-3.8h.09a1.6 1.6 0 0 0 1.46-1.05 1.6 1.6 0 0 0-.32-1.76l-.06-.06a1.9 1.9 0 1 1 2.69-2.69l.06.06a1.6 1.6 0 0 0 1.76.32h.08a1.6 1.6 0 0 0 .97-1.46V4.8a1.9 1.9 0 1 1 3.8 0v.09a1.6 1.6 0 0 0 .97 1.46 1.6 1.6 0 0 0 1.76-.32l.06-.06a1.9 1.9 0 1 1 2.69 2.69l-.06.06a1.6 1.6 0 0 0-.32 1.76v.08a1.6 1.6 0 0 0 1.46.97H19.2a1.9 1.9 0 1 1 0 3.8h-.09a1.6 1.6 0 0 0-1.46.97Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="drawer__label">Settings</span>
          </button>
        </nav>

        <p className="drawer__foot">
          Live data only — no cached or delayed quotes. A failed poll clears the board rather
          than showing stale prices.
          <br />
          <span style={{ opacity: 0.7 }}>Build {process.env.NEXT_PUBLIC_BUILD_STAMP}</span>
        </p>
      </aside>
    </>
  );
}
