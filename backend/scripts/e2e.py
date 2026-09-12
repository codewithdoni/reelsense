"""End-to-end check against a running server, using a realistic captured account.

    .venv/bin/python -m scripts.e2e [profile|ideas|compare|reel|video|all]

Exercises the real model path — the same request bodies the side panel sends.
`video` additionally spends a few cents proving the provider really accepts
inline video, which is the one integration a mocked payload cannot verify.
"""

from __future__ import annotations

import base64
import json
import pathlib
import sys
import time

import httpx

BASE = "http://localhost:8000"
NOW = int(time.time())

PROFILE = {
    "username": "fitwithaziz",
    "full_name": "Aziz | Uy sharoitida fitness",
    "biography": "Uy sharoitida 20 daqiqada mashq · Sport zalisiz · Toshkent",
    "followers": 18400,
    "following": 312,
    "media_count": 214,
    "category": "Personal Trainer",
    "is_business": True,
}

# A plausible account: a few breakouts, a long tail, mixed formats.
REELS = [
    ("3 ta xato: qorin mushaklari chiqmayapti", 412_000, 21_400, 480, 14.2, True, 3),
    ("Uyda 20 daqiqa: to'liq mashq", 38_000, 2_100, 96, 62.0, True, 9),
    ("Protein kerakmi? Oddiy javob", 19_500, 980, 41, 28.5, False, 15),
    ("Ertalab turishning eng oson yo'li", 256_000, 14_800, 390, 11.8, True, 21),
    ("Sport zalisiz ko'krak mashqi", 22_400, 1_050, 33, 34.0, False, 27),
    ("Kechki ovqatdan keyin nima qilish kerak", 8_900, 410, 18, 44.0, False, 33),
    ("Bir oyda natija: rostmi?", 15_200, 720, 55, 51.0, False, 39),
    ("Eng ko'p so'raladigan savol", 31_000, 1_600, 88, 13.4, True, 45),
    ("Suv qancha ichish kerak", 6_400, 290, 12, 38.0, False, 51),
    ("Mashqdan keyin og'riq — normalmi?", 11_800, 540, 26, 25.0, False, 57),
    ("5 daqiqalik cho'zilish", 9_200, 380, 15, 19.0, True, 63),
    ("Kaloriya sanashni to'xtating", 47_000, 2_900, 140, 16.5, True, 69),
]

COMPETITOR_PROFILE = {
    "username": "sport.hamrohingiz",
    "full_name": "Sport Hamrohingiz",
    "biography": "Kunlik mashqlar · Ovqatlanish · 100k+ jamoa",
    "followers": 104_000,
    "following": 180,
    "media_count": 640,
    "category": "Fitness Trainer",
    "is_business": True,
}

COMPETITOR_REELS = [
    ("30 kunlik chellenj: 1-kun", 1_240_000, 68_000, 2_100, 12.0, True, 2),
    ("Nonushta uchun 3 ta variant", 210_000, 9_800, 340, 22.0, False, 6),
    ("Bu mashqni noto'g'ri qilyapsiz", 890_000, 44_000, 1_500, 9.5, True, 11),
    ("Zalga bormasdan natija", 120_000, 5_400, 190, 31.0, False, 16),
    ("Kechki ovqat: nima yeyish mumkin", 96_000, 4_100, 150, 27.0, False, 22),
    ("Hafta davomida rejam", 74_000, 3_200, 110, 48.0, False, 29),
    ("1 daqiqada: qorin mashqi", 640_000, 31_000, 980, 8.0, True, 35),
    ("Suv va vazn: bog'liqlikmi?", 58_000, 2_400, 88, 35.0, False, 42),
    ("Eng katta xato", 430_000, 22_000, 700, 10.5, True, 49),
    ("Ovqatlanish rejasi", 88_000, 3_900, 130, 40.0, False, 55),
]


def mk(items, owner):
    return [
        {
            "code": f"D{owner[:3]}{i:04d}",
            "username": owner,
            "caption": cap,
            "views": v,
            "likes": lk,
            "comments": cm,
            "taken_at": NOW - days * 86400,
            "duration": dur,
            "is_original_audio": orig,
            "audio_title": "Original audio" if orig else "Trending sound",
        }
        for i, (cap, v, lk, cm, dur, orig, days) in enumerate(items)
    ]


COMMENTS = [
    {"id": "1", "text": "Bu mashqni tizza og'rig'i bilan qilsa bo'ladimi?", "username": "user1"},
    {"id": "2", "text": "Ovqatlanish rejasini ham chiqaring iltimos", "username": "user2"},
    {"id": "3", "text": "+", "username": "user3"},
    {"id": "4", "text": "Zalga bormay natija bo'ladimi rostdan?", "username": "user4"},
    {"id": "5", "text": "Ayollar uchun ham shu mashqmi?", "username": "user5"},
]


def post(path: str, body: dict, timeout: float = 240) -> dict:
    t0 = time.time()
    res = httpx.post(BASE + path, json=body, timeout=timeout)
    took = time.time() - t0
    if res.status_code != 200:
        print(f"\n✗ {path} -> {res.status_code}\n{res.text[:900]}\n")
        sys.exit(1)
    print(f"✓ {path}  ({took:.1f}s)")
    return res.json()


def show(label: str, value, limit: int = 3):
    print(f"\n  \033[1m{label}\033[0m")
    if isinstance(value, str):
        print("   ", value[:400].replace("\n", "\n    "))
    elif isinstance(value, list):
        for item in value[:limit]:
            if isinstance(item, dict):
                print("    -", json.dumps(item, ensure_ascii=False)[:220])
            else:
                print("    -", str(item)[:220])
    else:
        print("   ", str(value)[:400])


def run_profile() -> dict:
    print("\n=== profile audit ===")
    rep = post("/analyze/profile", {"profile": PROFILE, "reels": mk(REELS, "fitwithaziz"), "lang": "uz"})
    m = rep["metrics"]
    print(f"\n  computed: median={m['median_views']:,} p90={m['p90_views']:,} "
          f"er={m['engagement_rate']}% breakouts={len(m['breakouts'])} "
          f"cadence={m['reels_per_week']}/week")
    show("niche", rep["niche"])
    show("voice", rep["voice"])
    show("pillars", rep["pillars"])
    show("what works", rep["what_works"])
    show("recommendations", rep["recommendations"])
    print(f"\n  score: {rep['score']}/100")
    return rep


def run_compare() -> dict:
    print("\n=== competitor compare ===")
    rep = post("/compare", {
        "me": {"profile": PROFILE, "reels": mk(REELS, "fitwithaziz")},
        "them": {"profile": COMPETITOR_PROFILE, "reels": mk(COMPETITOR_REELS, "sport.hamrohingiz")},
        "them_comments": COMMENTS,
        "lang": "uz",
    })
    print()
    for r in rep["table"]:
        mark = {"me": "◀ siz", "them": "▶ ular", "tie": ""}[r["winner"]]
        print(f"    {r['metric']:<22} {r['me']:>10}  {r['them']:>10}   {mark}")
    show("breakouts", rep["breakouts"])
    show("gaps", rep["gaps"])
    show("steal these", rep["steal_these"], limit=2)
    return rep


def run_ideas(profile_report: dict, competitor_report: dict | None) -> dict:
    print("\n=== ideas + scripts ===")
    body = {"profile_report": {k: v for k, v in profile_report.items() if k != "metrics"},
            "competitor_report": competitor_report, "reel_reports": [], "lang": "uz"}
    pack = post("/generate/ideas", body)
    for i, idea in enumerate(pack["ideas"], 1):
        print(f"\n  \033[1m{i}. {idea['title']}\033[0m  [{idea.get('format')}]")
        print(f"     {idea['why_it_fits'][:200]}")
        for h in idea["hooks"][:2]:
            print(f"     hook: {h[:140]}")
        lm = idea.get("lead_magnet")
        if lm:
            print(f"     lead magnet: \"{lm['keyword']}\" -> {lm['dm_text'][:110]}")
        print(f"     script: {len(idea.get('script',''))} chars")
    return pack


def run_reel() -> dict:
    print("\n=== reel decode (metadata mode, no video bytes) ===")
    rep = post("/analyze/reel", {
        "reel": mk(REELS, "fitwithaziz")[0],
        "comments": COMMENTS,
        "my_profile": PROFILE,
        "lang": "uz",
    })
    print(f"\n  saw_video: {rep['saw_video']}")
    show("hook", rep["hook"])
    show("structure", rep["structure"])
    show("why it works", rep["why_it_works"])
    show("remake script", rep["remake_script"])
    return rep


SAMPLE_VIDEO = "https://download.samplelib.com/mp4/sample-5s.mp4"
SAMPLE_PATH = pathlib.Path("/tmp/reelsense-sample.mp4")


def run_video() -> dict:
    """Prove the provider accepts inline video, not just that our code compiles."""
    print("\n=== reel decode (real video bytes) ===")
    if not SAMPLE_PATH.exists():
        print("  downloading sample clip…")
        SAMPLE_PATH.write_bytes(httpx.get(SAMPLE_VIDEO, follow_redirects=True, timeout=120).content)
    b64 = base64.b64encode(SAMPLE_PATH.read_bytes()).decode()
    print(f"  {len(b64) * 3 // 4:,} bytes in")

    rep = post("/analyze/reel", {
        "reel": {**mk(REELS, "fitwithaziz")[0], "video_url": None},
        "comments": COMMENTS,
        "my_profile": PROFILE,
        "video_b64": b64,
        "lang": "uz",
    })
    print(f"\n  saw_video: {rep['saw_video']}")
    if not rep["saw_video"]:
        print("  ✗ the provider did not accept the video — check REELSENSE_VIDEO_MODEL "
              "supports the `video` input modality")
        sys.exit(1)
    show("hook", rep["hook"])
    show("on screen text", rep["on_screen_text"])
    show("transcript", rep["transcript"])
    return rep


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    health = httpx.get(BASE + "/health", timeout=5).json()
    print(f"provider={health['provider']} model={health['model']} "
          f"video={health['video']} instagram={health['instagram']}")
    if not health["llm_ready"]:
        print("no model key configured")
        sys.exit(1)

    prof = comp = None
    if which in ("profile", "ideas", "all"):
        prof = run_profile()
    if which in ("compare", "all"):
        comp = run_compare()
    if which in ("ideas", "all"):
        run_ideas(prof, comp)
    if which in ("reel", "all"):
        run_reel()
    if which == "video":
        run_video()
    print("\ndone\n")
