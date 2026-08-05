from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import yaml
from dotenv import load_dotenv
from rich.console import Console
from rich.table import Table

from scanner.filters import apply_scan
from scanner.providers import get_provider

console = Console()


def load_config(path: Path) -> dict:
    with path.open() as f:
        return yaml.safe_load(f)


def print_table(hits) -> None:
    table = Table(title="Day Trading Stock Scanner")
    table.add_column("Symbol", style="bold")
    table.add_column("Price", justify="right")
    table.add_column("Gap %", justify="right")
    table.add_column("RVOL", justify="right")
    table.add_column("$ Vol", justify="right")
    table.add_column("Score", justify="right")
    table.add_column("Why")
    for h in hits:
        table.add_row(
            h.symbol,
            f"{h.price:.2f}",
            f"{h.gap_pct:+.1f}",
            f"{h.rel_volume:.1f}x",
            f"{h.dollar_volume:,.0f}",
            f"{h.score:.3f}",
            "; ".join(h.reasons),
        )
    console.print(table)


def write_csv(hits, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "symbol",
                "price",
                "gap_pct",
                "rel_volume",
                "dollar_volume",
                "float_millions",
                "score",
                "reasons",
            ],
        )
        writer.writeheader()
        for h in hits:
            row = h.to_dict()
            row["reasons"] = "|".join(h.reasons)
            writer.writerow(row)


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description="Day Trading Stock Scanner")
    parser.add_argument(
        "--config",
        type=Path,
        default=Path("config/default.yaml"),
        help="Path to scan config YAML",
    )
    args = parser.parse_args(argv)

    if not args.config.exists():
        console.print(f"[red]Config not found:[/red] {args.config}")
        return 1

    cfg = load_config(args.config)
    quotes = get_provider().get_quotes()
    hits = apply_scan(quotes, cfg["filters"], cfg["ranking"])

    fmt = cfg.get("output", {}).get("format", "table")
    if fmt == "json":
        print(json.dumps([h.to_dict() for h in hits], indent=2))
    else:
        print_table(hits)

    out_path = cfg.get("output", {}).get("path")
    if out_path:
        write_csv(hits, Path(out_path))
        console.print(f"[dim]Wrote {len(hits)} hits to {out_path}[/dim]")

    return 0


if __name__ == "__main__":
    sys.exit(main())
