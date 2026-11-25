"""Publish compact, PII-free fact files for the web dashboard (web/data/*.json).

The browser aggregates these facts itself, so every filter combination (region x cell x lane x people)
works without pre-computing each one. Metric *definitions* (events, stage dates, TAT, pending rules)
stay in Python (pipeline/jobs/*); the browser only counts, filters and takes percentiles.

Encoding (keeps files small):
  - dates  -> integer day numbers since 2020-01-01 (IST dates)
  - labels -> index into a per-file dictionary  ("dims": {"region": [...], ...})
  - rows   -> arrays; column order listed in "cols"

Usage (from the repo root, after the jobs have run):
    python -m pipeline.publish.web_data
Reads the raw extracts (no Metabase calls). Writes web/data/meta.json, p1.json, p2.json, ... nbfc.json, psu.json (git-ignored).
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from datetime import date, datetime

from pipeline.common.dates import IST, add_months, fy_label, history_start, previous_windows, today_ist, windows
from pipeline.common.dims import PLAN_LANES
from pipeline.common.privacy import safe_id, scan_for_contacts
from pipeline.config import REPO_ROOT
from pipeline.jobs import p1_hoto_to_install as p1
from pipeline.jobs import p2_install_to_commissioning as p2
from pipeline.jobs import escalations, loans, qhse, subsidy

OUT = REPO_ROOT / "web" / "data"
EPOCH = date(2020, 1, 1)


def day(d: date | None) -> int | None:
    return (d - EPOCH).days if d else None


class Dict:
    """Label -> index dictionaries per dimension."""

    def __init__(self):
        self.values: dict[str, list[str]] = {}
        self.index: dict[str, dict[str, int]] = {}

    def __call__(self, dim: str, value) -> int:
        v = value if value not in (None, "") else "—"
        idx = self.index.setdefault(dim, {})
        if v not in idx:
            idx[v] = len(idx)
            self.values.setdefault(dim, []).append(v)
        return idx[v]


def write(name: str, obj) -> int:
    hits = scan_for_contacts(obj)  # D-92: the site is public, so no email / phone may ever be published
    if hits:
        raise SystemExit(f"{name}: {len(hits)} email / phone values found (e.g. {hits[:3]}); not published. "
                         "Clean the field before publishing (pipeline/common/privacy.py).")
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return path.stat().st_size


def read_mop() -> dict:
    """HOTO plan (MOP) per month and cluster (D-72), from config/seed/hoto_mop.csv until the Config sheet reader exists."""
    import csv
    path = REPO_ROOT / "config" / "seed" / "hoto_mop.csv"
    out: dict = {}
    if path.exists():
        for r in csv.DictReader(path.open(encoding="utf-8")):
            out.setdefault(r["month"], {})[r["cluster"]] = int(r["mop_hotos"])
    return out


def publish_plan() -> dict:
    """D-95 / D-98: the monthly Install Plan (base = target, aggressive = stretch), its daily cumulative curve, the HOTO plan (MOP)
    and the plan's lane mix / conversion rates, from config/seed/ until the Config sheet reader exists."""
    import csv
    seed = REPO_ROOT / "config" / "seed"
    num = lambda v: (float(v) if "." in v else int(v)) if v not in ("", None) else None
    months: dict = {}
    for r in csv.DictReader((seed / "install_plan.csv").open(encoding="utf-8")):
        months.setdefault(r["month"], {"clusters": {}})["clusters"][r["cluster"]] = {
            "group": r["group"], **{k: num(r[k]) for k in r if k not in ("month", "cluster", "group")}, "lanes": {}}
    for line in (seed / "install_plan_daily.csv").open(encoding="utf-8"):
        if line.startswith("#") or line.startswith("month,"):
            continue
        parts = line.strip().split(",")
        c = months.get(parts[0], {}).get("clusters", {}).get(parts[1])
        if c is not None:
            c[parts[2]] = [num(v) for v in parts[3:]]
    for r in csv.DictReader((seed / "plan_lane_mix.csv").open(encoding="utf-8")):
        c = months.get(r["month"], {}).get("clusters", {}).get(r["cluster"])
        if c is not None:
            c["lanes"][r["lane"]] = {k: num(r[k]) for k in r if k not in ("month", "cluster", "lane")}
    size = write("plan.json", {"section": "plan", "source": "Install Plan sheet (Nov26_Install_Plan_v3) via config/seed", "lanes": PLAN_LANES,
                               "target": "base", "months": months})
    return {"months": list(months), "bytes": size}


def publish_p2(today: date, since: date) -> dict:
    rows, tasks, extracted_at = p2.load_raw()
    projects, dq = p2.transform(rows, today)
    steps, _ = p2.current_steps(tasks)
    _, listing = p2.pending_metrics(projects, steps)
    D = Dict()
    cols = ["region", "cluster", "cell", "lane", "payment_lane", "com", "soh", "zoh", "installed_day", "commissioned_day", "tat_days", "hoto_day", "sseid"]
    facts = []
    for p in projects:
        inst, comm = p["installed_on"], p["commissioned_on"]
        if not ((inst and inst >= since) or (comm and comm >= since)):
            continue
        facts.append([D("region", p["region"]), D("cluster", p["cluster"]), D("cell", p["cell"]), D("lane", p["lane"]),
                      D("payment_lane", p["payment_lane"]), D("com", p["com"]), D("soh", p["soh"]), D("zoh", p["zoh"]),
                      day(inst), day(comm), p["tat_days"], day(p.get("hoto_on")), safe_id(p.get("sseid"))])
    pcols = ["sseid", "state", "region", "cluster", "cell", "lane", "payment_lane", "com", "soh", "zoh", "installed_day",
             "aging_days", "substage", "current_task", "task_since_day", "dependency", "sub_dependency", "ct_reason", "kw"]
    pending = []
    for r in listing:
        pending.append([safe_id(r["sseid"]), D("state", r["project_state"]), D("region", r["region"]), D("cluster", r["cluster"]),
                        D("cell", r["cell"]), D("lane", r["lane"]), D("payment_lane", r["payment_lane"]), D("com", r["com"]),
                        D("soh", r["soh"]), D("zoh", r["zoh"]), day(date.fromisoformat(r["installed_on"])) if r.get("installed_on") else None,
                        r["aging_days"], D("substage", r["current_substage"]), r.get("current_task"),
                        day(date.fromisoformat(r["current_task_since"])) if r.get("current_task_since") else None,
                        D("dependency", r.get("dependency") or "None tagged"), r.get("sub_dependency"),
                        D("ct_reason", r.get("ct_sub_reason") or "No CT reason"), r.get("project_size_kw")])
    size = write("p2.json", {"section": "p2", "extracted_at": extracted_at, "dims": D.values,
                             "cols": cols, "facts": facts, "pending_cols": pcols, "pending": pending,
                             "aging_buckets": [[lo, hi, label] for lo, hi, label in p2.AGING_BUCKETS],
                             "data_quality": dq})
    return {"rows": len(facts), "pending": len(pending), "bytes": size, "extracted_at": extracted_at}


def publish_p1(today: date, since: date) -> dict:
    projects, comp, extracted_at = p1.load_raw()
    rows, stages, dq = p1.transform(projects, comp, today)
    D = Dict()
    stage_ids = [s["stage_id"] for s in stages]
    cols = ["region", "cluster", "cell", "lane", "payment_lane", "com", "soh", "zoh", "state", "later_cancelled", "hoto_day", "mismatch", "rm"] + stage_ids + ["sseid", "cx_design_day", "sanction_day", "permits"]
    facts, pending = [], []
    ev_keys = p1.DISPLAY_EVENTS
    pcols = ["sseid", "state", "status", "region", "cluster", "cell", "lane", "payment_lane", "com", "soh", "zoh",
             "hoto_day", "days_since_hoto", "next_stage", "kw"] + ev_keys
    for r in rows:
        enc = []
        for sid in stage_ids:
            s = r["stages"][sid]
            if not s.get("defined") or not s.get("applies"):
                enc.append(None)          # not defined / not applicable
            elif not s.get("reached"):
                enc.append(-1)            # applicable, not reached yet
            else:
                enc.append(s["tat"] if s.get("tat") is not None else -2)  # reached; -2 = reached but bad date
        base = [D("region", r["region"]), D("cluster", r["cluster"]), D("cell", r["cell"]), D("lane", r["lane"]),
                D("payment_lane", r["payment_lane"]), D("com", r["com"]), D("soh", r["soh"]), D("zoh", r["zoh"]),
                D("state", r["project_state"])]
        if r["hoto_on"] >= since:
            facts.append(base + [1 if r["later_cancelled"] else 0, day(r["hoto_on"]), r.get("mismatch") or 0, r.get("rm")] + enc + [safe_id(r["sseid"]),
                          day(r["event_dates"].get("E_CX_DESIGN")), day(r["event_dates"].get("E_SANCTION")),  # D-100 TAT stages
                          D("permits", r.get("permits") or "None")])  # D-110 permits split
        if r["pending_install"]:
            pending.append([safe_id(r["sseid"]), D("state", r["project_state"]), D("status", r["project_status"]), *base[:8],
                            day(r["hoto_on"]), r["days_since_hoto"], D("next_stage", r["next_pending_stage"]), r["project_size_kw"]]
                           + [day(r["event_dates"][e]) for e in ev_keys])
    stage_meta = [{"id": s["stage_id"], "name": s["stage_name"].replace("HOTO to ", ""), "start": s["start_event"],
                   "end": s["end_event"], "applies_to": s["applies_to"], "status": s["status"], "decision": s["decision"],
                   "notes": s["notes"]} for s in stages]
    size = write("p1.json", {"section": "p1", "extracted_at": extracted_at, "dims": D.values, "stages": stage_meta,
                             "cols": cols, "facts": facts, "pending_cols": pcols, "pending": pending,
                             "aging_buckets": [[lo, hi, label] for lo, hi, label in p1.HOTO_AGING],
                             "event_labels": {e: e.replace("E_", "").replace("_", " ").title() for e in ev_keys},
                             "mismatch_flags": [f.replace("_", " ").capitalize() for f in p1.MISMATCH_FLAGS], "mop": read_mop(),
                             "rm_sections": [label for _, label in p1.RM_SECTIONS],
                             "data_quality": dq})
    return {"rows": len(facts), "pending": len(pending), "bytes": size, "extracted_at": extracted_at}


def publish_qhse(today: date, since: date) -> dict:
    """QHSE facts (D-71): one row per site in scope + one row per punch point. No customer fields."""
    projects, pps, extra, comps, extracted_at = qhse.load_raw()
    sites, dq = qhse.transform(projects, pps, extra, comps, today)
    D = Dict()
    cols = ["sseid", "region", "cluster", "cell", "lane", "payment_lane", "com", "soh", "zoh", "ic", "vendor", "inspection", "state",
            "install_day", "audit_day", "rect_day", "revisit_day", "closure_tat", "n_pp", "n_open", "zt", "zh",
            "open_mech", "open_nonmech", "open_lm", "n_pp_all", "zt_all", "zh_all"]
    pp_cols = ["site", "code", "severity", "status", "flag", "component", "issue", "source"]
    facts, pp_rows = [], []
    for s in sites:
        i = len(facts)
        facts.append([safe_id(s["sseid"]), D("region", s["region"]), D("cluster", s["cluster"]), D("cell", s["cell"]), D("lane", s["lane"]),
                      D("payment_lane", s["payment_lane"]), D("com", s["com"]), D("soh", s["soh"]), D("zoh", s["zoh"]),
                      D("ic", s["ic"]), D("vendor", s["vendor"]), D("inspection", s["inspection"]), D("state", s["state"]),
                      day(s["installed_on"]), day(s["audited_on"]), day(s["rectified_on"]), day(s["revisited_on"]), s["closure_tat"],
                      s["n_pp"], s["n_open"], 1 if s["has_zt"] else 0, 1 if s["has_zh"] else 0,
                      s["open_mech"], s["open_nonmech"], s["open_lm"],
                      s["n_pp_all"], 1 if s["has_zt_all"] else 0, 1 if s["has_zh_all"] else 0])
        for pp in s["pps"]:
            pp_rows.append([i, D("code", pp["code"]), D("severity", pp["severity"]), D("status", pp["status"]), D("flag", pp["flag"]),
                            D("component", pp["component"]), D("issue", pp["issue"]), D("source", pp["source"])])
    size = write("qhse.json", {"section": "qhse", "extracted_at": extracted_at, "dims": D.values, "cols": cols, "facts": facts,
                               "pp_cols": pp_cols, "pps": pp_rows,
                               "aging_buckets": [[lo, hi, label] for lo, hi, label in qhse.OPEN_AGING], "data_quality": dq})
    return {"rows": len(facts), "pps": len(pp_rows), "bytes": size, "extracted_at": extracted_at}


def publish_escalations(today: date, since: date) -> dict:
    """Escalation tickets (D-75): one row per ticket. Ticket id + SSE ID + categories; no subject or customer fields."""
    projects, tickets, extracted_at = escalations.load_raw()
    rows, dq = escalations.transform(projects, tickets, today)
    D = Dict()
    cols = ["ticket_id", "sseid", "region", "cluster", "cell", "lane", "payment_lane", "com", "soh", "zoh", "level", "true_esc", "group",
            "source", "issue_type", "issue_detail", "status", "created_day", "closed_day", "closure_tat", "is_open"]
    facts = [[r["ticket_id"], safe_id(r["sseid"]), D("region", r["region"]), D("cluster", r["cluster"]), D("cell", r["cell"]), D("lane", r["lane"]),
              D("payment_lane", r["payment_lane"]), D("com", r["com"]), D("soh", r["soh"]), D("zoh", r["zoh"]), D("level", r["level"]),
              1 if r["true_escalation"] else 0, D("group", r["group"]), D("source", r["source"]), D("issue_type", r["issue_type"]),
              D("issue_detail", r["issue_detail"]), D("status", r["status"]), day(r["created_on"]), day(r["closed_on"]), r["closure_tat"],
              1 if r["is_open"] else 0] for r in rows]
    size = write("escalations.json", {"section": "escalations", "extracted_at": extracted_at, "dims": D.values, "cols": cols, "facts": facts,
                                      "levels": escalations.LEVELS, "aging_buckets": [[lo, hi, label] for lo, hi, label in escalations.AGING],
                                      "data_quality": dq})
    return {"rows": len(facts), "bytes": size, "extracted_at": extracted_at}


def publish_subsidy(today: date, since: date) -> dict:
    """Subsidy (D-87): one row per National DBT project in scope. SSE ID + stage + dates; no customer fields."""
    projects, subs, hist, extracted_at = subsidy.load_raw()
    rows, dq = subsidy.transform(projects, subs, hist, today)
    D = Dict()
    cols = ["sseid", "region", "cluster", "cell", "lane", "payment_lane", "com", "soh", "zoh", "stage", "state",
            "comm_day", "stage_day", "disbursed_day", "comm_to_disbursed", "in_backlog", "old_no_status"]
    facts = [[safe_id(r["sseid"]), D("region", r["region"]), D("cluster", r["cluster"]), D("cell", r["cell"]), D("lane", r["lane"]),
              D("payment_lane", r["payment_lane"]), D("com", r["com"]), D("soh", r["soh"]), D("zoh", r["zoh"]), D("stage", r["stage"]),
              D("state", r["state"]), day(r["commissioned_on"]), day(r["stage_since"]), day(r["disbursed_on"]), r["comm_to_disbursed"],
              1 if r["in_backlog"] else 0, 1 if r["old_no_status"] else 0] for r in rows]
    size = write("subsidy.json", {"section": "subsidy", "extracted_at": extracted_at, "dims": D.values, "cols": cols, "facts": facts,
                                  "stages": subsidy.STAGES, "aging_buckets": [[lo, hi, label] for lo, hi, label in subsidy.AGING],
                                  "history_reliable_from": "2026-10-01", "vsp_from": subsidy.VSP_FROM.isoformat(), "old_no_status_label": subsidy.OLD_NO_STATUS, "data_quality": dq})
    return {"rows": len(facts), "bytes": size, "extracted_at": extracted_at}


def publish_loans(today: date, since: date) -> tuple[dict, dict]:
    """NBFC and PSU cases (D-122): one row per NBFC / PSU project in scope, in two files. SSE ID, lender, steps and dates only:
    no customer, bank or loan-amount fields."""
    projects, comps, journey, extracted_at = loans.load_raw()
    rows, dq = loans.transform(projects, comps, journey, today)
    base_cols = ["sseid", "region", "cluster", "cell", "lane", "payment_lane", "com", "soh", "zoh", "state", "later_cancelled", "lender", "step"]
    base = lambda D, r: [safe_id(r["sseid"]), D("region", r["region"]), D("cluster", r["cluster"]), D("cell", r["cell"]), D("lane", r["lane"]),
                         D("payment_lane", r["payment_lane"]), D("com", r["com"]), D("soh", r["soh"]), D("zoh", r["zoh"]), D("state", r["state"]),
                         1 if r["state"] in ("cancelled", "on-hold", "seeking-cancellation") else 0, D("lender", r["lender"]), D("step", r["step"])]
    # NBFC
    D = Dict()
    ncols = base_cols + ["tag", "tag2", "rfd_src", "hoto_day", "rfd_day", "installed_day", "approved_day", "enach_day", "predisb_day",
                         "disbursed_day", "pap_day", "step_day"]
    nf = [base(D, r) + [D("tag", r["tag"] or "No tag"), D("tag2", r["tag2"] or "—"), D("rfd_src", r["rfd_src"] or "—"),
                        day(r["hoto_on"]), day(r["rfd_on"]), day(r["installed_on"]), day(r["approved_on"]), day(r["enach_on"]),
                        day(r["predisb_on"]), day(r["disbursed_on"]), day(r["pap_on"]), day(r["step_since"])]
          for r in rows if r["payment_lane"] == "NBFC"]
    n_size = write("nbfc.json", {"section": "nbfc", "extracted_at": extracted_at, "dims": D.values, "cols": ncols, "facts": nf,
                                 "steps": loans.NBFC_STEPS, "portal_from": "2026-06-01",
                                 "data_quality": {k: v for k, v in dq.items() if k.startswith("NBFC") or k == "no_hoto_date"}})
    # PSU
    D = Dict()
    pcols = base_cols + ["hoto_day", "rfd_day", "d70_day", "d30_day", "installed_day", "step_day"] + [f"e{i}" for i in range(len(loans.PSU_STEPS))]
    pf = [base(D, r) + [day(r["hoto_on"]), day(r["rfd_on"]), day(r["d70_on"]), day(r["d30_on"]), day(r["installed_on"]), day(r["step_since"])]
          + [day(d) for d in r["entries"]] for r in rows if r["payment_lane"] == "PSU"]
    p_size = write("psu.json", {"section": "psu", "extracted_at": extracted_at, "dims": D.values, "cols": pcols, "facts": pf,
                                "steps": [label for _, label in loans.PSU_STEPS], "extra_steps": loans.PSU_EXTRA, "portal_from": "2026-06-01",
                                "data_quality": {k: v for k, v in dq.items() if k.startswith("PSU") or k == "no_hoto_date"}})
    return ({"rows": len(nf), "bytes": n_size, "extracted_at": extracted_at}, {"rows": len(pf), "bytes": p_size, "extracted_at": extracted_at})


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    today = today_ist()
    since = history_start(today)  # last FY start: needed for YTD vs last year (D-63)
    trend_from = add_months(date(today.year, today.month, 1), -12)
    info_p2 = publish_p2(today, since)
    info_p1 = publish_p1(today, since)
    info_qhse = publish_qhse(today, since)
    info_esc = publish_escalations(today, since)
    info_sub = publish_subsidy(today, since)
    info_nbfc, info_psu = publish_loans(today, since)
    info_plan = publish_plan()
    # The dashboard's "as of" day = the oldest extract among the sections, so month-to-date is never compared with
    # more days of last month than the data actually covers (e.g. one section refreshed today, another yesterday).
    extracted = [datetime.fromisoformat(i["extracted_at"]).astimezone(IST).date() for i in (info_p1, info_p2, info_qhse, info_esc, info_sub, info_nbfc) if i.get("extracted_at")]
    data_day = min(extracted + [today])
    wins = {k: [day(a), day(b)] for k, (a, b) in windows(today).items()}
    meta = {
        "generated_at": datetime.now(IST).isoformat(timespec="seconds"), "as_of_day": day(data_day), "as_of": data_day.isoformat(),
        "epoch": EPOCH.isoformat(), "fy": fy_label(today), "since_day": day(since), "trend_from_day": day(trend_from), "windows": wins,
        "windows_prev": {k: [day(a), day(b)] for k, (a, b) in previous_windows(today).items()},
        "sections": {"p1": info_p1, "p2": info_p2, "qhse": info_qhse, "escalations": info_esc, "subsidy": info_sub, "nbfc": info_nbfc, "psu": info_psu}, "plan": info_plan,
        "lanes": PLAN_LANES,
        "rules": {"timezone": "IST", "tat": "calendar days", "percentile": "inclusive (Sheets PERCENTILE)",
                  "windows": "MTD; L3M / L6M = last complete months; YTD = financial year"},
    }
    write("meta.json", meta)
    print(f"published web/data: p1 {info_p1['rows']:,} facts + {info_p1['pending']:,} pipeline ({info_p1['bytes']/1e6:.1f} MB); "
          f"p2 {info_p2['rows']:,} facts + {info_p2['pending']:,} pending ({info_p2['bytes']/1e6:.1f} MB); "
          f"qhse {info_qhse['rows']:,} sites + {info_qhse['pps']:,} punch points ({info_qhse['bytes']/1e6:.1f} MB); "
          f"escalations {info_esc['rows']:,} tickets ({info_esc['bytes']/1e6:.1f} MB); subsidy {info_sub['rows']:,} projects ({info_sub['bytes']/1e6:.1f} MB); "
          f"nbfc {info_nbfc['rows']:,} ({info_nbfc['bytes']/1e6:.1f} MB); psu {info_psu['rows']:,} ({info_psu['bytes']/1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
