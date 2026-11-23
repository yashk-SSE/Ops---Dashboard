"""Reconcile QHSE punch-point numbers: Metabase (our SQL) vs the QHSE Version 1 sheet (an export of Q-5424).

Usage:  python -m pipeline.tools.reconcile_qhse
Prints the same aggregates we read from the sheet (docs/reconciliation/qhse.md), computed from the database with Q-5424's rules:
  rows in scope = installed (039B) or audit closed (046) on/after 2026-01-01 (UTC date, as Q-5424), or any PP still Open;
  audit_status = Close when task 046 is done; mechanical = the 21 hard-coded PP codes of Q-5424.
Read-only; no customer fields leave the database; only counts are printed.
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from datetime import datetime, timezone

from pipeline.config import REPO_ROOT, require
from pipeline.common.stage_model import extract_completions
from pipeline.extract.metabase import MetabaseClient
from pipeline.run_sql import strip_comments

DB_ID = 2
SQL = REPO_ROOT / "sql" / "exploration"
MECH_CODES = {"QMSZ08", "QMSH13", "QMSH14", "QMSZ17", "QMSH19", "QSPZ08", "QSMSZ01", "QSMSZ02", "QSMSZ03", "QSMSZ04", "QSMSZ05",
              "QSMSZ06", "QSMSZ07", "QSCWZ01", "QSMSH02", "QMSZ18", "QMSZ19", "QMSH21", "QMSZ13", "QMSZ14", "QMSZ16"}
CUTOFF = datetime(2026, 1, 1, tzinfo=timezone.utc)


def flag(code: str, sev: str) -> str:
    if not code:
        return ""
    if sev in ("Low", "Medium"):
        return "L+M"
    if sev in ("Zero Tolerance", "High"):
        return "Z+H With Mechanical Risk" if code in MECH_CODES else "Z+H Without Mechanical Risk"
    return "Z+H Without Mechanical Risk"  # Q-5424's ELSE branch (blank / other severities)


def utc(ms) -> datetime | None:
    if ms in (None, ""):
        return None
    return datetime.fromtimestamp(float(ms) / 1000, tz=timezone.utc)


def main() -> int:
    mb = MetabaseClient(require("METABASE_URL"), require("METABASE_API_KEY"))
    pps = mb.export_sql(DB_ID, strip_comments((REPO_ROOT / "sql" / "extract" / "qhse_punch_points.sql").read_text(encoding="utf-8")))
    sites = mb.export_sql(DB_ID, strip_comments((SQL / "16_qhse_sites.sql").read_text(encoding="utf-8")))
    print(f"punch-point rows: {len(pps):,}  projects: {len(sites):,}")
    comp = extract_completions(mb, DB_ID, [s["project_id"] for s in sites], ["039B", "046"])

    pp_by_sse = defaultdict(list)
    for r in pps:
        pp_by_sse[r["sseid"]].append(r)

    out = Counter()
    sev_status, open_by_flag, insp, close_month = Counter(), Counter(), Counter(), Counter()
    open_sites_by_flag = defaultdict(set)
    sites_in, sites_closed, pp_keys, open_keys = set(), set(), set(), set()
    for s in sites:
        sse = s["sseid"]
        c = comp.get(s["project_id"], {})
        inst, aud = utc(c.get("last_039B")), utc(c.get("last_046"))
        mine = pp_by_sse.get(sse, [])
        any_open = any(p.get("pp_status") == "Open" for p in mine)
        if not ((inst and inst >= CUTOFF) or (aud and aud >= CUTOFF) or any_open):
            continue
        sites_in.add(sse)
        if aud:
            sites_closed.add(sse)
            close_month[aud.strftime("%Y-%m")] += 1
        insp[s.get("inspection_type") or "(blank)"] += 1
        for p in mine:
            k = (sse, p["code"])
            sev_status[f"{p.get('severity') or '(blank)'} / {p.get('pp_status') or '(blank)'}"] += 1
            if k in pp_keys:
                continue
            pp_keys.add(k)
            if p.get("pp_status") == "Open":
                f = flag(p["code"], p.get("severity") or "")
                open_keys.add(k)
                open_by_flag[f] += 1
                open_sites_by_flag[f].add(sse)
    res = {
        "distinct_sites_in_scope": len(sites_in),
        "sites_audit_closed": len(sites_closed),
        "distinct_pp": len(pp_keys),
        "open_pp_distinct": len(open_keys),
        "open_pp_by_flag": dict(open_by_flag),
        "open_sites_by_flag": {k: len(v) for k, v in open_sites_by_flag.items()},
        "pp_rows_by_sev_status": dict(sorted(sev_status.items())),
        "sites_by_audit_close_month": dict(sorted(close_month.items())[-8:]),
        "inspection_type_sites": dict(insp),
    }
    print(json.dumps(res, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
