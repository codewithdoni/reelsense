"""Watch the actual video.

OpenAI's Responses API takes text and images but not video files, so reel footage
goes to a Gemini model that ingests video natively — it both sees the frames and
hears the audio in one call, which removes any need for ffmpeg or a separate
transcription step.

Two routes, tried in order: OpenRouter (sponsor credits) and the Gemini API
directly. If neither is configured the caller falls back to metadata-only
analysis and says so in the UI.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re

import httpx

log = logging.getLogger("reelsense.video")

OPENROUTER_KEY = os.getenv("OPENROUTER_API_KEY", "")
GEMINI_KEY = os.getenv("GEMINI_API_KEY", "")
VIDEO_MODEL = os.getenv("REELSENSE_VIDEO_MODEL") or "google/gemini-3-flash"
GEMINI_MODEL = os.getenv("REELSENSE_GEMINI_MODEL") or "gemini-3.6-flash"
MAX_BYTES = 19_000_000  # inline video ceiling

PROMPT = """Analyse this short-form vertical video as a social media strategist.

Return STRICT JSON, no markdown fence, with exactly these keys:
{
  "transcript": "every spoken word, verbatim, in the original language",
  "hook": "what is said AND shown in the first 3 seconds",
  "hook_type": "curiosity|pain|contrast|number|story|shock|promise",
  "scenes": ["0-3s: description", "3-7s: description", ...],
  "on_screen_text": ["each distinct text overlay, in order"],
  "pacing": "cuts per 10s, camera style, energy",
  "cta": "the call to action, or null",
  "visual_notes": "framing, setting, props, editing tricks worth copying"
}
Be concrete. Describe what is actually on screen, not what such a video usually contains."""


def _parse_json(text: str) -> dict | None:
    text = text.strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.MULTILINE).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                return None
    return None


async def _via_openrouter(b64: str) -> dict | None:
    if not OPENROUTER_KEY:
        return None
    payload = {
        "model": VIDEO_MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {"type": "video_url", "video_url": {"url": f"data:video/mp4;base64,{b64}"}},
                ],
            }
        ],
    }
    async with httpx.AsyncClient(timeout=180) as client:
        res = await client.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENROUTER_KEY}",
                "HTTP-Referer": "https://github.com/reelsense",
                "X-Title": "ReelSense",
            },
            json=payload,
        )
    if res.status_code >= 400:
        log.warning("openrouter video failed %s: %s", res.status_code, res.text[:300])
        return None
    content = res.json()["choices"][0]["message"]["content"]
    return _parse_json(content)


async def _via_gemini(b64: str) -> dict | None:
    if not GEMINI_KEY:
        return None
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent?key={GEMINI_KEY}"
    )
    payload = {
        "contents": [
            {
                "parts": [
                    {"text": PROMPT},
                    {"inline_data": {"mime_type": "video/mp4", "data": b64}},
                ]
            }
        ],
        "generationConfig": {"responseMimeType": "application/json"},
    }
    async with httpx.AsyncClient(timeout=180) as client:
        res = await client.post(url, json=payload)
    if res.status_code >= 400:
        log.warning("gemini video failed %s: %s", res.status_code, res.text[:300])
        return None
    parts = res.json()["candidates"][0]["content"]["parts"]
    return _parse_json("".join(p.get("text", "") for p in parts))


async def fetch_video(url: str) -> str | None:
    """Try to pull the mp4 server-side. Instagram's CDN often refuses; that is fine,
    the extension can fetch it from inside the page instead."""
    try:
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            res = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
        if res.status_code >= 400 or len(res.content) > MAX_BYTES:
            log.info("cdn fetch rejected: status=%s size=%s", res.status_code, len(res.content))
            return None
        return base64.b64encode(res.content).decode()
    except Exception as exc:  # noqa: BLE001
        log.info("cdn fetch failed: %s", exc)
        return None


async def analyze(b64: str | None, video_url: str | None) -> dict | None:
    """Return a structured reading of the video, or None if it could not be watched."""
    if not b64 and video_url:
        b64 = await fetch_video(video_url)
    if not b64:
        return None
    if len(b64) * 3 / 4 > MAX_BYTES:
        log.info("video too large for inline analysis")
        return None

    for route, fn in (("openrouter", _via_openrouter), ("gemini", _via_gemini)):
        try:
            result = await fn(b64)
            if result:
                result["_route"] = route
                return result
        except Exception as exc:  # noqa: BLE001
            log.warning("video route %s raised: %s", route, exc)
    return None


def configured() -> bool:
    return bool(OPENROUTER_KEY or GEMINI_KEY)
