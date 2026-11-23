"""Privacy guards for anything published (web/data, the share file, the live site). D-92.

safe_id(value)        keep only ID-shaped tokens from an "SSE ID" field; agents sometimes type a customer's name, email or
                      phone there in Freshdesk, and those must never be published.
scan_for_contacts(x)  find email addresses and Indian mobile numbers anywhere in a JSON-like value (used to block a build).
"""
from __future__ import annotations

import re

NOT_AN_ID = "(not an SSE ID)"
_SSE = re.compile(r"^R?SSE[A-Z]{2,3}\d{1,7}$")          # canonical SSE IDs, e.g. SSEMH0934, RSSEDL1603
_OTHER_ID = re.compile(r"^[A-Z]{2,4}\d{3,7}$")           # other project / lead IDs, e.g. LUP140676
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
PHONE = re.compile(r"(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d)")


def safe_id(value) -> str:
    """Return the SSE ID(s) in `value`, or NOT_AN_ID. Anything with an '@' is dropped whole (no fragments of emails)."""
    s = str(value or "").strip()
    if not s:
        return ""
    if "@" in s:
        return NOT_AN_ID
    tokens = [t for t in re.split(r"[^A-Za-z0-9]+", s.upper()) if t]
    ids = [t for t in tokens if _SSE.match(t)] or [t for t in tokens if _OTHER_ID.match(t)]
    return " / ".join(dict.fromkeys(ids)) if ids else NOT_AN_ID


def scan_for_contacts(obj) -> list[str]:
    """Masked examples of email addresses / phone numbers found in obj (empty list = clean)."""
    found: list[str] = []

    def walk(x):
        if isinstance(x, str):
            if EMAIL.search(x) or PHONE.search(x):
                found.append(re.sub(r"\d", "#", EMAIL.sub("***@***", x))[:40])
        elif isinstance(x, dict):
            for k, v in x.items():
                walk(k)
                walk(v)
        elif isinstance(x, (list, tuple)):
            for v in x:
                walk(v)

    walk(obj)
    return found
