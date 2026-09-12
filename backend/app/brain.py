"""The agents.

Four specialists, each with a typed output contract so the side panel can render
results without parsing prose. Statistics arrive pre-computed from metrics.py —
the agents interpret, they do not count.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, TypeVar

from agents import Agent, Runner
from pydantic import BaseModel

from .schemas import CompetitorReport, IdeaPack, ProfileReport, ReelReport

log = logging.getLogger("reelsense.brain")

MODEL = os.getenv("REELSENSE_MODEL", "gpt-5.6-terra")
FALLBACK_MODELS = [m for m in os.getenv("REELSENSE_FALLBACK_MODELS", "gpt-5.6-luna,gpt-4o").split(",") if m]

LANG_NAMES = {"uz": "Uzbek", "ru": "Russian", "en": "English"}

HOUSE_RULES = """
You are part of ReelSense, a social media strategist that works from real captured
Instagram data. Rules that apply to every answer:

- Ground every claim in the numbers and captions you were given. Reference concrete
  reels ("the 42s cooking reel at 310K") instead of generic advice.
- Never invent metrics. If something was not captured, say what is missing.
- Advice must be specific enough to act on today. "Post more consistently" is a
  failure; "you post 1.2 reels/week, all on weekends — add one Tuesday reel using
  the format from your 310K reel" is correct.
- Short-form video reality in 2026: the first 3 seconds decide reach, shares
  (sends) outrank likes in distribution, and skip rate is the metric to beat.
- Write naturally in the requested language. For Uzbek, use everyday spoken Uzbek
  (Latin script), not translated-from-English phrasing.
"""

T = TypeVar("T", bound=BaseModel)


def _agent(name: str, instructions: str, output_type: type[T], model: str | None = None) -> Agent:
    return Agent(
        name=name,
        instructions=HOUSE_RULES + "\n" + instructions,
        model=model or MODEL,
        output_type=output_type,
    )


async def _run(name: str, instructions: str, output_type: type[T], payload: Any) -> T:
    """Run an agent, degrading to a cheaper model if the primary one is unavailable."""
    prompt = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, default=str)
    errors: list[str] = []
    for model in [MODEL, *FALLBACK_MODELS]:
        try:
            result = await Runner.run(_agent(name, instructions, output_type, model), prompt)
            return result.final_output
        except Exception as exc:  # noqa: BLE001 - we deliberately try the next model
            errors.append(f"{model}: {exc}")
            log.warning("agent %s failed on %s: %s", name, model, exc)
    raise RuntimeError(f"All models failed for {name}. " + " | ".join(errors))


# --- profile ---------------------------------------------------------------

PROFILE_INSTRUCTIONS = """
Audit this Instagram creator from their captured profile and reels.

You receive: the profile, pre-computed statistics (median/p90 views, engagement,
cadence, duration performance, audio mix), the top reels and the weakest reels.

Work out what actually separates the top reels from the weak ones — topic, hook
style, duration bucket, audio choice, caption length. That difference is the
whole point of the audit.

The score is profile health: reach relative to follower count, consistency of
output, and how repeatable their winning format is.
"""


async def analyze_profile(profile: dict, metrics: dict, lang: str) -> ProfileReport:
    return await _run(
        "ProfileAnalyst",
        PROFILE_INSTRUCTIONS + f"\nWrite every field in {LANG_NAMES.get(lang, 'Uzbek')}.",
        ProfileReport,
        {"profile": profile, "statistics": metrics},
    )


# --- reel ------------------------------------------------------------------

REEL_INSTRUCTIONS = """
Decode one reel so the creator can rebuild its mechanics.

You may receive a machine analysis of the actual video (transcript, shot-by-shot
description, on-screen text, pacing). If you do, use it as ground truth for the
hook, structure and on-screen text fields. If you do not, say so plainly in
why_it_works and work from caption, metrics and comments only — do not invent
visual details you were not given.

The remake_script is the deliverable: a complete, recordable script that moves
this format onto the target creator's niche and voice. Include the spoken lines,
the on-screen text, the shot changes, and a CTA. Never copy the original wording.
"""


async def decode_reel(reel: dict, video_analysis: dict | None, comments: list[dict],
                      my_profile: dict | None, lang: str) -> ReelReport:
    return await _run(
        "ReelDecoder",
        REEL_INSTRUCTIONS + f"\nWrite remake_script, hook and all prose in {LANG_NAMES.get(lang, 'Uzbek')}.",
        ReelReport,
        {
            "reel": reel,
            "video_analysis": video_analysis,
            "video_was_analyzed": video_analysis is not None,
            "comments": comments[:40],
            "target_creator": my_profile,
        },
    )


# --- competitor ------------------------------------------------------------

COMPETITOR_INSTRUCTIONS = """
Compare the creator ("me") against a competitor ("them") and produce a plan.

The comparison table and breakout list are already computed and passed to you —
copy them into your output unchanged, then interpret them.

they_win_at / i_win_at must cite the evidence. gaps come from what their
commenters ask for that neither account answers well. steal_these must contain
exactly 5 transferable format templates, each with a hook already rewritten for
MY niche — not theirs.
"""


async def compare(me: dict, them: dict, my_metrics: dict, their_metrics: dict,
                  table: list[dict], comments: list[dict], lang: str) -> CompetitorReport:
    # The caller overwrites table and breakouts with the computed values afterwards:
    # those are facts, not opinions.
    return await _run(
        "CompetitorAnalyst",
        COMPETITOR_INSTRUCTIONS + f"\nWrite all prose in {LANG_NAMES.get(lang, 'Uzbek')}.",
        CompetitorReport,
        {
            "me": {"profile": me, "statistics": my_metrics},
            "them": {"profile": them, "statistics": their_metrics},
            "comparison_table": table,
            "their_breakout_reels": their_metrics.get("breakouts", []),
            "their_comments": comments[:60],
        },
    )


# --- strategist ------------------------------------------------------------

IDEAS_INSTRUCTIONS = """
Turn the analysis into 5 reels the creator can shoot this week.

Each idea must trace back to evidence: their own winning pattern, a competitor
format worth stealing, or a gap their audience keeps asking about. Say which in
why_it_fits.

The script is a real script — spoken lines, on-screen text cues, shot changes,
and a CTA — not a summary of one.

lead_magnet: give every idea that can carry one a comment-to-DM offer. The
keyword must be something a viewer will actually type ("+", "GID", "PLAN").
public_reply is what gets posted under their comment; dm_text is the direct
message they receive. Write dm_text as a real message from the creator, one or
two sentences, with the link at the end. If the creator has nothing to deliver
for an idea, set lead_magnet to null rather than inventing a product.

recent_niche_trends, when present, is live web context about what this niche is
discussing right now. Use it to make one or two ideas timely, and only when it
genuinely fits the creator — a forced trend is worse than an evergreen idea.
"""


async def make_ideas(profile_report: dict, competitor_report: dict | None,
                     reel_reports: list[dict], lang: str,
                     trends: list[dict] | None = None) -> IdeaPack:
    return await _run(
        "Strategist",
        IDEAS_INSTRUCTIONS + f"\nWrite titles, hooks, scripts, captions and DM text in {LANG_NAMES.get(lang, 'Uzbek')}.",
        IdeaPack,
        {
            "profile_report": profile_report,
            "competitor_report": competitor_report,
            "decoded_reels": reel_reports[:4],
            "recent_niche_trends": trends or [],
        },
    )
