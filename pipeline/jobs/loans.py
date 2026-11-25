"""NBFC and PSU cases (D-122): the loan journey of NBFC- and PSU-lane projects after HOTO.

Usage (from the repo root):
    python -m pipeline.jobs.loans            # extract fresh data from Metabase
    python -m pipeline.jobs.loans --reuse    # recompute from the last raw extracts
Rules:
  population    = projects in the NBFC / PSU payment lane (D-38) handed over since history_start, plus older ones still alive;
  payment ready = the shared events, so the numbers match HOTO -> Installation and the TAT page:
                  NBFC = lender RFD when recorded, else OMS task E004A / E004 (E_NBFC_RFD, D-84); PSU = OMS task PSUN004 (E_PSU_RFD, D-61);
  PSU 70% / 30% = OMS tasks PSUN005 / PSUN007 (E_PSU_70 / E_PSU_30); installed = task 039B (E_INSTALL_DONE, D-34);
  steps         = first entry into each lender / PSU stage of the project's latest finalized EMI application (emiApplicationLog,
                  history from Dec 2025); the current step = the application's current stage, "since" = the first log entry of its
                  current run;
  PAP done      = (provisional, OQ-91) the first EMI-team tag "PAP Done" or a later one (TFR received, RFD check, RFD Done).
                  Tags are set by hand and many applications carry none, so the page shows their coverage.
Writes data/marts/loans/summary.json (git-ignored).
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import date, datetime

from pipeline.common.dates import IST, history_start, ist_date, today_ist
from pipeline.common.dims import ClusterFiller, RegionFiller, lane, people
from pipeline.common.stage_model import event_datetime, extract_completions, load_events, needed_keys, to_ist_date
from pipeline.common.stats import tat_summary
from pipeline.config import REPO_ROOT, require
from pipeline.extract.metabase import MetabaseClient
from pipeline.jobs.p1_hoto_to_install import add_lender_rfd
from pipeline.probe_metabase import write_json
from pipeline.run_sql import strip_comments

DB_ID = 2
SQL = REPO_ROOT / "sql" / "extract"
RAW = REPO_ROOT / "data" / "raw" / "extract"
MART = REPO_ROOT / "data" / "marts" / "loans"
ALIVE = ("active", "on-hold", "seeking-cancellation")
EVENTS = ["E_HOTO", "E_NBFC_RFD", "E_NBFC_LENDER_RFD", "E_PSU_RFD", "E_PSU_70", "E_PSU_30", "E_INSTALL_DONE"]

LENDERS = {"ecofy": "Ecofy", "creditfair": "CreditFair", "caprion": "Caprion", "fibe": "Fibe", "ratnaafin": "Ratnaafin",
           "bajajfinance": "Bajaj Finance", "sbi": "SBI", "pnb": "PNB", "bob": "Bank of Baroda", "ubi": "Union Bank",
           "canerabank": "Canara Bank", "otherpsu": "Other PSU bank"}
NO_APP = "No loan application"

# NBFC: lender stage -> step on the page, in journey order (approval mostly lands a day before HOTO)
NBFC_STEPS = [NO_APP, "Application", "Approved", "KYC", "e-NACH", "Pre-disbursal documents", "Ready for disbursement", "Disbursed",
              "Failed / rejected", "Other"]
NBFC_STAGE_STEP = {
    "Select NBFC": "Application", "Document Verification": "Application", "loan-application-created": "Application",
    "loan-application-submitted": "Application", "loan-application-inprogress": "Application", "loan-application-soft-approval": "Application",
    "loan-additional-document-required": "Application", "loan-application-bank-statement-approved": "Application",
    "loan-application-approved": "Approved", "loan-application-partially-approved": "Approved",
    "loan-application-kyc-in-review": "KYC", "loan-application-kyc-approved": "KYC", "loan-application-kyc-rejected": "KYC",
    "loan-application-enach-pending": "e-NACH", "loan-application-enach-in-review": "e-NACH", "loan-application-enach-rejected": "e-NACH",
    "loan-application-enach-completed": "Pre-disbursal documents", "loan-application-pre-disbursal-documents": "Pre-disbursal documents",
    "loan-application-ready-for-disbursement": "Ready for disbursement", "Pending Disbursal Verification": "Ready for disbursement",
    "loan-application-disbursed": "Disbursed", "Disbursed": "Disbursed",
    "loan-application-failed": "Failed / rejected", "loan-application-aborted": "Failed / rejected", "Rejected": "Failed / rejected",
}

# PSU: (log column = first entry into the stage, label = what the project waits for there), in journey order (D-122).
# Time in step k = entry(k + 1) - entry(k).
PSU_STEPS = [("docver_at", "Document verification"), ("select_lender_at", "Lender selection"), ("js_pending_at", "Jan Samarth application"),
             ("runner_at", "Runner assignment"), ("bank_visit_pending_at", "Bank visit"), ("bank_insp_pending_at", "Bank inspection"),
             ("final_visit_pending_at", "Final customer visit (RFD)"), ("first_disb_pending_at", "1st disbursal"),
             ("disb_verif_at", "Disbursal verification"), ("first_disb_recv_at", "Installation (1st disbursal received)"),
             ("install_docs_at", "Installation documents"), ("second_disb_pending_at", "2nd disbursal"), ("disbursed_at", "Disbursed")]
PSU_STAGE_STEP = {
    "Document Verification": "Document verification", "Select NBFC": "Lender selection", "Feasibility Report": "Lender selection",
    "Jan Samarth Application Pending": "Jan Samarth application", "Assign Runner": "Runner assignment", "Bank Visit Pending": "Bank visit",
    "Bank Inspection Pending": "Bank inspection", "First Disbursal Pending": "1st disbursal",
    "Pending Disbursal Verification": "Disbursal verification", "First Disbursal Received": "Installation (1st disbursal received)",
    "Submit Installation Documents": "Installation documents", "Second Disbursal Pending": "2nd disbursal", "Disbursed": "Disbursed",
    "Rejected": "Failed / rejected", "loan-application-failed": "Failed / rejected",
}
PSU_EXTRA = [NO_APP, "Portal application", "Failed / rejected", "Other"]


def nbfc_step(stage: str | None) -> str:
    if not stage:
        return NO_APP
    return NBFC_STAGE_STEP.get(stage, "Other")


def psu_step(stage: str | None) -> str:
    if not stage:
        return NO_APP
    if stage.startswith("Final CX Visit Pending"):
        return "Final customer visit (RFD)"
    if stage in PSU_STAGE_STEP:
        return PSU_STAGE_STEP[stage]
    return "Portal application" if stage.startswith("loan-") else "Other"


# ----------------------------------------------------------------------------- extract
def extract(today: date) -> tuple[list, dict, list, str]:
    client = MetabaseClient(require("METABASE_URL"), require("METABASE_API_KEY"), timeout=600)
    q = lambda sql: client.export_sql(DB_ID, sql)
    read = lambda name: strip_comments((SQL / name).read_text(encoding="utf-8"))
    projects = q(read("project_dim.sql"))
    lender = q(read("nbfc_lender_rfd.sql"))
    since = history_start(today)
    journey = q(read("loan_journey.sql").replace("{since}", since.isoformat()))
    ids = [p["project_id"] for p in projects if p.get("payment_lane") in ("NBFC", "PSU")
           and ((ist_date(p.get("hoto_at")) or date.min) >= since or p.get("project_state") in ALIVE)]
    keys = needed_keys(load_events(), set(EVENTS))
    comps = extract_completions(client, DB_ID, ids, keys)
    print(f"extract: {len(projects):,} projects, {len(lender):,} lender RFD rows, {len(journey):,} loan journeys, {len(ids):,} NBFC / PSU projects")
    at = datetime.now(IST).isoformat(timespec="seconds")
    write_json(RAW / "loan_project_dim.json", {"extracted_at": at, "rows": projects})
    write_json(RAW / "loan_lender_rfd.json", {"extracted_at": at, "rows": lender})
    write_json(RAW / "loan_journey.json", {"extracted_at": at, "since": since.isoformat(), "rows": journey})
    write_json(RAW / "loan_task_completions.json", {"extracted_at": at, "keys": keys, "rows": comps})
    add_lender_rfd(projects, lender)
    return projects, comps, journey, at


def load_raw() -> tuple[list, dict, list, str]:
    j = lambda n: json.load(open(RAW / n, encoding="utf-8"))
    p = j("loan_project_dim.json")
    add_lender_rfd(p["rows"], j("loan_lender_rfd.json")["rows"])
    return p["rows"], j("loan_task_completions.json")["rows"], j("loan_journey.json")["rows"], p.get("extracted_at", "")


# ----------------------------------------------------------------------------- transform
def transform(projects: list, comps: dict, journey: list, today: date) -> tuple[list[dict], dict]:
    since = history_start(today)
    rf, cf = RegionFiller(projects), ClusterFiller(projects)
    events = load_events()
    jy = {r["project_id"]: r for r in journey}
    dq = Counter()
    out = []
    for p in projects:
        pay = p.get("payment_lane")
        if pay not in ("NBFC", "PSU"):
            continue
        hoto = ist_date(p.get("hoto_at"))
        state = p.get("project_state") or "unknown"
        if hoto is None:
            dq["no_hoto_date"] += 1
            continue
        if hoto < since and state not in ALIVE:
            continue
        cache: dict = {}
        ev = lambda e: to_ist_date(event_datetime(e, p, comps.get(p["project_id"], {}), events, cache))
        j = jy.get(p["project_id"]) or {}
        stage = (j.get("application_stage") or "").strip() or None
        if not j:
            dq[f"{pay}: no finalized EMI application"] += 1
        rfd = ev("E_NBFC_RFD") if pay == "NBFC" else ev("E_PSU_RFD")
        row = {
            "sseid": p.get("sseid"), "project_id": p["project_id"], "region": rf(p), "cluster": cf(p), "cell": p.get("cell_name") or "No cell",
            **people(p), "lane": lane(p, rf(p)), "payment_lane": pay, "state": state, "hoto_on": hoto,
            "installed_on": ev("E_INSTALL_DONE"), "rfd_on": rfd,
            "lender": LENDERS.get((j.get("emi_partner") or "").strip().lower(), (j.get("emi_partner") or "").strip() or NO_APP),
            "app_stage": stage, "step_since": ist_date(j.get("stage_since")),
            "tag": (j.get("tags_l1") or "").strip() or None, "tag2": (j.get("tags_l2") or "").strip() or None,
        }
        if pay == "NBFC":
            lender_rfd = ev("E_NBFC_LENDER_RFD")
            row.update({
                "step": nbfc_step(stage), "rfd_src": None if rfd is None else ("Lender" if lender_rfd == rfd else "OMS task E004A"),
                "approved_on": ist_date(j.get("approved_at")), "enach_on": ist_date(j.get("enach_done_at")),
                "predisb_on": ist_date(j.get("predisb_at")),
                "disbursed_on": min([d for d in (ist_date(j.get("lender_disbursed_at")), ist_date(j.get("disbursed_at"))) if d], default=None),
                "pap_on": ist_date(j.get("pap_done_at")),
            })
            if row["step"] == "Other":
                dq[f"NBFC other stage: {stage}"] += 1
        else:
            row.update({
                "step": psu_step(stage), "d70_on": ev("E_PSU_70"), "d30_on": ev("E_PSU_30"),
                "entries": [ist_date(j.get(col)) for col, _ in PSU_STEPS],
            })
            if row["step"] == "Other":
                dq[f"PSU other stage: {stage}"] += 1
        if rfd and rfd < hoto:
            dq[f"{pay}: RFD before HOTO"] += 1
        out.append(row)
    return out, dict(dq)


def summarise(rows: list[dict], today: date) -> dict:
    out = {}
    for pay in ("NBFC", "PSU"):
        rs = [r for r in rows if r["payment_lane"] == pay]
        tat = [(r["rfd_on"] - r["hoto_on"]).days for r in rs if r["rfd_on"] and r["rfd_on"] >= r["hoto_on"]
               and (today - r["rfd_on"]).days <= 120]
        open_ = [r for r in rs if r["state"] == "active" and not r["rfd_on"]]
        out[pay] = {"projects": len(rs), "open_active_no_rfd": len(open_), "open_by_step": dict(Counter(r["step"] for r in open_).most_common()),
                    "lenders": dict(Counter(r["lender"] for r in rs).most_common()), "hoto_to_rfd_last_120d": tat_summary(tat)}
    return out


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--reuse", action="store_true", help="recompute from the last raw extracts")
    args = ap.parse_args(argv)
    today = today_ist()
    projects, comps, journey, at = load_raw() if args.reuse else extract(today)
    rows, dq = transform(projects, comps, journey, today)
    s = summarise(rows, today)
    MART.mkdir(parents=True, exist_ok=True)
    write_json(MART / "summary.json", {"extracted_at": at, "as_of": today.isoformat(), "summary": s, "data_quality": dq})
    print(json.dumps(s, indent=1, default=str))
    print("data quality:", dq)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
