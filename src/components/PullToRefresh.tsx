"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { hapticPull } from "@/lib/nativeUi";

const THRESHOLD = 64;
const MAX_PULL = 96;
/** Rubber-band factor — the sheet lags the finger so the gesture feels weighted. */
const RESISTANCE = 0.45;

type Props = {
  /** Fire one extra live poll. Must be safe to call at any time. */
  onRefresh: () => void | Promise<void>;
  disabled?: boolean;
  children: React.ReactNode;
};

/** Nearest vertically-scrollable ancestor of `el`, or null. */
function findScroller(el: HTMLElement | null, stopAt: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el;
  while (node && node !== stopAt.parentElement) {
    const style = window.getComputedStyle(node);
    const canScroll = /(auto|scroll)/.test(style.overflowY);
    if (canScroll && node.scrollHeight > node.clientHeight + 1) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * iOS pull-to-refresh.
 *
 * Touch listeners are attached natively with `{ passive: false }` — React attaches
 * touch handlers passively, which would make `preventDefault()` a no-op and let the
 * page rubber-band instead of following the gesture.
 *
 * The refresh triggers ONE extra poll. It does not reset the 3s interval and it
 * cannot double-fire: `fetchLiveScannerClient` calls are already guarded by the
 * `inFlight` ref in ScannerBoard.
 */
export function PullToRefresh({ onRefresh, disabled = false, children }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [pull, setPull] = useState(0);
  const [settling, setSettling] = useState(false);

  const startY = useRef(0);
  const armed = useRef(false);
  const passedThreshold = useRef(false);
  const pullRef = useRef(0);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const setPullBoth = useCallback((v: number) => {
    pullRef.current = v;
    setPull(v);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const onStart = (e: TouchEvent) => {
      if (disabledRef.current || e.touches.length !== 1) return;
      const scroller = findScroller(e.target as HTMLElement, host);
      // Engage only at the very top of the list; otherwise this is a normal scroll.
      if (scroller && scroller.scrollTop > 0) return;
      armed.current = true;
      passedThreshold.current = false;
      startY.current = e.touches[0].clientY;
      setSettling(false);
    };

    const onMove = (e: TouchEvent) => {
      if (!armed.current) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy <= 0) {
        if (pullRef.current !== 0) setPullBoth(0);
        armed.current = false;
        return;
      }
      // We own this gesture now — stop the document rubber-banding underneath it.
      e.preventDefault();
      const next = Math.min(MAX_PULL, dy * RESISTANCE);
      setPullBoth(next);
      if (!passedThreshold.current && next >= THRESHOLD) {
        passedThreshold.current = true;
        void hapticPull();
      }
    };

    const onEnd = () => {
      if (!armed.current) return;
      armed.current = false;
      const fire = pullRef.current >= THRESHOLD;
      setSettling(true);
      setPullBoth(0);
      if (fire) void onRefreshRef.current();
    };

    host.addEventListener("touchstart", onStart, { passive: true });
    host.addEventListener("touchmove", onMove, { passive: false });
    host.addEventListener("touchend", onEnd, { passive: true });
    host.addEventListener("touchcancel", onEnd, { passive: true });

    return () => {
      host.removeEventListener("touchstart", onStart);
      host.removeEventListener("touchmove", onMove);
      host.removeEventListener("touchend", onEnd);
      host.removeEventListener("touchcancel", onEnd);
    };
  }, [setPullBoth]);

  const ready = pull >= THRESHOLD;

  return (
    <div className="ptr" ref={hostRef}>
      {pull > 0 && (
        <div className="ptr__spinner" style={{ height: pull, opacity: Math.min(1, pull / THRESHOLD) }}>
          {ready ? "RELEASE TO REFRESH" : "PULL TO REFRESH"}
        </div>
      )}
      <div
        className="ptr__inner"
        style={{
          transform: pull > 0 ? `translateY(${pull}px)` : undefined,
          transition: settling ? "transform 0.25s cubic-bezier(0.32,0.72,0,1)" : undefined,
        }}
        onTransitionEnd={() => setSettling(false)}
      >
        {children}
      </div>
    </div>
  );
}
