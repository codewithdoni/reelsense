"""Trend radar and competitor discovery via Exa.

Captured Instagram data says what already happened on the account. It says
nothing about what the niche is talking about this week. Exa's neural search
fills that gap, so the Strategist can anchor ideas to a live conversation
rather than only to past performance.

Optional: with no key the endpoints report `configured: false` and the rest of
the product is unaffected.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone

import httpx

log = logging.getLogger("reelsense.exa")

KEY = os.getenv("EXA_API_KEY", "")
BASE = "https://api.exa.ai"


def configured() -> bool:
    return bool(KEY)


async def _post(path: str, payload: dict) -> dict | None:
    if not KEY:
        return None
    try:
        async with httpx.AsyncClient(timeout=45) as client:
            res = await client.post(
                f"{BASE}/{path}",
                headers={"x-api-key": KEY, "content-type": "application/json"},
                json=payload,
            )
        if res.status_code >= 400:
            log.warning("exa %s -> %s %s", path, res.status_code, res.text[:200])
            return None
        return res.json()
    except Exception as exc:  # noqa: BLE001
        log.warning("exa %s failed: %s", path, exc)
        return None


async def trends(niche: str, days: int = 14, limit: int = 8) -> list[dict]:
    """What the niche has been publishing and arguing about recently."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    data = await _post(
        "search",
        {
            "query": f"{niche}: what people are talking about right now, new angles and debates",
            "type": "auto",
            "numResults": limit,
            "startPublishedDate": since,
            "contents": {"text": {"maxCharacters": 700}},
        },
    )
    if not data:
        return []
    return [
        {
            "title": r.get("title") or "",
            "url": r.get("url") or "",
            "published": (r.get("publishedDate") or "")[:10],
            "summary": (r.get("text") or "")[:700],
        }
        for r in data.get("results", [])
    ]


async def similar_accounts(username: str, limit: int = 8) -> list[dict]:
    """Accounts adjacent to one you already consider a competitor."""
    data = await _post(
        "findSimilar",
        {
            "url": f"https://www.instagram.com/{username}/",
            "numResults": limit,
            "includeDomains": ["instagram.com"],
        },
    )
    if not data:
        return []
    out = []
    for r in data.get("results", []):
        url = r.get("url", "")
        handle = url.rstrip("/").split("/")[-1]
        if handle and handle.lower() != username.lower() and "?" not in handle:
            out.append({"username": handle, "title": r.get("title") or "", "url": url})
    return out
