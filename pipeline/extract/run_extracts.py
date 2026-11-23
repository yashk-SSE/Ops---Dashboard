"""Run extract SQL files through Metabase's export endpoint (all rows) and save them raw.

Usage (from the repo root):
    python -m pipeline.extract.run_extracts sql/extract/p2_installed_projects.sql sql/extract/p2_pending_open_tasks.sql

Writes data/raw/extract/<file-stem>.json = {"extracted_at": ..., "sql_file": ..., "row_count": n, "rows": [...]}
(git-ignored). Each file must hold one read-only SELECT / WITH query.
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from pipeline.config import REPO_ROOT, require
from pipeline.extract.metabase import MetabaseClient, MetabaseError
from pipeline.probe_metabase import write_json
from pipeline.run_sql import strip_comments

DB_ID = 2
OUT = REPO_ROOT / "data" / "raw" / "extract"


def run(paths: list[Path]) -> int:
    client = MetabaseClient(require("METABASE_URL"), require("METABASE_API_KEY"), timeout=600)
    status = 0
    for path in paths:
        sql = strip_comments(path.read_text(encoding="utf-8"))
        started = time.time()
        try:
            rows = client.export_sql(DB_ID, sql)
        except MetabaseError as exc:
            print(f"FAILED {path.as_posix()}: {exc}")
            status = 1
            continue
        write_json(OUT / f"{path.stem}.json", {
            "extracted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "sql_file": path.as_posix(), "row_count": len(rows), "rows": rows,
        })
        print(f"OK {path.as_posix()}: {len(rows):,} rows in {time.time() - started:.1f}s")
    return status


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    parser = argparse.ArgumentParser(description="Run extract SQL files (all rows).")
    parser.add_argument("files", nargs="+", type=Path)
    return run(parser.parse_args(argv).files)


if __name__ == "__main__":
    raise SystemExit(main())
