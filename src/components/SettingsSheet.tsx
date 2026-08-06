"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_SETTINGS,
  ensureNotificationPermission,
  resetFiredAlerts,
  type AlertRule,
  type AppSettings,
} from "@/lib/alerts";
import { hapticTap } from "@/lib/nativeUi";

/**
 * iOS-style bottom sheet for settings + price alerts.
 *
 * Only user preferences and alert rules live here — no market data is stored or
 * displayed from storage (STOCK_SCANNER_APP_MEMORY.md).
 */

type Props = {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSettingsChange: (next: AppSettings) => void;
  rules: AlertRule[];
  onRulesChange: (next: AlertRule[]) => void;
  /** Display-only view filters — never affect ranking or the top-50 cut. */
  viewFilter: ViewFilter;
  onViewFilterChange: (next: ViewFilter) => void;
};

export type ViewFilter = {
  minPrice: number | null;
  maxPrice: number | null;
  minVolume: number | null;
  maxFloatMillions: number | null;
};

export const EMPTY_VIEW_FILTER: ViewFilter = {
  minPrice: null,
  maxPrice: null,
  minVolume: null,
  maxFloatMillions: null,
};

export function viewFilterActive(f: ViewFilter): boolean {
  return (
    f.minPrice != null || f.maxPrice != null || f.minVolume != null || f.maxFloatMillions != null
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="sheet__row">
      <div className="sheet__row-text">
        <span className="sheet__row-label">{label}</span>
        {hint && <span className="sheet__row-hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`sheet__toggle${on ? " sheet__toggle--on" : ""}`}
      onClick={() => {
        void hapticTap();
        onChange(!on);
      }}
    >
      <span className="sheet__toggle-knob" />
    </button>
  );
}

function NumField({
  value,
  onChange,
  placeholder,
  suffix,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder: string;
  suffix?: string;
}) {
  return (
    <span className="sheet__numwrap">
      <input
        className="sheet__num"
        type="number"
        inputMode="decimal"
        placeholder={placeholder}
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (!raw) return onChange(null);
          const n = Number(raw);
          onChange(Number.isFinite(n) ? n : null);
        }}
      />
      {suffix && <span className="sheet__numsuffix">{suffix}</span>}
    </span>
  );
}

export function SettingsSheet({
  open,
  onClose,
  settings,
  onSettingsChange,
  rules,
  onRulesChange,
  viewFilter,
  onViewFilterChange,
}: Props) {
  const [newSymbol, setNewSymbol] = useState("");
  const [newThreshold, setNewThreshold] = useState("25");

  // Close on hardware/Escape as well as the backdrop.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const patch = (p: Partial<AppSettings>) => onSettingsChange({ ...settings, ...p });

  const addRule = () => {
    const pct = Number(newThreshold);
    if (!Number.isFinite(pct)) return;
    const rule: AlertRule = {
      id: `r${Date.now().toString(36)}`,
      symbol: newSymbol.trim().toUpperCase() || undefined,
      thresholdPct: pct,
      enabled: true,
    };
    resetFiredAlerts();
    onRulesChange([...rules, rule]);
    setNewSymbol("");
    void hapticTap();
  };

  return (
    <div className="sheet__scrim" onClick={onClose} role="presentation">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet__grabber" />
        <div className="sheet__head">
          <h2 className="sheet__title">Settings</h2>
          <button type="button" className="sheet__done" onClick={onClose}>
            Done
          </button>
        </div>

        <div className="sheet__body">
          <h3 className="sheet__section">Display</h3>
          <Row label="Keep screen awake" hint="While the market session is open">
            <Toggle
              on={settings.keepAwakeEnabled}
              onChange={(v) => patch({ keepAwakeEnabled: v })}
            />
          </Row>
          <Row label="Haptics" hint="Tap feedback on tabs and refresh">
            <Toggle on={settings.hapticsEnabled} onChange={(v) => patch({ hapticsEnabled: v })} />
          </Row>

          <h3 className="sheet__section">Price alerts</h3>
          <Row label="Enable alerts" hint="Notifies while the app is open">
            <Toggle
              on={settings.alertsEnabled}
              onChange={async (v) => {
                if (v) {
                  const granted = await ensureNotificationPermission();
                  patch({ alertsEnabled: granted });
                  return;
                }
                patch({ alertsEnabled: false });
              }}
            />
          </Row>
          <Row label="Alert vibration" hint="Banner + sound follow your iOS notification settings">
            <Toggle on={settings.soundEnabled} onChange={(v) => patch({ soundEnabled: v })} />
          </Row>

          <div className="sheet__ruleadd">
            <input
              className="sheet__ruleinput"
              placeholder="Symbol (blank = any)"
              value={newSymbol}
              autoCapitalize="characters"
              autoCorrect="off"
              onChange={(e) => setNewSymbol(e.target.value)}
            />
            <input
              className="sheet__ruleinput sheet__ruleinput--pct"
              type="number"
              inputMode="decimal"
              placeholder="%"
              value={newThreshold}
              onChange={(e) => setNewThreshold(e.target.value)}
            />
            <button type="button" className="sheet__add" onClick={addRule}>
              Add
            </button>
          </div>

          {rules.length === 0 && (
            <p className="sheet__empty">
              No alerts yet. Add one above — e.g. blank symbol at 50% notifies on any runner
              crossing +50%.
            </p>
          )}

          {rules.map((r) => (
            <Row key={r.id} label={r.symbol || "Any symbol"} hint={`at +${r.thresholdPct}%`}>
              <span className="sheet__ruleactions">
                <Toggle
                  on={r.enabled}
                  onChange={(v) =>
                    onRulesChange(rules.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)))
                  }
                />
                <button
                  type="button"
                  className="sheet__del"
                  aria-label={`Delete alert for ${r.symbol || "any symbol"}`}
                  onClick={() => onRulesChange(rules.filter((x) => x.id !== r.id))}
                >
                  ✕
                </button>
              </span>
            </Row>
          ))}

          <h3 className="sheet__section">View filter</h3>
          <p className="sheet__note">
            Display-only. Ranking is always top&nbsp;50 by&nbsp;% gain across the whole US
            market — these hide rows after ranking, they never change what qualifies.
          </p>
          <Row label="Min price">
            <NumField
              value={viewFilter.minPrice}
              onChange={(v) => onViewFilterChange({ ...viewFilter, minPrice: v })}
              placeholder="—"
              suffix="$"
            />
          </Row>
          <Row label="Max price">
            <NumField
              value={viewFilter.maxPrice}
              onChange={(v) => onViewFilterChange({ ...viewFilter, maxPrice: v })}
              placeholder="—"
              suffix="$"
            />
          </Row>
          <Row label="Min volume">
            <NumField
              value={viewFilter.minVolume}
              onChange={(v) => onViewFilterChange({ ...viewFilter, minVolume: v })}
              placeholder="—"
            />
          </Row>
          <Row label="Max float">
            <NumField
              value={viewFilter.maxFloatMillions}
              onChange={(v) => onViewFilterChange({ ...viewFilter, maxFloatMillions: v })}
              placeholder="—"
              suffix="M"
            />
          </Row>
          {viewFilterActive(viewFilter) && (
            <button
              type="button"
              className="sheet__clear"
              onClick={() => onViewFilterChange(EMPTY_VIEW_FILTER)}
            >
              Clear view filter
            </button>
          )}

          <p className="sheet__footer">
            Live data only — no cached or delayed quotes. A failed poll clears the board rather
            than showing stale prices.
          </p>
        </div>
      </div>
    </div>
  );
}

export { DEFAULT_SETTINGS };
