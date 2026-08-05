# HOD Scanner

Real-time day trading stock scanner focused on **high-of-day (HOD) peaking** stocks — the ones hitting session highs right now.

Inspired by [Realtime Stock Screener](https://apps.apple.com/us/app/realtime-stock-screener/id1563483991).

## Layout

| Panel | Content |
|-------|---------|
| **Left** | Breaking / most recent news |
| **Center** | Premarket HOD gainers |
| **Right** | Market top gainers at HOD |

Only stocks within **0.35% of day high** and green on the day are listed.

## Stack

- Next.js (App Router) + TypeScript
- Polygon.io snapshots + news (live)
- Server-Sent Events stream (~2.5s refresh)
- Live Yahoo Finance gainers + news (refreshed every 5 minutes via GitHub Actions). Optional Polygon key for exchange-grade snapshots.

## Live

**https://xgamer791.github.io/day-trading-stock-scanner/**

Deployed automatically to GitHub Pages on every push to `main`.

## Setup

```bash
npm install
cp .env.example .env.local
# Add POLYGON_API_KEY=... for live data
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Data accuracy

Live mode uses Polygon US stock **gainers snapshots** and **reference news**. For production day trading, use a Polygon plan with real-time (not delayed) entitlements.

Without `POLYGON_API_KEY`, the UI runs on rotating demo data so you can still verify layout and HOD filters.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Local development |
| `npm run build` | Production build |
| `npm start` | Serve production build |
| `npm test` | Unit tests for HOD filters |

## Disclaimer

Not financial advice. For research and education only.
