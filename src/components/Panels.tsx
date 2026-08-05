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

export function NewsFeed({ items, loading = false }: { items: NewsItem[]; loading?: boolean }) {
  return (
    <div className="news6" role="feed" aria-label="Live market news">
      <div className="news6__titlebar">
        <span className="news6__title">NEWS SCANNER</span>
        <span className="news6__count">{loading && !items.length ? "…" : items.length}</span>
      </div>
      <div className="news6__list">
        {items.map((item, idx) => {
          const sym = (item.tickers[0] || "NEWS").toUpperCase();
          const up = (item.changePct ?? 0) >= 0;
          const hasQuote = item.price != null && Number.isFinite(item.price);
          return (
            <a
              key={item.id}
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="news6__row"
              style={{ animationDelay: `${Math.min(idx, 12) * 20}ms` }}
            >
              <span className="news6__ticker" style={{ background: tickerColor(sym) }}>
                {sym.slice(0, 5)}
              </span>
              <span className="news6__headline">{item.title}</span>
              <span className="news6__quote">
                {hasQuote ? (
                  <>
                    <span className="news6__price">{formatPrice(item.price!)}</span>
                    <span className={up ? "news6__chg news6__chg--up" : "news6__chg news6__chg--down"}>
                      {formatPct(item.changePct!)}
                    </span>
                  </>
                ) : (
                  <span className="news6__price news6__price--empty">—</span>
                )}
              </span>
              <span className="news6__ago">{timeAgo(item.publishedAt)}</span>
            </a>
          );
        })}
        {loading && items.length === 0 && <EmptyState text="Loading live news…" />}
        {!loading && items.length === 0 && <EmptyState text="No live headlines right now" />}
      </div>
    </div>
  );
}

/** Stable mock-6 palette from ticker symbol (not % based). */
function tickerColor(sym: string): string {
  const palette = [
    "#16a34a", // green
    "#7c3aed", // purple
    "#dc2626", // red
    "#1d4ed8", // blue
    "#ea580c", // orange
    "#ca8a04", // yellow/gold
    "#0d9488", // teal
    "#9333ea", // violet
    "#2563eb", // bright blue
    "#b45309", // amber
  ];
  let h = 0;
  for (let i = 0; i < sym.length; i++) h = (h * 31 + sym.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
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
