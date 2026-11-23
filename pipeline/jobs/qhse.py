"""QHSE: sites audited, punch points (PP) by severity / status / risk flag, closure TAT and open aging.

Usage (from the repo root):
    python -m pipeline.jobs.qhse            # extract fresh data from Metabase
    python -m pipeline.jobs.qhse --reuse    # recompute from the last raw extract
Rules (docs/metrics/qhse.md): D-71 audited = task 046 done, closure TAT = 046 -> 051, open aging = days since audit;
PP / severity / risk flag / status as Metabase Q-5424 (O-13, O-14); D-07 calendar days; IST dates (D-34); D-49 IC.
Writes data/marts/qhse/summary.json (git-ignored). Reconciliation with the QHSE sheet: docs/reconciliation/qhse.md.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from datetime import date, datetime

from pipeline.common.dates import IST, history_start, ist_date, today_ist
from pipeline.common.dims import ClusterFiller, RegionFiller, lane, people
from pipeline.common.stage_model import extract_completions
from pipeline.common.stats import tat_summary
from pipeline.config import REPO_ROOT, require
from pipeline.extract.metabase import MetabaseClient
from pipeline.probe_metabase import write_json
from pipeline.run_sql import strip_comments

DB_ID = 2
SQL = REPO_ROOT / "sql" / "extract"
RAW = REPO_ROOT / "data" / "raw" / "extract"
MART = REPO_ROOT / "data" / "marts" / "qhse"
KEYS = ["039B", "046", "051", "052"]
# Q-5424: ZT / High punch points on these field codes carry mechanical risk (O-14)
MECH_CODES = {"QMSZ08", "QMSH13", "QMSH14", "QMSZ17", "QMSH19", "QSPZ08", "QSMSZ01", "QSMSZ02", "QSMSZ03", "QSMSZ04", "QSMSZ05",
              "QSMSZ06", "QSMSZ07", "QSCWZ01", "QSMSH02", "QMSZ18", "QMSZ19", "QMSH21", "QMSZ13", "QMSZ14", "QMSZ16"}
OPEN_AGING = [(0, 1, "0-1 d"), (2, 4, "2-4 d"), (5, 7, "5-7 d"), (8, 15, "8-15 d"), (16, 30, "16-30 d"), (31, None, ">30 d")]  # D-71
SEVERITIES = ["Zero Tolerance", "High", "Medium", "Low"]


def risk_flag(code: str, severity: str) -> str:
    if severity in ("Low", "Medium"):
        return "L+M"
    return "Z+H mechanical" if code in MECH_CODES else "Z+H non-mechanical"  # Q-5424 ELSE branch covers ZT / High / blank


def aging_bucket(days: int | None) -> str:
    if days is None:
        return "No audit date"
    for lo, hi, label in OPEN_AGING:
        if days >= lo and (hi is None or days <= hi):
            return label
    return OPEN_AGING[0][2]


# ----------------------------------------------------------------------------- extract
def extract(today: date) -> tuple[list, list, list, dict, str]:
    client = MetabaseClient(require("METABASE_URL"), require("METABASE_API_KEY"), timeout=600)
    q = lambda name: client.export_sql(DB_ID, strip_comments((SQL / name).read_text(encoding="utf-8")))
    projects = q("project_dim.sql")
    pps = q("qhse_punch_points.sql")
    extra = q("qhse_project_extra.sql")
    print(f"extract: {len(projects):,} projects, {len(pps):,} punch-point rows, {len(extra):,} project extras")
    comps = extract_completions(client, DB_ID, [p["project_id"] for p in projects], KEYS)
    at = datetime.now(IST).isoformat(timespec="seconds")
    write_json(RAW / "qhse_project_dim.json", {"extracted_at": at, "rows": projects})
    write_json(RAW / "qhse_punch_points.json", {"extracted_at": at, "rows": pps})
    write_json(RAW / "qhse_project_extra.json", {"extracted_at": at, "rows": extra})
    write_json(RAW / "qhse_task_completions.json", {"extracted_at": at, "keys": KEYS, "rows": comps})
    return projects, pps, extra, comps, at


def load_raw() -> tuple[list, list, list, dict, str]:
    j = lambda n: json.load(open(RAW / n, encoding="utf-8"))
    p = j("qhse_project_dim.json")
    return p["rows"], j("qhse_punch_points.json")["rows"], j("qhse_project_extra.json")["rows"], j("qhse_task_completions.json")["rows"], p.get("extracted_at", "")


# ----------------------------------------------------------------------------- transform
def transform(projects: list, pps: list, extra: list, comps: dict, today: date) -> tuple[list[dict], dict]:
    since = history_start(today)
    rf = RegionFiller(projects)
    cf = ClusterFiller(projects)  # D-86
    ex = {e["project_id"]: e for e in extra}
    by_sse = defaultdict(dict)
    dq = Counter()
    for r in pps:  # one PP per (sseid, code); prefer the physical-audit row (it carries the status)
        k = r.get("code")
        if not r.get("sseid") or not k:
            dq["pp_without_sse_or_code"] += 1
            continue
        cur = by_sse[r["sseid"]].get(k)
        if cur is None or (cur.get("source") != "physical" and r.get("source") == "physical"):
            by_sse[r["sseid"]][k] = r
        else:
            dq["duplicate_pp_rows"] += 1
    sites = []
    for p in projects:
        pid, sse = p["project_id"], p.get("sseid")
        c = comps.get(pid, {})
        inst, audit = ist_date(c.get("last_039B")), ist_date(c.get("last_046"))
        rect, revisit = ist_date(c.get("last_051")), ist_date(c.get("last_052"))
        mine = list(by_sse.get(sse, {}).values())
        open_pps = [x for x in mine if x.get("pp_status") == "Open"]
        if not ((audit and audit >= since) or (inst and inst >= since) or open_pps):
            continue
        e = ex.get(pid, {})
        pp_out = []
        for x in mine:
            sev = x.get("severity") or "(blank)"
            pp_out.append({"code": x["code"], "severity": sev, "status": x.get("pp_status") or "(blank)",
                           "flag": risk_flag(x["code"], sev), "component": (x.get("component") or "").strip() or "—",
                           "issue": (x.get("issue") or "").strip() or "—", "source": x.get("source")})
        flags_open = Counter(x["flag"] for x in pp_out if x["status"] == "Open")
        closure = (rect - audit).days if (rect and audit and rect >= audit) else None
        if rect and audit and rect < audit:
            dq["rectified_before_audit"] += 1
        sites.append({
            "sseid": sse, "project_id": pid,
            "region": rf(p), "city": (p.get("city") or "").strip() or "Unknown", "cluster": cf(p), "cell": p.get("cell_name") or "No cell",
            **people(p), "lane": lane(p, rf(p)), "payment_lane": p.get("payment_lane") or "UNKNOWN",
            "ic": e.get("ic_name") or "Not mapped", "vendor": (e.get("vendor") or "").strip() or "Not mapped",
            "inspection": e.get("inspection_type") or "(blank)", "state": p.get("project_state") or "unknown",
            "installed_on": inst, "audited_on": audit, "rectified_on": rect, "revisited_on": revisit,
            "closure_tat": closure, "open_days": (today - audit).days if (open_pps and audit) else None,
            "n_pp": sum(1 for x in pp_out if x["source"] == "physical"), "n_pp_all": len(pp_out), "n_open": len(open_pps),
            # physical-audit punch points (default); *_all also counts failed IC-audit items, as Q-5424 / the QHSE sheet do
            "has_zt": any(x["severity"] == "Zero Tolerance" and x["source"] == "physical" for x in pp_out),
            "has_zh": any(x["severity"] in ("Zero Tolerance", "High") and x["source"] == "physical" for x in pp_out),
            "has_zt_all": any(x["severity"] == "Zero Tolerance" for x in pp_out),
            "has_zh_all": any(x["severity"] in ("Zero Tolerance", "High") for x in pp_out),
            "open_mech": flags_open["Z+H mechanical"], "open_nonmech": flags_open["Z+H non-mechanical"], "open_lm": flags_open["L+M"],
            "pps": pp_out,
        })
    return sites, dict(dq)


def summarise(sites: list[dict], today: date) -> dict:
    by_month = Counter(s["audited_on"].strftime("%Y-%m") for s in sites if s["audited_on"])
    open_sites = {f: sum(1 for s in sites if s[k]) for f, k in [("Z+H mechanical", "open_mech"), ("Z+H non-mechanical", "open_nonmech"), ("L+M", "open_lm")]}
    sev_status = Counter(f"{pp['severity']} / {pp['status']}" for s in sites for pp in s["pps"])
    aging = Counter(aging_bucket(s["open_days"]) for s in sites if s["n_open"])
    rectified = [s["closure_tat"] for s in sites if s["closure_tat"] is not None]
    return {
        "sites": len(sites), "sites_audited": sum(1 for s in sites if s["audited_on"]),
        "distinct_pp": sum(s["n_pp_all"] for s in sites), "physical_pp": sum(s["n_pp"] for s in sites), "open_pp": sum(s["n_open"] for s in sites),
        "open_sites_by_flag": open_sites, "sites_audited_by_month": dict(sorted(by_month.items())[-8:]),
        "pp_by_severity_status": dict(sorted(sev_status.items())), "open_site_aging": dict(aging),
        "closure_tat_all": tat_summary(rectified),
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
    projects, pps, extra, comps, at = load_raw() if args.reuse else extract(today)
    sites, dq = transform(projects, pps, extra, comps, today)
    summary = summarise(sites, today)
    MART.mkdir(parents=True, exist_ok=True)
    write_json(MART / "summary.json", {"extracted_at": at, "as_of": today.isoformat(), "summary": summary, "data_quality": dq})
    print(f"\nQHSE as of {today}: {summary['sites']:,} sites in scope, {summary['sites_audited']:,} audited")
    print(json.dumps({k: summary[k] for k in ("distinct_pp", "open_pp", "open_sites_by_flag", "sites_audited_by_month", "open_site_aging")}, indent=1))
    print("closure TAT (all rectified):", summary["closure_tat_all"])
    print("data quality:", dq)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
