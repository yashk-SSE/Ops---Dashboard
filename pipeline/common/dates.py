"""Date helpers. Every timestamp is converted to IST exactly once, here (D-34).

Conventions (agreed so far):
  - TAT is in calendar days (D-07): IST date of end minus IST date of start.
  - "Every 10 days" = fixed buckets per month: 1-10, 11-20, 21-month end (D-06).
  - YTD = financial year, April to March (D-20).
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))


def parse_ts(value) -> datetime | None:
    """Parse ISO-8601 text ('2026-06-21T11:56:40.941Z', '+00:00' offsets) or epoch ms into an aware UTC datetime."""
    if value in (None, "", "-1"):
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000, tz=timezone.utc)
    text = str(value).strip()
    if text.isdigit():
        return datetime.fromtimestamp(int(text) / 1000, tz=timezone.utc)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def ist_date(value) -> date | None:
    dt = parse_ts(value)
    return dt.astimezone(IST).date() if dt else None


def today_ist() -> date:
    """Today in IST. A recompute from saved extracts (run_all --reuse) sets OPS_AS_OF to the extracts' own date, so ages
    and 'days since' are measured on the day the data was pulled, not the day the recompute runs."""
    import os
    forced = os.environ.get("OPS_AS_OF")
    if forced:
        return date.fromisoformat(forced)
    return datetime.now(IST).date()


def month_key(d: date) -> str:
    return f"{d:%Y-%m}"


def ten_day_bucket(d: date) -> str:
    """'2026-11 B1' (1-10), 'B2' (11-20), 'B3' (21-end)."""
    part = 1 if d.day <= 10 else 2 if d.day <= 20 else 3
    return f"{d:%Y-%m} B{part}"


def fy_start(d: date) -> date:
    return date(d.year if d.month >= 4 else d.year - 1, 4, 1)


def fy_label(d: date) -> str:
    start = fy_start(d).year
    return f"FY{str(start + 1)[-2:]}"  # FY27 = Apr 2026 - Mar 2027


def add_months(d: date, months: int) -> date:
    y, m = divmod(d.month - 1 + months, 12)
    return date(d.year + y, m + 1, 1)


def windows(today: date) -> dict[str, tuple[date, date]]:
    """Reporting windows, inclusive [start, end].

    MTD = 1st of this month .. today; L3M / L6M = last 3 / 6 *complete* months (provisional, OQ-49);
    YTD = financial-year start .. today.
    """
    this_month = date(today.year, today.month, 1)
    last_month_end = this_month - timedelta(days=1)
    return {
        "MTD": (this_month, today),
        "L3M": (add_months(this_month, -3), last_month_end),
        "L6M": (add_months(this_month, -6), last_month_end),
        "YTD": (fy_start(today), today),
    }


# Longest "within N days of HOTO" card (V-03). Those cards follow the HOTOs whose N-day mark falls in the
# period, i.e. HOTOs from N days before the window (D-67), so history starts this many days earlier.
# Raise it if Ops CT sets a longer N.
CONVERSION_MAX_DAYS = 30


def history_start(today: date) -> date:
    """Earliest date the dashboard needs: 13 trend months AND last-FY comparisons (YTD vs last year),
    plus CONVERSION_MAX_DAYS so the '<= N days of HOTO' cards of the earliest window have all their HOTOs."""
    last_fy = fy_start(today).replace(year=fy_start(today).year - 1)
    thirteen = add_months(date(today.year, today.month, 1), -12)
    return min(last_fy, thirteen) - timedelta(days=CONVERSION_MAX_DAYS)


def previous_windows(today: date) -> dict[str, tuple[date, date]]:
    """The comparison period for each window (D-63):
    MTD -> same days of the previous month; L3M / L6M -> the 3 / 6 complete months before;
    YTD -> same span of the previous financial year."""
    cur = windows(today)
    this_month = date(today.year, today.month, 1)
    prev_month = add_months(this_month, -1)
    prev_month_end = this_month - timedelta(days=1)
    mtd_prev_end = min(date(prev_month.year, prev_month.month, min(today.day, prev_month_end.day)), prev_month_end)
    def shift_back(win, months):
        a, b = win
        return add_months(a, -months), add_months(date(b.year, b.month, 1), -months + 1) - timedelta(days=1)
    ytd_a = cur["YTD"][0].replace(year=cur["YTD"][0].year - 1)
    try:
        ytd_b = today.replace(year=today.year - 1)
    except ValueError:  # 29 Feb
        ytd_b = today.replace(year=today.year - 1, day=28)
    return {
        "MTD": (prev_month, mtd_prev_end),
        "L3M": shift_back(cur["L3M"], 3),
        "L6M": shift_back(cur["L6M"], 6),
        "YTD": (ytd_a, ytd_b),
    }
