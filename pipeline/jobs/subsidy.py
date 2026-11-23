"""Subsidy backlog: National DBT projects commissioned but not yet disbursed, by stage, with days in stage.

Usage (from the repo root):
    python -m pipeline.jobs.subsidy            # extract fresh data from Metabase
    python -m pipeline.jobs.subsidy --reuse    # recompute from the last raw extract
Rules (D-87, the logic of the "New - Pending Subsidy Tracker_V1" sheet on live system data):
  stage = current OMS subsidy status; commissioned from 1 Oct 2026 with no status yet = "Vendor Selection Pending";
  commissioned before that with no status = "No status (commissioned before Oct 2026)": not backlog, counted apart (D-90);
  backlog = National DBT, commissioned, not cancelled, stage not "Subsidy Disbursed";
  days in stage = today - first entry into the current status (subsidy_status_history), Vendor Selection = since commissioning;
  disbursed on = first entry into "Subsidy Disbursed" after another status (real transitions only; the history was bulk-loaded); buckets 0-3, 4-7, 8-15, 16-30, 30+ (as the sheet).
Writes data/marts/subsidy/summary.json (git-ignored).
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
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
MART = REPO_ROOT / "data" / "marts" / "subsidy"
DISBURSED = "Subsidy Disbursed"
VSP = "Vendor Selection Pending"
VSP_FROM = date(2026, 10, 1)  # D-90: the tracker's manual 'Consider' matches projects commissioned from Oct 2026 (283 vs 285)
OLD_NO_STATUS = "No status (commissioned before Oct 2026)"
STAGES = [VSP, "PCR Submission Pending", "DISCOM Inspection Pending", "Pending for Redeem", "Reverification",
          "Subsidy Disbursal Pending", "Application Returned for Correction", "Warning ! Recheck Give-up"]
AGING = [(0, 3, "0-3 d"), (4, 7, "4-7 d"), (8, 15, "8-15 d"), (16, 30, "16-30 d"), (31, None, "30+ d")]  # as the sheet


def bucket(days: int | None) -> str | None:
    if days is None:
        return None
    for lo, hi, label in AGING:
        if days >= lo and (hi is None or days <= hi):
            return label
    return AGING[0][2]


def extract() -> tuple[list, list, list, str]:
    client = MetabaseClient(require("METABASE_URL"), require("METABASE_API_KEY"), timeout=600)
    q = lambda name: client.export_sql(DB_ID, strip_comments((SQL / name).read_text(encoding="utf-8")))
    projects, subs, hist = q("project_dim.sql"), q("subsidy_projects.sql"), q("subsidy_status_history.sql")
    print(f"extract: {len(projects):,} projects, {len(subs):,} National DBT projects, {len(hist):,} status-history rows")
    at = datetime.now(IST).isoformat(timespec="seconds")
    write_json(RAW / "sub_project_dim.json", {"extracted_at": at, "rows": projects})
    write_json(RAW / "subsidy_projects.json", {"extracted_at": at, "rows": subs})
    write_json(RAW / "subsidy_status_history.json", {"extracted_at": at, "rows": hist})
    return projects, subs, hist, at


def load_raw() -> tuple[list, list, list, str]:
    j = lambda n: json.load(open(RAW / n, encoding="utf-8"))
    p = j("sub_project_dim.json")
    return p["rows"], j("subsidy_projects.json")["rows"], j("subsidy_status_history.json")["rows"], p.get("extracted_at", "")


def transform(projects: list, subs: list, hist: list, today: date) -> tuple[list[dict], dict]:
    since = history_start(today)
    rf, cf = RegionFiller(projects), ClusterFiller(projects)
    dims = {p["project_id"]: p for p in projects}
    h = defaultdict(dict)
    for r in hist:
        h[r["project_id"]][(r.get("subsidy_status") or "").strip()] = r
    dq = Counter()
    out = []
    for s in subs:
        pid = s["project_id"]
        p = dims.get(pid)
        if p is None:
            dq["not_in_project_dim"] += 1
            continue
        comm = ist_date(s.get("commissioned_at"))
        status = (s.get("subsidy_status") or "").strip()
        state = s.get("project_state") or "unknown"
        if status == DISBURSED:
            stage = DISBURSED
        elif status:
            stage = status
        elif comm:
            stage = VSP if comm >= VSP_FROM else OLD_NO_STATUS
        else:
            continue  # not commissioned and no status yet: not in the subsidy pipeline
        if stage not in STAGES and stage not in (DISBURSED, OLD_NO_STATUS):
            dq[f"other_status:{stage}"] += 1
        hp = h.get(pid, {})
        # The history was bulk-loaded (Mar and Sep 2026) and re-logs the status on every sync, so:
        #  - days in stage = since the FIRST entry into the current status (the latest entry is just the last sync);
        #  - "disbursed on" counts only real transitions: the project was logged in another status before turning Disbursed.
        disbursed_first = ist_date(hp.get(DISBURSED, {}).get("first_at"))
        earlier = [ist_date(v.get("first_at")) for k, v in hp.items() if k != DISBURSED]
        disbursed_on = disbursed_first if (disbursed_first and any(e and e < disbursed_first for e in earlier)) else None
        if disbursed_first and not disbursed_on:
            dq["disbursed_without_prior_status (bulk load)"] += 1
        if stage in (VSP, OLD_NO_STATUS):
            stage_since = comm
        else:
            stage_since = ist_date(hp.get(status, {}).get("first_at"))
            if stage_since is None:
                dq["no_history_for_current_status"] += 1
        in_backlog = bool(comm) and state != "cancelled" and stage not in (DISBURSED, OLD_NO_STATUS)
        old_no_status = stage == OLD_NO_STATUS and state != "cancelled"
        if not (in_backlog or old_no_status or (comm and comm >= since) or (disbursed_on and disbursed_on >= since)):
            continue
        days_in_stage = (today - stage_since).days if ((in_backlog or old_no_status) and stage_since) else None
        tat = (disbursed_on - comm).days if (disbursed_on and comm and disbursed_on >= comm) else None
        out.append({
            "sseid": p.get("sseid"), "project_id": pid, "region": rf(p), "cluster": cf(p), "cell": p.get("cell_name") or "No cell",
            **people(p), "lane": lane(p, rf(p)), "payment_lane": p.get("payment_lane") or "UNKNOWN",
            "state": state, "stage": stage, "commissioned_on": comm, "stage_since": stage_since, "disbursed_on": disbursed_on,
            "comm_to_disbursed": tat, "in_backlog": in_backlog, "old_no_status": old_no_status,
            "days_in_stage": days_in_stage, "aging": bucket(days_in_stage) if in_backlog else None,
            "days_since_comm": (today - comm).days if ((in_backlog or old_no_status) and comm) else None,
        })
    return out, dict(dq)


def summarise(rows: list[dict]) -> dict:
    back = [r for r in rows if r["in_backlog"]]
    return {
        "projects": len(rows), "backlog": len(back), "backlog_by_stage": dict(Counter(r["stage"] for r in back).most_common()),
        "old_no_status": sum(1 for r in rows if r["old_no_status"]),
        "backlog_aging": dict(Counter(r["aging"] for r in back)),
        "disbursed_by_month": dict(sorted(Counter(r["disbursed_on"].strftime("%Y-%m") for r in rows if r["disbursed_on"]).items())[-8:]),
        "comm_to_disbursed": tat_summary([r["comm_to_disbursed"] for r in rows if r["comm_to_disbursed"] is not None]),
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
    projects, subs, hist, at = load_raw() if args.reuse else extract()
    rows, dq = transform(projects, subs, hist, today)
    s = summarise(rows)
    MART.mkdir(parents=True, exist_ok=True)
    write_json(MART / "summary.json", {"extracted_at": at, "as_of": today.isoformat(), "summary": s, "data_quality": dq})
    print(json.dumps(s, indent=1, default=str))
    print("data quality:", dq)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
