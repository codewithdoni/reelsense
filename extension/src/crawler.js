// ReelSense crawler — the agent doing its own legwork.
//
// Analysing a competitor needs their reels, and their reels only exist in the
// page once someone has actually opened the profile and scrolled it. Rather
// than asking the creator to do that for every account on their watchlist, the
// agent drives the browser itself: it opens each profile in a background tab,
// scrolls until the feed stops yielding new reels, and closes it.
//
// This is deliberately gentle. It visits pages a logged-in human could visit,
// at human speed, and reads only what the page loads on its own — no private
// endpoints, no parallel tabs hammering Instagram, no interaction with anyone's
// content.

const SETTLE_MS = 2500;      // let the page's own requests land
const SCROLL_PAUSE_MS = 2200; // roughly how long a person looks at a screenful
const MAX_SCROLLS = 6;
const PER_PROFILE_TIMEOUT_MS = 45_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Crawler {
  /**
   * @param {() => object} getStore   reads the live capture store
   * @param {(state: object) => void} onProgress
   */
  constructor(getStore, onProgress) {
    this.getStore = getStore;
    this.onProgress = onProgress;
    this.running = false;
    this.cancelled = false;
    this.state = { running: false, done: [], current: null, queue: [], startedAt: null };
  }

  publish(patch = {}) {
    this.state = { ...this.state, ...patch };
    try {
      this.onProgress(this.state);
    } catch {
      /* panel may be closed */
    }
  }

  cancel() {
    this.cancelled = true;
  }

  reelCount(username) {
    const p = this.getStore().profiles[username];
    return p ? Object.keys(p.reels).length : 0;
  }

  async scrollTab(tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.scrollBy({ top: window.innerHeight * 2, behavior: "smooth" }),
      });
    } catch {
      /* tab closed or navigated away */
    }
  }

  /** Open one profile, scroll it until it stops producing new reels, close it. */
  async visit(username) {
    const before = this.reelCount(username);
    let tab;
    const deadline = Date.now() + PER_PROFILE_TIMEOUT_MS;

    try {
      tab = await chrome.tabs.create({
        url: `https://www.instagram.com/${encodeURIComponent(username)}/reels/`,
        active: false,
      });
      await sleep(SETTLE_MS);

      let stagnant = 0;
      let seen = this.reelCount(username);

      for (let i = 0; i < MAX_SCROLLS && !this.cancelled && Date.now() < deadline; i++) {
        await this.scrollTab(tab.id);
        await sleep(SCROLL_PAUSE_MS);

        const now = this.reelCount(username);
        this.publish({ current: { username, reels: now } });

        // Two quiet scrolls in a row means the feed is exhausted or blocked;
        // there is nothing to gain by scrolling into the void.
        if (now === seen) {
          if (++stagnant >= 2) break;
        } else {
          stagnant = 0;
          seen = now;
        }
      }
      return { username, reels: this.reelCount(username), gained: this.reelCount(username) - before };
    } catch (e) {
      return { username, reels: this.reelCount(username), gained: 0, error: String(e) };
    } finally {
      if (tab?.id) {
        try {
          await chrome.tabs.remove(tab.id);
        } catch {
          /* already gone */
        }
      }
    }
  }

  /** @param {string[]} usernames */
  async run(usernames) {
    if (this.running) return this.state;
    this.running = true;
    this.cancelled = false;
    const queue = [...new Set(usernames.map((u) => u.trim().replace(/^@/, "")).filter(Boolean))];
    this.publish({ running: true, queue, done: [], current: null, startedAt: Date.now() });

    const done = [];
    for (const username of queue) {
      if (this.cancelled) break;
      this.publish({ current: { username, reels: this.reelCount(username) } });
      const result = await this.visit(username);
      done.push(result);
      this.publish({ done: [...done], queue: queue.slice(done.length) });
    }

    this.running = false;
    this.publish({ running: false, current: null, finishedAt: Date.now() });
    return this.state;
  }
}
