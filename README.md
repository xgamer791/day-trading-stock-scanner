# Day Trading Stock Scanner

A real-time and pre-market stock scanner for day traders. Finds high-relative-volume movers, gap plays, and breakout candidates with configurable filters.

## Features

- **Premarket / opening-range scans** — gap %, relative volume, float, price range
- **Intraday momentum** — RVOL spikes, VWAP reclaim/reject, breakout levels
- **Watchlist output** — ranked candidates with why they fired
- **Configurable filters** — YAML/CLI overrides for your trading style
- **Extensible data providers** — swap in Polygon, Alpaca, or other market data APIs

> Not financial advice. For research and education only. Markets involve risk of loss.

## Quick start

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Copy env template and add API keys when ready
cp .env.example .env

# Run a sample scan (demo data if no provider key is set)
python -m scanner --config config/default.yaml
```

## Project layout

```
src/scanner/     # Core scanner package
config/          # Scan profiles and filters
tests/           # Unit tests
data/            # Local cache / sample fixtures (gitignored except samples)
```

## Configuration

Edit `config/default.yaml` to tune:

| Filter | Default | Notes |
|--------|---------|--------|
| `min_price` / `max_price` | 2 / 50 | Typical day-trade range |
| `min_rel_volume` | 2.0 | Relative to average volume |
| `min_gap_pct` | 3.0 | Premarket gap threshold |
| `min_avg_volume` | 500000 | Liquidity floor |

## Roadmap

- [ ] Live websocket quotes
- [ ] News / catalyst tagging
- [ ] Discord / Telegram alerts
- [ ] Backtest harness for scan rules
- [ ] Web dashboard

## License

MIT
