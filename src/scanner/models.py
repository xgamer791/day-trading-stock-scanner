from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class Quote:
    symbol: str
    price: float
    prev_close: float
    volume: int
    avg_volume: int
    float_millions: float
    dollar_volume: float

    @property
    def gap_pct(self) -> float:
        if self.prev_close <= 0:
            return 0.0
        return ((self.price - self.prev_close) / self.prev_close) * 100.0

    @property
    def rel_volume(self) -> float:
        if self.avg_volume <= 0:
            return 0.0
        return self.volume / self.avg_volume


@dataclass
class ScanHit:
    symbol: str
    price: float
    gap_pct: float
    rel_volume: float
    dollar_volume: float
    float_millions: float
    score: float
    reasons: list[str]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
