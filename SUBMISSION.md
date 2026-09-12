# Submission pack

Everything the portal asks for, ready to paste. Deadline 15:30.

---

## Title

**ReelSense — the AI social media manager that lives inside Instagram**

---

## Written description

Creators do their work on instagram.com. Every tool that helps them lives somewhere else.

You paste a username into a separate app, wait, and read a generic report about an account you already know. Then you go back to Instagram and start over. Comment-to-DM tools automate the delivery end, but they have no idea what your content is about — a human still writes every rule. Nothing closes the loop.

ReelSense is a Chrome side panel on instagram.com. Whatever you are looking at, it is already looking at too. Open your profile and it audits what separates your best reels from your worst. Open a competitor and it compares you side by side, finds their breakout reels, and extracts five formats worth stealing with hooks already rewritten for your niche. Open any viral reel and it watches the video — sees the frames, hears the audio — then rebuilds that format as a script in your voice, in Uzbek, Russian or English.

Then it acts. Each idea comes with a lead magnet: a comment keyword, a public reply, and a DM. Arm it from the panel, and when a viewer comments that keyword, the agent delivers the DM through Meta's official Instagram Messaging API. The agent wrote the call to action, configured the automation for it, and handles the responses. That chain does not exist in a chat window.

The environment is what makes it possible. Instagram's official API only reports on your own account, so competitor analysis is closed to it, and scraping Instagram's private endpoints breaks every few weeks when their GraphQL ids rotate. ReelSense does neither. A content script in the page's main world reads the responses the page already loaded for the logged-in user. Open a profile and the profile JSON is there. Scroll the Reels tab and forty reels arrive with play counts, durations and audio metadata. No extra request is made that Instagram would not have made anyway — no scraping, no stored credentials, no automation of the web session. Being inside the browser is not packaging here; it is the only place this data legally and reliably exists.

Built with the OpenAI Agents SDK. Four typed specialists — ProfileAnalyst, ReelDecoder, CompetitorAnalyst, Strategist — with every number computed in Python first and handed to them as fact, because models are bad at arithmetic and good at interpretation. Video goes to Gemini, which ingests video natively. The provider layer runs the same agents on OpenAI, Gemini or OpenRouter, whichever you have credits for.

**Repo:** <paste GitHub URL>

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
> Code 👇 <repo link>

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
