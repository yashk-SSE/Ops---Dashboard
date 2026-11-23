"""Probe Metabase before we design anything on top of it.

For each saved question (card) ID, this script:
  1. reads its definition (name, collection, database, parameters, columns)
  2. saves the SQL behind it: native SQL as written, or the SQL Metabase compiles for a GUI question
  3. runs it once and keeps a sample of rows (max 2,000) so we can study real values

Usage (from the repo root):
    python -m pipeline.probe_metabase 2259 5896 517 1529 4039

Writes:
    sql/metabase/q<ID>_<slug>.sql          SQL snapshot of each question (committed: logic is documentation)
    data/raw/metabase/q<ID>_card.json      full question definition from Metabase   (git-ignored)
    data/raw/metabase/q<ID>_sample.json    columns + sample rows                    (git-ignored: customer data)
    data/raw/metabase/probe_summary.json   what was found, per question             (git-ignored)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pipeline.config import REPO_ROOT, require
from pipeline.extract.metabase import MetabaseClient, MetabaseError

SQL_DIR = REPO_ROOT / "sql" / "metabase"
RAW_DIR = REPO_ROOT / "data" / "raw" / "metabase"


def slugify(text: str | None, max_len: int = 50) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", (text or "").lower()).strip("_")
    return slug[:max_len].rstrip("_") or "untitled"


def write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False, default=str), encoding="utf-8")


def rel(path: Path) -> str:
    return path.relative_to(REPO_ROOT).as_posix()


def save_sql(card_id: int, info: dict, sql: str, note: str, fetched_at: str) -> Path:
    SQL_DIR.mkdir(parents=True, exist_ok=True)
    path = SQL_DIR / f"q{card_id}_{slugify(info.get('name'))}.sql"
    header = [
        f"-- Metabase question {card_id}: {info.get('name')}",
        f"-- Collection: {info.get('collection')}",
        f"-- Database: {info.get('database')}",
        f"-- Fetched: {fetched_at} by pipeline.probe_metabase",
    ]
    if note:
        header.append(f"-- Note: {note}")
    header.append("-- Snapshot of the source question. Do not edit by hand; re-run the probe to refresh.")
    path.write_text("\n".join(header) + "\n\n" + sql.strip() + "\n", encoding="utf-8")
    return path


def probe_card(client: MetabaseClient, card_id: int, db_names: dict, fetched_at: str) -> dict:
    info: dict[str, Any] = {"id": card_id}

    # 1. Definition
    try:
        card = client.card(card_id)
    except MetabaseError as exc:
        info["error"] = str(exc)
        return info
    write_json(RAW_DIR / f"q{card_id}_card.json", card)

    dq = card.get("dataset_query") or {}
    is_sql = dq.get("type") == "native"
    db_id = card.get("database_id") or dq.get("database")
    tags = ((dq.get("native") or {}).get("template-tags") or {}) if is_sql else {}
    info.update(
        name=card.get("name"),
        collection=(card.get("collection") or {}).get("name", "(root)"),
        database=db_names.get(db_id, db_id),
        query_type="SQL" if is_sql else "GUI",
        archived=card.get("archived", False),
        parameters=[
            {"name": t.get("name"), "type": t.get("type"), "required": t.get("required", False),
             "default": t.get("default")}
            for t in tags.values()
        ],
    )

    # 2. SQL
    sql, note = "", ""
    if is_sql:
        sql = (dq.get("native") or {}).get("query", "")
    else:
        try:
            sql = client.compile_to_sql(dq)
            note = "Compiled by Metabase from a GUI (non-SQL) question."
        except MetabaseError as exc:
            note = f"Could not compile GUI question to SQL: {exc}"
    if sql:
        info["sql_file"] = rel(save_sql(card_id, info, sql, note, fetched_at))
    elif note:
        info["sql_note"] = note

    # 3. Sample run
    try:
        res = client.run_card(card_id) or {}
    except MetabaseError as exc:
        info["run_error"] = str(exc)
        return info
    if res.get("status") == "failed" or res.get("error"):
        info["run_error"] = str(res.get("error"))[:400]
        return info
    data = res.get("data") or {}
    cols = [{"name": c.get("name"), "display_name": c.get("display_name"), "base_type": c.get("base_type")}
            for c in data.get("cols", [])]
    rows = data.get("rows", [])
    write_json(RAW_DIR / f"q{card_id}_sample.json", {
        "card_id": card_id, "name": info["name"], "fetched_at": fetched_at,
        "row_count_returned": res.get("row_count"), "rows_truncated_at": data.get("rows_truncated"),
        "columns": cols, "rows": rows,
    })
    info.update(
        columns=[c["name"] for c in cols],
        rows_returned=len(rows),
        truncated=bool(data.get("rows_truncated")),
        running_time_ms=res.get("running_time"),
    )
    return info


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # Windows consoles default to cp1252
    except AttributeError:
        pass

    parser = argparse.ArgumentParser(description="Probe Metabase saved questions.")
    parser.add_argument("card_ids", nargs="+", type=int, help="Metabase question IDs, e.g. 2259 5896")
    args = parser.parse_args(argv)

    client = MetabaseClient(require("METABASE_URL"), require("METABASE_API_KEY"))
    fetched_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    try:
        print(f"Metabase version: {client.version()}")
    except MetabaseError as exc:
        print(f"Could not read Metabase version: {exc}")

    try:
        user = client.current_user() or {}
        print(f"API key OK. Acting as: {user.get('common_name') or user.get('first_name') or 'API key user'}")
    except MetabaseError as exc:
        print(f"API key check failed: {exc}")
        return 1

    try:
        dbs = client.databases()
    except MetabaseError as exc:
        print(f"Could not list databases: {exc}")
        dbs = []
    db_names = {d.get("id"): f"{d.get('name')} ({d.get('engine')})" for d in dbs}
    print(f"\nDatabases visible to this key ({len(dbs)}):")
    for d in dbs:
        print(f"  [{d.get('id')}] {d.get('name')}  engine={d.get('engine')}")

    results = []
    for card_id in args.card_ids:
        print(f"\n--- Question {card_id} ---")
        info = probe_card(client, card_id, db_names, fetched_at)
        results.append(info)
        if "error" in info:
            print(f"  ERROR reading question: {info['error']}")
            continue
        print(f"  Name:       {info['name']}")
        print(f"  Collection: {info['collection']}   Database: {info['database']}   Type: {info['query_type']}")
        if info.get("archived"):
            print("  NOTE: question is archived")
        if info["parameters"]:
            print(f"  Parameters: {', '.join(p['name'] + (' (required)' if p['required'] else '') for p in info['parameters'])}")
        print(f"  SQL:        {info.get('sql_file') or info.get('sql_note', 'none')}")
        if "run_error" in info:
            print(f"  RUN ERROR:  {info['run_error']}")
            continue
        more = " (truncated: more rows exist)" if info["truncated"] else ""
        print(f"  Sample:     {info['rows_returned']} rows{more}, {len(info['columns'])} columns, {info['running_time_ms']} ms")
        print(f"  Columns:    {', '.join(info['columns'])}")

    write_json(RAW_DIR / "probe_summary.json", {"fetched_at": fetched_at, "databases": dbs, "cards": results})
    print(f"\nSaved: {rel(RAW_DIR / 'probe_summary.json')} and per-question files under {rel(RAW_DIR)} / {rel(SQL_DIR)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
