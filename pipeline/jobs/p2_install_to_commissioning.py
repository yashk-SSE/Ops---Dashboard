"""P2 Installation -> Commissioning: extract, transform, compute metrics, write marts.

Usage (from the repo root):
    python -m pipeline.jobs.p2_install_to_commissioning            # extract fresh data from Metabase
    python -m pipeline.jobs.p2_install_to_commissioning --reuse    # recompute from the last raw extract

Rules (see docs/decisions.md):
  D-34  installation = task 039B done (MAX timeCompleted); commissioning = project.commissioning_date; IST everywhere
  D-35  closed cases (commissioned in period): P50/P75/P90 TAT + % within 7/15 days; pending: aging buckets
  D-36  COM = cell roles (COM + SPO), all names comma-separated; cell is a global filter
  D-50  SOH / ZOH = project.soh / project.zoh
  D-37  region = business region (project.site_address_cluster_state; blank -> most common region of the city)
  D-95  lane = the Install Plan's six lanes (FL NBFC, FL Direct, LC only, Name change, Phase change, PSU)
  D-41  delay reason = dependency / sub_dependency on the open task
  D-42  pending = installed, not commissioned, state active / on-hold / seeking-cancellation (switcher)
  D-07  TAT in calendar days; D-06 fixed 10-day buckets; D-20 YTD = financial year

Writes data/marts/p2/*.json (git-ignored).
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import date, datetime

from pipeline.common.dims import ClusterFiller, canon_region, lane as plan_lane
from pipeline.common.dates import IST, add_months, fy_label, ist_date, month_key, parse_ts, ten_day_bucket, today_ist, windows
from pipeline.common.stats import tat_summary
from pipeline.config import REPO_ROOT, require
from pipeline.extract.metabase import MetabaseClient
from pipeline.probe_metabase import write_json
from pipeline.run_sql import strip_comments

DB_ID = 2
SQL_PROJECTS = REPO_ROOT / "sql/extract/p2_installed_projects.sql"
SQL_TASKS = REPO_ROOT / "sql/extract/p2_pending_open_tasks.sql"
RAW = REPO_ROOT / "data/raw/extract"
MART = REPO_ROOT / "data/marts/p2"
SEED_TASKS = REPO_ROOT / "config/seed/task_milestones.csv"
SEED_SUBSTAGES = REPO_ROOT / "config/seed/p2_commissioning_substages.csv"
SEED_OVERRIDES = REPO_ROOT / "config/seed/p2_task_substage_overrides.csv"  # Pan India's own task -> sub-stage map
# D-48: CT's manual Sub-Reasons from Pan India Commissioning > CT Working ("sseid|reason" per line).
# INTERIM: pulled through the signed-in browser. Replace with a Sheets reader (service account) in the pipeline.
# Interim copy of the Pan India sheet's CT reasons (SSE ID | reason, D-48), kept in config/seed so the daily GitHub run has it
# (D-114); the old local path is the fallback.
CT_REASONS = REPO_ROOT / "config/seed/ct_reasons_interim.txt"
if not CT_REASONS.exists():
    CT_REASONS = REPO_ROOT / "data/raw/sheets/pan_india_ct_working_reasons.txt"

PENDING_STATES = ("active", "on-hold", "seeking-cancellation")
AGING_BUCKETS = [(0, 3, "0-3 days"), (4, 10, "4-10 days"), (11, 20, "11-20 days"), (21, 30, "21-30 days"), (31, None, ">30 days")]
DIMENSIONS = ["region", "city", "cell", "lane", "payment_lane", "com", "soh", "zoh"]
CHUNK = 400
OBJECT_ID = re.compile(r"^[0-9a-f]{24}$")
N = lambda s: re.sub(r"\s+", " ", (s or "").lower().replace("&", "and")).strip()


# ----------------------------------------------------------------------------- extract
def extract() -> tuple[list[dict], list[dict], str]:
    client = MetabaseClient(require("METABASE_URL"), require("METABASE_API_KEY"), timeout=600)
    t0 = time.time()
    projects = client.export_sql(DB_ID, strip_comments(SQL_PROJECTS.read_text(encoding="utf-8")))
    print(f"extract projects: {len(projects):,} rows in {time.time() - t0:.1f}s")
    ids = [p["project_id"] for p in projects
           if not p.get("commissioned_at") and p.get("project_state") in PENDING_STATES]
    safe = [i for i in ids if i and OBJECT_ID.match(i)]
    if len(safe) != len(ids):
        print(f"WARNING: {len(ids) - len(safe)} pending project ids are not 24-hex ObjectIds and were skipped")
    template = strip_comments(SQL_TASKS.read_text(encoding="utf-8"))
    tasks: list[dict] = []
    t0 = time.time()
    for i in range(0, len(safe), CHUNK):
        in_list = ",".join(f"'{x}'" for x in safe[i:i + CHUNK])
        tasks += client.export_sql(DB_ID, template.replace("{project_ids}", in_list))
    print(f"extract open tasks: {len(tasks):,} rows for {len(safe):,} pending projects in {time.time() - t0:.1f}s")
    extracted_at = datetime.now(IST).isoformat(timespec="seconds")
    write_json(RAW / "p2_installed_projects.json", {"extracted_at": extracted_at, "row_count": len(projects), "rows": projects})
    write_json(RAW / "p2_pending_open_tasks.json", {"extracted_at": extracted_at, "row_count": len(tasks), "rows": tasks})
    return projects, tasks, extracted_at


def load_raw() -> tuple[list[dict], list[dict], str]:
    p = json.load(open(RAW / "p2_installed_projects.json", encoding="utf-8"))
    t = json.load(open(RAW / "p2_pending_open_tasks.json", encoding="utf-8"))
    return p["rows"], t["rows"], p.get("extracted_at", "")


# ----------------------------------------------------------------------------- transform
def names(*parts: str | None) -> str | None:
    """De-duplicated, comma-separated people names in Title Case (D-36, D-55)."""
    seen = []
    for part in parts:
        for n in (part or "").split(","):
            n = " ".join(w[:1].upper() + w[1:].lower() for w in n.split())
            if n and n not in seen:
                seen.append(n)
    return ", ".join(seen) or None


def aging_bucket(days: int) -> str:
    for lo, hi, label in AGING_BUCKETS:
        if days >= lo and (hi is None or days <= hi):
            return label
    return AGING_BUCKETS[0][2]


def transform(rows: list[dict], today: date) -> tuple[list[dict], dict]:
    city_regions = defaultdict(Counter)
    for r in rows:
        if r.get("region") and r.get("city"):
            city_regions[N(r["city"])][r["region"]] += 1
    city_region = {c: cnt.most_common(1)[0][0] for c, cnt in city_regions.items()}
    cf = ClusterFiller(rows)  # D-86
    dq = Counter()
    out = []
    for r in rows:
        inst, comm = ist_date(r.get("installed_at")), ist_date(r.get("commissioned_at"))
        region = r.get("region")
        if not region:
            region = city_region.get(N(r.get("city"))) or r.get("legal_state") or "Unknown"
            dq["region_filled_from_city_or_state"] += 1
        region = canon_region(region)  # one spelling per region
        lane = plan_lane(r, region)  # D-95
        tat = (comm - inst).days if inst and comm else None
        if tat is not None and tat < 0:
            dq["negative_tat_excluded"] += 1
        if not r.get("cell_name"):
            dq["no_cell"] += 1
        state = r.get("project_state")
        pending = comm is None and state in PENDING_STATES
        aging = (today - inst).days if pending and inst else None
        out.append({
            "sseid": r.get("sseid"), "project_id": r.get("project_id"), "project_state": state,
            "project_status": r.get("project_status"), "region": region, "city": (r.get("city") or "").strip() or "Unknown", "cluster": cf(r),
            "cell": r.get("cell_name") or "No cell", "com": names(r.get("com"), r.get("spo")) or "Not mapped",
            "soh": names(r.get("soh")) or "Not mapped", "zoh": names(r.get("zoh")) or "Not mapped",
            "lane": lane, "payment_lane": r.get("payment_lane") or "UNKNOWN",
            "project_size_kw": r.get("project_size_kw"), "subsidy_type": r.get("subsidy_type"),
            "installed_on": inst, "commissioned_on": comm, "hoto_on": ist_date(r.get("hoto_at")),
            "tat_days": tat if tat is None or tat >= 0 else None,
            "pending": pending, "aging_days": aging, "aging_bucket": aging_bucket(aging) if aging is not None else None,
            "later_cancelled_or_hold": state in ("cancelled", "on-hold", "seeking-cancellation"),
        })
    return out, dict(dq)


def load_task_map() -> tuple[dict, dict, dict]:
    by_pair, by_name = {}, {}
    for row in csv.DictReader(open(SEED_TASKS, encoding="utf-8")):
        if row["milestone"]:
            by_pair[(row["key"], N(row["task_name"]))] = row["milestone"]
            by_name.setdefault(N(row["task_name"]), row["milestone"])
    substage, order = {}, {}
    for row in csv.DictReader(open(SEED_SUBSTAGES, encoding="utf-8")):
        substage[row["milestone"]] = (row["p2_substage"], int(row["substage_order"]), row["in_commissioning_chain"] == "Y")
        order.setdefault(row["p2_substage"], int(row["substage_order"]))
    overrides = {}
    for row in csv.DictReader(open(SEED_OVERRIDES, encoding="utf-8")):
        lab = row["p2_substage"]
        overrides.setdefault(N(row["task_name"]), (lab, order.get(lab, 99), True) if lab else ("Not in chain", 99, False))
    return by_pair, by_name, substage, overrides


def current_steps(tasks: list[dict]) -> tuple[dict, Counter]:
    """Per pending project: the latest-created open task in the commissioning chain (and the oldest, for checks).

    Sub-stage lookup order: (1) Pan India's own task -> sub-stage map, so numbers match the sheet the team uses;
    (2) Sheet3 milestone -> sub-stage rollup (config/seed/p2_commissioning_substages.csv).
    Checked 2026-11-07: the latest-created rule matches the sheet's current task for 86% of projects (oldest rule: 74%).
    """
    by_pair, by_name, substage, overrides = load_task_map()
    per_project = defaultdict(list)
    unmapped = Counter()
    for t in tasks:
        ms = by_pair.get((t.get("key"), N(t.get("task_name")))) or by_name.get(N(t.get("task_name")))
        sub = overrides.get(N(t.get("task_name"))) or (substage.get(ms) if ms else None)
        if not ms and not sub:
            unmapped[t.get("task_name")] += 1
        per_project[t.get("project_id")].append({**t, "milestone": ms, "substage": sub, "created": parse_ts(t.get("task_created_at"))})
    steps = {}
    for pid, items in per_project.items():
        chain = [x for x in items if x["substage"] and x["substage"][2] and x["created"]]
        latest = max(chain, key=lambda x: x["created"]) if chain else None
        oldest = min(chain, key=lambda x: x["created"]) if chain else None
        other = sorted({x["substage"][0] for x in items if x["substage"] and not x["substage"][2]})
        steps[pid] = {
            "current_substage": latest["substage"][0] if latest else "No open commissioning task",
            "current_task": latest.get("task_name") if latest else None,
            "current_task_key": latest.get("key") if latest else None,
            "current_task_since": ist_date(latest.get("task_created_at")).isoformat() if latest else None,
            "dependency": (latest or {}).get("dependency") or None,
            "sub_dependency": (latest or {}).get("sub_dependency") or None,
            "oldest_chain_task": oldest.get("task_name") if oldest else None,
            "other_open_areas": ", ".join(other) or None,
            "open_task_count": len(items),
        }
    return steps, unmapped


# ----------------------------------------------------------------------------- metrics
def in_window(d: date | None, win: tuple[date, date]) -> bool:
    return d is not None and win[0] <= d <= win[1]


def closed_metrics(projects: list[dict], today: date) -> dict:
    closed = [p for p in projects if p["commissioned_on"] and p["tat_days"] is not None]
    wins = windows(today)
    by_window = {}
    for wname, win in wins.items():
        rows = [p for p in closed if in_window(p["commissioned_on"], win)]
        entry = {"window": [win[0].isoformat(), win[1].isoformat()], "overall": tat_summary([p["tat_days"] for p in rows])}
        for dim in DIMENSIONS:
            groups = defaultdict(list)
            for p in rows:
                groups[p[dim]].append(p["tat_days"])
            entry[dim] = {k: tat_summary(v) for k, v in sorted(groups.items(), key=lambda x: -len(x[1]))}
        by_window[wname] = entry
    first = add_months(date(today.year, today.month, 1), -12)
    months = [month_key(add_months(first, i)) for i in range(13)]
    monthly = []
    for m in months:
        rows = [p for p in closed if month_key(p["commissioned_on"]) == m]
        installed = sum(1 for p in projects if p["installed_on"] and month_key(p["installed_on"]) == m)
        monthly.append({"month": m, "installed": installed, "commissioned": len(rows), **tat_summary([p["tat_days"] for p in rows])})
    fy_from = wins["YTD"][0]
    buckets = defaultdict(list)
    for p in closed:
        if p["commissioned_on"] >= fy_from:
            buckets[ten_day_bucket(p["commissioned_on"])].append(p["tat_days"])
    ten_day = [{"bucket": b, **tat_summary(v)} for b, v in sorted(buckets.items())]
    month_start = wins["MTD"][0]
    daily = []
    d = month_start
    while d <= today:
        daily.append({"date": d.isoformat(),
                      "installed": sum(1 for p in projects if p["installed_on"] == d),
                      "commissioned": sum(1 for p in closed if p["commissioned_on"] == d)})
        d = date.fromordinal(d.toordinal() + 1)
    return {"by_window": by_window, "monthly": monthly, "ten_day_fy": ten_day, "daily_mtd": daily}


def load_ct_reasons() -> dict:
    if not CT_REASONS.exists():
        return {}
    out = {}
    for line in CT_REASONS.read_text(encoding="utf-8").splitlines():
        parts = line.split("|")
        if len(parts) >= 2 and parts[1].strip():
            out[parts[0].strip()] = parts[1].strip()
    return out


def pending_metrics(projects: list[dict], steps: dict) -> tuple[dict, list[dict]]:
    pend = [p for p in projects if p["pending"]]
    ct = load_ct_reasons()
    for p in pend:
        p["ct_sub_reason"] = ct.get(p["sseid"])
    labels = [b[2] for b in AGING_BUCKETS]
    def bucket_table(key: str) -> dict:
        t = defaultdict(lambda: {**{l: 0 for l in labels}, "total": 0})
        for p in pend:
            row = t[p[key]]; row[p["aging_bucket"]] += 1; row["total"] += 1
        return dict(sorted(t.items(), key=lambda x: -x[1]["total"]))
    listing = []
    for p in sorted(pend, key=lambda x: -(x["aging_days"] or 0)):
        s = steps.get(p["project_id"], {"current_substage": "No open task", "open_task_count": 0})
        p.update({k: s.get(k) for k in ("current_substage", "current_task", "current_task_key", "current_task_since",
                                       "dependency", "sub_dependency", "oldest_chain_task", "other_open_areas", "open_task_count")})
        listing.append({k: (v.isoformat() if isinstance(v, date) else v) for k, v in p.items()
                        if k not in ("project_id", "commissioned_on", "tat_days", "pending", "later_cancelled_or_hold")})
    summary = {
        "total": len(pend),
        "by_state": dict(Counter(p["project_state"] for p in pend)),
        "by_state_bucket": bucket_table("project_state"),
        "by_region_bucket": bucket_table("region"),
        "by_cell_bucket": bucket_table("cell"),
        "by_substage_bucket": bucket_table("current_substage"),
        "by_dependency": dict(Counter((p.get("dependency") or "None tagged") for p in pend).most_common()),
        "by_ct_sub_reason": dict(Counter((p.get("ct_sub_reason") or "No CT reason") for p in pend).most_common()),
        "ct_reasons_source": "Pan India Commissioning > CT Working (interim browser pull)" if ct else "not loaded",
        "aging_buckets": labels,
    }
    return summary, listing


# ----------------------------------------------------------------------------- main
def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    ap = argparse.ArgumentParser(description="P2 Installation -> Commissioning job")
    ap.add_argument("--reuse", action="store_true", help="recompute from the last raw extract")
    args = ap.parse_args(argv)

    rows, tasks, extracted_at = load_raw() if args.reuse else extract()
    today = today_ist()
    projects, dq = transform(rows, today)
    steps, unmapped = current_steps(tasks)
    closed = closed_metrics(projects, today)
    pending, listing = pending_metrics(projects, steps)

    meta = {
        "section": "P2 Installation -> Commissioning", "as_of_date_ist": today.isoformat(), "extracted_at": extracted_at,
        "fy": fy_label(today), "windows": {k: [a.isoformat(), b.isoformat()] for k, (a, b) in windows(today).items()},
        "rows": {"installed_projects": len(projects), "commissioned_with_tat": sum(1 for p in projects if p["tat_days"] is not None),
                 "pending": pending["total"], "open_tasks": len(tasks)},
        "data_quality": {**dq, "open_tasks_without_milestone": sum(unmapped.values()),
                         "top_unmapped_open_tasks": dict(unmapped.most_common(10))},
        "rules": ["D-34", "D-35", "D-36", "D-37", "D-38", "D-41", "D-42", "D-47", "D-48", "D-50", "D-07", "D-06", "D-20"],
    }
    write_json(MART / "meta.json", meta)
    write_json(MART / "closed.json", closed)
    write_json(MART / "pending_summary.json", pending)
    write_json(MART / "pending_projects.json", listing)

    o = closed["by_window"]
    print(f"\nP2 as of {today} ({meta['fy']})")
    for w in ("MTD", "L3M", "L6M", "YTD"):
        s = o[w]["overall"]
        print(f"  {w:4} {o[w]['window'][0]}..{o[w]['window'][1]}  commissioned={s['count']:>6,}  P50={s['p50']}  P75={s['p75']}  P90={s['p90']}  <=7d={s['pct_within_7d']}%  <=15d={s['pct_within_15d']}%")
    print(f"  Pending: {pending['total']:,}  {pending['by_state']}")
    print(f"  Aging:   " + ", ".join(f"{k}={v}" for k, v in pending["by_state_bucket"].get("active", {}).items()))
    print(f"  Data quality: {meta['data_quality']}")
    print(f"  Marts written to {MART.relative_to(REPO_ROOT).as_posix()}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
