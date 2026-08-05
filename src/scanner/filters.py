from __future__ import annotations

from typing import Any

from scanner.models import Quote, ScanHit


def passes_filters(quote: Quote, filters: dict[str, Any]) -> tuple[bool, list[str]]:
    reasons: list[str] = []

    if quote.price < filters["min_price"] or quote.price > filters["max_price"]:
        return False, reasons
    if quote.avg_volume < filters["min_avg_volume"]:
        return False, reasons
    if quote.float_millions > filters["max_float_millions"]:
        return False, reasons
    if abs(quote.gap_pct) < filters["min_gap_pct"]:
        return False, reasons
    if quote.rel_volume < filters["min_rel_volume"]:
        return False, reasons

    direction = "gap up" if quote.gap_pct >= 0 else "gap down"
    reasons.append(f"{direction} {quote.gap_pct:.1f}%")
    reasons.append(f"RVOL {quote.rel_volume:.1f}x")
    reasons.append(f"float {quote.float_millions:.1f}M")
    return True, reasons


def score_quote(quote: Quote, ranking: dict[str, Any]) -> float:
    # Normalize loosely so larger gaps / RVOL / dollar volume rank higher.
    gap_component = min(abs(quote.gap_pct) / 20.0, 1.0)
    rvol_component = min(quote.rel_volume / 10.0, 1.0)
    dvol_component = min(quote.dollar_volume / 20_000_000.0, 1.0)
    return (
        gap_component * ranking["gap_weight"]
        + rvol_component * ranking["rel_volume_weight"]
        + dvol_component * ranking["dollar_volume_weight"]
    )


def apply_scan(
    quotes: list[Quote],
    filters: dict[str, Any],
    ranking: dict[str, Any],
) -> list[ScanHit]:
    hits: list[ScanHit] = []
    for quote in quotes:
        ok, reasons = passes_filters(quote, filters)
        if not ok:
            continue
        hits.append(
            ScanHit(
                symbol=quote.symbol,
                price=quote.price,
                gap_pct=quote.gap_pct,
                rel_volume=quote.rel_volume,
                dollar_volume=quote.dollar_volume,
                float_millions=quote.float_millions,
                score=score_quote(quote, ranking),
                reasons=reasons,
            )
        )
    hits.sort(key=lambda h: h.score, reverse=True)
    return hits[: int(ranking.get("top_n", 25))]
