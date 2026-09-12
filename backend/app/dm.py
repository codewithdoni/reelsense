"""Comment-to-DM automation.

This closes the loop: the Strategist writes a script with a comment CTA, the
creator arms it from the side panel, and this watcher delivers the DM when
someone actually comments.

Delivery uses Meta's official Instagram Messaging API (private replies), never
the logged-in web session — automating DMs through the web UI risks the
creator's account and violates Instagram's terms.

Private reply constraints enforced by Meta and mirrored here:
  * one private reply per comment, ever
  * within 7 days of the comment
  * not to your own comments

Production would subscribe to the `comments` webhook. Polling is used here
because it needs no public HTTPS callback and no Meta webhook configuration,
which matters when the whole build is a few hours long.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

log = logging.getLogger("reelsense.dm")

GRAPH = "https://graph.instagram.com"
API_VERSION = os.getenv("IG_API_VERSION", "v23.0")
TOKEN = os.getenv("IG_TOKEN", "")
USER_ID = os.getenv("IG_USER_ID", "")
POLL_SECONDS = int(os.getenv("IG_POLL_SECONDS", "10"))
SEVEN_DAYS = 7 * 86400

STATE_PATH = Path(__file__).resolve().parent.parent / "rules.json"


# --- persistence -----------------------------------------------------------


def _load() -> dict[str, Any]:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text())
        except json.JSONDecodeError:
            log.warning("rules.json corrupt, starting fresh")
    return {"rules": [], "events": [], "handled": []}


def _save(state: dict[str, Any]) -> None:
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2))


STATE = _load()


def rules() -> list[dict]:
    return STATE["rules"]


def events() -> list[dict]:
    return STATE["events"][-50:]


def add_rule(keyword: str, dm_text: str, public_reply: str = "", link: str = "") -> dict:
    rule = {
        "id": uuid.uuid4().hex[:8],
        "keyword": keyword.strip(),
        "dm_text": dm_text.strip(),
        "public_reply": public_reply.strip(),
        "link": link.strip(),
        "active": True,
        "sent_count": 0,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    STATE["rules"].append(rule)
    _save(STATE)
    log.info("rule armed: %r -> DM", rule["keyword"])
    return rule


def toggle_rule(rule_id: str) -> dict | None:
    for r in STATE["rules"]:
        if r["id"] == rule_id:
            r["active"] = not r["active"]
            _save(STATE)
            return r
    return None


def _record(username: str, text: str, action: str) -> None:
    STATE["events"].append(
        {
            "username": username,
            "text": text[:60],
            "action": action,
            "at": datetime.now(timezone.utc).strftime("%H:%M:%S"),
        }
    )
    STATE["events"] = STATE["events"][-200:]
    _save(STATE)


# --- matching --------------------------------------------------------------


def match(rule: dict, text: str) -> bool:
    """Keyword triggers are typed by real people: match loosely but not wildly."""
    kw = rule["keyword"].lower().strip()
    body = text.lower().strip()
    if not kw:
        return False
    if len(kw) <= 2:          # "+", "1", "➕" — the whole comment is the trigger
        return body.strip(" .!") == kw
    return kw in body


def compose(rule: dict) -> str:
    text = rule["dm_text"]
    link = rule.get("link", "")
    if link and link not in text:
        text = f"{text}\n\n{link}"
    return text


# --- Instagram API ---------------------------------------------------------


def configured() -> bool:
    return bool(TOKEN and USER_ID)


async def _get(client: httpx.AsyncClient, path: str, **params) -> dict:
    params["access_token"] = TOKEN
    res = await client.get(f"{GRAPH}/{API_VERSION}/{path}", params=params)
    if res.status_code >= 400:
        raise RuntimeError(f"GET {path} -> {res.status_code} {res.text[:200]}")
    return res.json()


async def _post(client: httpx.AsyncClient, path: str, payload: dict) -> dict:
    res = await client.post(
        f"{GRAPH}/{API_VERSION}/{path}",
        params={"access_token": TOKEN},
        json=payload,
    )
    if res.status_code >= 400:
        raise RuntimeError(f"POST {path} -> {res.status_code} {res.text[:300]}")
    return res.json()


async def whoami() -> dict | None:
    if not configured():
        return None
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            return await _get(client, "me", fields="id,username")
    except Exception as exc:  # noqa: BLE001
        log.warning("token check failed: %s", exc)
        return None


async def send_private_reply(client: httpx.AsyncClient, comment_id: str, text: str) -> None:
    await _post(
        client,
        f"{USER_ID}/messages",
        {"recipient": {"comment_id": comment_id}, "message": {"text": text}},
    )


async def send_public_reply(client: httpx.AsyncClient, comment_id: str, text: str) -> None:
    await _post(client, f"{comment_id}/replies", {"message": text})


# --- watcher ---------------------------------------------------------------


async def _process_comment(client: httpx.AsyncClient, comment: dict, me: str) -> None:
    cid = str(comment.get("id"))
    text = comment.get("text") or ""
    author = comment.get("username") or "someone"

    if cid in STATE["handled"]:
        return
    if author == me:
        return  # Instagram will not let you DM yourself
    ts = comment.get("timestamp")
    if ts:
        try:
            age = time.time() - datetime.fromisoformat(ts.replace("+0000", "+00:00")).timestamp()
            if age > SEVEN_DAYS:
                return
        except ValueError:
            pass

    for rule in STATE["rules"]:
        if not rule.get("active") or not match(rule, text):
            continue

        STATE["handled"].append(cid)          # claim it before sending: never double-DM
        STATE["handled"] = STATE["handled"][-2000:]

        if not configured():
            _record(author, text, "would send DM (Instagram not connected)")
            _save(STATE)
            return

        try:
            await send_private_reply(client, cid, compose(rule))
            rule["sent_count"] += 1
            action = "DM sent"
            if rule.get("public_reply"):
                try:
                    await send_public_reply(client, cid, rule["public_reply"])
                    action += " + public reply"
                except Exception as exc:  # noqa: BLE001
                    log.warning("public reply failed: %s", exc)
            _record(author, text, action)
            log.info("DM sent to @%s for %r", author, rule["keyword"])
        except Exception as exc:  # noqa: BLE001
            _record(author, text, f"error: {str(exc)[:80]}")
            log.warning("private reply failed: %s", exc)
        _save(STATE)
        return


async def _tick(client: httpx.AsyncClient, me: str) -> None:
    media = await _get(client, f"{USER_ID}/media", fields="id,caption,timestamp", limit=6)
    for item in media.get("data", []):
        try:
            comments = await _get(
                client, f"{item['id']}/comments", fields="id,text,username,timestamp", limit=40
            )
        except Exception as exc:  # noqa: BLE001
            log.debug("comments fetch failed for %s: %s", item["id"], exc)
            continue
        for comment in comments.get("data", []):
            await _process_comment(client, comment, me)


async def watch() -> None:
    """Poll recent media for new comments and fire armed rules."""
    if not configured():
        log.info("Instagram not connected — rules will log instead of sending")
        return

    identity = await whoami()
    me = (identity or {}).get("username", "")
    log.info("comment watcher running as @%s every %ss", me or "?", POLL_SECONDS)

    async with httpx.AsyncClient(timeout=25) as client:
        while True:
            try:
                if any(r.get("active") for r in STATE["rules"]):
                    await _tick(client, me)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.warning("watcher tick failed: %s", exc)
            await asyncio.sleep(POLL_SECONDS)


async def simulate(username: str, text: str) -> dict:
    """Run a fake comment through the real rules engine (used by tests and the demo
    fallback when Instagram credentials are not available)."""
    fake = {"id": f"sim_{uuid.uuid4().hex[:10]}", "text": text, "username": username}
    async with httpx.AsyncClient(timeout=20) as client:
        await _process_comment(client, fake, me="__none__")
    return events()[-1] if events() else {}
