"""Deterministic statistics.

Language models are bad at arithmetic and good at interpretation, so every
number the agents reason about is computed here first and handed to them as a
finished fact. This also keeps the analysis reproducible between runs.
"""

from __future__ import annotations

import statistics
from datetime import datetime, timezone
from typing import Any

from .schemas import BreakoutReel, CompareRow, Reel

DURATION_BUCKETS = [(7, "<7s"), (15, "7-15s"), (30, "15-30s"), (60, "30-60s"), (10**9, "60s+")]


def _bucket(seconds: float | None) -> str:
    if not seconds:
        return "unknown"
    for limit, label in DURATION_BUCKETS:
        if seconds < limit:
            return label
    return "60s+"


def _pct(part: float, whole: float) -> float:
    return round(100.0 * part / whole, 2) if whole else 0.0


def summarize(reels: list[Reel], followers: int = 0) -> dict[str, Any]:
    """Turn a pile of captured reels into the handful of numbers that matter."""
    reels = [r for r in reels if r.views or r.likes]
    if not reels:
        return {"reel_count": 0}

    views = [r.views for r in reels]
    median_views = int(statistics.median(views))
    mean_views = int(statistics.fmean(views))
    p90 = int(sorted(views)[max(0, int(len(views) * 0.9) - 1)])

    engagement = [
        _pct(r.likes + r.comments, r.views) for r in reels if r.views
    ]
    engagement_rate = round(statistics.fmean(engagement), 2) if engagement else 0.0

    # Breakouts: the reels that genuinely escaped the account's baseline.
    threshold = max(median_views * 3, 1)
    breakouts = sorted(
        [r for r in reels if r.views >= threshold], key=lambda r: r.views, reverse=True
    )[:5]

    # Cadence from post timestamps.
    stamps = sorted(r.taken_at for r in reels if r.taken_at)
    per_week = None
    hours: dict[int, int] = {}
    weekdays: dict[int, int] = {}
    if len(stamps) >= 2:
        span_days = max((stamps[-1] - stamps[0]) / 86400, 1)
        per_week = round(len(stamps) / span_days * 7, 1)
        for s in stamps:
            dt = datetime.fromtimestamp(s, tz=timezone.utc)
            hours[dt.hour] = hours.get(dt.hour, 0) + 1
            weekdays[dt.weekday()] = weekdays.get(dt.weekday(), 0) + 1

    durations: dict[str, list[int]] = {}
    for r in reels:
        durations.setdefault(_bucket(r.duration), []).append(r.views)
    duration_perf = {
        k: {"count": len(v), "median_views": int(statistics.median(v))}
        for k, v in sorted(durations.items(), key=lambda kv: -len(kv[1]))
    }

    original_audio = sum(1 for r in reels if r.is_original_audio)
    captions = [len(r.caption) for r in reels if r.caption]
    hashtags = [r.caption.count("#") for r in reels]

    top = sorted(reels, key=lambda r: r.views, reverse=True)[:5]
    bottom = sorted(reels, key=lambda r: r.views)[:3]

    return {
        "reel_count": len(reels),
        "median_views": median_views,
        "mean_views": mean_views,
        "p90_views": p90,
        "engagement_rate": engagement_rate,
        "views_per_follower": round(median_views / followers, 3) if followers else None,
        "breakout_threshold": threshold,
        "breakouts": [
            BreakoutReel(code=r.code, caption=r.caption[:120], views=r.views) for r in breakouts
        ],
        "reels_per_week": per_week,
        "top_hours_utc": sorted(hours, key=hours.get, reverse=True)[:3],
        "top_weekdays": sorted(weekdays, key=weekdays.get, reverse=True)[:3],
        "duration_performance": duration_perf,
        "original_audio_share": _pct(original_audio, len(reels)),
        "avg_caption_chars": int(statistics.fmean(captions)) if captions else 0,
        "avg_hashtags": round(statistics.fmean(hashtags), 1) if hashtags else 0,
        "top_reels": [
            {"code": r.code, "views": r.views, "likes": r.likes, "caption": r.caption[:160],
             "duration": r.duration, "audio": r.audio_title}
            for r in top
        ],
        "weak_reels": [
            {"code": r.code, "views": r.views, "caption": r.caption[:120]} for r in bottom
        ],
    }


def _fmt(n: float | None, suffix: str = "") -> str:
    if n is None:
        return "—"
    if isinstance(n, float) and not n.is_integer():
        return f"{n:g}{suffix}"
    n = int(n)
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M{suffix}".replace(".0M", "M")
    if n >= 1_000:
        return f"{n/1_000:.1f}K{suffix}".replace(".0K", "K")
    return f"{n}{suffix}"


def compare_table(mine: dict[str, Any], theirs: dict[str, Any],
                  my_followers: int, their_followers: int) -> list[CompareRow]:
    """Side-by-side rows with an explicit winner per metric."""
    def row(metric: str, a, b, fmt=_fmt, higher_is_better: bool = True) -> CompareRow:
        if a is None or b is None:
            winner = "tie"
        elif a == b:
            winner = "tie"
        else:
            better_is_me = (a > b) if higher_is_better else (a < b)
            winner = "me" if better_is_me else "them"
        return CompareRow(metric=metric, me=fmt(a), them=fmt(b), winner=winner)

    return [
        row("Obunachilar", my_followers, their_followers),
        row("Median ko'rish", mine.get("median_views"), theirs.get("median_views")),
        row("Eng yuqori (p90)", mine.get("p90_views"), theirs.get("p90_views")),
        row("Engagement %", mine.get("engagement_rate"), theirs.get("engagement_rate"),
            lambda v: _fmt(v, "%")),
        row("Ko'rish / obunachi", mine.get("views_per_follower"), theirs.get("views_per_follower"),
            lambda v: "—" if v is None else f"{v:g}"),
        row("Haftasiga reel", mine.get("reels_per_week"), theirs.get("reels_per_week"),
            lambda v: "—" if v is None else f"{v:g}"),
        row("Breakout reel", len(mine.get("breakouts", [])), len(theirs.get("breakouts", []))),
        row("Original audio %", mine.get("original_audio_share"), theirs.get("original_audio_share"),
            lambda v: _fmt(v, "%")),
    ]
