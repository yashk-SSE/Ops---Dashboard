"""Order -> HOTO (D-124): orders booked, how fast they reach HOTO, where they wait, and the RM welcome call (Opening Act).

Usage (from the repo root):
    python -m pipeline.jobs.orders            # extract fresh data from Metabase
    python -m pipeline.jobs.orders --reuse    # recompute from the last raw extracts
Rules:
  order          = a lead with an order date: lead.order_closure_datetime (when sales closed the order, ~3 days before HOTO;
                   project.order_closure_datetime is later, ~1 day before HOTO, D-124);
  HOTO           = project.sales_handover_datetime (E-02) of the project with the same SSE ID (project.lead_id is not lead._id);
                   projects' dims (cluster, COM, SOH, ZOH, lane) win; orders not handed over use the lead's city / cluster / cell;
  status         = Handed over | Waiting (no HOTO, lead in a booking / verification / RM-call stage) | Dropped (cancelled or
                   rejected before HOTO) | Other (lead moved back to a sales stage);
  welcome call   = RM verification checklist (task SC008, D-78 / D-91): first-call verdict (GTG = APPROVED on the first attempt),
                   latest verdict, attempts, SC008 task created, first checklist saved; NGTG sections / reasons from the first
                   attempt (not ALIGNED, incl. PENDING).
Writes data/marts/orders/summary.json (git-ignored).
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
from pipeline.jobs.p1_hoto_to_install import RM_SECTIONS, rm_bits
from pipeline.probe_metabase import write_json
from pipeline.run_sql import strip_comments

DB_ID = 2
SQL = REPO_ROOT / "sql" / "extract"
RAW = REPO_ROOT / "data" / "raw" / "extract"
MART = REPO_ROOT / "data" / "marts" / "orders"
# lead stages of an order that is still on its way to HOTO, in journey order
WAIT_STAGES = ["Booking Pending by Cx", "Booking Pending by ZSM", "Booking Processing", "Advance Received", "Pending Verification",
               "Verification Rejected", "Pending RM Call", "RM Rejected", "Order Confirmed", "HOTO Initiated"]
DROPPED = {"Cancelled", "Cancellation Initiated", "Booking Rejected by Cx", "Booking Rejected by ZSM"}
SECTION_LABEL = dict(RM_SECTIONS)


def extract(today: date) -> tuple[list, list, str]:
    client = MetabaseClient(require("METABASE_URL"), require("METABASE_API_KEY"), timeout=600)
    read = lambda name: strip_comments((SQL / name).read_text(encoding="utf-8"))
    projects = client.export_sql(DB_ID, read("project_dim.sql"))
    since = history_start(today)
    orders = client.export_sql(DB_ID, read("order_journey.sql").replace("{since}", since.isoformat()))
    print(f"extract: {len(projects):,} projects, {len(orders):,} orders since {since}")
    at = datetime.now(IST).isoformat(timespec="seconds")
    write_json(RAW / "order_project_dim.json", {"extracted_at": at, "rows": projects})
    write_json(RAW / "order_journey.json", {"extracted_at": at, "since": since.isoformat(), "rows": orders})
    return projects, orders, at


def load_raw() -> tuple[list, list, str]:
    j = lambda n: json.load(open(RAW / n, encoding="utf-8"))
    p = j("order_project_dim.json")
    return p["rows"], j("order_journey.json")["rows"], p.get("extracted_at", "")


def reason_label(pair: str) -> str:
    key, _, reason = pair.partition(":")
    return f"{SECTION_LABEL.get(key, key)}: {reason or 'no reason given'}"


def transform(projects: list, orders: list, today: date) -> tuple[list[dict], dict]:
    rf, cf = RegionFiller(projects), ClusterFiller(projects)
    by_sse = {}
    for p in projects:
        s = (p.get("sseid") or "").strip()
        if s:
            by_sse[s] = p
    dq = Counter()
    out = []
    for o in orders:
        order_on = ist_date(o.get("order_at"))
        if order_on is None:
            dq["no_order_date"] += 1
            continue
        p = by_sse.get(o.get("sseid") or "")
        hoto = ist_date(p.get("hoto_at")) if p else None
        stage = (o.get("stage") or "").strip() or "—"
        dropped_flag = str(o.get("pre_hoto_cancellation")).lower() == "true" or bool(o.get("cancellation_id"))
        if hoto:
            status = "Handed over"
        elif stage in DROPPED or dropped_flag:
            status = "Dropped"
        elif stage in WAIT_STAGES:
            status = "Waiting"
        else:
            status = "Other"
            dq[f"other stage: {stage}"] += 1
        if p:
            place = {"region": rf(p), "cluster": cf(p), "cell": p.get("cell_name") or "No cell", **people(p), "lane": lane(p, rf(p)),
                     "payment_lane": p.get("payment_lane") or "UNKNOWN"}
        else:
            pseudo = {"region": None, "city": o.get("city"), "legal_state": o.get("legal_state"), "cluster": o.get("cluster")}
            place = {"region": rf(pseudo), "cluster": cf(pseudo), "cell": o.get("cell_name") or "No cell",
                     **people({"com": o.get("com"), "soh": o.get("soh"), "zoh": o.get("zoh")}), "lane": "Not handed over", "payment_lane": "UNKNOWN"}
        first = (o.get("first_verdict") or "").upper() or None
        latest = (o.get("latest_verdict") or "").upper() or None
        reasons = sorted({reason_label(x) for x in (o.get("first_reasons") or "").split("|") if x.strip()}) if first == "REJECTED" else []
        out.append({
            "sseid": o.get("sseid"), **place, "status": status, "stage": stage,
            "oa": None if o.get("opening_act") is None else str(o.get("opening_act")).lower() == "true",
            "rm": o.get("rm") or "No RM", "order_on": order_on, "hoto_on": hoto,
            "sc008_on": ist_date(o.get("sc008_created_at")), "call_on": ist_date(o.get("first_call_at")), "verified_on": ist_date(o.get("verified_at")),
            "attempts": int(o["attempts"]) if o.get("attempts") not in (None, "") else None,
            "first_gtg": None if first is None else first == "APPROVED", "latest_gtg": None if latest is None else latest == "APPROVED",
            "ngtg_bits": rm_bits(o.get("first_not_aligned")) if first == "REJECTED" else 0, "reasons": reasons,
        })
        if hoto and hoto < order_on:
            dq["HOTO before order date"] += 1
    return out, dict(dq)


def summarise(rows: list[dict], today: date) -> dict:
    recent = [r for r in rows if (today - r["order_on"]).days <= 120]
    tat = [(r["hoto_on"] - r["order_on"]).days for r in recent if r["hoto_on"] and r["hoto_on"] >= r["order_on"]]
    calls = [r for r in recent if r["first_gtg"] is not None]
    return {"orders": len(rows), "status": dict(Counter(r["status"] for r in rows)),
            "waiting_by_stage": dict(Counter(r["stage"] for r in rows if r["status"] == "Waiting").most_common()),
            "order_to_hoto_last_120d": tat_summary(tat),
            "first_call_gtg_pct_last_120d": round(100 * sum(r["first_gtg"] for r in calls) / len(calls), 1) if calls else None,
            "rms": len({r["rm"] for r in rows if r["rm"] != "No RM"})}


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--reuse", action="store_true", help="recompute from the last raw extracts")
    args = ap.parse_args(argv)
    today = today_ist()
    projects, orders, at = load_raw() if args.reuse else extract(today)
    rows, dq = transform(projects, orders, today)
    s = summarise(rows, today)
    MART.mkdir(parents=True, exist_ok=True)
    write_json(MART / "summary.json", {"extracted_at": at, "as_of": today.isoformat(), "summary": s, "data_quality": dq})
    print(json.dumps(s, indent=1, default=str))
    print("data quality:", dq)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
