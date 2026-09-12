// ReelSense service worker — the context store.
//
// Everything the side panel reasons about is accumulated here: the profile the
// user is looking at, the reels Instagram has rendered for it, the comments on
// an open reel, and which account is "me".

import { extract } from "./lib/ig.js";
import { Crawler } from "./crawler.js";

const STORE_KEY = "rs_store";
const ME_KEY = "rs_me";
const WATCH_KEY = "rs_watch";      // { usernames: [], hour: 9, minute: 0, enabled: bool }
const DIGEST_KEY = "rs_digest";
const ALARM = "rs_daily";
const API = "http://localhost:8000";

/** @type {{profiles: Record<string, any>, suggested: string[], stats: any}} */
let store = { profiles: {}, suggested: [], stats: { payloads: 0, matched: 0, lastAt: 0 } };
let me = null;
/** @type {Record<number, any>} */
const contextByTab = {};
let saveTimer = null;

// --- persistence -----------------------------------------------------------

// Captured data lives in local rather than session storage. Session storage is
// wiped whenever the extension reloads, which during development and a demo
// means losing an account's entire capture history to a single reload.
async function boot() {
  const s = await chrome.storage.local.get([STORE_KEY, ME_KEY]);
  if (s[STORE_KEY]) store = { ...store, ...s[STORE_KEY] };
  if (!store.stats) store.stats = { payloads: 0, matched: 0, lastAt: 0 };
  if (s[ME_KEY]) me = s[ME_KEY];
}
const ready = boot();

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ [STORE_KEY]: store }).catch((e) => {
      console.warn("[ReelSense] persist failed", e);
    });
  }, 400);
}

function bucket(username) {
  if (!store.profiles[username]) {
    store.profiles[username] = {
      username,
      profile: null,
      reels: {},
      comments: {},
      updatedAt: 0,
    };
  }
  return store.profiles[username];
}

// --- ingest ----------------------------------------------------------------

function ingest(url, body, tabId) {
  const ctx = contextByTab[tabId] || {};
  const { reels, users, comments, sample } = extract(body);
  let touched = false;

  if (sample && !store.stats.sample) store.stats.sample = sample;

  // Counters make the difference between "nothing was intercepted" and
  // "intercepted but nothing recognised" visible in the panel.
  store.stats.payloads += 1;
  if (reels.length || users.length || comments.length) store.stats.matched += 1;
  store.stats.lastAt = Date.now();

  for (const u of users) {
    const b = bucket(u.username);
    b.profile = mergeProfile(b.profile, u);
    b.updatedAt = Date.now();
    touched = true;
  }

  for (const r of reels) {
    if (!r.username) {
      // A reel with no owner in its own node: attribute it to the page we are on.
      if (ctx.kind === "profile") r.username = ctx.username;
      else if (ctx.kind === "reel") {
        const owner = Object.values(store.profiles).find((p) => p.reels[r.code]);
        if (owner) r.username = owner.username;
      }
    }
    if (!r.username) continue;
    // File the reel under the author and every collaborator: a collab reel is
    // as much the creator's work as the partner's, and Instagram names only one.
    for (const owner of new Set([r.username, ...(r.coauthors || [])])) {
      const b = bucket(owner);
      const prev = b.reels[r.code];
      b.reels[r.code] = { ...(prev || {}), ...r, capturedAt: prev?.capturedAt || Date.now() };
      b.updatedAt = Date.now();
    }
    touched = true;
  }

  if (comments.length && ctx.kind === "reel" && ctx.code) {
    const owner =
      Object.values(store.profiles).find((p) => p.reels[ctx.code])?.username || null;
    if (owner) {
      const b = bucket(owner);
      const list = b.comments[ctx.code] || [];
      const byId = new Map(list.map((c) => [c.id, c]));
      for (const c of comments) byId.set(c.id, c);
      b.comments[ctx.code] = [...byId.values()].slice(0, 60);
      touched = true;
    }
  }

  // Instagram's own "similar accounts" rail is a free competitor shortlist.
  if (/discover\/chaining/.test(url)) {
    const names = users.map((u) => u.username).filter(Boolean);
    store.suggested = [...new Set([...names, ...store.suggested])].slice(0, 12);
    touched = true;
  }

  // The logged-in viewer shows up in most GraphQL envelopes.
  if (!me) {
    const viewer = body?.data?.viewer?.user || body?.viewer || body?.data?.viewer;
    if (viewer?.username) setMe(viewer.username);
  }

  if (touched) {
    persist();
    chrome.runtime.sendMessage({ type: "STATE_CHANGED" }, () => void chrome.runtime.lastError);
  }
}

/**
 * The same account appears in many payloads at very different fidelities: the
 * profile header carries follower counts and bio, while a reel's embedded
 * `user` carries little more than a username. A plain spread lets the thin
 * version overwrite the rich one and blanks the numbers, so merge per field
 * and only ever trade up.
 */
function mergeProfile(prev, next) {
  if (!prev) return next;
  const out = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "number" && v === 0 && typeof out[k] === "number" && out[k] > 0) continue;
    if (v === false && out[k] === true) continue;
    if (typeof v === "string" && typeof out[k] === "string" && v.length < out[k].length) continue;
    out[k] = v;
  }
  return out;
}

const inFlight = new Set();

function askTab(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (res) =>
        resolve(chrome.runtime.lastError ? null : res)
      );
    } catch {
      resolve(null);
    }
  });
}

async function anyInstagramTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
  return tabs[0]?.id ?? null;
}

/**
 * Instagram server-renders the profile page, embedding the initial data in the
 * HTML, so simply opening a profile produces no request to read. Ask the page
 * to fetch the same JSON once, from its own origin and session.
 *
 * Retried because the content script may not have registered its listener yet
 * when a navigation lands, and a silent miss here shows up much later as a
 * profile with no follower count.
 */
async function ensureProfile(username, tabId) {
  if (!username || inFlight.has(username)) return false;
  await ready;
  if (store.profiles[username]?.profile?.followers) return true;

  inFlight.add(username);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const target = tabId ?? (await anyInstagramTab());
      if (target) {
        const res = await askTab(target, { type: "FETCH_PROFILE", username });
        if (res?.ok) {
          ingest("web_profile_info", res.body, target);
          console.info("[ReelSense] profile fetched for", username);
          return true;
        }
        if (res?.error) console.info("[ReelSense] profile fetch:", username, res.error);

        // The endpoint can decline, but the counts are rendered on the page
        // regardless — so read the header rather than give up on them.
        const dom = await askTab(target, { type: "READ_PROFILE_DOM", username });
        if (dom?.ok) {
          const b = bucket(username);
          b.profile = mergeProfile(b.profile, dom.profile);
          b.updatedAt = Date.now();
          persist();
          chrome.runtime.sendMessage({ type: "STATE_CHANGED" }, () => void chrome.runtime.lastError);
          console.info("[ReelSense] profile read from DOM for", username);
          return true;
        }
      }
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
    console.warn("[ReelSense] could not resolve profile for", username);
    return false;
  } finally {
    inFlight.delete(username);
  }
}

function setMe(username) {
  me = username;
  chrome.storage.local.set({ [ME_KEY]: username }).catch(() => {});
}

// --- messaging -------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (msg?.type === "IG_PAYLOAD") {
    ready.then(() => {
      try {
        ingest(msg.url, msg.body, tabId);
      } catch (e) {
        console.warn("[ReelSense] ingest failed", e);
      }
    });
    return false;
  }

  if (msg?.type === "IG_CONTEXT") {
    contextByTab[tabId] = msg.context;
    if (msg.context?.kind === "profile") ensureProfile(msg.context.username, tabId);
    chrome.runtime.sendMessage(
      { type: "CONTEXT_CHANGED", context: msg.context },
      () => void chrome.runtime.lastError
    );
    return false;
  }

  if (msg?.type === "GET_STATE") {
    ready.then(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const ctx = (tab && contextByTab[tab.id]) || { kind: "other" };
      // A tab sitting on instagram.com with no reported context means its
      // content script is orphaned — the usual cause is an extension reload
      // without a page refresh, which otherwise looks exactly like a bug.
      const onInstagram = /^https:\/\/www\.instagram\.com\//.test(tab?.url || "");
      const stale = onInstagram && !contextByTab[tab.id];
      const target =
        ctx.kind === "profile"
          ? ctx.username
          : ctx.kind === "reel"
          ? Object.values(store.profiles).find((p) => p.reels[ctx.code])?.username
          : null;

      sendResponse({
        me,
        context: ctx,
        suggested: store.suggested,
        known: Object.keys(store.profiles),
        target: target ? snapshot(target) : null,
        mine: me ? snapshot(me) : null,
        stats: store.stats,
        stale,
        onInstagram,
        recent: recentReels(30),
        totals: {
          reels: Object.values(store.profiles).reduce((n, p) => n + Object.keys(p.reels).length, 0),
          profiles: Object.keys(store.profiles).length,
        },
      });
    });
    return true;
  }

  if (msg?.type === "SET_ME") {
    setMe(msg.username);
    sendResponse({ ok: true, me });
    return true;
  }

  if (msg?.type === "GET_WATCH") {
    (async () => {
      const d = await chrome.storage.local.get(DIGEST_KEY);
      sendResponse({
        watch: await getWatch(),
        crawl: crawler.state,
        digest: d[DIGEST_KEY] || null,
      });
    })();
    return true;
  }

  if (msg?.type === "SET_WATCH") {
    setWatch(msg.patch).then((w) => sendResponse({ ok: true, watch: w }));
    return true;
  }

  if (msg?.type === "REFRESH_TABS") {
    refreshInstagramTabs("panel asked").then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg?.type === "COLLECT_PROFILE") {
    (async () => {
      const username = msg.username || me;
      if (!username) return sendResponse({ ok: false, error: "Username noma'lum" });
      sendResponse({ ok: true, started: username });
      // Fill in the profile header and read the reels feed to the end, so the
      // creator never has to scroll their own account by hand.
      await ensureProfile(username, null);
      await crawler.collectOwn(username);
      await ensureProfile(username, null);
      chrome.runtime.sendMessage(
        { type: "COLLECT_DONE", username, reels: Object.keys(store.profiles[username]?.reels || {}).length },
        () => void chrome.runtime.lastError
      );
    })();
    return true;
  }

  if (msg?.type === "RUN_SWEEP") {
    (async () => {
      const watch = await getWatch();
      const names = msg.usernames?.length ? msg.usernames : watch.usernames;
      if (!names.length) return sendResponse({ ok: false, error: "Ro'yxat bo'sh" });
      sendResponse({ ok: true, started: names });
      runSweep(names, false);       // continues after the response
    })();
    return true;
  }

  if (msg?.type === "CANCEL_SWEEP") {
    crawler.cancel();
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === "FETCH_MEDIA_VIA_PAGE") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      chrome.tabs.sendMessage(tab.id, { type: "FETCH_MEDIA", url: msg.url }, (r) =>
        sendResponse(r || { ok: false, error: String(chrome.runtime.lastError?.message) })
      );
    })();
    return true;
  }

  return false;
});

/** Everything captured anywhere, newest first — what the reels feed fills up. */
function recentReels(limit) {
  const all = [];
  for (const p of Object.values(store.profiles)) {
    for (const r of Object.values(p.reels)) all.push(r);
  }
  return all
    .sort((a, z) => (z.capturedAt || z.taken_at || 0) - (a.capturedAt || a.taken_at || 0))
    .slice(0, limit);
}

function snapshot(username) {
  const b = store.profiles[username];
  if (!b) return null;
  const reels = Object.values(b.reels).sort((a, z) => (z.taken_at || 0) - (a.taken_at || 0));
  return {
    username,
    profile: b.profile,
    reels,
    comments: b.comments,
    reel_count: reels.length,
  };
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

/**
 * Reloading the extension orphans every content script already on a page, so
 * capture silently stops until the tab is refreshed by hand. That looks exactly
 * like a broken extension, so heal it: refresh Instagram tabs ourselves
 * whenever this worker starts fresh.
 */
const recentlyReloaded = new Map();

async function refreshInstagramTabs(reason) {
  try {
    const tabs = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
    for (const tab of tabs) {
      const last = recentlyReloaded.get(tab.id) || 0;
      if (Date.now() - last < 15_000) continue;   // never loop on a failing tab
      recentlyReloaded.set(tab.id, Date.now());
      await chrome.tabs.reload(tab.id, { bypassCache: false });
    }
    if (tabs.length) console.info(`[ReelSense] refreshed ${tabs.length} Instagram tab(s) — ${reason}`);
  } catch (e) {
    console.warn("[ReelSense] tab refresh failed", e);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  refreshInstagramTabs("extension installed or reloaded");
});
chrome.runtime.onStartup?.addListener(() => refreshInstagramTabs("browser started"));

chrome.tabs.onRemoved.addListener((tabId) => {
  delete contextByTab[tabId];
  recentlyReloaded.delete(tabId);
});

// --- autonomous competitor sweep -------------------------------------------

const crawler = new Crawler(
  () => store,
  (s) =>
    chrome.runtime.sendMessage({ type: "CRAWL_PROGRESS", crawl: s }, () => void chrome.runtime.lastError)
);

async function getWatch() {
  const v = await chrome.storage.local.get(WATCH_KEY);
  return v[WATCH_KEY] || { usernames: [], hour: 9, minute: 0, enabled: false };
}

async function setWatch(patch) {
  const next = { ...(await getWatch()), ...patch };
  await chrome.storage.local.set({ [WATCH_KEY]: next });
  await rescheduleAlarm(next);
  return next;
}

async function rescheduleAlarm(watch) {
  await chrome.alarms.clear(ALARM);
  if (!watch.enabled || !watch.usernames.length) return;

  // Next occurrence of the chosen local time.
  const when = new Date();
  when.setHours(watch.hour, watch.minute, 0, 0);
  if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);

  chrome.alarms.create(ALARM, { when: when.getTime(), periodInMinutes: 24 * 60 });
  console.info("[ReelSense] daily sweep scheduled for", when.toString());
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  await ready;
  const watch = await getWatch();
  if (!watch.enabled || !watch.usernames.length) return;
  await runSweep(watch.usernames, true);
});

/** Visit every watched profile, then ask the backend what changed. */
async function runSweep(usernames, notify = false) {
  await crawler.run(usernames);

  const digest = { at: Date.now(), competitors: [], error: null };
  try {
    const mine = me ? snapshot(me) : null;
    for (const username of usernames) {
      const them = snapshot(username);
      if (!them?.reels?.length) continue;
      const entry = { username, reels: them.reels.length, report: null };

      if (mine?.reels?.length) {
        const res = await fetch(`${API}/compare`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            me: { profile: mine.profile, reels: mine.reels },
            them: { profile: them.profile, reels: them.reels },
            them_comments: Object.values(them.comments || {}).flat().slice(0, 60),
            lang: "uz",
          }),
        });
        if (res.ok) entry.report = await res.json();
      }
      digest.competitors.push(entry);
    }
  } catch (e) {
    digest.error = String(e);
  }

  await chrome.storage.local.set({ [DIGEST_KEY]: digest });
  chrome.runtime.sendMessage({ type: "DIGEST_READY", digest }, () => void chrome.runtime.lastError);

  if (notify) {
    const n = digest.competitors.length;
    chrome.notifications?.create({
      type: "basic",
      // Inline so the notification never fails on a missing asset.
      iconUrl:
        "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjgiIGhlaWdodD0iMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjZDYyOTc2Ii8+PHRleHQgeD0iNjQiIHk9Ijg2IiBmb250LXNpemU9IjcwIiBmb250LWZhbWlseT0iSGVsdmV0aWNhLEFyaWFsIiBmaWxsPSIjZmZmIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj5SPC90ZXh0Pjwvc3ZnPg==",
      title: "ReelSense — kunlik tahlil tayyor",
      message: n
        ? `${n} ta raqobatchi yangilandi. Panelni oching.`
        : "Yangi ma'lumot yig'ilmadi.",
    }, () => void chrome.runtime.lastError);
  }
  return digest;
}

// Restore the schedule when the service worker wakes up.
ready.then(async () => rescheduleAlarm(await getWatch()));
