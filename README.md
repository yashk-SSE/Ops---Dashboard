# Ops Dashboard

Tracking dashboard for SolarSquare Ops leadership: HOTO → installation → commissioning, TAT breaches, QHSE, escalations, subsidy and finance cases.

**Status:** V3 dashboard (Overview, # of HOTOs, Yesterday, Needs action and every module page), refreshed and published every day at 04:00 IST by `.github/workflows/daily-refresh.yml` on GitHub Pages (D-114, D-115). The link is public with privacy guards: the build stops if any email or phone number is in the data.

> **This GitHub repo is a temporary public copy** (D-115) until the dashboard moves to SolarSquare's own repo and domain. It holds only what the daily job runs on (`pipeline/`, `sql/extract/`, `config/seed/`, `web/`). The handover docs linked below (`CONTEXT.md`, `docs/`, `CHANGELOG.md`) and the reference SQL are kept in the full project copy and move with it.

## Start here

1. [`CONTEXT.md`](CONTEXT.md): what we're building, for whom, the rules agreed so far, glossary
2. [`docs/requirements/v1-scope.md`](docs/requirements/v1-scope.md): every metric, its cuts, and which data covers it
3. [`docs/stage-mapping/`](docs/stage-mapping/README.md): task → stage analysis and the draft stage model
4. [`docs/data-sources/`](docs/data-sources/README.md): every source studied, column by column
5. [`docs/open-questions.md`](docs/open-questions.md): what is still unknown
6. [`docs/decisions.md`](docs/decisions.md): what has been decided, and by whom
7. [`CHANGELOG.md`](CHANGELOG.md): history of changes

## Setup

Requires **Python 3.10+**. No packages to install: the pipeline uses the standard library only.

1. Copy `.env.example` to `.env`. A blank `.env` already exists locally.
2. Fill in `METABASE_URL` and `METABASE_API_KEY`. `.env` is git-ignored; never commit it.

## Probe Metabase

Checks access and pulls each saved question's definition, SQL and a sample of rows:

```bash
python -m pipeline.probe_metabase 2259 5896
```

| Output | What | In git? |
|---|---|---|
| `sql/metabase/q<ID>_<name>.sql` | SQL behind each question (native, or compiled from a GUI question) | Yes |
| `data/raw/metabase/q<ID>_card.json` | Full question definition | No |
| `data/raw/metabase/q<ID>_sample.json` | Columns + up to 2,000 sample rows | No (customer data) |
| `data/raw/metabase/probe_summary.json` | Summary of the run | No |

## Dashboard (local)

```bash
python -m pipeline.run_all
```

```bash
python -m pipeline.tools.serve --port 8765
```

- `run_all` runs every job and publishes `web/data/` (add `--reuse` to skip Metabase).
- `serve` serves `web/` without caching, so a reload shows the latest files. Then open http://localhost:8765.
- Details, data contract and how to add the next metric: [`docs/dashboard/README.md`](docs/dashboard/README.md).

## Share a single file (snapshot)

```bash
python -m pipeline.run_all
```

```bash
python -m pipeline.tools.build_share
```

- Writes `dist/Ops_Dashboard_<published time>.html` (about 7 MB): one file with the code, styles and data inside. It opens by double-click in Chrome or Edge, with no server.
- It needs internet only for the font and Chart.js. It is a frozen snapshot: the sidebar shows "Data as of".
- **Internal only:** it has SSE IDs and staff names and no login. Share inside SolarSquare only. `dist/` is git-ignored.

## Run a dashboard section

```bash
python -m pipeline.jobs.p2_install_to_commissioning
```

```bash
python -m pipeline.jobs.p1_hoto_to_install
```

- Extracts from Metabase, computes P2 metrics and writes `data/marts/p2/*.json` (git-ignored). Takes about 1 minute.
- Add `--reuse` to recompute from the last raw extract without querying Metabase.
- Definitions and reconciliation: [`docs/metrics/p2-install-to-commissioning.md`](docs/metrics/p2-install-to-commissioning.md), [`docs/metrics/p1-hoto-to-install.md`](docs/metrics/p1-hoto-to-install.md).
- What else can be built: [`docs/requirements/coverage-matrix.md`](docs/requirements/coverage-matrix.md).

## Config sheet template

```bash
python -m pipeline.tools.build_config_template
```

This rebuilds `config/template/Ops_Dashboard_Config_v0.1.xlsx` from `config/seed/`. Import it into Google Drive once. After that, the Google Sheet is the source of truth. Spec: [`docs/config-sheet/README.md`](docs/config-sheet/README.md).

## Explore the database

```bash
python -m pipeline.explore_schema usertasks project cell
```

```bash
python -m pipeline.run_sql sql/exploration/01_usertasks_status_mix.sql
```

- `explore_schema` prints a table's columns from Metabase's metadata. No data is queried.
- `run_sql` runs one read-only SELECT per file and saves results to `data/raw/exploration/` (git-ignored). The client refuses anything that isn't SELECT / WITH.
- Exploration queries live in `sql/exploration/`, each with a comment saying why it exists.

## Repo layout

```
pipeline/            Python: extract → transform → metrics → marts
  config.py          reads settings from env / .env
  common/            dates (IST, 10-day buckets, FY windows), stats (percentiles, TAT summary)
  extract/metabase.py  Metabase API client (ad-hoc + bulk export)
  extract/run_extracts.py  run extract SQL files, save raw
  jobs/p2_install_to_commissioning.py  P2 job
  tools/             builders for config seeds
config/seed/         stage mapping + P2 sub-stage seeds (move to the Config Google Sheet later)
sql/extract/         production extract queries (commented, PII-free)
data/marts/          job outputs for the UI, git-ignored
  probe_metabase.py  discovery probe (above)
  explore_schema.py  table columns from Metabase metadata
  run_sql.py         run read-only SQL files
sql/metabase/        SQL snapshots of source Metabase questions (once access is granted)
sql/exploration/     read-only discovery queries
data/raw/            pulled data, git-ignored
docs/                context, decisions, questions, sources, stage mapping
```
