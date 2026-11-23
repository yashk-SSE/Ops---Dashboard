"""Minimal Metabase API client.

Standard library only (urllib), so it needs no installs and runs on any host.
Auth uses a Metabase API key sent as the `X-API-KEY` header (Metabase v0.49+).
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

READ_ONLY_PREFIXES = ("select", "with")


class MetabaseError(RuntimeError):
    """Raised when Metabase returns an error or cannot be reached."""


class MetabaseClient:
    def __init__(self, base_url: str, api_key: str, timeout: int = 180) -> None:
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key
        self.timeout = timeout

    # -- low level ---------------------------------------------------------
    def _request(self, method: str, path: str, body: dict | None = None, auth: bool = True) -> Any:
        url = f"{self.base_url}/api/{path.lstrip('/')}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if auth:
            headers["X-API-KEY"] = self._api_key
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:400]
            raise MetabaseError(f"{method} /api/{path} -> HTTP {exc.code}: {detail}") from None
        except urllib.error.URLError as exc:
            raise MetabaseError(f"{method} /api/{path} -> cannot reach Metabase ({exc.reason})") from None
        if not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            raise MetabaseError(f"{method} /api/{path} -> response was not JSON (check METABASE_URL)") from None

    # -- endpoints ---------------------------------------------------------
    def version(self) -> str:
        """Metabase version tag. Public endpoint, no key needed."""
        props = self._request("GET", "session/properties", auth=False) or {}
        return (props.get("version") or {}).get("tag", "unknown")

    def current_user(self) -> dict:
        """The user the API key acts as. Confirms the key works."""
        return self._request("GET", "user/current")

    def databases(self) -> list[dict]:
        res = self._request("GET", "database")
        return res.get("data", []) if isinstance(res, dict) else (res or [])

    def card(self, card_id: int) -> dict:
        """A saved question's definition (name, query, columns, parameters)."""
        return self._request("GET", f"card/{card_id}")

    def compile_to_sql(self, dataset_query: dict) -> str:
        """SQL that Metabase generates for a GUI (MBQL) question."""
        res = self._request("POST", "dataset/native", body=dataset_query) or {}
        return res.get("query", "")

    def tables(self, db_id: int) -> list[dict]:
        """Tables Metabase has synced for a database (metadata only, no DB query)."""
        return [t for t in (self._request("GET", "table") or []) if t.get("db_id") == db_id]

    def table_fields(self, table_id: int) -> dict:
        """A table's columns with types, from Metabase's synced metadata (no DB query)."""
        return self._request("GET", f"table/{table_id}/query_metadata")

    def run_sql(self, db_id: int, sql: str) -> dict:
        """Run an ad-hoc native SQL query. Returns at most 2,000 rows (Metabase ad-hoc limit).

        Only ever pass read-only SELECT statements.
        """
        _guard_read_only(sql)
        body = {"database": db_id, "type": "native", "native": {"query": sql}}
        return self._request("POST", "dataset", body=body)

    def export_sql(self, db_id: int, sql: str) -> list[dict]:
        """Run a read-only query and return ALL rows (Metabase export, up to ~1M rows).

        Rows come back as dicts keyed by column name, with unformatted values.
        Sent as a JSON body: a form-encoded body is blocked by the Cloudflare WAF in
        front of SolarSquare's Metabase (HTTP 403 "Attention Required").
        """
        _guard_read_only(sql)
        query = {"database": db_id, "type": "native", "native": {"query": sql}}
        res = self._request("POST", "dataset/json", body={"query": query, "format_rows": False})
        if isinstance(res, dict) and (res.get("error") or res.get("status") == "failed"):
            raise MetabaseError(f"export failed: {str(res.get('error'))[:400]}")
        return res or []

    def collections(self) -> list[dict]:
        """Every collection the key can see (flat list; `location` holds the parent path, e.g. "/12/34/")."""
        res = self._request("GET", "collection")
        return res.get("data", []) if isinstance(res, dict) else (res or [])

    def collection_items(self, collection_id: int) -> list[dict]:
        """Direct children of a collection: questions (card), models (dataset), metrics, dashboards, sub-collections."""
        res = self._request("GET", f"collection/{collection_id}/items")
        return res.get("data", []) if isinstance(res, dict) else (res or [])

    def dashboard(self, dashboard_id: int) -> dict:
        """A dashboard's definition: its cards (dashcards), filters (parameters), tabs. No data."""
        return self._request("GET", f"dashboard/{dashboard_id}")

    def run_card(self, card_id: int) -> dict:
        """Run a saved question with its default parameters.

        This endpoint returns at most 2,000 rows (Metabase's ad-hoc limit), so it is for
        sampling and checks. Full extracts will use the export endpoint later.
        """
        return self._request("POST", f"card/{card_id}/query", body={"parameters": []})


def _guard_read_only(sql: str) -> None:
    """Refuse anything that is not a plain SELECT / WITH query."""
    if not sql.lstrip().lower().startswith(READ_ONLY_PREFIXES):
        raise MetabaseError("only SELECT / WITH queries are allowed")
