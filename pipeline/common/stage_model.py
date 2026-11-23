"""Config-driven stage model (D-43): events + stages from config/seed (later: the Config Google Sheet).

events.csv  event_id, event_name, type, ref, pick, status, ...
            type = project_field  -> a date column on the project extract (see FIELD_MAP)
                   task_done      -> completion of task key(s); pick first / last
                   greatest_of    -> latest of other events; only when ALL are present (as Q-1529 does for RTI)
                   by_lane        -> a different event per payment lane, ref = "DIRECT=E_X,NBFC=E_Y,PSU=E_Z" (D-61)
                   milestone_done -> not supported yet (needs Task_Milestones join); returns None
stages.csv  stage_id, section, stage_name, stage_order, start_event, end_event, applies_to, sla_days, ...

An event with an empty ref (status TBC) simply yields no date, so its stage shows as 'definition pending'
until Ops CT fills it in. No code change needed.
"""
from __future__ import annotations

import csv
import re
import time
from datetime import date, datetime

from pipeline.common.dates import IST, parse_ts
from pipeline.config import REPO_ROOT
from pipeline.extract.metabase import MetabaseClient
from pipeline.run_sql import strip_comments

SEED = REPO_ROOT / "config" / "seed"
SQL_TASKS = REPO_ROOT / "sql" / "extract" / "task_completions.sql"
FIELD_MAP = {  # project column in events.csv -> column name in sql/extract/project_dim.sql
    "sales_handover_datetime": "hoto_at",
    "order_closure_datetime": "order_at",
    "commissioning_date": "commissioned_at",
}
KEY_RE = re.compile(r"^[A-Za-z0-9]+$")
OBJECT_ID = re.compile(r"^[0-9a-f]{24}$")


def load_events() -> dict[str, dict]:
    out = {}
    for row in csv.DictReader(open(SEED / "events.csv", encoding="utf-8")):
        refs = [x.strip() for x in (row["ref"] or "").split(",") if x.strip()]
        out[row["event_id"]] = {**row, "refs": refs}
    return out


def load_stages(section_prefix: str) -> list[dict]:
    rows = [r for r in csv.DictReader(open(SEED / "stages.csv", encoding="utf-8")) if r["section"].startswith(section_prefix)]
    return sorted(rows, key=lambda r: int(r["stage_order"]))


def needed_keys(events: dict, event_ids: set[str]) -> list[str]:
    keys, todo, seen = set(), list(event_ids), set()
    while todo:
        eid = todo.pop()
        if eid in seen or eid not in events:
            continue
        seen.add(eid)
        ev = events[eid]
        if ev["type"] == "task_done":
            keys.update(ev["refs"])
        elif ev["type"] in ("greatest_of", "first_available"):
            todo.extend(ev["refs"])
        elif ev["type"] == "by_lane":
            todo.extend(r.split("=", 1)[1].strip() for r in ev["refs"] if "=" in r)
    bad = [k for k in keys if not KEY_RE.match(k)]
    if bad:
        raise ValueError(f"invalid task keys in events.csv: {bad}")
    return sorted(keys)


def extract_completions(client: MetabaseClient, db_id: int, project_ids: list[str], keys: list[str],
                        chunk: int = 1000) -> dict[str, dict]:
    """project_id -> {'first_<key>': epoch_ms, 'last_<key>': epoch_ms, ...} for done tasks."""
    template = strip_comments(SQL_TASKS.read_text(encoding="utf-8"))
    pivot = ",\n".join(
        f"  min(case when t.key = '{k}' then nullif(t.\"timeCompleted\", '-1')::numeric end) as \"first_{k}\",\n"
        f"  max(case when t.key = '{k}' then nullif(t.\"timeCompleted\", '-1')::numeric end) as \"last_{k}\""
        for k in keys)
    key_list = ",".join(f"'{k}'" for k in keys)
    ids = [i for i in project_ids if i and OBJECT_ID.match(i)]
    out: dict[str, dict] = {}
    t0 = time.time()
    for i in range(0, len(ids), chunk):
        in_list = ",".join(f"'{x}'" for x in ids[i:i + chunk])
        sql = template.replace("{pivot_columns}", pivot).replace("{task_keys}", key_list).replace("{project_ids}", in_list)
        for row in client.export_sql(db_id, sql):
            out[row.pop("project_id")] = row
    print(f"extract task completions: {len(out):,} projects with any of {len(keys)} keys, "
          f"{(len(ids) + chunk - 1) // chunk} chunks, {time.time() - t0:.1f}s")
    return out


def _ms_to_dt(v) -> datetime | None:
    if v in (None, ""):
        return None
    return parse_ts(int(float(v)))


def event_datetime(eid: str, project: dict, comp: dict, events: dict, cache: dict) -> datetime | None:
    if eid in cache:
        return cache[eid]
    ev = events.get(eid)
    val = None
    if ev and ev["refs"]:
        if ev["type"] == "project_field":
            val = parse_ts(project.get(FIELD_MAP.get(ev["refs"][0], ev["refs"][0])))
        elif ev["type"] == "task_done":
            pick = ev.get("pick") or "last"
            vals = [_ms_to_dt(comp.get(f"{pick}_{k}")) for k in ev["refs"]]
            vals = [v for v in vals if v]
            val = (min(vals) if pick == "first" else max(vals)) if vals else None
        elif ev["type"] == "greatest_of":
            vals = [event_datetime(r, project, comp, events, cache) for r in ev["refs"]]
            val = max(vals) if vals and all(vals) else None
        elif ev["type"] == "first_available":  # first event in the list that has a date (D-76: lender RFD, else E004A)
            for r in ev["refs"]:
                val = event_datetime(r, project, comp, events, cache)
                if val:
                    break
        elif ev["type"] == "by_lane":
            lanes = dict(r.split("=", 1) for r in ev["refs"] if "=" in r)
            target = lanes.get(project.get("payment_lane") or "")
            val = event_datetime(target.strip(), project, comp, events, cache) if target else None
    cache[eid] = val
    return val


def to_ist_date(dt: datetime | None) -> date | None:
    return dt.astimezone(IST).date() if dt else None


def applies(stage: dict, project: dict, start_dt: datetime | None = None) -> bool:
    """Lane filter from stages.applies_to.

    'LC/NC/PC started' (provisional, OQ-60): LC / NC / PC flagged AND a bill-correction application task exists.
    Needed because in Maharashtra net-metering processes the load change runs inside the NM sanction steps,
    with no LC tasks at all (~10k projects show lc_status 'LC Completed' without P013 / P020).
    """
    rule = (stage.get("applies_to") or "All").strip()
    lane = project.get("payment_lane")
    flagged = any(project.get(k) == "Yes" for k in ("lc", "nc", "pc"))
    if rule == "All":
        return True
    if rule == "LC/NC/PC only":
        return flagged
    if rule == "LC/NC/PC started":
        return flagged and start_dt is not None
    return {"NBFC only": lane == "NBFC", "PSU only": lane == "PSU", "Direct only": lane == "DIRECT"}.get(rule, True)


def defined(stage: dict, events: dict) -> bool:
    """A stage is computable only when both its events have a definition (non-empty ref)."""
    return all(events.get(stage[k], {}).get("refs") for k in ("start_event", "end_event"))
