"use client";

import { formatFloat, formatPct, formatPrice, formatVolume, timeAgo } from "@/lib/market";
import type { NewsItem, StockMover } from "@/lib/types";

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
  return (
    <div className="stock-table" role="table" aria-label="Top gainers">
      <div className="stock-table__grid stock-table__grid--head" role="row">
        <div className="stock-table__cell stock-table__cell--head" role="columnheader">
          Ticker
        </div>
        <div className="stock-table__cell stock-table__cell--head stock-table__cell--num" role="columnheader">
          Price
        </div>
        <div className="stock-table__cell stock-table__cell--head stock-table__cell--num" role="columnheader">
          %Chg ↓
        </div>
        <div className="stock-table__cell stock-table__cell--head stock-table__cell--num" role="columnheader">
          Vol
        </div>
        <div className="stock-table__cell stock-table__cell--head stock-table__cell--num" role="columnheader">
          Flt
        </div>
      </div>

      {rows.map((row, idx) => {
        const up = row.changePct >= 0;
        const delay = `${Math.min(idx, 15) * 25}ms`;
        return (
          <div
            key={row.symbol}
            className="stock-table__grid stock-table__row panel-enter row-flash"
            style={{ animationDelay: delay }}
            role="row"
          >
            <div className="stock-table__cell stock-table__cell--ticker" role="cell">
              {row.symbol}
            </div>
            <div className="stock-table__cell stock-table__cell--num stock-table__cell--price" role="cell">
              {formatPrice(row.price)}
            </div>
            <div
              className={`stock-table__cell stock-table__cell--num stock-table__cell--chg ${
                up ? "stock-table__cell--chg-up" : "stock-table__cell--chg-down"
              }`}
              role="cell"
              title="(last − prev close) / prev close — same as Realtime HOD %"
            >
              {formatPct(row.changePct)}
            </div>
            <div className="stock-table__cell stock-table__cell--num stock-table__cell--vol" role="cell">
              {formatVolume(row.volume)}
            </div>
            <div className="stock-table__cell stock-table__cell--num stock-table__cell--flt" role="cell">
              {formatFloat(row.floatMillions)}
            </div>
          </div>
        );
      })}
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
