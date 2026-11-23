"""Escalations: Operations customer tickets from Freshdesk by level, with closure TAT and open aging.

Usage (from the repo root):
    python -m pipeline.jobs.escalations            # extract fresh data from Metabase
    python -m pipeline.jobs.escalations --reuse    # recompute from the last raw extract
Rules: D-75 population = LOB Operations, not merged, with an SSE ID, assigned group not 'CT Team' (matches the PAN India
Escalation DB, docs/reconciliation/escalations.md); all levels shown, L1 separate, L2-L5 + Red Alert = true escalations.
Closure TAT and aging buckets as Metabase Q-1767 (the CX ticket report): closed time - created time, IST dates
(calendar days, G-02); buckets 0-3, 4-7, 8-15, 16-30, 31-60, 60+. Closed = closed_time, else resolved_time, else status 'Closed'.
Writes data/marts/escalations/summary.json (git-ignored).
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import date, datetime

from pipeline.common.dates import IST, history_start, ist_date, today_ist
from pipeline.common.dims import ClusterFiller, RegionFiller, lane, people
from pipeline.common.stats import tat_summary
from pipeline.config import REPO_ROOT, require
from pipeline.extract.metabase import MetabaseClient
from pipeline.probe_metabase import write_json
from pipeline.run_sql import strip_comments

DB_ID = 2
SQL = REPO_ROOT / "sql" / "extract"
RAW = REPO_ROOT / "data" / "raw" / "extract"
MART = REPO_ROOT / "data" / "marts" / "escalations"
EXCLUDED_GROUPS = {"CT Team"}  # D-75
AGING = [(0, 3, "0-3 d"), (4, 7, "4-7 d"), (8, 15, "8-15 d"), (16, 30, "16-30 d"), (31, 60, "31-60 d"), (61, None, "60+ d")]  # Q-1767
LEVELS = ["L1 - New Escalation", "L2 - Repeat Escalation", "L3 - Founders", "L4 - Social Media", "L5 - Consumer Forum", "Red Alert", "QHSE", "(blank)"]
TRUE_ESCALATION = {"L2 - Repeat Escalation", "L3 - Founders", "L4 - Social Media", "L5 - Consumer Forum", "Red Alert"}


def bucket(days: int | None) -> str | None:
    if days is None:
        return None
    for lo, hi, label in AGING:
        if days >= lo and (hi is None or days <= hi):
            return label
    return AGING[0][2]


def extract() -> tuple[list, list, str]:
    client = MetabaseClient(require("METABASE_URL"), require("METABASE_API_KEY"), timeout=600)
    q = lambda name: client.export_sql(DB_ID, strip_comments((SQL / name).read_text(encoding="utf-8")))
    projects, tickets = q("project_dim.sql"), q("escalation_tickets.sql")
    print(f"extract: {len(projects):,} projects, {len(tickets):,} Operations tickets")
    at = datetime.now(IST).isoformat(timespec="seconds")
    write_json(RAW / "esc_project_dim.json", {"extracted_at": at, "rows": projects})
    write_json(RAW / "escalation_tickets.json", {"extracted_at": at, "rows": tickets})
    return projects, tickets, at


def load_raw() -> tuple[list, list, str]:
    p = json.load(open(RAW / "esc_project_dim.json", encoding="utf-8"))
    return p["rows"], json.load(open(RAW / "escalation_tickets.json", encoding="utf-8"))["rows"], p.get("extracted_at", "")


def transform(projects: list, tickets: list, today: date) -> tuple[list[dict], dict]:
    since = history_start(today)
    rf = RegionFiller(projects)
    cf = ClusterFiller(projects)  # D-86
    by_sse = {p["sseid"]: p for p in projects if p.get("sseid")}
    dq = Counter()
    out = []
    for t in tickets:
        merged = (t.get("is_merged") or "").strip().lower() in ("merged", "true", "t", "1")
        sse = (t.get("sse_id") or "").strip()
        group = (t.get("assigned_group") or "").strip() or "(blank)"
        if merged:
            dq["excluded_merged"] += 1; continue
        if not sse:
            dq["excluded_no_sse"] += 1; continue
        if group in EXCLUDED_GROUPS:
            dq["excluded_ct_team"] += 1; continue
        created = ist_date(t.get("created_at"))
        if not created:
            dq["no_created_date"] += 1; continue
        closed_on = ist_date(t.get("closed_time")) or ist_date(t.get("resolved_time"))
        status = (t.get("status") or "").strip() or "(blank)"
        is_open = closed_on is None and status != "Closed"
        if not is_open and closed_on is None:
            dq["closed_without_date"] += 1
        if created < since and not is_open:
            continue
        p = by_sse.get(sse)
        if p is None:
            dq["sse_not_in_projects"] += 1
        level = (t.get("severity_level") or "").strip() or "(blank)"
        tat = (closed_on - created).days if (closed_on and closed_on >= created) else None
        open_days = (today - created).days if is_open else None
        out.append({
            "ticket_id": t["ticket_id"], "sseid": sse,
            "region": rf(p) if p else "Unknown", "city": ((p or {}).get("city") or "").strip() or "Unknown", "cluster": cf(p) if p else "Unknown",
            "cell": (p or {}).get("cell_name") or "No cell",
            **(people(p) if p else {"com": "Not mapped", "soh": "Not mapped", "zoh": "Not mapped"}),
            "lane": lane(p, rf(p)) if p else "Unknown", "payment_lane": (p or {}).get("payment_lane") or "UNKNOWN",
            "level": level, "true_escalation": level in TRUE_ESCALATION, "group": group,
            "source": (t.get("source_channel") or "").strip() or "(blank)", "priority": (t.get("priority") or "").strip() or "(blank)",
            "issue_type": (t.get("issue_category") or "").strip() or "(blank)", "issue_detail": (t.get("issue_detail") or "").strip() or "(blank)",
            "status": status, "created_on": created, "closed_on": closed_on, "closure_tat": tat,
            "is_open": is_open, "open_days": open_days, "aging": bucket(open_days if is_open else tat),
        })
    return out, dict(dq)


def summarise(rows: list[dict]) -> dict:
    by_month = Counter(r["created_on"].strftime("%Y-%m") for r in rows)
    lvl = Counter(r["level"] for r in rows if r["created_on"] >= date(2026, 10, 1) and r["created_on"] <= date(2026, 11, 10))
    return {
        "tickets": len(rows), "open": sum(r["is_open"] for r in rows),
        "open_true_escalations": sum(r["is_open"] and r["true_escalation"] for r in rows),
        "created_by_month": dict(sorted(by_month.items())[-8:]),
        "oct1_nov10_total": sum(lvl.values()), "oct1_nov10_by_level": dict(lvl.most_common()),
        "closure_tat": tat_summary([r["closure_tat"] for r in rows if r["closure_tat"] is not None]),
        "open_aging": dict(Counter(r["aging"] for r in rows if r["is_open"])),
    }


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--reuse", action="store_true", help="recompute from the last raw extract")
    args = ap.parse_args(argv)
    today = today_ist()
    projects, tickets, at = load_raw() if args.reuse else extract()
    rows, dq = transform(projects, tickets, today)
    s = summarise(rows)
    MART.mkdir(parents=True, exist_ok=True)
    write_json(MART / "summary.json", {"extracted_at": at, "as_of": today.isoformat(), "summary": s, "data_quality": dq})
    print(json.dumps({k: v for k, v in s.items()}, indent=1, default=str))
    print("data quality:", dq)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
