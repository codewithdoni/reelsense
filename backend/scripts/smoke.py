"""Smoke test — checks everything that does not need a model call.

    .venv/bin/python -m scripts.smoke

Verifies: statistics, the comparison table, the comment-to-DM rules engine
(including the never-DM-twice guarantee), and the live HTTP surface if the
server happens to be running.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import dm  # noqa: E402
from app.metrics import compare_table, summarize  # noqa: E402
from app.schemas import Reel  # noqa: E402

OK, FAIL = "\033[32m✓\033[0m", "\033[31m✗\033[0m"
failures = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global failures
    print(f"  {OK if condition else FAIL} {label}{'' if condition else '  ' + detail}")
    if not condition:
        failures += 1


def fake_reels(n: int, base: int, spike_at: int | None = None) -> list[Reel]:
    now = int(time.time())
    out = []
    for i in range(n):
        views = base + i * 120
        if spike_at is not None and i == spike_at:
            views = base * 12
        out.append(
            Reel(
                code=f"C{i:04d}",
                username="demo",
                caption=f"Reel {i} #test #uz",
                views=views,
                likes=views // 20,
                comments=views // 200,
                taken_at=now - (n - i) * 86400 * 2,
                duration=8 + (i % 4) * 9,
                is_original_audio=i % 3 == 0,
            )
        )
    return out


def test_metrics() -> None:
    print("\nmetrics")
    reels = fake_reels(14, 5_000, spike_at=9)
    s = summarize(reels, followers=12_000)

    check("counts every reel", s["reel_count"] == 14)
    check("median computed", s["median_views"] > 0)
    check("breakout threshold is median x3", s["breakout_threshold"] == s["median_views"] * 3)
    check("spike detected as breakout", len(s["breakouts"]) == 1, f"got {len(s['breakouts'])}")
    check("breakout is the spike", s["breakouts"][0].views == 60_000)
    check("cadence derived", s["reels_per_week"] is not None)
    check("duration buckets built", len(s["duration_performance"]) >= 2)
    check("views per follower", s["views_per_follower"] is not None)

    flat = summarize(fake_reels(10, 5_000), followers=12_000)
    check("no false breakouts on flat account", flat["breakouts"] == [])
    check("empty input is safe", summarize([], 0)["reel_count"] == 0)


def test_compare() -> None:
    print("\ncomparison table")
    mine = summarize(fake_reels(10, 2_000), followers=5_000)
    theirs = summarize(fake_reels(12, 20_000, spike_at=5), followers=50_000)
    table = compare_table(mine, theirs, 5_000, 50_000)

    check("every metric has a row", len(table) == 8, f"got {len(table)}")
    check("winner is decided per row", all(r.winner in ("me", "them", "tie") for r in table))
    check("bigger account wins reach", next(r for r in table if "Median" in r.metric).winner == "them")


def test_rules() -> None:
    print("\ncomment-to-DM rules engine")
    dm.STATE["rules"].clear()
    dm.STATE["events"].clear()
    dm.STATE["handled"].clear()

    rule = dm.add_rule(keyword="+", dm_text="Mana qo'llanma:", link="https://example.com/guide")
    check("rule stored", len(dm.rules()) == 1)
    check("link appended to DM", "example.com" in dm.compose(rule))

    check("bare + matches", dm.match(rule, "+"))
    check("+ with punctuation matches", dm.match(rule, "+!"))
    check("+ inside a sentence does not match", not dm.match(rule, "juda zo'r + davom eting"))

    word = dm.add_rule(keyword="GID", dm_text="Link:")
    check("word keyword matches in sentence", dm.match(word, "menga GID kerak"))
    check("word keyword is case insensitive", dm.match(word, "gid yuboring"))
    check("unrelated comment does not match", not dm.match(word, "zo'r video"))

    async def run() -> None:
        await dm.simulate("viewer_one", "+")
        first = len(dm.events())
        await dm.simulate("viewer_one", "+")  # same generated id? no - new id, but rule fires again
        return first

    first = asyncio.run(run())
    check("comment triggers an event", first >= 1)
    check("event names the commenter", dm.events()[-1]["username"].startswith("viewer"))

    # Idempotency: the same comment id must never be handled twice.
    cid = "c_repeat"
    async def twice() -> None:
        import httpx
        async with httpx.AsyncClient() as client:
            for _ in range(2):
                await dm._process_comment(client, {"id": cid, "text": "+", "username": "bob"}, me="x")
    before = len(dm.events())
    asyncio.run(twice())
    check("same comment handled exactly once", len(dm.events()) == before + 1,
          f"added {len(dm.events()) - before}")

    dm.STATE["rules"].clear()
    dm.STATE["events"].clear()
    dm.STATE["handled"].clear()
    dm._save(dm.STATE)


def test_http() -> None:
    print("\nhttp surface")
    try:
        import httpx

        r = httpx.get("http://localhost:8000/health", timeout=3)
        body = r.json()
        check("/health responds", r.status_code == 200)
        if body.get("llm_ready"):
            check(f"llm provider: {body['provider']} ({body['model']})", True)
        else:
            print("     ⚠ no model key — set GEMINI_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY")
        if not body.get("video"):
            print("     ⚠ no video key — reels analysed from metadata only")
        if not body.get("instagram"):
            print("     ⚠ Instagram not connected — DM rules will log instead of send")
    except Exception:
        print("     — server not running, skipped (uvicorn app.main:app)")


if __name__ == "__main__":
    test_metrics()
    test_compare()
    test_rules()
    test_http()
    print(f"\n{'all checks passed' if not failures else str(failures) + ' FAILED'}\n")
    sys.exit(1 if failures else 0)
