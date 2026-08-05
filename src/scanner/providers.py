from __future__ import annotations

import os
from abc import ABC, abstractmethod

from scanner.models import Quote


class MarketDataProvider(ABC):
    @abstractmethod
    def get_quotes(self) -> list[Quote]:
        raise NotImplementedError


class DemoProvider(MarketDataProvider):
    """Sample quotes so the scanner runs without an API key."""

    def get_quotes(self) -> list[Quote]:
        rows = [
            ("ABCD", 8.42, 7.10, 2_400_000, 600_000, 18.0),
            ("EFGH", 12.05, 11.80, 900_000, 1_200_000, 45.0),
            ("IJKL", 3.55, 2.90, 5_100_000, 800_000, 22.5),
            ("MNOP", 41.20, 39.00, 1_800_000, 2_000_000, 80.0),
            ("QRST", 6.10, 6.05, 200_000, 700_000, 12.0),
            ("UVWX", 15.75, 14.20, 3_300_000, 900_000, 35.0),
            ("YZAA", 2.40, 2.10, 4_000_000, 1_500_000, 9.5),
            ("HIGH", 95.00, 80.00, 10_000_000, 3_000_000, 50.0),  # filtered by price
        ]
        quotes: list[Quote] = []
        for symbol, price, prev, vol, avg, flt in rows:
            quotes.append(
                Quote(
                    symbol=symbol,
                    price=price,
                    prev_close=prev,
                    volume=vol,
                    avg_volume=avg,
                    float_millions=flt,
                    dollar_volume=price * vol,
                )
            )
        return quotes


def get_provider() -> MarketDataProvider:
    # Hook for real providers once keys are configured.
    if os.getenv("POLYGON_API_KEY") or os.getenv("ALPACA_API_KEY"):
        # Real integrations can be added here; fall back to demo for now.
        return DemoProvider()
    return DemoProvider()
