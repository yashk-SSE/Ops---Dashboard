# config/

Settings the pipeline reads. Per D-44 the **Config Google Sheet** will be the live home for anything Ops edits (SLAs, MOP link, AVP mapping, Expansion list, login allowlist, stage mapping). Until it exists, the same tables live here as **seed CSVs**, so the pipeline runs. When the sheet is created, these files become its first content.

**Config sheet template:** `template/Ops_Dashboard_Config_v0.1.xlsx`, built by `python -m pipeline.tools.build_config_template`. Spec: [`../docs/config-sheet/README.md`](../docs/config-sheet/README.md).

| File | What | Status |
|---|---|---|
| `seed/events.csv` | Named events (dates) used by stages | Draft; 4 TBC |
| `seed/stages.csv` | Layer 2 stages: P1 funnel, P2, P3 TAT breach; SLA column empty for Ops CT | Draft |
| `seed/p2_task_substage_overrides.csv` | Pan India's task → P2 sub-stage map | From Pan India `Mapping_sheet` |
| `seed/task_milestones.csv` | Layer 1: task key + task name → milestone + department. Built by `python -m pipeline.tools.build_task_milestone_seed` from Sheet3 + live task names. | Draft; Ops CT to clean (OQ-35) |
| `seed/p2_commissioning_substages.csv` | Layer 2 for P2: milestone → commissioning sub-stage + order. `in_commissioning_chain = Y` marks the permit / net-meter steps that block commissioning. | Draft by Claude, follows Pan India's sub-stages; NM Application kept separate |
