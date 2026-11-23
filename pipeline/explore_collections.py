"""Catalogue Metabase collections: every question / model / dashboard with its SQL and output columns.

Reads DEFINITIONS only (no data rows are queried). Read-only API calls.

Usage:
  python -m pipeline.explore_collections --key-var METABASE_API_KEY_OPS \
      --collections "COE Ops" "OMS Adoption Reports" "COE Ops Analytics"

Writes:
  data/raw/metabase/collections/catalogue.json      full catalogue (git-ignored: raw metadata)
  sql/metabase/collections/<collection>/<id>_<slug>.sql   each question's SQL (native, or compiled from the GUI query)
and prints a short access + inventory summary. The API key is read from .env and never printed.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from pipeline.config import REPO_ROOT, require
from pipeline.extract.metabase import MetabaseClient, MetabaseError

DB_ID = 2  # "SolarSquare" Postgres
RAW = REPO_ROOT / "data" / "raw" / "metabase" / "collections"
SQL_DIR = REPO_ROOT / "sql" / "metabase" / "collections"
RECHECK_CARDS = (517, 1529, 2259, 4039, 5896)  # questions Yash shared; 2259 / 5896 were 403 for the Referral key


EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE = re.compile(r"(?<![0-9A-Fa-f])(?:\+?91[- ]?)?[6-9][0-9]{9}(?![0-9A-Fa-f])")


def redact(sql: str) -> str:
    """Saved SQL is committed: mask email addresses and Indian mobile-number-like literals (D-18, no PII in the repo)."""
    return PHONE.sub("<number redacted>", EMAIL.sub("<email redacted>", sql or ""))


def slug(s: str, n: int = 60) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (s or "").lower()).strip("_")[:n] or "untitled"


def card_sql(mb: MetabaseClient, card: dict) -> tuple[str, str]:
    """(kind, sql) for a card: native SQL as written, or Metabase's compiled SQL for a GUI question."""
    dq = card.get("dataset_query") or {}
    if dq.get("type") == "native":  # legacy MBQL shape
        return "native", (dq.get("native") or {}).get("query", "")
    stages = dq.get("stages") or []  # pMBQL shape (Metabase 0.5x+): {"lib/type": "mbql/query", "stages": [...]}
    if stages and stages[0].get("lib/type") == "mbql.stage/native":
        return "native", stages[0].get("native", "")
    # MBQL / pMBQL (GUI) question: ask Metabase for the SQL it would run
    try:
        return "gui", mb.compile_to_sql(dq)
    except MetabaseError as exc:
        return "gui", f"-- could not compile: {exc}"


INDEX_CSV = REPO_ROOT / "docs" / "data-sources" / "metabase-collections-index.csv"
# First matching theme wins (by question name). Only a reading aid for the index, not a definition.
THEMES = [
    ("TAT / SLA / escalation", r"sla|tat|breach|escalat|aging|ageing|delay|pendency|pending|dependency"),
    ("QHSE / audit", r"qhse|audit|safety|observation|snag|\bpp\b"),
    ("Subsidy", r"subsid|subidy"),
    ("NBFC / PSU / EMI / payments", r"nbfc|psu|emi|loan|bank|disburs|financ|payment|invoice|lender|bre\b|subvention|soft approval|\bha\b"),
    ("Permits / net metering", r"permit|net ?meter|wcr|meter|sanction|feasib|\bpc\b|\blc\b|\bnc\b|commission"),
    ("Installation / planning / crew", r"install|crew|vendor|material|delivery|bom|erp|slot|velocity|\bic\b|champion|attendance|structure|site|tinshed"),
    ("HOTO / order / OA / sales", r"hoto|handover|order|\boa\b|opening act|sales|lead|quote|\brm\b|welcome|lrm|leaderboard|speed"),
    ("Design / DEV", r"design|\bdev\b|dev_|survey|insta ?360|shadow|\bfpd\b|\bds\b|\bdd\b"),
    ("Customer / CSAT / AMC / tickets", r"csat|nps|amc|ticket|freshdesk|fresh desk|complain|customer|\bcx\b|call|ocr"),
    ("Hold / cancel / resume", r"hold|cancel|resume|seeking|inactive|deferral|close"),
    ("Hierarchy / users / tasks", r"cell|role|user|hierarch|mapping|cdm|\bcom\b|soh|task"),
]


def theme_of(name: str) -> str:
    n = (name or "").lower()
    return next((t for t, rx in THEMES if re.search(rx, n)), "Other")


def write_index(catalogue: dict) -> Path:
    """One row per question: a browsable, PII-free index committed with the docs."""
    import csv
    INDEX_CSV.parent.mkdir(parents=True, exist_ok=True)
    with INDEX_CSV.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "name", "collection", "theme", "type", "display", "database_id", "source_tables", "n_columns", "parameters", "last_edited", "sql_file"])
        for c in sorted(catalogue["cards"], key=lambda x: (x.get("collection") or "", x["id"])):
            w.writerow([c["id"], c.get("name"), c.get("collection"), theme_of(c.get("name")), c.get("kind") or c.get("error", ""), c.get("display"),
                        c.get("database_id"), " ".join(c.get("source_tables") or []), len(c.get("columns") or []),
                        " | ".join(p for p in (c.get("parameters") or []) if p), (c.get("updated_at") or "")[:10], c.get("sql_file")])
    return INDEX_CSV


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--key-var", default="METABASE_API_KEY", help="name of the .env setting that holds the API key")
    ap.add_argument("--collections", nargs="+", help="collection names (case-insensitive); sub-collections included")
    ap.add_argument("--index-only", action="store_true", help="rebuild the docs index from the saved catalogue (no API calls)")
    args = ap.parse_args(argv)
    if args.index_only:
        out = write_index(json.loads((RAW / "catalogue.json").read_text(encoding="utf-8")))
        print("wrote", out.relative_to(REPO_ROOT))
        return 0
    if not args.collections:
        ap.error("--collections is required unless --index-only")

    mb = MetabaseClient(require("METABASE_URL"), require(args.key_var))
    summary: dict = {"key_var": args.key_var}

    # ---- access
    me = mb.current_user()
    summary["acts_as"] = {"first_name": me.get("first_name"), "is_superuser": me.get("is_superuser"),
                          "group_ids": [g.get("id") if isinstance(g, dict) else g for g in (me.get("user_group_memberships") or me.get("group_ids") or [])]}
    summary["databases"] = [(d.get("id"), d.get("name"), d.get("native_permissions")) for d in mb.databases()]
    try:
        res = mb.run_sql(DB_ID, "select 1 as ok")
        summary["native_sql_db2"] = "ok" if (res or {}).get("status") == "completed" else f"failed: {(res or {}).get('error')}"
    except MetabaseError as exc:
        summary["native_sql_db2"] = f"failed: {str(exc)[:160]}"
    rechecks = {}
    for cid in RECHECK_CARDS:
        try:
            c = mb.card(cid)
            rechecks[cid] = f"ok: {c.get('name')}"
        except MetabaseError as exc:
            rechecks[cid] = "403" if "HTTP 403" in str(exc) else f"error: {str(exc)[:80]}"
    summary["recheck_cards"] = rechecks

    # ---- collections
    all_cols = mb.collections()
    by_id = {c["id"]: c for c in all_cols if isinstance(c.get("id"), int)}
    wanted = {n.strip().lower() for n in args.collections}
    roots = [c for c in by_id.values() if (c.get("name") or "").strip().lower() in wanted and not c.get("archived")]
    found = {(c.get("name") or "").strip().lower() for c in roots}
    summary["collections_missing"] = sorted(wanted - found)
    summary["visible_collections"] = len(by_id)

    def path_name(c: dict) -> str:
        ids = [int(x) for x in (c.get("location") or "/").strip("/").split("/") if x]
        return " / ".join([by_id[i]["name"] for i in ids if i in by_id] + [c["name"]])

    scope = {}
    for r in roots:
        scope[r["id"]] = r
        for c in by_id.values():
            if f"/{r['id']}/" in (c.get("location") or "") and not c.get("archived"):
                scope[c["id"]] = c

    catalogue = {"summary": summary, "collections": [], "cards": [], "dashboards": []}
    SQL_DIR.mkdir(parents=True, exist_ok=True)
    RAW.mkdir(parents=True, exist_ok=True)
    for cid, col in sorted(scope.items(), key=lambda kv: path_name(kv[1])):
        items = mb.collection_items(cid)
        catalogue["collections"].append({"id": cid, "path": path_name(col), "items": len(items)})
        for it in items:
            model = it.get("model")
            if model in ("card", "dataset", "metric"):
                try:
                    card = mb.card(it["id"])
                except MetabaseError as exc:
                    catalogue["cards"].append({"id": it["id"], "name": it.get("name"), "collection": path_name(col), "error": str(exc)[:120]})
                    continue
                kind, sql = card_sql(mb, card)
                cols = [(m.get("name"), m.get("display_name"), m.get("base_type")) for m in (card.get("result_metadata") or [])]
                rel = Path(slug(path_name(col).split(" / ")[0], 40)) / f"{card['id']}_{slug(card.get('name'))}.sql"
                header = (f"-- Metabase question {card['id']}: {card.get('name')}\n-- Collection: {path_name(col)}\n"
                          f"-- Type: {model} / {kind} · display: {card.get('display')} · database: {card.get('database_id')}\n"
                          f"-- Description: {(card.get('description') or '').strip()[:300]}\n"
                          f"-- Last edited: {card.get('updated_at')}\n-- Saved by pipeline/explore_collections.py (definition only, no data)\n\n")
                (SQL_DIR / rel).parent.mkdir(parents=True, exist_ok=True)
                (SQL_DIR / rel).write_text(header + redact(sql) + "\n", encoding="utf-8")
                catalogue["cards"].append({
                    "id": card["id"], "name": card.get("name"), "model": model, "kind": kind, "display": card.get("display"),
                    "collection": path_name(col), "database_id": card.get("database_id"), "description": card.get("description"),
                    "updated_at": card.get("updated_at"), "columns": cols, "sql_file": f"sql/metabase/collections/{rel.as_posix()}",
                    "parameters": [p.get("name") or p.get("slug") for p in (card.get("parameters") or [])],
                    "source_tables": sorted(set(re.findall(r'(?:from|join)\s+"?(?:public"?\.)?"?([a-z_][a-z0-9_]*)"?', (sql or "").lower()))),
                })
            elif model == "dashboard":
                try:
                    d = mb.dashboard(it["id"])
                except MetabaseError as exc:
                    catalogue["dashboards"].append({"id": it["id"], "name": it.get("name"), "collection": path_name(col), "error": str(exc)[:120]})
                    continue
                dcs = d.get("dashcards") or d.get("ordered_cards") or []
                catalogue["dashboards"].append({
                    "id": d["id"], "name": d.get("name"), "collection": path_name(col), "description": d.get("description"),
                    "tabs": [t.get("name") for t in (d.get("tabs") or [])],
                    "filters": [p.get("name") for p in (d.get("parameters") or [])],
                    "cards": [{"id": (dc.get("card") or {}).get("id"), "name": (dc.get("card") or {}).get("name")} for dc in dcs if dc.get("card")],
                    "updated_at": d.get("updated_at"),
                })

    (RAW / "catalogue.json").write_text(json.dumps(catalogue, indent=2, ensure_ascii=False), encoding="utf-8")
    write_index(catalogue)
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    print(f"\ncollections in scope: {len(catalogue['collections'])}")
    for c in catalogue["collections"]:
        print(f"  [{c['id']}] {c['path']}  ({c['items']} items)")
    print(f"questions/models: {len(catalogue['cards'])}  dashboards: {len(catalogue['dashboards'])}")
    print(f"catalogue: {(RAW / 'catalogue.json').relative_to(REPO_ROOT)}  SQL: {SQL_DIR.relative_to(REPO_ROOT)}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
