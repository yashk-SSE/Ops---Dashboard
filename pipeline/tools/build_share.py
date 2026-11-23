"""Build ONE self-contained HTML file of the dashboard to share (opens by double-click, no server).

Usage:  python -m pipeline.tools.build_share [--out dist/Ops_Dashboard_<date>.html]

What goes in:
  web/index.html            page shell
  web/assets/css/app.css    inlined as <style>
  web/assets/js/**          ES modules bundled into one classic <script> (tiny bundler below; no Node needed)
  web/data/*.json           embedded as <script type="application/json" id="opsdash-data-<name>">
                            (web/assets/js/data.js reads these before trying fetch)
Still loaded from the internet when opened: the DM Sans font (Google Fonts) and Chart.js 4.4.1 (cdnjs),
exactly as the hosted dashboard does. Without internet the page falls back to system fonts and charts don't draw.

The output holds internal data (SSE IDs, staff names, delay reasons) and has NO login, so it is written to the
git-ignored dist/ folder and must only be shared inside SolarSquare. Run `python -m pipeline.run_all` first so the
snapshot is fresh.
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime
from pathlib import Path

from pipeline.common.privacy import scan_for_contacts
from pipeline.config import REPO_ROOT

WEB = REPO_ROOT / "web"
JS_ROOT = WEB / "assets" / "js"
ENTRY = JS_ROOT / "app.js"
DATA_FILES = ("meta", "p1", "p2", "qhse", "escalations", "subsidy", "plan")

IMPORT_NAMED = re.compile(r'^import\s*\{([^}]*)\}\s*from\s*"([^"]+)";\s*$')
IMPORT_STAR = re.compile(r'^import\s*\*\s*as\s+(\w+)\s+from\s*"([^"]+)";\s*$')
EXPORT_DECL = re.compile(r"^export\s+((?:async\s+)?function\*?|const|let|class)\s+(\w+)")
EXPORT_LIST = re.compile(r"^export\s*\{([^}]*)\};?\s*$")


# ---------------------------------------------------------------- bundler
def _key(path: Path) -> str:
    return path.relative_to(JS_ROOT).as_posix()


def _resolve(spec: str, importer: Path) -> Path:
    if not spec.startswith("."):
        raise SystemExit(f"{_key(importer)}: only relative imports are supported, got {spec!r}")
    return (importer.parent / spec).resolve()


def _transform(path: Path) -> tuple[str, list[Path]]:
    """Rewrite one ES module into the body of a factory function. Returns (code, dependencies)."""
    deps: list[Path] = []
    exports: list[str] = []
    out: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if m := IMPORT_NAMED.match(line):
            dep = _resolve(m.group(2), path)
            deps.append(dep)
            names = [n.strip() for n in m.group(1).split(",") if n.strip()]
            binds = [f"{a.strip()}: {b.strip()}" if " as " in n else n for n in names for a, _, b in [n.partition(" as ")]]
            out.append(f'const {{ {", ".join(binds)} }} = __mods["{_key(dep)}"];')
        elif m := IMPORT_STAR.match(line):
            dep = _resolve(m.group(2), path)
            deps.append(dep)
            out.append(f'const {m.group(1)} = __mods["{_key(dep)}"];')
        elif line.startswith("import "):
            raise SystemExit(f"{_key(path)}: unsupported import form: {line}")
        elif m := EXPORT_LIST.match(line):
            for n in m.group(1).split(","):
                if n.strip():
                    local, _, public = n.strip().partition(" as ")
                    exports.append(f"{public.strip()}: {local.strip()}" if public else local.strip())
        elif m := EXPORT_DECL.match(line):
            exports.append(m.group(2))
            out.append(line[len("export "):])
        elif line.startswith("export "):
            raise SystemExit(f"{_key(path)}: unsupported export form: {line}")
        else:
            out.append(line)
    out.append(f"return {{ {', '.join(exports)} }};")
    return "\n".join(out), deps


def bundle(entry: Path = ENTRY) -> str:
    """Depth-first, dependencies before dependants; each module runs once in its own function scope."""
    order: list[tuple[Path, str]] = []
    state: dict[Path, str] = {}

    def visit(p: Path, chain: tuple[str, ...]) -> None:
        if state.get(p) == "done":
            return
        if state.get(p) == "busy":
            raise SystemExit("circular import: " + " -> ".join(chain + (_key(p),)))
        state[p] = "busy"
        code, deps = _transform(p)
        for d in deps:
            visit(d, chain + (_key(p),))
        state[p] = "done"
        order.append((p, code))

    visit(entry.resolve(), ())
    parts = ['"use strict";', "const __mods = Object.create(null);"]
    for p, code in order:
        parts.append(f'// ---- {_key(p)}\n__mods["{_key(p)}"] = (function () {{\n{code}\n}})();')
    return "(function () {\n" + "\n".join(parts) + "\n})();"


# ---------------------------------------------------------------- page
def _safe_script_text(s: str) -> str:
    """Text placed inside <script> must not contain '</script' (or '<!--'); escape the slash / bang."""
    return s.replace("</", "<\\/").replace("<!--", "<\\!--")


def build(out: Path | None = None) -> Path:
    meta_path = WEB / "data" / "meta.json"
    if not meta_path.exists():
        raise SystemExit("web/data/ is empty: run `python -m pipeline.run_all` first.")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    stamp = datetime.fromisoformat(meta["generated_at"]).strftime("%Y-%m-%d_%H%M")

    html = (WEB / "index.html").read_text(encoding="utf-8")
    css = (WEB / "assets" / "css" / "app.css").read_text(encoding="utf-8")
    link = '<link rel="stylesheet" href="assets/css/app.css">'
    entry_tag = '<script type="module" src="assets/js/app.js"></script>'
    for needle in (link, entry_tag):
        if needle not in html:
            raise SystemExit(f"web/index.html changed: cannot find {needle!r}")

    data_tags = []
    for name in DATA_FILES:
        raw = (WEB / "data" / f"{name}.json").read_text(encoding="utf-8")
        obj = json.loads(raw)
        if hits := scan_for_contacts(obj):
            raise SystemExit(f"data/{name}.json holds {len(hits)} email / phone values (e.g. {hits[:3]}): not built.")
        compact = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
        data_tags.append(f'<script type="application/json" id="opsdash-data-{name}">{_safe_script_text(compact)}</script>')

    html = html.replace(link, f"<style>\n{css}\n</style>")
    html = html.replace("<title>Ops Dashboard</title>",
                        f"<title>Ops Dashboard</title>\n  <!-- Shared snapshot built {stamp} by pipeline/tools/build_share.py. Internal: SolarSquare only. -->")
    html = html.replace(entry_tag, "\n  ".join(data_tags) + f"\n  <script>\n{_safe_script_text(bundle())}\n  </script>")

    out = out or REPO_ROOT / "dist" / f"Ops_Dashboard_{stamp}.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build one self-contained HTML file of the dashboard to share")
    ap.add_argument("--out", type=Path, default=None, help="output file (default dist/Ops_Dashboard_<published>.html)")
    out = build(ap.parse_args(argv).out)
    size = out.stat().st_size / 1e6
    print(f"wrote {out.relative_to(REPO_ROOT) if out.is_relative_to(REPO_ROOT) else out}  ({size:.1f} MB)")
    print("Internal data, no login: share inside SolarSquare only. Opens in Chrome / Edge; needs internet for charts + font.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
