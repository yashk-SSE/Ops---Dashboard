"""P1 HOTO -> Install funnel, by HOTO cohort (D-58), plus the live pipeline of projects not yet installed.

Usage (from the repo root):
    python -m pipeline.jobs.p1_hoto_to_install            # extract fresh data from Metabase
    python -m pipeline.jobs.p1_hoto_to_install --reuse    # recompute from the last raw extract

Stages come from config/seed/stages.csv (section 'P1 ...') and events from config/seed/events.csv (D-43).
A stage whose event has no definition yet (e.g. 'Payment 1 collected', OQ-47) is reported as not defined.

Rules: D-58 cohort = HOTO date; D-40 stage definitions; D-34 HOTO / installation; D-42 later-cancelled toggle;
       D-36 / D-50 people; D-37 region; D-38 lane; D-07 calendar days; D-06 10-day buckets; D-20 / D-47 windows.
Writes data/marts/p1/*.json (git-ignored).
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from datetime import date, datetime

from pipeline.common.dates import IST, add_months, fy_label, history_start, ist_date, month_key, parse_ts, ten_day_bucket, today_ist, windows
from pipeline.common.dims import ClusterFiller, RegionFiller, lane, people
from pipeline.common.stage_model import (applies, defined, event_datetime, extract_completions, load_events, load_stages,
                                         needed_keys, to_ist_date)
from pipeline.common.stats import tat_summary
from pipeline.config import REPO_ROOT, require
from pipeline.extract.metabase import MetabaseClient
from pipeline.probe_metabase import write_json
from pipeline.run_sql import strip_comments

DB_ID = 2
SQL_PROJECTS = REPO_ROOT / "sql/extract/project_dim.sql"
SQL_LENDER_RFD = REPO_ROOT / "sql/extract/nbfc_lender_rfd.sql"  # D-76
SQL_MISMATCH = REPO_ROOT / "sql/extract/hoto_mismatch.sql"  # D-74 (old flags, filled until Sep 2026)
SQL_RM = REPO_ROOT / "sql/extract/hoto_rm_checklist.sql"  # D-91: RM verification checklist (SC008)
# D-91: checklist sections in display order; bit i = RM_SECTIONS[i]; an unknown key sets the last bit ("other")
RM_SECTIONS = [("designDetails", "Design details"), ("paymentDetails", "Payment details"), ("permitFormalities", "Permit formalities"),
               ("noc", "NOC"), ("postCommissioningTimelines", "Post-commissioning timelines"), ("siteReadiness", "Site readiness"),
               ("ocrCustomerScopeAddons", "Customer-scope add-ons"), ("orderDetails", "Order details"),
               ("customerCommitmentDates", "Customer commitment dates"), ("additionalComments", "Additional comments"), ("other", "Other")]
MISMATCH_FLAGS = ["finance_mode", "project_timeline", "site_status", "payment_terms", "bill_correction_scope", "phase_change",
                  "name_change", "load_change", "structure_table", "number_of_modules", "module_make", "address",
                  "customer_first_name", "customer_last_name", "aadhar_card_front", "aadhar_card_back", "pan_card",
                  "property_tax", "cancelled_cheque", "customer_photo", "property_document"]  # bit i = flag i
# Q-2369: these lenders log a "ready-for-disbursement" stage; the others get an "RFD Done" tag
LENDER_STAGE_PARTNERS = {"creditfair", "credit fair", "credifire", "fibe", "fibe - offline", "caprion"}
RAW = REPO_ROOT / "data/raw/extract"
MART = REPO_ROOT / "data/marts/p1"
ALIVE = ("active", "on-hold", "seeking-cancellation")
LATER_CANCELLED = ("cancelled", "on-hold", "seeking-cancellation")
HOTO_AGING = [(0, 15, "0-15 days"), (16, 30, "16-30 days"), (31, 45, "31-45 days"), (46, 60, "46-60 days"),
              (61, 90, "61-90 days"), (91, None, ">90 days")]  # provisional, OQ-59
DIMENSIONS = ["region", "city", "cell", "lane", "payment_lane", "com", "soh", "zoh"]
DISPLAY_EVENTS = ["E_HOTO", "E_BILLCORR_START", "E_BILLCORR_DONE", "E_CX_DESIGN", "E_SANCTION", "E_P1_COLLECTED", "E_RTI", "E_P1_REFLECTED",
                  "E_ERP_RAISED", "E_INSTALL_PLANNED", "E_MATERIAL", "E_INSTALL_DONE", "E_P2_REFLECTED"]


def cohort_start(today: date) -> date:
    return add_months(date(today.year, today.month, 1), -12)  # 13 HOTO months incl. the current one


# ----------------------------------------------------------------------------- extract
def extract(today: date) -> tuple[list[dict], dict, str]:
    client = MetabaseClient(require("METABASE_URL"), require("METABASE_API_KEY"), timeout=600)
    projects = client.export_sql(DB_ID, strip_comments(SQL_PROJECTS.read_text(encoding="utf-8")))
    print(f"extract project_dim: {len(projects):,} projects")
    events, stages = load_events(), load_stages("P1")
    wanted = {s["start_event"] for s in stages} | {s["end_event"] for s in stages} | set(DISPLAY_EVENTS)
    keys = needed_keys(events, wanted)
    since = history_start(today)  # covers last-FY comparisons (D-63), not just the 13 trend months
    ids = [p["project_id"] for p in projects
           if (ist_date(p.get("hoto_at")) or date.min) >= since or p.get("project_state") in ALIVE]
    comps = extract_completions(client, DB_ID, ids, keys)
    lender = client.export_sql(DB_ID, strip_comments(SQL_LENDER_RFD.read_text(encoding="utf-8")))
    print(f"extract nbfc_lender_rfd: {len(lender):,} EMI applications")
    mism = client.export_sql(DB_ID, strip_comments(SQL_MISMATCH.read_text(encoding="utf-8")))
    print(f"extract hoto_mismatch: {len(mism):,} projects")
    rm = client.export_sql(DB_ID, strip_comments(SQL_RM.read_text(encoding="utf-8")))
    print(f"extract hoto_rm_checklist: {len(rm):,} projects")
    at = datetime.now(IST).isoformat(timespec="seconds")
    write_json(RAW / "project_dim.json", {"extracted_at": at, "row_count": len(projects), "rows": projects})
    write_json(RAW / "nbfc_lender_rfd.json", {"extracted_at": at, "rows": lender})
    write_json(RAW / "hoto_mismatch.json", {"extracted_at": at, "rows": mism})
    write_json(RAW / "hoto_rm_checklist.json", {"extracted_at": at, "rows": rm})
    add_lender_rfd(projects, lender)
    add_mismatch(projects, mism)
    add_rm(projects, rm)
    write_json(RAW / "p1_task_completions.json", {"extracted_at": at, "keys": keys, "project_ids": ids, "rows": comps})
    return projects, {"ids": set(ids), "comps": comps}, at



def add_lender_rfd(projects: list[dict], lender: list[dict]) -> None:
    """D-76: put the NBFC lender's RFD time on each project as `nbfc_lender_rfd_at` (event E_NBFC_LENDER_RFD)."""
    by_pid = {r["project_id"]: r for r in lender}
    for p in projects:
        r = by_pid.get(p["project_id"])
        if not r:
            continue
        partner = (r.get("emi_partner") or r.get("project_loan_partner") or "").strip().lower()
        p["nbfc_lender_rfd_at"] = r.get("lender_stage_last_at") if partner in LENDER_STAGE_PARTNERS else r.get("rfd_tag_last_at")


def add_mismatch(projects: list[dict], rows: list[dict]) -> None:
    """D-74: pack the HOTO mismatch flags into `mismatch` (bit i = MISMATCH_FLAGS[i])."""
    by_pid = {r["project_id"]: r for r in rows}
    for p in projects:
        r = by_pid.get(p["project_id"])
        if r:
            p["mismatch"] = sum(1 << i for i, f in enumerate(MISMATCH_FLAGS) if str(r.get(f"{f}_mismatch")).lower() in ("true", "t", "1"))

def rm_bits(keys: str | None) -> int:
    idx = {k: i for i, (k, _) in enumerate(RM_SECTIONS)}
    return sum({1 << idx.get(k.strip(), len(RM_SECTIONS) - 1) for k in (keys or "").split(",") if k.strip()})


def add_rm(projects: list[dict], rows: list[dict]) -> None:
    """D-91: `rm` = bitmask of the sections not ALIGNED in ANY attempt of the RM checklist (0 = good to go first time);
    absent = no checklist. The latest attempt is almost always clean (HOTO waits for approval), so it is kept only as `rm_latest`."""
    by_pid = {r["project_id"]: r for r in rows}
    for p in projects:
        r = by_pid.get(p["project_id"])
        if r:
            p["rm"] = rm_bits(r.get("ever_not_aligned"))
            p["rm_latest"] = rm_bits(r.get("latest_not_aligned"))


def load_raw() -> tuple[list[dict], dict, str]:
    p = json.load(open(RAW / "project_dim.json", encoding="utf-8"))
    c = json.load(open(RAW / "p1_task_completions.json", encoding="utf-8"))
    lr = RAW / "nbfc_lender_rfd.json"
    add_lender_rfd(p["rows"], json.load(open(lr, encoding="utf-8"))["rows"] if lr.exists() else [])
    mm = RAW / "hoto_mismatch.json"
    add_mismatch(p["rows"], json.load(open(mm, encoding="utf-8"))["rows"] if mm.exists() else [])
    rmf = RAW / "hoto_rm_checklist.json"
    add_rm(p["rows"], json.load(open(rmf, encoding="utf-8"))["rows"] if rmf.exists() else [])
    return p["rows"], {"ids": set(c["project_ids"]), "comps": c["rows"]}, p.get("extracted_at", "")


# ----------------------------------------------------------------------------- transform
def bucket(days: int, buckets) -> str:
    for lo, hi, label in buckets:
        if days >= lo and (hi is None or days <= hi):
            return label
    return buckets[0][2]


def transform(projects: list[dict], comp: dict, today: date) -> tuple[list[dict], list[dict], dict]:
    events, stages = load_events(), load_stages("P1")
    rf = RegionFiller(projects)
    cf = ClusterFiller(projects)  # D-86
    dq = Counter()
    out = []
    for p in projects:
        pid = p["project_id"]
        if pid not in comp["ids"]:
            continue
        c = comp["comps"].get(pid, {})
        cache: dict = {}
        hoto = to_ist_date(event_datetime("E_HOTO", p, c, events, cache))
        if not hoto:
            dq["no_hoto_date"] += 1
            continue
        installed = to_ist_date(event_datetime("E_INSTALL_DONE", p, c, events, cache))
        st = {}
        for s in stages:
            sid = s["stage_id"]
            if not defined(s, events):
                st[sid] = {"defined": False}
                continue
            started = event_datetime("E_BILLCORR_START", p, c, events, cache)  # for 'LC/NC/PC started' (OQ-60)
            if not applies(s, p, started):
                st[sid] = {"defined": True, "applies": False}
                continue
            start = to_ist_date(event_datetime(s["start_event"], p, c, events, cache))
            end = to_ist_date(event_datetime(s["end_event"], p, c, events, cache))
            tat = (end - start).days if start and end else None
            if tat is not None and tat < 0:
                dq[f"negative_tat_{sid}"] += 1
                tat = None
            st[sid] = {"defined": True, "applies": True, "reached": end is not None, "tat": tat}
        if any(p.get(k) == "Yes" for k in ("lc", "nc", "pc")) and not event_datetime("E_BILLCORR_START", p, c, events, cache):
            dq["lc_nc_pc_flagged_but_no_bill_correction_task"] += 1
        state = p.get("project_state")
        pending = state in ALIVE and installed is None
        days = (today - hoto).days
        nxt = None
        if pending:
            for s in stages:
                r = st[s["stage_id"]]
                if r.get("defined") and r.get("applies") and not r.get("reached"):
                    nxt = s["stage_name"].replace("HOTO to ", "")
                    break
        row = {
            "sseid": p.get("sseid"), "project_state": state, "project_status": p.get("project_status"),
            "region": rf(p), "city": (p.get("city") or "").strip() or "Unknown", "cluster": cf(p), "cell": p.get("cell_name") or "No cell", "mismatch": p.get("mismatch") or 0, "rm": p.get("rm"),
            **people(p), "lane": lane(p, rf(p)), "payment_lane": p.get("payment_lane") or "UNKNOWN",
            # D-110: permit work flagged at HOTO (LC / NC / PC), e.g. "LC+NC"; "None" when no permit change
            "permits": "+".join(k.upper() for k in ("lc", "nc", "pc") if p.get(k) == "Yes") or "None",
            "project_size_kw": p.get("project_size_kw"),
            "hoto_on": hoto, "installed_on": installed, "stages": st,
            "later_cancelled": state in LATER_CANCELLED, "pending_install": pending,
            "days_since_hoto": days if pending else None,
            "hoto_aging_bucket": bucket(days, HOTO_AGING) if pending else None,
            "next_pending_stage": nxt or ("No defined stage pending" if pending else None),
            "event_dates": {e: (to_ist_date(event_datetime(e, p, c, events, cache)) or None) for e in DISPLAY_EVENTS},
        }
        out.append(row)
    dq["region_filled_from_city_or_state"] = rf.filled
    return out, stages, dict(dq)


# ----------------------------------------------------------------------------- metrics
def funnel(rows: list[dict], stages: list[dict]) -> dict:
    res = {"hotos": len(rows), "stages": {}}
    for s in stages:
        sid = s["stage_id"]
        vals = [r["stages"][sid] for r in rows]
        if not vals or not vals[0].get("defined", False):
            res["stages"][sid] = {"stage": s["stage_name"], "defined": False}
            continue
        app = [v for v in vals if v.get("applies")]
        reached = [v for v in app if v.get("reached")]
        tats = [v["tat"] for v in reached if v.get("tat") is not None]
        summ = tat_summary(tats)
        res["stages"][sid] = {
            "stage": s["stage_name"], "defined": True, "applicable": len(app), "reached": len(reached),
            "reached_pct": round(100 * len(reached) / len(app), 1) if app else None,
            "tat_p50": summ["p50"], "tat_p75": summ["p75"], "tat_p90": summ["p90"],
            "pct_within_7d": summ["pct_within_7d"], "pct_within_15d": summ["pct_within_15d"],
        }
    return res


def both(rows: list[dict], stages: list[dict]) -> dict:
    """D-42: 'all' includes later-cancelled / on-hold projects; 'excl_cancelled' hides them (dashboard toggle)."""
    return {"all": funnel(rows, stages), "excl_cancelled": funnel([r for r in rows if not r["later_cancelled"]], stages)}


def cohort_metrics(rows: list[dict], stages: list[dict], today: date) -> dict:
    first = cohort_start(today)
    months = [month_key(add_months(first, i)) for i in range(13)]
    by_month = defaultdict(list)
    for r in rows:
        by_month[month_key(r["hoto_on"])].append(r)
    monthly = [{"hoto_month": m, **both(by_month.get(m, []), stages)} for m in months]
    wins = windows(today)
    fy_from = wins["YTD"][0]
    by_bucket = defaultdict(list)
    for r in rows:
        if r["hoto_on"] >= fy_from:
            by_bucket[ten_day_bucket(r["hoto_on"])].append(r)
    ten_day = [{"hoto_bucket": b, **both(v, stages)} for b, v in sorted(by_bucket.items())]
    by_window = {}
    for wname, (a, b) in wins.items():
        sel = [r for r in rows if a <= r["hoto_on"] <= b]
        entry = {"window": [a.isoformat(), b.isoformat()], "overall": both(sel, stages)}
        for dim in DIMENSIONS:
            groups = defaultdict(list)
            for r in sel:
                groups[r[dim]].append(r)
            entry[dim] = {k: both(v, stages) for k, v in sorted(groups.items(), key=lambda x: -len(x[1]))}
        by_window[wname] = entry
    return {"monthly": monthly, "ten_day_fy": ten_day, "by_window": by_window}


def pipeline_now(rows: list[dict], stages: list[dict]) -> tuple[dict, list[dict]]:
    pend = [r for r in rows if r["pending_install"]]
    labels = [b[2] for b in HOTO_AGING]
    def table(key: str) -> dict:
        t = defaultdict(lambda: {**{l: 0 for l in labels}, "total": 0})
        for r in pend:
            x = t[r[key]]; x[r["hoto_aging_bucket"]] += 1; x["total"] += 1
        return dict(sorted(t.items(), key=lambda kv: -kv[1]["total"]))
    not_reached = {}
    for s in stages:
        sid = s["stage_id"]
        vals = [r["stages"][sid] for r in pend]
        if vals and vals[0].get("defined"):
            not_reached[s["stage_name"]] = sum(1 for v in vals if v.get("applies") and not v.get("reached"))
    summary = {
        "total": len(pend), "by_state": dict(Counter(r["project_state"] for r in pend)),
        "aging_buckets": labels, "by_state_bucket": table("project_state"), "by_next_stage_bucket": table("next_pending_stage"),
        "by_region_bucket": table("region"), "by_cell_bucket": table("cell"), "not_reached_by_stage": not_reached,
    }
    listing = []
    for r in sorted(pend, key=lambda x: -(x["days_since_hoto"] or 0)):
        listing.append({
            **{k: r[k] for k in ("sseid", "project_state", "project_status", "region", "city", "cluster", "cell", "com", "soh", "zoh",
                                 "lane", "payment_lane", "project_size_kw", "days_since_hoto", "hoto_aging_bucket", "next_pending_stage")},
            **{e: (d.isoformat() if d else None) for e, d in r["event_dates"].items()},
        })
    return summary, listing


# ----------------------------------------------------------------------------- main
def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    ap = argparse.ArgumentParser(description="P1 HOTO -> Install funnel job")
    ap.add_argument("--reuse", action="store_true", help="recompute from the last raw extract")
    args = ap.parse_args(argv)
    today = today_ist()
    projects, comp, extracted_at = load_raw() if args.reuse else extract(today)
    rows, stages, dq = transform(projects, comp, today)
    cohorts = cohort_metrics(rows, stages, today)
    pipe, listing = pipeline_now(rows, stages)
    meta = {
        "section": "P1 HOTO -> Install funnel (HOTO cohort)", "as_of_date_ist": today.isoformat(), "extracted_at": extracted_at,
        "fy": fy_label(today), "cohort_from": cohort_start(today).isoformat(),
        "windows": {k: [a.isoformat(), b.isoformat()] for k, (a, b) in windows(today).items()},
        "stages": [{"id": s["stage_id"], "name": s["stage_name"], "start": s["start_event"], "end": s["end_event"],
                    "applies_to": s["applies_to"], "status": s["status"]} for s in stages],
        "rows": {"projects_in_scope": len(rows), "pending_install": pipe["total"]},
        "data_quality": dq,
        "rules": ["D-58", "D-40", "D-34", "D-42", "D-36", "D-50", "D-37", "D-38", "D-07", "D-06", "D-20", "D-47"],
    }
    write_json(MART / "meta.json", meta)
    write_json(MART / "cohorts.json", cohorts)
    write_json(MART / "pipeline_summary.json", pipe)
    write_json(MART / "pipeline_projects.json", listing)

    print(f"\nP1 as of {today}: {len(rows):,} projects in scope (HOTO since {history_start(today)} or alive)")
    for w in ("MTD", "L3M", "L6M", "YTD"):
        o = cohorts["by_window"][w]["overall"]["all"]
        print(f"\n  {w} cohort {cohorts['by_window'][w]['window']}: {o['hotos']:,} HOTOs")
        for sid, v in o["stages"].items():
            if not v["defined"]:
                print(f"    {sid} {v['stage']:34} definition pending")
            else:
                print(f"    {sid} {v['stage']:34} reached {v['reached']:>6,}/{v['applicable']:<6,} = {v['reached_pct']}%  "
                      f"P50 {v['tat_p50']}  P90 {v['tat_p90']}  <=15d {v['pct_within_15d']}%")
    print(f"\n  Pipeline (alive, not installed): {pipe['total']:,} {pipe['by_state']}")
    print("  Next pending stage:", {k: v['total'] for k, v in pipe['by_next_stage_bucket'].items()})
    print("  Data quality:", dq)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
