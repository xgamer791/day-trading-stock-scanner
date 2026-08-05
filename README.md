# Top Gainers Scanner

Day-trade scanner for **top % gainers across the entire US market** (NASDAQ, NYSE, NYSE American/AMEX, NYSE Arca, Cboe BZX, IEX).

Inspired by [Realtime Stock Screener](https://apps.apple.com/us/app/realtime-stock-screener/id1563483991).

## Live

**https://xgamer791.github.io/day-trading-stock-scanner/**

Auto-deploys on every push to `main`. The browser rescans **live APIs every 3 seconds** (no `live.json` cache for movers).

## Layout

| Panel | Content |
|-------|---------|
| **Left** | Breaking / most recent news |
| **Center** | Premarket / gap top gainers |
| **Right** | Open-market top % gainers |

## Markets & indexes screened

**Exchanges:** NASDAQ, NYSE, NYSE American (AMEX), NYSE Arca, Cboe BZX, IEX (when listed)

**Indexes:** Nasdaq Composite, Nasdaq-100, Dow Jones Industrial Average, S&P 500, S&P MidCap 400, S&P SmallCap 600, Russell 1000, Russell 2000, Russell 3000

Universe is rebuilt from official Nasdaq Trader symbol directories + index membership lists (`public/data/coverage.json`). Live ranking scrapes the **full Nasdaq.com composite screener** (all US listings) plus live Most Advanced movers. Feeds show the **top 20** % gainers only.

## Data sources

- **Nasdaq.com full stock screener** — entire US listed equity market (download, all exchanges)
- **Nasdaq.com Most Advanced** — live top % movers (Realtime Screener parity)
- **Yahoo quotes** — last / volume / day-high enrichment for display
- Optional **Polygon** key for exchange-grade websockets

**Only filter:** positive % change, ranked highest → lowest. Warrants / units / rights / preferreds are excluded. No HOD, price, or volume gates.

**No cache:** Gainers/premarket are fetched live in the browser each tick. Stale Actions snapshots are never painted.

> Public feeds are not SIP. For true zero-delay tape, add a Polygon/Massive entitlement.

## Setup

```bash
npm install
npm run fetch:live
npm run dev
```

If live data cannot be fetched, the app shows an error — there is no demo fallback.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run fetch:universe` | Rebuild exchange/index universe |
| `npm run fetch:live` | Rebuild universe + scrape full-US top gainers → `public/data/live.json` |
| `npm run build` | Static export for GitHub Pages |
