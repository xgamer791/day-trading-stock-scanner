from scanner.filters import apply_scan, passes_filters, score_quote
from scanner.models import Quote


FILTERS = {
    "min_price": 2.0,
    "max_price": 50.0,
    "min_rel_volume": 2.0,
    "min_gap_pct": 3.0,
    "min_avg_volume": 500_000,
    "max_float_millions": 100,
}

RANKING = {
    "gap_weight": 0.35,
    "rel_volume_weight": 0.40,
    "dollar_volume_weight": 0.25,
    "top_n": 10,
}


def _q(**kwargs) -> Quote:
    base = dict(
        symbol="TEST",
        price=10.0,
        prev_close=9.0,
        volume=2_000_000,
        avg_volume=500_000,
        float_millions=20.0,
        dollar_volume=20_000_000.0,
    )
    base.update(kwargs)
    return Quote(**base)


def test_passes_gap_and_rvol():
    ok, reasons = passes_filters(_q(), FILTERS)
    assert ok
    assert any("gap" in r for r in reasons)


def test_rejects_low_rvol():
    ok, _ = passes_filters(_q(volume=100_000, avg_volume=500_000), FILTERS)
    assert not ok


def test_score_increases_with_rvol():
    low = score_quote(_q(volume=1_000_000, avg_volume=500_000), RANKING)
    high = score_quote(_q(volume=5_000_000, avg_volume=500_000), RANKING)
    assert high > low


def test_apply_scan_ranks_and_limits():
    quotes = [
        _q(symbol="A", price=8, prev_close=7, volume=3_000_000),
        _q(symbol="B", price=8, prev_close=7.8, volume=1_100_000),
        _q(symbol="C", price=80, prev_close=70, volume=5_000_000),  # price filter
    ]
    hits = apply_scan(quotes, FILTERS, {**RANKING, "top_n": 1})
    assert len(hits) == 1
    assert hits[0].symbol == "A"
