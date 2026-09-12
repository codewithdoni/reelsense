"""ReelSense API — the side panel's brain."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

from . import brain, dm, exa, video  # noqa: E402
from .metrics import compare_table, summarize  # noqa: E402
from .schemas import (  # noqa: E402
    AnalyzeProfileReq,
    AnalyzeReelReq,
    CompareReq,
    IdeasReq,
    RuleReq,
    ToggleReq,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)-18s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("reelsense")


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(dm.watch())
    log.info(
        "ReelSense up — model=%s video=%s instagram=%s trends=%s",
        brain.MODEL,
        "on" if video.configured() else "off",
        "connected" if dm.configured() else "not connected",
        "on" if exa.configured() else "off",
    )
    yield
    task.cancel()


app = FastAPI(title="ReelSense", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"chrome-extension://.*|http://localhost:\d+",
    allow_methods=["*"],
    allow_headers=["*"],
)


def _fail(exc: Exception) -> HTTPException:
    log.exception("request failed")
    return HTTPException(status_code=500, detail=str(exc)[:400])


def _real_key(name: str) -> bool:
    """A key copied from .env.example is worse than no key: it fails at call time
    instead of at startup. Treat placeholders as missing."""
    value = (os.getenv(name) or "").strip()
    return len(value) > 20 and "..." not in value and not value.lower().startswith("your")


@app.get("/health")
async def health():
    return {
        "ok": True,
        "model": brain.MODEL,
        "video": video.configured(),
        "instagram": dm.configured(),
        "trends": exa.configured(),
        "openai_key": _real_key("OPENAI_API_KEY"),
    }


# --- analysis --------------------------------------------------------------


@app.post("/analyze/profile")
async def analyze_profile(req: AnalyzeProfileReq):
    if not req.reels:
        raise HTTPException(400, "Hech qanday reel yig'ilmadi — Reels tabini aylantiring.")
    stats = summarize(req.reels, req.profile.followers)
    try:
        report = await brain.analyze_profile(
            req.profile.model_dump(), _jsonable(stats), req.lang
        )
    except Exception as exc:  # noqa: BLE001
        raise _fail(exc) from exc
    return {**report.model_dump(), "metrics": _jsonable(stats)}


@app.post("/analyze/reel")
async def analyze_reel(req: AnalyzeReelReq):
    analysis = None
    if video.configured():
        analysis = await video.analyze(req.video_b64, req.reel.video_url)
        if analysis:
            log.info("video analysed via %s for %s", analysis.get("_route"), req.reel.code)
        else:
            log.info("video unavailable for %s — metadata mode", req.reel.code)

    try:
        report = await brain.decode_reel(
            req.reel.model_dump(),
            analysis,
            [c.model_dump() for c in req.comments],
            req.my_profile.model_dump() if req.my_profile else None,
            req.lang,
        )
    except Exception as exc:  # noqa: BLE001
        raise _fail(exc) from exc

    data = report.model_dump()
    if analysis and not data.get("transcript"):
        data["transcript"] = analysis.get("transcript", "")
    return {**data, "saw_video": analysis is not None}


@app.post("/compare")
async def compare(req: CompareReq):
    if not req.them.reels:
        raise HTTPException(400, "Raqobatchining reellari yig'ilmadi — uning Reels tabini aylantiring.")
    mine = summarize(req.me.reels, req.me.profile.followers)
    theirs = summarize(req.them.reels, req.them.profile.followers)
    table = compare_table(mine, theirs, req.me.profile.followers, req.them.profile.followers)

    try:
        report = await brain.compare(
            req.me.profile.model_dump(),
            req.them.profile.model_dump(),
            _jsonable(mine),
            _jsonable(theirs),
            [r.model_dump() for r in table],
            [c.model_dump() for c in req.them_comments],
            req.lang,
        )
    except Exception as exc:  # noqa: BLE001
        raise _fail(exc) from exc

    data = report.model_dump()
    # Numbers are computed, not generated.
    data["table"] = [r.model_dump() for r in table]
    data["breakouts"] = _jsonable(theirs.get("breakouts", []))
    return data


@app.post("/generate/ideas")
async def generate_ideas(req: IdeasReq):
    # Past performance says what worked; the trend radar says what the niche is
    # talking about this week. Ideas are better when they know both.
    trends = await exa.trends(req.profile_report.niche) if exa.configured() else []
    if trends:
        log.info("trend radar: %d recent items for %r", len(trends), req.profile_report.niche)

    try:
        pack = await brain.make_ideas(
            req.profile_report.model_dump(),
            req.competitor_report.model_dump() if req.competitor_report else None,
            [r.model_dump() for r in req.reel_reports],
            req.lang,
            trends=trends,
        )
    except Exception as exc:  # noqa: BLE001
        raise _fail(exc) from exc
    return {**pack.model_dump(), "trend_sources": [t["url"] for t in trends[:5]]}


@app.get("/trends")
async def get_trends(niche: str):
    if not exa.configured():
        raise HTTPException(400, "EXA_API_KEY sozlanmagan")
    return {"niche": niche, "items": await exa.trends(niche)}


@app.get("/discover")
async def discover(username: str):
    if not exa.configured():
        raise HTTPException(400, "EXA_API_KEY sozlanmagan")
    return {"seed": username, "accounts": await exa.similar_accounts(username)}


# --- automation ------------------------------------------------------------


@app.get("/automation/state")
async def automation_state():
    identity = await dm.whoami()
    return {
        "connected": dm.configured() and identity is not None,
        "username": (identity or {}).get("username"),
        "poll_seconds": dm.POLL_SECONDS,
        "rules": dm.rules(),
        "events": dm.events(),
    }


@app.post("/automation/rules")
async def create_rule(req: RuleReq):
    if not req.keyword or not req.dm_text:
        raise HTTPException(400, "Kalit so'z va DM matni kerak.")
    return dm.add_rule(req.keyword, req.dm_text, req.public_reply, req.link)


@app.post("/automation/rules/toggle")
async def toggle_rule(req: ToggleReq):
    rule = dm.toggle_rule(req.id)
    if not rule:
        raise HTTPException(404, "Qoida topilmadi")
    return rule


@app.post("/automation/simulate")
async def simulate(username: str = "tester", text: str = "+"):
    """Push a comment through the live rules engine without waiting for Instagram."""
    return await dm.simulate(username, text)


# --- helpers ---------------------------------------------------------------


def _jsonable(value):
    """Pydantic models nested inside plain dicts (breakouts) -> plain data."""
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    if hasattr(value, "model_dump"):
        return value.model_dump()
    return value
