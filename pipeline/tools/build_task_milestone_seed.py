"""Build config/seed/task_milestones.csv (stage-model Layer 1 seed, D-43).

Inputs:
  docs/stage-mapping/task-mapping-comparison.csv   Sheet3 task name -> department, milestone
  data/raw/exploration/05_usertasks_keys_last30d.json  live (key, task name) pairs (run sql/exploration/05 first)

Rule: a (key, task name) pair gets Sheet3's milestone when the name matches (trimmed, case-insensitive,
'&' = 'and'). If the name isn't in Sheet3 but every other name under the same key maps to one milestone,
that milestone is inferred (source = key_inferred). Otherwise it stays blank for Ops CT to fill.

Usage:  python -m pipeline.tools.build_task_milestone_seed
"""
from __future__ import annotations

import csv
import json
import re
from collections import defaultdict

from pipeline.config import REPO_ROOT

N = lambda s: re.sub(r"\s+", " ", (s or "").lower().replace("&", "and")).strip()


def main() -> int:
    s3 = {}
    for row in csv.DictReader(open(REPO_ROOT / "docs/stage-mapping/task-mapping-comparison.csv", encoding="utf-8")):
        if row["in_sheet3"] == "Y" and row["sheet3_milestone"] and "|" not in row["sheet3_milestone"]:
            s3[N(row["task_name"])] = (row["sheet3_department"].split(" | ")[0], row["sheet3_milestone"])
    live = json.load(open(REPO_ROOT / "data/raw/exploration/05_usertasks_keys_last30d.json", encoding="utf-8"))["rows"]
    pairs = defaultdict(int)
    for key, name, _proc, n in live:
        pairs[(key, name)] += n
    by_key = defaultdict(set)
    for (key, name) in pairs:
        if N(name) in s3:
            by_key[key].add(s3[N(name)])
    out = []
    for (key, name), n in sorted(pairs.items(), key=lambda x: (x[0][0], -x[1])):
        if N(name) in s3:
            dept, ms = s3[N(name)]; src = "sheet3_name"
        elif len(by_key[key]) == 1:
            dept, ms = next(iter(by_key[key])); src = "key_inferred"
        else:
            dept, ms, src = "", "", "unmapped"
        out.append({"key": key, "task_name": name, "department": dept, "milestone": ms,
                    "source": src, "done_last_30d": n})
    path = REPO_ROOT / "config/seed/task_milestones.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0].keys()))
        w.writeheader(); w.writerows(out)
    from collections import Counter
    print(f"wrote {path.relative_to(REPO_ROOT).as_posix()}: {len(out)} rows", dict(Counter(r['source'] for r in out)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
