"""Build the Ops CT logic review pack from the logic register.

Source of truth : docs/logic/logic-register.csv (one row per logic / rule)
Also reads      : config/seed/events.csv, docs/stage-mapping/task-key-dictionary.csv, docs/open-questions.md
Writes          : docs/logic/Ops_Dashboard_Logic_Review_v<version>.xlsx (review workbook with CT verdict columns)
                  docs/logic/logic-register.md (readable copy)

Usage:  python -m pipeline.tools.build_logic_review [--version 1]
"""
from __future__ import annotations

import argparse
import csv
import re
from collections import Counter, OrderedDict
from datetime import date

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

from pipeline.config import REPO_ROOT

FONT = "Arial"
F_BODY = Font(name=FONT, size=10)
F_HEAD = Font(name=FONT, size=10, bold=True, color="FFFFFF")
F_TITLE = Font(name=FONT, size=14, bold=True, color="1F3864")
F_BOLD = Font(name=FONT, size=10, bold=True)
F_GREY = Font(name=FONT, size=10, color="7F7F7F")
FILL_HEAD = PatternFill("solid", fgColor="1F3864")
FILL_INPUT = PatternFill("solid", fgColor="FFF2CC")
STATUS_FILL = {
    "Confirmed": PatternFill("solid", fgColor="E2EFDA"),
    "Proposed": PatternFill("solid", fgColor="DDEBF7"),
    "Provisional": PatternFill("solid", fgColor="FCE4D6"),
    "Open": PatternFill("solid", fgColor="F8CBAD"),
}
WRAP = Alignment(wrap_text=True, vertical="top")
VERDICTS = ["Agree", "Change", "Not sure"]

DATA_ISSUES = [
    ("K-01", "Installation date", "Task 039B and project.installation_date fall on the same day only 62% of the time (87% within 24 h; 039B ~4.7 h earlier on median). We follow the existing queries (039B)."),
    ("K-02", "Delay reasons", "System dependency tags exist on only 38% of pending-commissioning projects; CT's Sub-Reasons rarely line up with them."),
    ("K-03", "Region", "Region is blank for 1,173 installed projects; 16 cities have no region at all (Config Region_Map to fill)."),
    ("K-04", "Commissioning before installation", "1,086 projects have commissioning dated before 039B, nearly all from 2020-2023. Excluded from TAT."),
    ("K-05", "Central Base payment dates", "Q-517 labels task 027 as 'payment_2_received_date_emi', but task 027 is the Payment 1 confirmation; it feeds both P1 and EMI P2 date columns."),
    ("K-06", "Central Base stage mapping", "The Validation tab maps status 'Pending Commissioning' to 'Completed'."),
    ("K-07", "Design docket date", "Task 019 (design docket sent) has not been created in the last year, so that Central Base column is always empty."),
    ("K-08", "Pan India sheet lag", "34 projects on the Pan India pending list are already commissioned in the system (the sheet refreshes less often)."),
    ("K-09", "Cell role coverage", "Cell roles give SOH for only 36% and ZOH for 9% of this year's installs; that is why SOH / ZOH come from the project fields."),
    ("K-10", "Timezones", "Existing Metabase queries handle UTC / IST differently; our pipeline converts everything to IST once."),
    ("K-11", "Task name variants", "Some task names differ by spelling or state ('and' vs '&', BESCOM / Format 6 tasks); 33 recently done tasks are not in Sheet3."),
    ("K-12", "Name casing", "People's names are stored in mixed case ('virendra kushwah'); shown in Title Case."),
]


def read_csv(path) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def open_questions() -> list[dict]:
    rows = []
    for line in open(REPO_ROOT / "docs/open-questions.md", encoding="utf-8"):
        m = re.match(r"\| (OQ-\d+) \|", line)
        if not m:
            continue
        cells = [c.strip() for c in line.strip().strip("|").split(" | ")]
        if len(cells) < 4:
            continue
        status = cells[3]
        if status.startswith("**Answered**"):
            continue
        clean = lambda s: re.sub(r"\*\*|`", "", s)
        rows.append({"id": cells[0], "question": clean(cells[1]), "why": clean(cells[2]), "status": clean(status)})
    return rows


def table(ws, headers: list[tuple], rows: list[list], input_from: int | None = None, status_col: int | None = None,
          verdict_col: int | None = None, spare: int = 0) -> None:
    for i, (name, width, note) in enumerate(headers, start=1):
        c = ws.cell(row=1, column=i, value=name)
        c.font, c.fill, c.alignment = F_HEAD, FILL_HEAD, Alignment(vertical="center", wrap_text=True)
        if note:
            c.comment = Comment(note, "Logic review")
        ws.column_dimensions[get_column_letter(i)].width = width
    for r, row in enumerate(rows, start=2):
        for i, v in enumerate(row, start=1):
            c = ws.cell(row=r, column=i, value=v if v != "" else None)
            c.font, c.alignment = F_BODY, WRAP
            if input_from and i >= input_from:
                c.fill = FILL_INPUT
            if status_col and i == status_col and v in STATUS_FILL:
                c.fill = STATUS_FILL[v]
    for r in range(len(rows) + 2, len(rows) + 2 + spare):
        for i in range(input_from or len(headers) + 1, len(headers) + 1):
            ws.cell(row=r, column=i).fill = FILL_INPUT
    if verdict_col:
        L = get_column_letter(verdict_col)
        dv = DataValidation(type="list", formula1=f'"{",".join(VERDICTS)}"', allow_blank=True)
        ws.add_data_validation(dv)
        dv.add(f"{L}2:{L}{len(rows) + 1 + spare}")
    ws.freeze_panes = "B2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{len(rows) + 1}"


def build(version: str) -> tuple[str, str]:
    today = date.today()
    reg = read_csv(REPO_ROOT / "docs/logic/logic-register.csv")
    events = read_csv(REPO_ROOT / "config/seed/events.csv")
    keys = [k for k in read_csv(REPO_ROOT / "docs/stage-mapping/task-key-dictionary.csv") if k["used_in"]]
    oq = open_questions()

    wb = Workbook()
    readme = wb.active
    readme.title = "README"

    ws = wb.create_sheet("Logic_Review")
    table(ws, [("id", 7, None), ("area", 18, None), ("topic", 20, None),
               ("logic (plain language)", 60, "What the dashboard will do"),
               ("system detail", 34, "Field / task code used"),
               ("status", 11, "Confirmed = agreed with Yash; Provisional = agreed for now; Proposed = Claude's draft from existing queries / data; Open = needs an answer"),
               ("source", 16, "Decision (D-xx), open question (OQ-xx) or Metabase question (Q-xxx)"),
               ("evidence / check", 40, "What the data or today's sheets show"),
               ("CT verdict", 11, "Agree / Change / Not sure"), ("CT comment", 40, "What should change, or the answer"),
               ("reviewed by", 14, None), ("reviewed on", 12, None)],
          [[r["id"], r["area"], r["topic"], r["logic"], r["system_detail"], r["status"], r["source"], r["evidence"], "", "", "", ""] for r in reg],
          input_from=9, status_col=6, verdict_col=9)

    ws = wb.create_sheet("Events")
    table(ws, [("event_id", 18, None), ("event", 28, None), ("type", 14, None), ("task codes / field", 26, None), ("pick", 7, None),
               ("status", 11, None), ("notes", 46, None), ("CT verdict", 11, None), ("CT comment", 40, None)],
          [[e["event_id"], e["event_name"], e["type"], e["ref"], e["pick"], e["status"], e["notes"], "", ""] for e in events],
          input_from=8, verdict_col=8)

    ws = wb.create_sheet("Task_Codes")
    table(ws, [("task code", 10, None), ("task name(s) in system", 44, None), ("used today as", 44, "Meaning given by the existing Metabase queries"),
               ("used in", 16, None), ("Sheet3 milestone", 30, None), ("done in last 30 days", 11, None), ("notes", 30, None),
               ("CT verdict", 11, None), ("CT comment", 40, None)],
          [[k["key"], k["task_names_30d"], k["existing_query_meaning"], k["used_in"], k["sheet3_milestone"], int(k["done_30d"] or 0), k["notes"], "", ""]
           for k in keys], input_from=8, verdict_col=8)

    ws = wb.create_sheet("Open_Questions")
    table(ws, [("id", 8, None), ("question", 70, None), ("why it matters", 30, None), ("current status", 40, None),
               ("CT answer", 50, None), ("answered by", 14, None)],
          [[q["id"], q["question"], q["why"], q["status"], "", ""] for q in oq], input_from=5)

    ws = wb.create_sheet("Data_Issues")
    table(ws, [("id", 7, None), ("topic", 26, None), ("what we found", 90, None), ("CT comment", 50, None)],
          [[i, t, d, ""] for i, t, d in DATA_ISSUES], input_from=4)

    # ---------------------------------------------------------------- README
    ws = readme
    for col, w in zip("ABCD", (30, 70, 14, 14)):
        ws.column_dimensions[col].width = w
    def put(r, c, v, font=F_BODY, fill=None):
        cell = ws.cell(row=r, column=c, value=v)
        cell.font, cell.alignment = font, WRAP
        if fill:
            cell.fill = fill
    put(1, 1, f"Ops Dashboard - Logic Review v{version}", F_TITLE)
    put(2, 1, f"Generated {today:%d %b %Y} from docs/logic/logic-register.csv. For Ops CT review.", F_GREY)
    put(4, 1, "What to do", F_BOLD)
    put(4, 2, "Go through Logic_Review, Events and Task_Codes. In each row, pick a CT verdict (Agree / Change / Not sure) and add a comment "
              "when something should change. Answer what you can in Open_Questions, and comment on Data_Issues. Only the yellow columns need input.")
    put(5, 1, "Status meanings", F_BOLD)
    put(5, 2, "Confirmed = agreed with Yash.  Provisional = agreed for now, may change.  Proposed = Claude's draft from the existing Metabase "
              "queries and data checks.  Open = needs an answer.")
    put(6, 1, "Codes", F_BOLD)
    put(6, 2, "D-xx = decision log; OQ-xx = open question; Q-xxx = existing Metabase question; task codes like 039B are usertask keys.")
    put(8, 1, "Summary", F_HEAD, FILL_HEAD); put(8, 2, "Count", F_HEAD, FILL_HEAD)
    summary = [
        ("Logic rows", "=COUNTA(Logic_Review!A2:A1000)"),
        ("  Confirmed", '=COUNTIF(Logic_Review!F2:F1000,"Confirmed")'),
        ("  Provisional", '=COUNTIF(Logic_Review!F2:F1000,"Provisional")'),
        ("  Proposed", '=COUNTIF(Logic_Review!F2:F1000,"Proposed")'),
        ("  Open", '=COUNTIF(Logic_Review!F2:F1000,"Open")'),
        ("Reviewed by CT", "=COUNTA(Logic_Review!I2:I1000)"),
        ("  Agree", '=COUNTIF(Logic_Review!I2:I1000,"Agree")'),
        ("  Change", '=COUNTIF(Logic_Review!I2:I1000,"Change")'),
        ("  Not sure", '=COUNTIF(Logic_Review!I2:I1000,"Not sure")'),
        ("Events to review", "=COUNTA(Events!A2:A1000)"),
        ("Task codes to review", "=COUNTA(Task_Codes!A2:A1000)"),
        ("Open questions", "=COUNTA(Open_Questions!A2:A1000)"),
        ("Known data issues", "=COUNTA(Data_Issues!A2:A1000)"),
    ]
    for i, (label, formula) in enumerate(summary, start=9):
        put(i, 1, label); put(i, 2, formula, F_BOLD)
    r = 9 + len(summary) + 1
    put(r, 1, "Legend", F_BOLD)
    for j, (name, fill) in enumerate(list(STATUS_FILL.items()) + [("CT input", FILL_INPUT)], start=1):
        put(r + j, 1, name, F_BODY, fill)
    wb.calculation.fullCalcOnLoad = True
    xlsx = REPO_ROOT / "docs" / "logic" / f"Ops_Dashboard_Logic_Review_v{version}.xlsx"
    wb.save(xlsx)

    # ---------------------------------------------------------------- Markdown copy
    by_area: "OrderedDict[str, list]" = OrderedDict()
    for row in reg:
        by_area.setdefault(row["area"], []).append(row)
    counts = Counter(r["status"] for r in reg)
    md = [f"# Logic Register (v{version})", "",
          "> Every rule the dashboard uses or will use, with its status. Generated from `docs/logic/logic-register.csv` by "
          "`python -m pipeline.tools.build_logic_review`, which also writes the Ops CT review workbook "
          f"`Ops_Dashboard_Logic_Review_v{version}.xlsx`.",
          f"> Last generated: {today:%Y-%m-%d} · {len(reg)} rules: " + ", ".join(f"{k} {v}" for k, v in counts.most_common()), "",
          "**Status:** Confirmed = agreed with Yash · Provisional = agreed for now · Proposed = Claude's draft from existing queries / data · Open = needs an answer", ""]
    esc = lambda s: (s or "").replace("|", "/")
    for area, rows in by_area.items():
        md += [f"## {area}", "", "| ID | Topic | Logic | System detail | Status | Source | Evidence |", "|---|---|---|---|---|---|---|"]
        md += [f"| {r['id']} | {esc(r['topic'])} | {esc(r['logic'])} | {esc(r['system_detail'])} | {r['status']} | {esc(r['source'])} | {esc(r['evidence'])} |" for r in rows]
        md.append("")
    md += ["## Events (named dates)", "", "| Event | Type | Task codes / field | Pick | Status | Notes |", "|---|---|---|---|---|---|"]
    md += [f"| {e['event_id']} ({esc(e['event_name'])}) | {e['type']} | {esc(e['ref'])} | {e['pick']} | {e['status']} | {esc(e['notes'])} |" for e in events]
    md += ["", "## Known data issues", "", "| ID | Topic | What we found |", "|---|---|---|"]
    md += [f"| {i} | {t} | {esc(d)} |" for i, t, d in DATA_ISSUES]
    md += ["", f"## Open questions ({len(oq)})", "", "See `docs/open-questions.md` for full context.", "", "| ID | Question | Status |", "|---|---|---|"]
    md += [f"| {q['id']} | {esc(q['question'])} | {esc(q['status'])} |" for q in oq]
    mdp = REPO_ROOT / "docs" / "logic" / "logic-register.md"
    mdp.write_text("\n".join(md) + "\n", encoding="utf-8")
    return xlsx.relative_to(REPO_ROOT).as_posix(), mdp.relative_to(REPO_ROOT).as_posix()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--version", default="1")
    x, m = build(ap.parse_args(argv).version)
    print("wrote", x, "and", m)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
