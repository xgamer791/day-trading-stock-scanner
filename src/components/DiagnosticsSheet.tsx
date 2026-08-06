"use client";

import { useCallback, useEffect, useState } from "react";
import { runDiagnostics, type ProbeResult } from "@/lib/diagnostics";

/**
 * On-device transport report.
 *
 * Exists so "the board is empty and it says RECONNECTING" becomes an answerable
 * question without plugging into Safari Web Inspector.
 */
export function DiagnosticsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [results, setResults] = useState<ProbeResult[] | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    setResults(null);
    try {
      setResults(await runDiagnostics());
    } catch (e) {
      setResults([
        {
          label: "Diagnostics failed",
          status: "fail",
          ms: 0,
          detail: e instanceof Error ? e.message : String(e),
        },
      ]);
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    if (open) void run();
  }, [open, run]);

  if (!open) return null;

  const text = (results || [])
    .map((r) => `${r.status.toUpperCase()} ${r.label} (${r.ms}ms)\n  ${r.detail}`)
    .join("\n\n");

  return (
    <div className="sheet__scrim" onClick={onClose} role="presentation">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Connection diagnostics"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet__grabber" />
        <div className="sheet__head">
          <h2 className="sheet__title">Connection</h2>
          <button type="button" className="sheet__done" onClick={onClose}>
            Done
          </button>
        </div>

        <div className="sheet__body">
          {running && <p className="sheet__note">Testing each transport…</p>}

          {results?.map((r) => (
            <div key={r.label} className="diag">
              <div className="diag__head">
                <span className={`diag__badge diag__badge--${r.status}`}>
                  {r.status === "ok" ? "OK" : r.status === "fail" ? "FAIL" : "INFO"}
                </span>
                <span className="diag__label">{r.label}</span>
                {r.ms > 0 && <span className="diag__ms">{r.ms}ms</span>}
              </div>
              <div className="diag__detail">{r.detail}</div>
            </div>
          ))}

          {!running && results && (
            <>
              <button type="button" className="sheet__clear" style={{ color: "var(--text)" }} onClick={() => void run()}>
                Run again
              </button>
              <button
                type="button"
                className="sheet__clear"
                style={{ color: "var(--accent)", marginTop: 8 }}
                onClick={() => void navigator.clipboard?.writeText(text)}
              >
                Copy report
              </button>
            </>
          )}

          <p className="sheet__footer">
            A one-shot probe. It never feeds the board and never stores a quote — the live
            feed still comes only from the 3s poll.
          </p>
        </div>
      </div>
    </div>
  );
}
