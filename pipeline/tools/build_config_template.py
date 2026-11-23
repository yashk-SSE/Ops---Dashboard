"""Build the Config Google Sheet template (D-44): config/template/Ops_Dashboard_Config_v<version>.xlsx

Yash uploads the .xlsx to Drive and opens it as a Google Sheet. Ops CT then maintains it there.
Tab names and header rows are a contract with the pipeline: do not rename them.

Inputs: config/seed/*.csv (task_milestones, p2_commissioning_substages, p2_task_substage_overrides,
events, stages) and data/raw/extract/p2_installed_projects.json (for city / region / cell lists).

Usage:  python -m pipeline.tools.build_config_template [--version 0.1]
"""
from __future__ import annotations

import argparse
import csv
import json
import os
from collections import Counter, defaultdict
from datetime import date

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

from pipeline.config import REPO_ROOT


def _sheet_url(sheet_id: str) -> str:
    """Google Sheet link from an ID kept in .env (no sheet IDs in the code, D-115)."""
    return f"https://docs.google.com/spreadsheets/d/{sheet_id}" if sheet_id else ""

SEED = REPO_ROOT / "config" / "seed"
FONT = "Arial"
F_BODY = Font(name=FONT, size=10)
F_GREY = Font(name=FONT, size=10, color="7F7F7F")
F_HEAD = Font(name=FONT, size=10, bold=True, color="FFFFFF")
F_TITLE = Font(name=FONT, size=14, bold=True, color="1F3864")
F_BOLD = Font(name=FONT, size=10, bold=True)
FILL_HEAD = PatternFill("solid", fgColor="1F3864")
FILL_INPUT = PatternFill("solid", fgColor="FFF2CC")   # yellow: Ops / CT fill or edit
FILL_TODO = PatternFill("solid", fgColor="F8CBAD")    # orange: missing, needs a value
FILL_SYS = PatternFill("solid", fgColor="EDEDED")     # grey: system-filled, don't edit
WRAP = Alignment(wrap_text=True, vertical="top")


def read_csv(name: str) -> list[dict]:
    with open(SEED / name, encoding="utf-8") as f:
        return list(csv.DictReader(f))


class Sheet:
    """Writes one table tab: header row with notes, rows, input colouring, dropdowns."""

    def __init__(self, wb: Workbook, title: str, columns: list[dict]):
        self.ws = wb.create_sheet(title)
        self.columns = columns
        for i, col in enumerate(columns, start=1):
            c = self.ws.cell(row=1, column=i, value=col["name"])
            c.font, c.fill, c.alignment = F_HEAD, FILL_HEAD, Alignment(vertical="center")
            if col.get("note"):
                c.comment = Comment(col["note"], "Config template")
            self.ws.column_dimensions[get_column_letter(i)].width = col.get("width", 18)
        self.ws.freeze_panes = "A2"
        self.ws.auto_filter.ref = f"A1:{get_column_letter(len(columns))}1"
        self.n = 0

    def add(self, values: list, todo_cols: tuple = ()) -> None:
        self.n += 1
        r = self.n + 1
        for i, (col, v) in enumerate(zip(self.columns, values), start=1):
            c = self.ws.cell(row=r, column=i, value=v if v != "" else None)
            c.font = F_BODY if col.get("input") else F_GREY
            if col.get("input"):
                c.fill = FILL_TODO if (col["name"] in todo_cols and v in ("", None)) else FILL_INPUT
            elif col.get("system"):
                c.fill = FILL_SYS
            if col.get("fmt"):
                c.number_format = col["fmt"]

    def finish(self, spare_rows: int = 50, lists: dict | None = None) -> None:
        last = self.n + 1 + spare_rows
        for r in range(self.n + 2, last + 1):
            for i, col in enumerate(self.columns, start=1):
                if col.get("input"):
                    c = self.ws.cell(row=r, column=i)
                    c.fill, c.font = FILL_INPUT, F_BODY
                    if col.get("fmt"):
                        c.number_format = col["fmt"]
        for i, col in enumerate(self.columns, start=1):
            ref = col.get("list")
            if ref and lists is not None:
                dv = DataValidation(type="list", formula1=lists[ref], allow_blank=True, showErrorMessage=True,
                                    errorTitle="Not in list", error=f"Pick a value from the {ref} list (Lists tab).")
                self.ws.add_data_validation(dv)
                L = get_column_letter(i)
                dv.add(f"{L}2:{L}{last}")


def build(version: str) -> str:
    today = date.today()
    projects = json.load(open(REPO_ROOT / "data/raw/extract/p2_installed_projects.json", encoding="utf-8"))["rows"]
    city_region = defaultdict(Counter)
    city_recent = Counter()
    for p in projects:
        city = (p.get("city") or "").strip()
        if not city:
            continue
        city_region[city][p.get("region") or ""] += 1
        if (p.get("installed_at") or "") >= "2026-04-01":
            city_recent[city] += 1
    regions = sorted({p["region"] for p in projects if p.get("region")})
    tasks = read_csv("task_milestones.csv")
    substages = read_csv("p2_commissioning_substages.csv")
    overrides = read_csv("p2_task_substage_overrides.csv")
    events = read_csv("events.csv")
    stages = read_csv("stages.csv")
    departments = sorted({t["department"] for t in tasks if t["department"]})
    sub_by_ms = {s["milestone"]: s for s in substages}
    ms_dept = defaultdict(Counter)
    for t in tasks:
        if t["milestone"]:
            ms_dept[t["milestone"]][t["department"]] += 1
    milestones = sorted(set(ms_dept) | set(sub_by_ms))
    p2_labels = sorted({s["p2_substage"] for s in substages} | {o["p2_substage"] for o in overrides if o["p2_substage"]},
                       key=lambda x: next((int(s["substage_order"]) for s in substages if s["p2_substage"] == x), 99))

    wb = Workbook()
    wb.remove(wb.active)
    readme = wb.create_sheet("README")

    # ---------------------------------------------------------------- Lists (dropdown sources)
    list_values = {
        "yes_no": ["Yes", "No"],
        "access_role": ["Viewer", "Central", "Admin"],
        "region": ["All"] + regions,
        "classification": ["BAU", "Expansion"],
        "level": ["City", "Cell"],
        "department": departments,
        "event_type": ["project_field", "task_done", "milestone_done", "greatest_of", "first_available", "by_lane"],
        "pick": ["first", "last"],
        "section": ["P1 HOTO-Install funnel", "P2 Install-Commissioning", "P3 TAT breach"],
        "applies_to": ["All", "LC/NC/PC only", "LC/NC/PC started", "NBFC only", "PSU only", "Direct only"],
        "status": ["Confirmed", "Provisional", "TBC", "Draft", "Built", "Retired"],
        "mapping_source": ["sheet3_name", "key_inferred", "unmapped", "manual"],
        "p2_substage": p2_labels,
    }
    lists_ws = wb.create_sheet("Lists")
    lists = {}
    for i, (name, vals) in enumerate(list_values.items(), start=1):
        L = get_column_letter(i)
        h = lists_ws.cell(row=1, column=i, value=name)
        h.font, h.fill = F_HEAD, FILL_HEAD
        for r, v in enumerate(vals, start=2):
            lists_ws.cell(row=r, column=i, value=v).font = F_BODY
        lists_ws.column_dimensions[L].width = 24
        lists[name] = f"=Lists!${L}$2:${L}${len(vals) + 1}"
    lists_ws.freeze_panes = "A2"
    lists["milestone"] = "=Milestones!$A$2:$A$300"
    lists["event_id"] = "=Events!$A$2:$A$300"

    # ---------------------------------------------------------------- Settings
    s = Sheet(wb, "Settings", [
        {"name": "key", "width": 30, "note": "Setting name read by the pipeline. Don't rename."},
        {"name": "value", "width": 46, "input": True, "note": "Edit this column only."},
        {"name": "allowed_values", "width": 34},
        {"name": "description", "width": 60},
        {"name": "owner", "width": 12},
        {"name": "decision", "width": 10},
    ])
    settings = [
        ("timezone", "Asia/Kolkata", "Asia/Kolkata", "All timestamps are converted to IST once", "Data", "D-34"),
        ("tat_unit", "calendar_days", "calendar_days", "TAT = IST date of end minus IST date of start", "Ops", "D-07"),
        ("ten_day_bucket_mode", "fixed", "fixed | rolling", "fixed = 1-10, 11-20, 21-month end", "Ops", "D-06"),
        ("fy_start_month", 4, "1-12", "Financial year starts in April (YTD)", "Ops", "D-20"),
        ("trend_window_mode", "complete_months", "complete_months | rolling_days | include_current", "L3M / L6M = last 3 / 6 complete months", "Ops", "D-47"),
        ("refresh_times_ist", "07:00, 10:00, 13:00, 16:00, 19:00", "HH:MM list", "Scheduled data refreshes per day", "Ops", "D-19"),
        ("pending_states", "active, on-hold, seeking-cancellation", "project_state values", "States counted as pending (switcher on the dashboard)", "Ops", "D-42"),
        ("include_later_cancelled_default", "Yes", "Yes | No", "Historical counts include projects later cancelled / on hold (toggle default)", "Ops", "D-42"),
        ("p2_aging_buckets", "0-3, 4-10, 11-20, 21-30, 31+", "day ranges", "Pending-commissioning aging buckets (days since installation)", "Ops", "D-35"),
        ("hierarchy_levels_v1", "COM, SOH, ZOH, AVP", "list", "Hierarchy shown on the dashboard; AVP from AVP_Map", "Ops", "D-36"),
        ("com_source", "cell roles COM + SPO (all names)", "", "COM / SPO from the project's cell", "Data", "D-36"),
        ("soh_zoh_source", "project.soh / project.zoh", "", "SOH and ZOH from the project's own fields (~99% filled)", "Data", "D-50"),
        ("avp_source", "AVP_Map by region", "", "AVP mapped from business region", "Ops", "D-51"),
        ("region_source", "project.site_address_cluster_state; blank -> Region_Map", "", "Business region (MH West, MH East ...)", "Data", "D-37"),
        ("ic_field", "project.installation_supervisor", "", "IC = Installation Champion", "Data", "D-49"),
        ("delay_reason_mode", "system_and_ct", "system_and_ct | system | ct", "P2 delay reasons shown side by side", "Ops", "D-48"),
        ("ct_reasons_sheet", _sheet_url(os.environ.get("PAN_INDIA_SHEET_ID", "")), "Sheet URL", "Pan India Commissioning (tab CT Working, column Sub-Reasons)", "Ops CT", "D-48"),
        ("daily_installation_tracker", "", "Sheet URL", "To be shared by Yash (planned dates, slippage reasons)", "Ops", "OQ-11"),
        ("subsidy_tracker", "", "Sheet URL", "To be shared by Yash (subsidy backlog)", "Ops", "OQ-13"),
    ]
    for row in settings:
        s.add(list(row), todo_cols=("value",))
    s.finish(spare_rows=10)

    # ---------------------------------------------------------------- Users (login allowlist)
    u = Sheet(wb, "Users", [
        {"name": "email", "width": 30, "input": True, "note": "@solarsquare.in email. Only listed + active emails can log in (D-45). Passwords are never stored here."},
        {"name": "name", "width": 22, "input": True},
        {"name": "access_role", "width": 14, "input": True, "list": "access_role", "note": "Viewer = dashboard; Central = + manual refresh (later); Admin = + manage users"},
        {"name": "region_scope", "width": 16, "input": True, "list": "region", "note": "All for V1. Region-restricted views come in Phase 2/3 (D-22)."},
        {"name": "active", "width": 9, "input": True, "list": "yes_no"},
        {"name": "added_by", "width": 18, "input": True},
        {"name": "added_on", "width": 12, "input": True, "fmt": "yyyy-mm-dd"},
        {"name": "notes", "width": 40, "input": True},
    ])
    u.add(["your.name@solarsquare.in", "Your Name", "Admin", "All", "Yes", "Your Name", today, "Example row: replace with the first admin's email and name"])
    u.finish(spare_rows=100, lists=lists)

    # ---------------------------------------------------------------- AVP_Map
    a = Sheet(wb, "AVP_Map", [
        {"name": "region", "width": 20, "note": "Business region (D-37). One row per region (D-51)."},
        {"name": "avp_name", "width": 24, "input": True, "note": "There are 2 AVPs pan-India; fill one per region."},
        {"name": "avp_email", "width": 30, "input": True},
        {"name": "effective_from", "width": 14, "input": True, "fmt": "yyyy-mm-dd", "note": "When a region moves to another AVP, add a new row with the new date instead of overwriting, so history stays right."},
        {"name": "effective_to", "width": 14, "input": True, "fmt": "yyyy-mm-dd"},
        {"name": "notes", "width": 36, "input": True},
    ])
    for reg in regions:
        a.add([reg, "", "", "", "", ""], todo_cols=("avp_name",))
    a.finish(spare_rows=20)

    # ---------------------------------------------------------------- Expansion_List
    e = Sheet(wb, "Expansion_List", [
        {"name": "level", "width": 8, "input": True, "list": "level", "note": "City, or Cell to override a single cell"},
        {"name": "name", "width": 26, "input": True},
        {"name": "region", "width": 18, "system": True},
        {"name": "classification", "width": 14, "input": True, "list": "classification", "note": "BAU or Expansion (D-39)"},
        {"name": "effective_from", "width": 14, "input": True, "fmt": "yyyy-mm-dd"},
        {"name": "installs_since_1_apr_2026", "width": 14, "system": True, "note": "Context only (filled by the template builder)"},
        {"name": "notes", "width": 36, "input": True},
    ])
    for city, n in sorted(city_recent.items(), key=lambda x: -x[1]):
        reg = city_region[city].most_common(1)[0][0] if city_region[city] else ""
        e.add(["City", city, reg, "", "", n, ""], todo_cols=("classification",))
    e.finish(spare_rows=50, lists=lists)

    # ---------------------------------------------------------------- Region_Map
    rm = Sheet(wb, "Region_Map", [
        {"name": "city", "width": 26, "note": "City as written in project.site_address_city"},
        {"name": "region", "width": 20, "input": True, "list": "region", "note": "Used only when the project's own region is blank (D-37)"},
        {"name": "source", "width": 22, "system": True},
        {"name": "projects", "width": 10, "system": True},
        {"name": "notes", "width": 36, "input": True},
    ])
    for city, cnt in sorted(city_region.items(), key=lambda x: -sum(x[1].values())):
        known = [(k, v) for k, v in cnt.most_common() if k]
        reg = known[0][0] if known else ""
        rm.add([city, reg, "system (most common)" if reg else "missing - please fill", sum(cnt.values()), ""], todo_cols=("region",))
    rm.finish(spare_rows=30, lists=lists)

    # ---------------------------------------------------------------- Task_Milestones (Layer 1)
    tm = Sheet(wb, "Task_Milestones", [
        {"name": "key", "width": 9, "note": "usertasks.key, the stable task code"},
        {"name": "task_name", "width": 52, "note": "usertasks.summary. Matching ignores case, spacing and & vs and."},
        {"name": "department", "width": 11, "input": True, "list": "department"},
        {"name": "milestone", "width": 32, "input": True, "list": "milestone", "note": "Layer 1 (D-43). Orange = unmapped, Ops CT to fill."},
        {"name": "source", "width": 13, "system": True, "note": "sheet3_name = from Sheet3; key_inferred = same key as a mapped name; unmapped = needs a value; manual = set by Ops CT"},
        {"name": "done_last_30d", "width": 11, "system": True, "note": "Completions in the last 30 days when the template was built (context only)"},
        {"name": "active", "width": 8, "input": True, "list": "yes_no"},
        {"name": "notes", "width": 36, "input": True},
    ])
    for t in sorted(tasks, key=lambda x: (x["milestone"] == "", -int(x["done_last_30d"] or 0))):
        tm.add([t["key"], t["task_name"], t["department"], t["milestone"], t["source"], int(t["done_last_30d"] or 0), "Yes", ""],
               todo_cols=("milestone",))
    tm.finish(spare_rows=100, lists=lists)

    # ---------------------------------------------------------------- Milestones
    m = Sheet(wb, "Milestones", [
        {"name": "milestone", "width": 34, "note": "Master list; Task_Milestones dropdown reads this column"},
        {"name": "department", "width": 12, "input": True, "list": "department"},
        {"name": "p2_substage", "width": 24, "input": True, "list": "p2_substage", "note": "Commissioning sub-stage for P2 (blank = not a P2 step)"},
        {"name": "substage_order", "width": 10, "input": True},
        {"name": "in_commissioning_chain", "width": 12, "input": True, "list": "yes_no", "note": "Yes = a permit / net-meter step that blocks commissioning"},
        {"name": "description", "width": 40, "input": True},
    ])
    for ms in milestones:
        sub = sub_by_ms.get(ms, {})
        dept = ms_dept[ms].most_common(1)[0][0] if ms_dept[ms] else ""
        m.add([ms, dept, sub.get("p2_substage", ""), int(sub["substage_order"]) if sub.get("substage_order") else "",
               "Yes" if sub.get("in_commissioning_chain") == "Y" else ("No" if sub else ""), ""])
    m.finish(spare_rows=30, lists=lists)

    # ---------------------------------------------------------------- P2_Task_Overrides
    o = Sheet(wb, "P2_Task_Overrides", [
        {"name": "task_name", "width": 60, "note": "Task-level sub-stage that wins over the milestone rollup (from Pan India's Mapping_sheet), so P2 matches the sheet the team uses"},
        {"name": "p2_substage", "width": 24, "input": True, "list": "p2_substage", "note": "Blank = not a commissioning-chain task"},
        {"name": "source", "width": 38, "system": True},
    ])
    for row in overrides:
        o.add([row["task_name"], row["p2_substage"], row["source"]])
    o.finish(spare_rows=30, lists=lists)

    # ---------------------------------------------------------------- Events
    ev = Sheet(wb, "Events", [
        {"name": "event_id", "width": 18, "note": "Referenced by Stages. Don't rename an id in use."},
        {"name": "event_name", "width": 30, "input": True},
        {"name": "type", "width": 15, "input": True, "list": "event_type",
         "note": "project_field = a date on the project; task_done = completion of task key(s); milestone_done = completion of any task mapped to the milestone; greatest_of = latest of other events"},
        {"name": "ref", "width": 30, "input": True, "note": "Field name / comma-separated task keys / milestone name / comma-separated event ids"},
        {"name": "pick", "width": 7, "input": True, "list": "pick", "note": "first or last completion when there are several"},
        {"name": "status", "width": 11, "input": True, "list": "status"},
        {"name": "source", "width": 16, "system": True},
        {"name": "notes", "width": 50, "input": True},
    ])
    for row in events:
        ev.add([row[k] for k in ("event_id", "event_name", "type", "ref", "pick", "status", "source", "notes")], todo_cols=("ref",))
    ev.finish(spare_rows=30, lists=lists)

    # ---------------------------------------------------------------- Stages (Layer 2)
    st = Sheet(wb, "Stages", [
        {"name": "stage_id", "width": 8},
        {"name": "section", "width": 24, "input": True, "list": "section"},
        {"name": "stage_name", "width": 38, "input": True},
        {"name": "stage_order", "width": 8, "input": True},
        {"name": "start_event", "width": 18, "input": True, "list": "event_id"},
        {"name": "end_event", "width": 18, "input": True, "list": "event_id"},
        {"name": "applies_to", "width": 14, "input": True, "list": "applies_to", "note": "Which projects the stage applies to (lane filter)"},
        {"name": "sla_days", "width": 9, "input": True, "note": "Calendar days. Owned by Ops CT (D-08). Orange = not set yet. Breach = actual days > sla_days."},
        {"name": "sla_owner", "width": 10, "input": True},
        {"name": "status", "width": 10, "input": True, "list": "status"},
        {"name": "decision", "width": 9, "system": True},
        {"name": "notes", "width": 40, "input": True},
    ])
    for row in stages:
        st.add([row["stage_id"], row["section"], row["stage_name"], int(row["stage_order"]), row["start_event"], row["end_event"],
                row["applies_to"], row["sla_days"], row["sla_owner"], row["status"], row["decision"], row["notes"]],
               todo_cols=("sla_days",))
    st.finish(spare_rows=30, lists=lists)

    # ---------------------------------------------------------------- MOP_Links
    mp = Sheet(wb, "MOP_Links", [
        {"name": "month", "width": 10, "input": True, "note": "YYYY-MM as text, e.g. 2026-11"},
        {"name": "mop_sheet_url", "width": 46, "input": True},
        {"name": "tab_name", "width": 18, "input": True},
        {"name": "grain", "width": 22, "input": True, "note": "e.g. month x region x metric. Today's MOP format will be mapped as-is (D-09)."},
        {"name": "metrics_covered", "width": 30, "input": True},
        {"name": "owner", "width": 14, "input": True},
        {"name": "notes", "width": 40, "input": True},
    ])
    mp.add(["2026-11", "(paste the MOP sheet link)", "(tab name)", "(e.g. month x region)", "HOTOs, installs, commissioning",
            "Ops", "Example row: replace with the real link"])
    mp.finish(spare_rows=24)

    # ---------------------------------------------------------------- Change_Log
    cl = Sheet(wb, "Change_Log", [
        {"name": "date", "width": 12, "input": True, "fmt": "yyyy-mm-dd"},
        {"name": "changed_by", "width": 18, "input": True},
        {"name": "tab", "width": 18, "input": True},
        {"name": "change", "width": 60, "input": True},
        {"name": "reason", "width": 36, "input": True},
    ])
    cl.add([today, "Claude (draft)", "All", f"v{version} template generated by pipeline/tools/build_config_template.py", "D-44"])
    cl.finish(spare_rows=200)

    # ---------------------------------------------------------------- README (written last; references the other tabs)
    ws = readme
    ws.column_dimensions["A"].width = 28
    ws.column_dimensions["B"].width = 62
    ws.column_dimensions["C"].width = 14
    ws.column_dimensions["D"].width = 18
    ws.column_dimensions["E"].width = 34
    def put(r, c, v, font=F_BODY, fill=None, wrap=True):
        cell = ws.cell(row=r, column=c, value=v)
        cell.font = font
        if fill:
            cell.fill = fill
        if wrap:
            cell.alignment = WRAP
        return cell
    put(1, 1, f"Ops Dashboard - Config Sheet (draft v{version})", F_TITLE, wrap=False)
    put(2, 1, f"Generated {today:%d %b %Y} from the repo (config/seed). Owner: Ops CT. Kept in sync with the repo copy.", F_GREY, wrap=False)
    r = 4
    put(r, 1, "What this is", F_BOLD)
    put(r, 2, "Everything Ops can change without a code deploy: SLAs, stage definitions, task-to-milestone mapping, AVP mapping, "
              "BAU/Expansion list, region fixes, MOP links, login allowlist and global settings. The dashboard pipeline reads this sheet on every refresh.")
    r += 1
    put(r, 1, "How to create it", F_BOLD)
    put(r, 2, "Upload this .xlsx to Google Drive > open with Google Sheets > File > Save as Google Sheets. "
              "Share it with Ops CT as Editor and with the pipeline's service account as Viewer (email to come).")
    r += 1
    put(r, 1, "Rules", F_BOLD)
    put(r, 2, "1) Don't rename tabs or header cells; the pipeline reads them by name.  2) Add new rows at the bottom; don't leave gaps.  "
              "3) Edit only yellow cells; grey cells are filled by the system.  4) Use the dropdowns where present.  5) Log every change in Change_Log.")
    r += 2
    put(r, 1, "Legend", F_BOLD)
    put(r + 1, 1, "Yellow", F_BODY, FILL_INPUT); put(r + 1, 2, "Input: Ops / CT fill or edit")
    put(r + 2, 1, "Orange", F_BODY, FILL_TODO); put(r + 2, 2, "Missing: a value is needed")
    put(r + 3, 1, "Grey text / grey fill", F_GREY, FILL_SYS); put(r + 3, 2, "System-filled or context: don't edit")
    r += 5
    put(r, 1, "Tab", F_HEAD, FILL_HEAD); put(r, 2, "Purpose", F_HEAD, FILL_HEAD); put(r, 3, "Owner", F_HEAD, FILL_HEAD)
    put(r, 4, "Edit how often", F_HEAD, FILL_HEAD); put(r, 5, "Used for", F_HEAD, FILL_HEAD)
    index = [
        ("Settings", "Global rules (timezone, TAT unit, windows, refresh slots, sources)", "Ops", "Rarely", "All sections"),
        ("Users", "Login allowlist and access role (D-45)", "Admin", "As people join/leave", "Login"),
        ("AVP_Map", "Region to AVP (2 AVPs pan-India) (D-51)", "Ops", "On reorg", "Hierarchy cuts"),
        ("Expansion_List", "BAU vs Expansion per city (or cell) (D-39)", "Ops", "On launches", "# HOTOs, funnel"),
        ("Region_Map", "City to business region, used when the project's region is blank (D-37)", "Ops", "New cities", "All region cuts"),
        ("Task_Milestones", "Layer 1: task key + name to milestone (D-43)", "Ops CT", "When tasks change", "Funnel, TAT, P2"),
        ("Milestones", "Milestone master list + P2 sub-stage rollup", "Ops CT", "Rarely", "P2, dropdowns"),
        ("P2_Task_Overrides", "Task-level P2 sub-stage (Pan India's map)", "Ops CT", "Rarely", "P2 current step"),
        ("Events", "Named events (dates) built from project fields or task completions", "Ops CT", "Rarely", "Stages"),
        ("Stages", "Layer 2: stage = start event to end event, applies-to, SLA (D-08, D-43)", "Ops CT", "SLA changes", "Funnel, TAT breach, P2"),
        ("MOP_Links", "Link to each month's MOP sheet (D-09)", "Ops", "Monthly", "MOP vs actual"),
        ("Lists", "Dropdown values", "Data", "Rarely", "Validation"),
        ("Change_Log", "Who changed what and why", "Everyone", "Every change", "Audit"),
    ]
    for t in index:
        r += 1
        for c, v in enumerate(t, start=1):
            put(r, c, v)
    r += 2
    put(r, 1, "Health check", F_HEAD, FILL_HEAD); put(r, 2, "What it counts", F_HEAD, FILL_HEAD); put(r, 3, "Value", F_HEAD, FILL_HEAD)
    put(r, 4, "Target", F_HEAD, FILL_HEAD)
    checks = [
        ("Active users", "Users with active = Yes", '=COUNTIF(Users!E2:E2000,"Yes")', "> 0"),
        ("Regions without AVP", "AVP_Map rows with no avp_name", '=COUNTIFS(AVP_Map!A2:A200,"<>",AVP_Map!B2:B200,"")', "0"),
        ("Cities not classified", "Expansion_List rows with no BAU / Expansion", '=COUNTIFS(Expansion_List!B2:B2000,"<>",Expansion_List!D2:D2000,"")', "0"),
        ("Cities without region", "Region_Map rows with no region", '=COUNTIFS(Region_Map!A2:A2000,"<>",Region_Map!B2:B2000,"")', "0"),
        ("Tasks without milestone", "Task_Milestones rows with no milestone", '=COUNTIFS(Task_Milestones!A2:A5000,"<>",Task_Milestones!D2:D5000,"")', "0 for active tasks"),
        ("Events still TBC", "Events with status TBC", '=COUNTIF(Events!F2:F500,"TBC")', "0"),
        ("Stages without SLA", "Stages rows with no sla_days", '=COUNTIFS(Stages!A2:A500,"<>",Stages!H2:H500,"")', "0 (except P2 if no SLA)"),
        ("MOP link for this month", "MOP_Links rows for the current month", '=COUNTIF(MOP_Links!A2:A200,TEXT(TODAY(),"yyyy-mm"))', "1"),
    ]
    for label, what, formula, target in checks:
        r += 1
        put(r, 1, label); put(r, 2, what); put(r, 3, formula, F_BOLD, wrap=False); put(r, 4, target)
    ws.freeze_panes = "A4"

    # Lists and Change_Log go last; README first.
    order = ["README", "Settings", "Users", "AVP_Map", "Expansion_List", "Region_Map", "Task_Milestones", "Milestones",
             "P2_Task_Overrides", "Events", "Stages", "MOP_Links", "Lists", "Change_Log"]
    wb._sheets = [wb[name] for name in order]
    wb.active = 0
    wb.calculation.fullCalcOnLoad = True  # openpyxl stores no cached results; make Excel / Sheets compute on open

    out = REPO_ROOT / "config" / "template" / f"Ops_Dashboard_Config_v{version}.xlsx"
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out)
    return out.relative_to(REPO_ROOT).as_posix()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--version", default="0.1")
    print("wrote", build(ap.parse_args(argv).version))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
