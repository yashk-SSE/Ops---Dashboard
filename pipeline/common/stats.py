"""Statistics helpers."""
from __future__ import annotations

import math


def percentile(values: list[float], p: float) -> float | None:
    """Inclusive linear-interpolation percentile, same as Excel / Sheets PERCENTILE(.INC). p in [0, 1]."""
    if not values:
        return None
    xs = sorted(values)
    k = (len(xs) - 1) * p
    lo, hi = math.floor(k), math.ceil(k)
    if lo == hi:
        return float(xs[lo])
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def tat_summary(days: list[int]) -> dict:
    """Count, P50/P75/P90 and % within 7 / 15 days for a list of TATs in calendar days."""
    n = len(days)
    if not n:
        return {"count": 0, "p50": None, "p75": None, "p90": None, "pct_within_7d": None, "pct_within_15d": None}
    r = lambda v: round(v, 1) if v is not None else None
    return {
        "count": n,
        "p50": r(percentile(days, 0.50)),
        "p75": r(percentile(days, 0.75)),
        "p90": r(percentile(days, 0.90)),
        "pct_within_7d": round(100 * sum(1 for d in days if d <= 7) / n, 1),
        "pct_within_15d": round(100 * sum(1 for d in days if d <= 15) / n, 1),
    }
