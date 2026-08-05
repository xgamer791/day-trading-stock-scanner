# HOD Scanner

Real-time day trading stock scanner focused on **high-of-day (HOD) peaking** stocks — the ones hitting session highs right now.

Inspired by [Realtime Stock Screener](https://apps.apple.com/us/app/realtime-stock-screener/id1563483991).

## Live

**https://xgamer791.github.io/day-trading-stock-scanner/**

Deployed automatically to GitHub Pages on every push to `main`, and refreshed every 5 minutes during US market hours.

## Layout

| Panel | Content |
|-------|---------|
| **Left** | Breaking / most recent news |
| **Center** | Premarket HOD gainers |
| **Right** | Market top gainers |

## Stack

- Next.js (App Router) + TypeScript
- Live Yahoo Finance day gainers, premarket movers, and news
- Optional Polygon key (`POLYGON_API_KEY` / `NEXT_PUBLIC_POLYGON_API_KEY`) for exchange snapshots
- GitHub Pages + Actions auto-deploy

> **Why not Yahoo day_gainers?** Yahoo’s predefined gainer list requires **market cap ≥ $2B** and **price ≥ $5**, so it misses low-float runners (e.g. +200% names). We scan the full Nasdaq.com universe instead.

## Setup

```bash
npm install
npm run fetch:live
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

If live data cannot be fetched, the app shows an error — there is no demo fallback.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run fetch:live` | Pull Yahoo gainers/news into `public/data/live.json` |
| `npm run dev` | Fetch live data, then local development |
| `npm run build` | Production static export |
| `npm test` | Unit tests for HOD helpers |

## Disclaimer

Not financial advice. For research and education only.
