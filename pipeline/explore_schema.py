"""List the columns of database tables, from Metabase's synced metadata (no data is queried).

Usage (from the repo root):
    python -m pipeline.explore_schema usertasks project cell
    python -m pipeline.explore_schema --list            # every table name

Writes data/raw/metabase/schema/<table>.json (git-ignored) and prints a column summary.
"""
from __future__ import annotations

import argparse
import sys

from pipeline.config import REPO_ROOT, require
from pipeline.extract.metabase import MetabaseClient, MetabaseError
from pipeline.probe_metabase import write_json

DB_ID = 2  # "SolarSquare" Postgres database in Metabase
OUT = REPO_ROOT / "data" / "raw" / "metabase" / "schema"


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("tables", nargs="*", help="table names (schema public)")
    parser.add_argument("--list", action="store_true", help="print every table name and exit")
    parser.add_argument("--db", type=int, default=DB_ID)
    args = parser.parse_args(argv)

    client = MetabaseClient(require("METABASE_URL"), require("METABASE_API_KEY"))
    tables = client.tables(args.db)
    by_name = {t["name"]: t for t in tables}
    if args.list or not args.tables:
        for name in sorted(by_name):
            print(name)
        return 0

    for name in args.tables:
        t = by_name.get(name)
        if not t:
            print(f"\n## {name}: not found / not visible")
            continue
        try:
            meta = client.table_fields(t["id"])
        except MetabaseError as exc:
            print(f"\n## {name}: {exc}")
            continue
        write_json(OUT / f"{name}.json", meta)
        fields = sorted(meta.get("fields", []), key=lambda f: f.get("position", 0))
        print(f"\n## {name}  (table id {t['id']}, {len(fields)} columns)")
        for f in fields:
            sem = f.get("semantic_type") or ""
            fk = " FK" if f.get("fk_target_field_id") else ""
            print(f"  {f.get('name')}  [{f.get('database_type')}] {sem}{fk}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
