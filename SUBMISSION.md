# Submission pack

Everything the portal asks for, ready to paste. Deadline 15:30.

---

## Title

**ReelSense — the AI social media manager that lives inside Instagram**

---

## Written description

*Paste the block below into the portal's Project Description field.*

---

### The problem

Creators do their work on instagram.com. Every tool that helps them lives somewhere else.

You paste a username into a separate app, wait, and read a generic report about an account you already know — then go back to Instagram and start over. Comment-to-DM tools sit on the other side of the same gap: they automate delivery but have no idea what your content is about, so a human still writes every rule. Analysis never reaches the work, and automation never understands it.

### The agent, and why the environment is load-bearing

ReelSense is a Chrome side panel on instagram.com. Whatever you are looking at, it is already looking at too.

The environment is not packaging here — it is the only viable data path. Instagram's Graph API reports on your own account only, so competitor analysis is closed to it entirely, and Meta's 2026 changes stripped view counts from lookups. Calling Instagram's private endpoints breaks every few weeks when their GraphQL `doc_id` values rotate, is rate-limited to roughly 200 requests an hour per IP, and violates the terms. A standalone chatbot simply cannot obtain this data.

Inside the browser it is already there. A content script in the page's main world wraps `fetch` and `XMLHttpRequest` and reads the responses **the page already loaded for the logged-in user**. Open a profile and the profile JSON is present. Scroll the Reels tab and dozens of reels arrive with play counts, durations, captions, collaborators and audio metadata. Open a reel and its comments come with it. No request is made that Instagram would not have made anyway: no scraping, no stored credentials, no automation of the web session.

### The environment shapes the workflow

Because the agent lives in the browser, it can do the legwork itself. Competitor analysis needs their reels, and their reels only exist in the page once someone opens the profile and scrolls it — so the agent opens each watched profile in a background tab, scrolls until three consecutive scrolls yield nothing new, closes it, and moves on. Give it a watchlist and a time, and `chrome.alarms` runs that sweep every day and leaves a digest. The creator never scrolls their own account either: pressing Analyze reads their profile to the end first.

And it closes the loop. Every generated idea carries a lead magnet — a comment keyword, a public reply, a DM. Arm it from the panel and the agent watches for that keyword, then delivers the DM through Meta's **official Instagram Messaging API** (private replies), never the web session, because automating DMs through the UI risks the creator's account. The agent wrote the call to action, configured the automation for it, and handles the responses. Analyse → create → act, in one place. That chain cannot exist in a chat window.

### Technical execution

**Agents.** OpenAI Agents SDK with four typed specialists — ProfileAnalyst, ReelDecoder, CompetitorAnalyst, Strategist — each with a Pydantic output contract so the panel renders structured data instead of parsing prose. Every number is computed in Python (`metrics.py`: medians, p90, engagement, breakout detection at median × 3, cadence, duration buckets, audio mix) and handed to the agents as finished fact. Models are bad at arithmetic and good at interpretation, and the split makes the analysis reproducible.

**Provider abstraction.** The Agents SDK is an OpenAI-protocol client, and Gemini and OpenRouter both speak that protocol, so the same agents run unchanged on whichever provider has credits — selected by `LLM_PROVIDER` or by first key found. Providers disagree on strict JSON schema output, so a rejected schema falls back to plain JSON validated locally rather than failing.

**Video.** The Responses API does not accept video, so reel footage goes to Gemini, which ingests video natively and both sees the frames and hears the audio in one call — no ffmpeg, no separate transcription pass.

**Extension.** Manifest V3, no build step. Instagram renames fields constantly, so the normalizer hard-codes no response paths: it walks each payload and recognises objects by shape, covering three real payload formats. Collab reels are filed under every co-author, not just the primary one.

**Degradation.** Every integration degrades instead of crashing. No video key means metadata-only analysis and the panel says so rather than inventing visual details. No Instagram token means rules are stored and logged rather than sent. A missing profile header never blocks analysis.

**Tests.** 37 normalizer checks (three payload shapes, hostile input, cycles) and 24 backend checks (statistics, comparison, keyword matching, never-DM-twice idempotency), plus end-to-end suites that run every flow against the real model and push a real mp4 through the real endpoint — whether a provider accepts inline video is exactly what a fixture cannot prove.

### Honest status

Everything above runs and is verified. The comment-to-DM rules engine is real code against the real API with Meta's constraints enforced locally (one private reply per comment, 7-day window, never your own comment), tested end to end through a simulate endpoint — but it is not yet connected to a live Meta app, so it currently logs "would send" instead of delivering. That is a credential away, not a build away.

Interface in English; hooks, scripts and DMs written in Uzbek, Russian or English.

**Repo:** https://github.com/codewithdoni/reelsense

---

## Prior work

*Paste into the portal's Prior Work field.*

No prior code. ReelSense was written from an empty directory during the hackathon: first commit 13:05, last 16:00, 18 commits across 27 files and roughly 4,700 lines. The git history is public and linear, so every piece can be traced to the day.

What we did not write: the open-source dependencies. OpenAI Agents SDK, FastAPI, Pydantic, httpx and uvicorn on the backend; the extension is vanilla Manifest V3 with no framework and no build step. Models are called through OpenRouter (OpenAI and Gemini), and comment-to-DM uses Meta's official Instagram Messaging API.

One piece of context rather than prior work: the Instagram account used throughout the demo, @plusfit_ai, is our own creator account with 12.8K followers and 42 posts. It is the subject being analysed, not code being reused — it exists so the analysis runs against real reels, real collaborators and real comments instead of fixtures.

---

## Social post

> We built ReelSense at the AI Tinkerers × OpenAI *Agents, Everywhere* hackathon in Tashkent 🇺🇿
>
> Most social media AI tools make you leave Instagram to use them. ReelSense doesn't. It's a side panel that reads what your browser already loaded — your profile, your competitor's reels, the viral video you're watching.
>
> It audits your account, decodes why a reel went viral (it actually watches the video), and writes your next five scripts in your voice.
>
> Then it closes the loop: the script it wrote includes a comment CTA, and the same agent handles the DMs when people comment it.
>
> Agents shouldn't live in a chatbox. They should live where the work is.
>
> Built with @OpenAI Agents SDK · @OpenRouterAI · thanks @aitinkerers, Impact Hub Tashkent & ML Community Uzbekistan
>
> Code 👇 https://github.com/codewithdoni/reelsense

Check the exact handles before posting.

---

## Two-minute video script

| Time | Shot | Say |
|---|---|---|
| 0:00–0:15 | Instagram open, side panel closed | "Every social media AI tool makes you leave Instagram to use it. Paste a username somewhere else, wait, read a generic report." |
| 0:15–0:40 | Open panel on your profile, hit Analyze | "ReelSense is already looking at what you're looking at. It reads what the page loaded — no scraping, no password. Here's what separates my best reels from my worst." |
| 0:40–1:05 | Navigate to competitor, Compare tab | "Open a competitor and it compares us. These are their breakout reels — three times their own median. And these five formats are the ones worth stealing, with hooks already written for my niche." |
| 1:05–1:30 | Open a viral reel, Decode | "It watches the actual video. Hook, structure, on-screen text, transcript. Then it rewrites that format as a script in my voice, in Uzbek." |
| 1:30–1:50 | Ideas tab → Arm rule → **second phone comments "+"** → DM arrives | "The script has a call to action. The agent arms the automation for it. Someone comments — and the DM goes out through Meta's official API." |
| 1:50–2:00 | Architecture slide | "The agent lives where creators already work. And it acts there too." |

**Critical:** Instagram will not let you DM your own comment. Use a second account on another phone for the 1:30 shot, and keep that phone in frame.

**Record the DM segment the moment it first works.** Do not save it for last.

---

## Pre-demo checklist

- [ ] Backend running: `.venv/bin/uvicorn app.main:app --port 8000`
- [ ] `curl localhost:8000/health` → `llm_ready: true`, `video: true`
- [ ] Extension loaded, panel opens on instagram.com
- [ ] Your profile: Reels tab scrolled twice, panel shows a reel count
- [ ] Competitor profile: Reels tab scrolled twice
- [ ] One reel open and decoded (cached, so the demo does not wait)
- [ ] Second account ready to comment the keyword
- [ ] Repo pushed and public
