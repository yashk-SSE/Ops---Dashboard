"""Build the folder that goes on the static host (GitHub Pages since D-115; Cloudflare Pages before, D-89).

Usage:
    python -m pipeline.tools.build_site                 # dist/site/        = dashboard + today's data
    python -m pipeline.tools.build_site --placeholder   # dist/site-placeholder/ = one page, NO data
    python -m pipeline.tools.build_site --deploy        # old Cloudflare upload with wrangler (retired with D-115)

What goes in dist/site/:
  web/index.html, web/assets/**     the dashboard (same files the local server shows)
  web/data/*.json                   the published snapshot (run `python -m pipeline.run_all` first)
  _headers                          Cloudflare Pages headers (ignored by GitHub Pages, harmless there; index.html
                                    carries the noindex and no-referrer tags itself)
  robots.txt                        disallow all crawlers
The daily GitHub Actions job (.github/workflows/daily-refresh.yml, D-114) runs this and publishes dist/site on GitHub Pages.
The placeholder exists so the very first upload carries no data: upload it, put Cloudflare Access in front of the
site, check the login works, and only then upload dist/site/. Steps: docs/deploy/cloudflare.md.

Settings (optional, in .env):  CF_PAGES_PROJECT = the Pages project name (the site is https://<name>.pages.dev)
dist/ is git-ignored. The live site is public for now (D-92): the build refuses data holding any email or phone number.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path

from pipeline.common.privacy import scan_for_contacts
from pipeline.config import REPO_ROOT

WEB = REPO_ROOT / "web"
DIST = REPO_ROOT / "dist"
DATA_FILES = ("meta", "p1", "p2", "qhse", "escalations", "subsidy", "nbfc", "psu", "orders", "plan")
LIMIT_BYTES = 25 * 1024 * 1024  # Cloudflare Pages: max size of one file

HEADERS = """/*
  X-Robots-Tag: noindex, nofollow
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Cache-Control: no-cache
"""
ROBOTS = "User-agent: *\nDisallow: /\n"
PLACEHOLDER = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Ops Dashboard</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#F6F7FB;color:#1B1F3B}
main{text-align:center;padding:24px}h1{font-size:22px;margin:0 0 6px;color:#131CA2}p{margin:0;color:#5B6078}</style></head>
<body><main><h1>Ops Dashboard</h1><p>Setting up. The dashboard will appear here soon.</p></main></body></html>
"""


def _fresh(out: Path) -> Path:
    out = out.resolve()
    if DIST.resolve() not in out.parents:
        raise SystemExit(f"refusing to write outside dist/: {out}")
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    (out / "_headers").write_text(HEADERS, encoding="utf-8")
    (out / "robots.txt").write_text(ROBOTS, encoding="utf-8")
    return out


def build_placeholder() -> Path:
    out = _fresh(DIST / "site-placeholder")
    (out / "index.html").write_text(PLACEHOLDER, encoding="utf-8")
    return out


def build_site() -> Path:
    missing = [n for n in DATA_FILES if not (WEB / "data" / f"{n}.json").exists()]
    if missing:
        raise SystemExit(f"web/data/ is missing {', '.join(missing)}: run `python -m pipeline.run_all` first.")
    out = _fresh(DIST / "site")
    shutil.copy2(WEB / "index.html", out / "index.html")
    shutil.copytree(WEB / "assets", out / "assets")
    (out / "data").mkdir()
    for n in DATA_FILES:  # only the published sections, never stray files
        hits = scan_for_contacts(json.loads((WEB / "data" / f"{n}.json").read_text(encoding="utf-8")))
        if hits:  # D-92: the live site is public
            shutil.rmtree(out)
            raise SystemExit(f"data/{n}.json holds {len(hits)} email / phone values (e.g. {hits[:3]}): not built. Re-run the publish step.")
        shutil.copy2(WEB / "data" / f"{n}.json", out / "data" / f"{n}.json")
    big = [p for p in out.rglob("*") if p.is_file() and p.stat().st_size > LIMIT_BYTES]
    if big:
        raise SystemExit("over Cloudflare Pages' 25 MB per-file limit: " + ", ".join(str(p.relative_to(out)) for p in big))
    return out


def deploy(folder: Path, project: str) -> int:
    npx = shutil.which("npx")
    if not npx:
        print("Node.js is not installed, so no command-line upload. Upload the folder in the Cloudflare dashboard instead:")
        print(f"  Workers & Pages > {project} > Create deployment > drag in {folder}")
        return 1
    cmd = [npx, "wrangler", "pages", "deploy", str(folder), "--project-name", project, "--branch", "main", "--commit-dirty=true"]
    print("About to run:", " ".join(cmd))
    if input("Upload now? Type yes: ").strip().lower() != "yes":
        print("Not uploaded.")
        return 1
    return subprocess.call(cmd)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build the static-host folder (Cloudflare Pages)")
    ap.add_argument("--placeholder", action="store_true", help="build a one-page site with no data (first upload)")
    ap.add_argument("--deploy", action="store_true", help="upload with wrangler after building (asks first)")
    ap.add_argument("--project", default=os.environ.get("CF_PAGES_PROJECT", "").strip(), help="Pages project name")
    args = ap.parse_args(argv)
    out = build_placeholder() if args.placeholder else build_site()
    files = [p for p in out.rglob("*") if p.is_file()]
    size = sum(p.stat().st_size for p in files) / 1e6
    print(f"built {out.relative_to(REPO_ROOT)}  ({len(files)} files, {size:.1f} MB)")
    if not args.placeholder:
        meta = json.loads((out / "data" / "meta.json").read_text(encoding="utf-8"))
        print(f"data as of {meta.get('as_of')} (generated {meta.get('generated_at')})")
    if args.deploy:
        if not args.project:
            raise SystemExit("set CF_PAGES_PROJECT in .env or pass --project <name>")
        return deploy(out, args.project)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
