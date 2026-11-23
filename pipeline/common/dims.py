"""Shared dimension rules (region, lane, people names) used by every section job."""
from __future__ import annotations

import re
from collections import Counter, defaultdict

N = lambda s: re.sub(r"\s+", " ", (s or "").lower().replace("&", "and")).strip()


def names(*parts: str | None) -> str | None:
    """De-duplicated, comma-separated people names in Title Case (D-36, D-55)."""
    seen: list[str] = []
    for part in parts:
        for n in (part or "").split(","):
            n = " ".join(w[:1].upper() + w[1:].lower() for w in n.split())
            if n and n not in seen:
                seen.append(n)
    return ", ".join(seen) or None


PLAN_LANES = ["FL NBFC", "FL Direct", "LC only", "Name change", "Phase change", "PSU"]  # D-95, display order


def lane(row: dict, region: str | None = None) -> str:
    """D-95: the monthly Install Plan's six lanes, in priority order:
    PSU (payment lane PSU) > Phase change (PC) > Name change (NC) > LC only (in MH regions LC folds into the fast lane)
    > FL NBFC / FL Direct (no permit change, by payment lane). Reproduces the Nov plan's October lane mix within 1-2 pts."""
    pay = (row.get("payment_lane") or "").upper()
    has = lambda k: row.get(k) == "Yes"
    if pay == "PSU":
        return "PSU"
    if has("pc"):
        return "Phase change"
    if has("nc"):
        return "Name change"
    if has("lc") and not (region or "").upper().startswith("MH"):
        return "LC only"
    if pay == "NBFC":
        return "FL NBFC"
    if pay == "DIRECT":
        return "FL Direct"
    return "Unknown"


# Source spellings of the same business region -> one name (keys lower-case). D-37 regions.
REGION_ALIASES = {"chattisgarh": "Chhattisgarh", "chhatisgarh": "Chhattisgarh", "chattishgarh": "Chhattisgarh"}


def canon_region(name: str | None) -> str | None:
    """One spelling per region (e.g. 'Chattisgarh' -> 'Chhattisgarh')."""
    if not name:
        return name
    s = str(name).strip()
    return REGION_ALIASES.get(s.lower(), s)


class RegionFiller:
    """D-37: business region; blank -> most common region of the same city -> legal state -> 'Unknown'. Spellings unified by canon_region."""

    def __init__(self, rows: list[dict]):
        counts = defaultdict(Counter)
        for r in rows:
            if r.get("region") and r.get("city"):
                counts[N(r["city"])][r["region"]] += 1
        self.city_region = {c: cnt.most_common(1)[0][0] for c, cnt in counts.items()}
        self.filled = 0

    def __call__(self, row: dict) -> str:
        if row.get("region"):
            return canon_region(row["region"])
        self.filled += 1
        return canon_region(self.city_region.get(N(row.get("city"))) or row.get("legal_state")) or "Unknown"


class ClusterFiller:
    """D-86: cluster = project.site_address_cluster; blank / 'None' -> the most common cluster of the same city -> the city -> 'Unknown'."""

    def __init__(self, rows: list[dict]):
        counts = defaultdict(Counter)
        for r in rows:
            c = (r.get("cluster") or "").strip()
            if c and c.lower() != "none" and r.get("city"):
                counts[N(r["city"])][c] += 1
        self.city_cluster = {c: cnt.most_common(1)[0][0] for c, cnt in counts.items()}
        self.filled = 0

    def __call__(self, row: dict) -> str:
        c = (row.get("cluster") or "").strip()
        if c and c.lower() != "none":
            return c
        self.filled += 1
        city = (row.get("city") or "").strip()
        return self.city_cluster.get(N(city)) or city or "Unknown"


def people(row: dict) -> dict:
    """COM (cell roles COM + SPO), SOH / ZOH (project fields), D-36 / D-50 / D-55."""
    return {
        "com": names(row.get("com"), row.get("spo")) or "Not mapped",
        "soh": names(row.get("soh")) or "Not mapped",
        "zoh": names(row.get("zoh")) or "Not mapped",
    }
