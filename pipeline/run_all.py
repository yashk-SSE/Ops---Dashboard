"""Refresh everything: run every section job, then publish the dashboard data.

Usage (from the repo root):
    python -m pipeline.run_all            # fresh extracts from Metabase (~4-5 min)
    python -m pipeline.run_all --reuse    # recompute from the last raw extracts (no Metabase calls)

This is the one command the scheduler will run at the refresh slots (D-52: 07, 10, 13, 16, 19 IST).
"""
from __future__ import annotations

import argparse
from pathlib import Path
import sys
import time

from pipeline.jobs import escalations, p1_hoto_to_install, p2_install_to_commissioning, qhse, subsidy
from pipeline.publish import web_data

JOBS = [("P2 Install -> Commissioning", p2_install_to_commissioning.main),
        ("P1 HOTO -> Install", p1_hoto_to_install.main),
        ("QHSE", qhse.main),
        ("Escalations", escalations.main),
        ("Subsidy", subsidy.main)]


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    ap = argparse.ArgumentParser(description="Run all jobs + publish dashboard data")
    ap.add_argument("--reuse", action="store_true")
    args = ap.parse_args(argv)
    t0 = time.time()
    if args.reuse:
        # measure ages on the date the saved extracts were pulled (the oldest section), not today
        import json
        import os
        from datetime import datetime as _dt
        raw = Path(__file__).resolve().parent.parent / "data" / "raw" / "extract"
        stamps = []
        for f in raw.glob("*.json"):
            try:
                with open(f, encoding="utf-8") as fh:
                    head = fh.read(200)
                i = head.find('"extracted_at"')
                if i >= 0:
                    v = head[i:].split('"')[3]
                    stamps.append(_dt.fromisoformat(v.replace("Z", "+00:00")))
            except (OSError, ValueError, IndexError):
                continue
        if stamps:
            from pipeline.common.dates import IST
            os.environ["OPS_AS_OF"] = min(s.astimezone(IST) if s.tzinfo else s for s in stamps).date().isoformat()
            print(f"--reuse: ages measured as of {os.environ['OPS_AS_OF']} (extract date)")
    for name, job in JOBS:
        print(f"\n===== {name} =====")
        code = job(["--reuse"] if args.reuse else [])
        if code:
            print(f"FAILED: {name} (exit {code}); dashboard data not published")
            return code
    print("\n===== Publish web data =====")
    web_data.main()
    print(f"\nDone in {time.time() - t0:.0f}s. Open the dashboard: python -m pipeline.tools.serve --port 8765")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
