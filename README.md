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

### What it does

| | |
|---|---|
| **Profile audit** | What separates your best reels from your worst — hook style, duration, audio, cadence — with three things to do next. The agent reads your profile to the end itself first; you never scroll your own account. |
| **Reel decoder** | Watches and *hears* any reel: hook, beat-by-beat structure, on-screen text, pacing, transcript. Then rewrites the format as a script in your voice. |
| **Competitor compare** | Side-by-side metrics, their breakout reels (median × 3), what their audience keeps asking for that nobody answers, and 5 transferable formats with hooks already written for your niche. |
| **Autonomous sweep** | Give it a watchlist and it visits each profile itself — background tab, scroll until the feed stops yielding, close, next. |
| **Daily schedule** | Pick a time and the sweep runs every day, leaving a digest and a notification. |
| **Ideas & scripts** | Five reels you can shoot this week, each traced back to evidence, each with a lead magnet. |
| **Comment → DM** | Arm a keyword, and the official Instagram Messaging API delivers the private reply when someone comments it. |
| **Chat** | A strategist that can see everything captured, so answers are about this account rather than social media in general. |

The interface is in English; scripts, hooks and DMs are written in Uzbek, Russian or English.

### The agent does its own legwork

Analysing a competitor needs their reels, and their reels only exist in the page once somebody has opened the profile and scrolled it. Rather than making that the creator's job, the agent drives the browser: it opens each watched profile in a background tab, scrolls until three consecutive scrolls yield nothing new, closes it, and moves on.

It is deliberately gentle. It visits pages a logged-in human could visit, at human pace, one at a time, and still reads only what the page loads on its own. No private endpoints, no parallel tabs, no interaction with anyone's content.

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
  ├─ content.js       relays payloads, tracks the page, reads the profile header
  ├─ crawler.js       opens and scrolls watched profiles by itself
  └─ background.js    normalizes and accumulates: profiles, reels, comments
        │             + chrome.alarms for the daily sweep
        ▼
   Side panel (vanilla MV3, no build step)
        │  JSON over localhost
        ▼
   FastAPI
        ├─ metrics.py   medians, breakouts, cadence, duration buckets   ← arithmetic
        ├─ brain.py     ProfileAnalyst · ReelDecoder · CompetitorAnalyst · Strategist
        │               (OpenAI Agents SDK, typed Pydantic outputs)     ← judgement
        ├─ provider.py  routes the SDK at OpenAI, Gemini or OpenRouter
        ├─ video.py     OpenRouter → Gemini, native video understanding
        ├─ exa.py       trend radar + competitor discovery
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
.venv/bin/python -m scripts.e2e all      # every flow against the real model
.venv/bin/python -m scripts.e2e video    # real mp4 through the real endpoint
```

The unit suites are free and offline. The end-to-end runs spend real credits —
a full pass over every flow, video included, costs under two cents — because
whether a provider actually accepts inline video is exactly the kind of
integration a fixture cannot prove.

## Configuration

The four agents are written against the OpenAI Agents SDK, but the SDK is really
an OpenAI-protocol client and both Gemini and OpenRouter speak that protocol. So
the same agents run unchanged on whichever provider you actually have credits
for — which at a hackathon is rarely the default one. Set one key, or name the
provider explicitly with `LLM_PROVIDER`.

| Variable | Needed for |
|---|---|
| `GEMINI_API_KEY` *or* `OPENAI_API_KEY` *or* `OPENROUTER_API_KEY` | the agents — any one of them |
| `GEMINI_API_KEY` *or* `OPENROUTER_API_KEY` | watching the video (otherwise metadata-only) |
| `EXA_API_KEY` | the trend radar (optional) |
| `IG_TOKEN`, `IG_USER_ID` | sending DMs (otherwise rules log "would send") |

Providers differ in how strictly they implement JSON schema output. When the
schema-enforced path is rejected, the agent retries by asking for plain JSON and
validating it locally, so a provider quirk costs a retry rather than the feature.

Instagram credentials come from developers.facebook.com → your app → Instagram → *API setup with Instagram login* → **Generate token**, with scopes `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_manage_messages`. Standard Access is enough to run this on your own account.

Every integration degrades instead of crashing: no video key means metadata-only analysis, no Instagram token means rules are stored and logged rather than sent. The panel always says which mode it is in.

## Boundaries

- Reads only what the logged-in user's own browser already loaded, plus the pages the agent opens on the creator's behalf. No credential storage, no private endpoints, no session automation.
- No follows, likes, mass-DMs or engagement automation. The only outbound action is a private reply to someone who chose to comment a keyword.
- A personal research and authoring tool, not an Instagram product.

## Built with

OpenAI Agents SDK · Gemini via OpenRouter · FastAPI · Chrome Manifest V3

Thanks to the hackathon partners: OpenAI, CopilotKit, OpenRouter, Impact Hub Tashkent and ML Community Uzbekistan.

## License

MIT
