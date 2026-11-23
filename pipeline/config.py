"""Settings loader.

Reads settings from environment variables. For local runs it first loads a `.env` file at
the repo root (see `.env.example` for the full list). Values already set in the environment
win over `.env`, so CI / hosting platforms can inject secrets the normal way.

Standard library only, so it runs the same on a laptop, in GitHub Actions or on the
SolarSquare servers after the Phase 2 move.
"""
from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = REPO_ROOT / ".env"


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key:
            os.environ.setdefault(key, value)


_load_env_file(ENV_FILE)


def require(name: str) -> str:
    """Return a setting or stop with a clear message if it is missing."""
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Missing setting {name}. Fill it in .env (see .env.example).")
    return value
