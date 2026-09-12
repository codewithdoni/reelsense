# ReelSense

**The AI social media manager that lives inside Instagram — and acts there.**

Built for the AI Tinkerers × OpenAI *Agents, Everywhere* global hackathon, 12 September 2026, Tashkent.

---

## The problem

Creators do their work on instagram.com. Every tool that helps them lives somewhere else.

You paste a username into a separate app, wait, and read a generic report about an account you already know. Then you go back to Instagram and start over. Meanwhile, comment-to-DM tools automate the delivery end but have no idea what your content is about — a human still writes every rule.

Nothing closes the loop.

## What ReelSense does

It is a Chrome side panel on instagram.com. Whatever you are looking at, it is already looking at too.

```
ANALYSE                 CREATE                  ACT
profile audit     →     5 reel ideas      →     someone comments "+"
competitor gaps         full scripts            → auto DM with the link
viral reel decode       + a comment CTA         (the rule the agent wrote)
```

The agent writes the script, puts a call-to-action in it, arms the automation for that exact CTA, and then delivers the DMs when the comments arrive. That chain does not exist in a chat window.

### Five things it does

| | |
|---|---|
| **Profile audit** | What separates your best reels from your worst — hook style, duration, audio, cadence — with three things to do next. |
| **Reel decoder** | Watches and *hears* any reel: hook, beat-by-beat structure, on-screen text, pacing, transcript. Then rewrites the format as a script in your voice. |
| **Competitor compare** | Side-by-side metrics, their breakout reels (median × 3), what their audience keeps asking for that nobody answers, and 5 transferable formats with hooks already written for your niche. |
| **Ideas & scripts** | Five reels you can shoot this week, each traced back to evidence, each with a lead magnet. |
| **Comment → DM** | Arm a keyword, and the official Instagram Messaging API delivers the private reply when someone comments it. |

Scripts are written in Uzbek, Russian or English.

## How it gets its data

This is the part that makes the environment matter.

Instagram's official Graph API only reports on your own account — competitor analysis is impossible through it, and a scraper that calls Instagram's private endpoints breaks every few weeks when the `doc_id` values rotate, on top of being rate-limited and against the terms.

ReelSense does neither. A content script in the page's main world wraps `fetch` and `XMLHttpRequest` and reads the responses **the page already loaded for the logged-in user**. Open a profile, and the profile JSON is there. Scroll the Reels tab, and forty reels arrive with play counts, durations, captions and audio metadata. Open a reel, and the comments come with it.

No extra request is made that Instagram would not have made anyway. There is no scraping, no stored credentials, no automation of the web session. The user's own browser is the data source, which is exactly the thing a standalone app cannot have.

Because Instagram renames fields and reshapes payloads constantly, the normalizer does not hard-code response paths. It walks each payload and recognises objects by their shape, so a schema change does not need a code change. Three different real payload shapes are covered by tests.

### Watching the video

OpenAI's Responses API takes text and images, not video files. Reel footage goes to Gemini instead, which ingests video natively and both sees the frames and hears the audio in one call — no ffmpeg, no separate transcription pass. OpenRouter is tried first, the Gemini API second, and if neither is configured the reel is analysed from metadata and the panel says so rather than inventing visual details.

### Sending the DM

Delivery uses Meta's official Instagram Messaging API — private replies to a comment, never the logged-in web session. Automating DMs through the web UI risks the creator's account.

Meta's constraints are enforced locally too: one private reply per comment ever, within 7 days, never to your own comment. The rules engine claims a comment id before sending, so a restart or a double poll cannot produce a second DM.

Production would subscribe to the `comments` webhook. This build polls every 10 seconds instead — it needs no public HTTPS callback and no webhook configuration, which is the right trade when the build window is a few hours.

## Architecture

```
instagram.com (logged in)
  │
  ├─ interceptor.js   MAIN world — wraps fetch/XHR, reads what the page loaded
  ├─ content.js       relays payloads, tracks which page you are on (SPA-aware)
  └─ background.js    normalizes and accumulates: profiles, reels, comments
        │
        ▼
   Side panel (vanilla MV3, no build step)
        │  JSON over localhost
        ▼
   FastAPI
        ├─ metrics.py   medians, breakouts, cadence, duration buckets   ← arithmetic
        ├─ brain.py     ProfileAnalyst · ReelDecoder · CompetitorAnalyst · Strategist
        │               (OpenAI Agents SDK, typed Pydantic outputs)     ← judgement
        ├─ video.py     OpenRouter → Gemini, native video understanding
        └─ dm.py        rules engine + comment watcher → Instagram Messaging API
```

Every number the agents reason about is computed in `metrics.py` first and handed over as a finished fact. Models are bad at arithmetic and good at interpretation, so the split is deliberate — it also makes the analysis reproducible between runs.

Each agent has a typed output contract, so the panel renders structured data instead of parsing prose. If the primary model is unavailable the run degrades to a cheaper one rather than failing.

## Running it

**Backend**

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env      # add OPENAI_API_KEY at minimum
.venv/bin/uvicorn app.main:app --port 8000
```

**Extension**

```
chrome://extensions → Developer mode → Load unpacked → select extension/
```

Open instagram.com and click the ReelSense icon. Visit your profile, scroll the Reels tab once or twice, then hit *Analyze*.

**Tests**

```bash
.venv/bin/python -m scripts.smoke        # statistics, comparison, rules engine
node extension/test/extract.test.mjs     # payload normalizer, 3 real shapes
```

## Configuration

| Variable | Needed for |
|---|---|
| `OPENAI_API_KEY` | everything |
| `OPENROUTER_API_KEY` *or* `GEMINI_API_KEY` | watching the video (otherwise metadata-only) |
| `IG_TOKEN`, `IG_USER_ID` | sending DMs (otherwise rules log "would send") |

Instagram credentials come from developers.facebook.com → your app → Instagram → *API setup with Instagram login* → **Generate token**, with scopes `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_manage_messages`. Standard Access is enough to run this on your own account.

Every integration degrades instead of crashing: no video key means metadata-only analysis, no Instagram token means rules are stored and logged rather than sent. The panel always says which mode it is in.

## Boundaries

- Reads only what the logged-in user's own browser already loaded. No credential storage, no scraping, no session automation.
- No follows, likes, mass-DMs or engagement automation. The only outbound action is a private reply to someone who chose to comment a keyword.
- A personal research and authoring tool, not an Instagram product.

## Built with

OpenAI Agents SDK · Gemini via OpenRouter · FastAPI · Chrome Manifest V3

Thanks to the hackathon partners: OpenAI, CopilotKit, OpenRouter, Impact Hub Tashkent and ML Community Uzbekistan.

## License

MIT
