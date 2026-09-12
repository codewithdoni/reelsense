// ReelSense service worker — the context store.
//
// Everything the side panel reasons about is accumulated here: the profile the
// user is looking at, the reels Instagram has rendered for it, the comments on
// an open reel, and which account is "me".

import { extract } from "./lib/ig.js";

const STORE_KEY = "rs_store";
const ME_KEY = "rs_me";

/** @type {{profiles: Record<string, any>, suggested: string[]}} */
let store = { profiles: {}, suggested: [] };
let me = null;
/** @type {Record<number, any>} */
const contextByTab = {};
let saveTimer = null;

// --- persistence -----------------------------------------------------------

async function boot() {
  const s = await chrome.storage.session.get(STORE_KEY);
  if (s[STORE_KEY]) store = s[STORE_KEY];
  const l = await chrome.storage.local.get(ME_KEY);
  if (l[ME_KEY]) me = l[ME_KEY];
}
const ready = boot();

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.session.set({ [STORE_KEY]: store }).catch(() => {});
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
  const { reels, users, comments } = extract(body);
  let touched = false;

  for (const u of users) {
    const b = bucket(u.username);
    b.profile = { ...(b.profile || {}), ...u };
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
    const b = bucket(r.username);
    b.reels[r.code] = { ...(b.reels[r.code] || {}), ...r };
    b.updatedAt = Date.now();
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
      });
    });
    return true;
  }

  if (msg?.type === "SET_ME") {
    setMe(msg.username);
    sendResponse({ ok: true, me });
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
