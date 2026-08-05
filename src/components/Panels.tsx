"use client";

import { formatFloat, formatPct, formatPrice, formatVolume, timeAgo } from "@/lib/market";
import type { NewsItem, StockMover } from "@/lib/types";

export function SessionBadge({ session }: { session: string }) {
  const label: Record<string, string> = {
    premarket: "PREMARKET",
    regular: "MARKET OPEN",
    afterhours: "AFTER HOURS",
    closed: "MARKET CLOSED",
  };
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: "0.08em",
        color: session === "closed" ? "var(--text-dim)" : "var(--hod)",
        border: "1px solid var(--border-strong)",
        padding: "4px 8px",
        background: "var(--bg-row)",
      }}
    >
      {label[session] ?? session.toUpperCase()}
    </span>
  );
}

export function PanelHeader({
  title,
  subtitle,
  count,
}: {
  title: string;
  subtitle: string;
  count?: number;
}) {
  return (
    <header
      style={{
        padding: "14px 16px 12px",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <h2
          style={{
            margin: 0,
            fontFamily: "var(--font-display)",
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: "-0.02em",
          }}
        >
          {title}
        </h2>
        {typeof count === "number" && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text-dim)",
            }}
          >
            {count}
          </span>
        )}
      </div>
      <p style={{ margin: 0, fontSize: 13, color: "var(--text-dim)", lineHeight: 1.35 }}>
        {subtitle}
      </p>
    </header>
  );
}

export function NewsFeed({ items }: { items: NewsItem[] }) {
  return (
    <div style={{ overflow: "auto", flex: 1 }}>
      {items.map((item, idx) => (
        <a
          key={item.id}
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="panel-enter"
          style={{
            display: "block",
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            textDecoration: "none",
            animationDelay: `${Math.min(idx, 12) * 30}ms`,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-row-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              marginBottom: 6,
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--text-faint)",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            <span>{item.publisher}</span>
            <span>{timeAgo(item.publishedAt)}</span>
          </div>
          <div style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.35, marginBottom: 8 }}>
            {item.title}
          </div>
          {item.tickers.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {item.tickers.slice(0, 4).map((t) => (
                <span
                  key={t}
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    fontWeight: 700,
                    color: "var(--accent)",
                    border: "1px solid var(--border-strong)",
                    padding: "2px 6px",
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </a>
      ))}
      {items.length === 0 && <EmptyState text="Waiting for breaking news…" />}
    </div>
  );
}

export function StockTable({
  rows,
  emptyText,
}: {
  rows: StockMover[];
  emptyText: string;
}) {
  const cols = "64px 1fr 88px 72px 64px";
  return (
    <div style={{ overflow: "auto", flex: 1 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: cols,
          gap: 8,
          padding: "10px 14px",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--text-dim)",
          borderBottom: "1px solid var(--border)",
          position: "sticky",
          top: 0,
          background: "var(--bg-panel)",
          zIndex: 1,
        }}
      >
        <span>Ticker</span>
        <span style={{ textAlign: "right" }}>Price</span>
        <span style={{ textAlign: "right" }}>%Chg</span>
        <span style={{ textAlign: "right" }}>Vol</span>
        <span style={{ textAlign: "right" }}>Flt</span>
      </div>
      {rows.map((row, idx) => (
        <div
          key={row.symbol}
          className="panel-enter row-flash"
          style={{
            display: "grid",
            gridTemplateColumns: cols,
            gap: 8,
            padding: "12px 14px",
            borderBottom: "1px solid var(--border)",
            alignItems: "center",
            animationDelay: `${Math.min(idx, 15) * 25}ms`,
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontWeight: 700,
              fontSize: 15,
              letterSpacing: "0.01em",
              color: "var(--text)",
            }}
          >
            {row.symbol}
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 15,
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
              textAlign: "right",
              color: "var(--text)",
            }}
          >
            {formatPrice(row.price)}
            <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text-dim)", marginTop: 2 }}>
              {row.change >= 0 ? "+" : ""}
              {formatPrice(Math.abs(row.change))}
            </div>
          </div>
          <div
            style={{
              textAlign: "right",
              fontFamily: "var(--font-mono)",
              fontWeight: 700,
              fontSize: 15,
              color: row.changePct >= 0 ? "var(--green)" : "var(--red)",
              background: row.changePct >= 0 ? "var(--green-dim)" : "var(--red-dim)",
              padding: "6px 8px",
            }}
            title="(last − prev close) / prev close — same as Realtime HOD %"
          >
            {formatPct(row.changePct)}
          </div>
          <div
            style={{
              textAlign: "right",
              fontFamily: "var(--font-mono)",
              fontSize: 14,
              fontWeight: 500,
              color: "var(--text)",
            }}
          >
            {formatVolume(row.volume)}
          </div>
          <div
            style={{
              textAlign: "right",
              fontFamily: "var(--font-mono)",
              fontSize: 14,
              fontWeight: 500,
              color: "var(--text)",
            }}
          >
            {formatFloat(row.floatMillions)}
          </div>
        </div>
      ))}
      {rows.length === 0 && <EmptyState text={emptyText} />}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: 32,
        textAlign: "center",
        color: "var(--text-faint)",
        fontSize: 13,
      }}
    >
      {text}
    </div>
  );
}
