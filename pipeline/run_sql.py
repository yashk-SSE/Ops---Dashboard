"""Run read-only SQL files against the SolarSquare database through Metabase.

Usage (from the repo root):
    python -m pipeline.run_sql sql/exploration/01_usertasks_status_mix.sql [more.sql ...]

Each file holds ONE SELECT/WITH query. Results (max 2,000 rows) are saved to
data/raw/exploration/<file-stem>.json (git-ignored) and the first rows are printed.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

from pipeline.config import REPO_ROOT, require
from pipeline.extract.metabase import MetabaseClient, MetabaseError
from pipeline.probe_metabase import write_json

DB_ID = 2
OUT = REPO_ROOT / "data" / "raw" / "exploration"


def strip_comments(sql: str) -> str:
    lines = [ln for ln in sql.splitlines() if not ln.strip().startswith("--")]
    return "\n".join(lines).strip().rstrip(";")


def show(cols: list[str], rows: list[list], limit: int) -> None:
    shown = [[("" if v is None else str(v))[:40] for v in r] for r in rows[:limit]]
    widths = [max([len(c)] + [len(r[i]) for r in shown]) for i, c in enumerate(cols)]
    print("  " + " | ".join(c.ljust(w) for c, w in zip(cols, widths)))
    print("  " + "-+-".join("-" * w for w in widths))
    for r in shown:
        print("  " + " | ".join(v.ljust(w) for v, w in zip(r, widths)))
    if len(rows) > limit:
        print(f"  ... {len(rows) - limit} more rows in the saved file")


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    parser = argparse.ArgumentParser(description="Run read-only SQL files via Metabase.")
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("--show", type=int, default=40, help="rows to print per query")
    args = parser.parse_args(argv)

    client = MetabaseClient(require("METABASE_URL"), require("METABASE_API_KEY"))
    status = 0
    for path in args.files:
        sql = strip_comments(path.read_text(encoding="utf-8"))
        print(f"\n=== {path.as_posix()} ===")
        try:
            res = client.run_sql(DB_ID, sql) or {}
        except MetabaseError as exc:
            print(f"  ERROR: {exc}")
            status = 1
            continue
        if res.get("status") == "failed" or res.get("error"):
            print(f"  QUERY ERROR: {str(res.get('error'))[:400]}")
            status = 1
            continue
        data = res.get("data") or {}
        cols = [c.get("name") for c in data.get("cols", [])]
        rows = data.get("rows", [])
        write_json(OUT / f"{path.stem}.json", {
            "file": path.as_posix(), "ran_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "running_time_ms": res.get("running_time"), "truncated": bool(data.get("rows_truncated")),
            "columns": cols, "rows": rows,
        })
        print(f"  {len(rows)} rows, {res.get('running_time')} ms{' (truncated)' if data.get('rows_truncated') else ''}")
        show(cols, rows, args.show)
    return status


if __name__ == "__main__":
    raise SystemExit(main())
