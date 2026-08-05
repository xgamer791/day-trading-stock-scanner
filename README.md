# HOD Scanner

Day-trade scanner focused on **high-of-day (HOD) peaking** stocks across **all US markets** (NYSE, NASDAQ, AMEX, and other listings in the composite feed).

Inspired by [Realtime Stock Screener](https://apps.apple.com/us/app/realtime-stock-screener/id1563483991).

## Live

**https://xgamer791.github.io/day-trading-stock-scanner/**

Auto-deploys on every push to `main`. The browser rescans every **3 seconds**; Actions republishes a snapshot every **1 minute** during market hours.

## Layout

| Panel | Content |
|-------|---------|
| **Left** | Breaking / most recent news |
| **Center** | Premarket HOD peaks / gaps |
| **Right** | Open-market HOD gainers |

## Markets & indexes screened

**Exchanges:** NASDAQ, NYSE, NYSE American (AMEX), NYSE Arca, Cboe BZX, IEX (when listed)

**Indexes:** Dow Jones Industrial Average, S&P 500, S&P MidCap 400, S&P SmallCap 600, Russell 1000, Russell 2000, Russell 3000

Universe is rebuilt from official Nasdaq Trader symbol directories + index membership lists (`public/data/coverage.json`). Feeds show the **top 20** HOD gainers only.

## Data sources

- **Nasdaq.com composite market movers** — Most Advanced / Most Active (includes NYSE, NASDAQ, AMEX names, not Nasdaq-listed only)
- **S&P 500 + full all-exchange screener** for breadth (server snapshot)
- **Yahoo 1m charts** to confirm each name is truly at high of day
- Optional **Polygon** key for exchange-grade websockets (true SIP / near-zero delay)

Only stocks **at/near high of day** are listed. Premarket tab ≠ open-market Gainers tab.

> Public feeds are not SIP. For true zero-delay tape, add a Polygon/Massive entitlement.

## Setup

```bash
npm install
npm run fetch:live
npm run dev
```

If live data cannot be fetched, the app shows an error — there is no demo fallback.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run fetch:live` | Build `public/data/live.json` snapshot |
| `npm run dev` | Local development |
| `npm run build` | Production static export |
| `npm test` | Unit tests for HOD helpers |

## Disclaimer

Not financial advice. For research and education only.
