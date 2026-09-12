// ReelSense content script — isolated world.
// Relays intercepted payloads to the service worker and reports which page the
// user is looking at, so the side panel always matches the visible context.

(() => {
  const TAG = "reelsense";

  const send = (msg) => {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch {
      /* extension reloaded — ignore */
    }
  };

  // --- payload relay -------------------------------------------------------
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== TAG || !d.body) return;
    send({ type: "IG_PAYLOAD", url: d.url, body: d.body });
  });

  // --- page context --------------------------------------------------------
  const RESERVED = new Set([
    "explore", "reels", "reel", "p", "stories", "direct", "accounts",
    "your_activity", "about", "legal", "challenge", "emails", "s",
  ]);

  function readContext() {
    const path = location.pathname.replace(/^\/+|\/+$/g, "");
    const parts = path.split("/").filter(Boolean);

    if (parts[0] === "reel" || parts[0] === "reels" || parts[0] === "p") {
      if (parts[1] && parts[1] !== "audio") {
        return { kind: "reel", code: parts[1] };
      }
      // The reels feed itself: no shortcode in the URL, but Instagram streams a
      // new reel into the page on every scroll. That is the richest capture
      // surface there is, so treat it as a first-class context.
      return { kind: "feed", source: "reels" };
    }
    if (parts[0] === "explore") {
      return { kind: "feed", source: "explore" };
    }
    if (parts[0] === "accounts" || path.includes("dashboard") || path.includes("insights")) {
      return { kind: "dashboard" };
    }
    if (parts.length >= 1 && !RESERVED.has(parts[0])) {
      return { kind: "profile", username: parts[0], tab: parts[1] || "posts" };
    }
    if (!parts.length) return { kind: "feed", source: "home" };
    return { kind: "other" };
  }

  let last = "";
  function reportContext() {
    const ctx = readContext();
    const key = JSON.stringify(ctx);
    if (key === last) return;
    last = key;
    send({ type: "IG_CONTEXT", context: ctx, href: location.href });
  }

  // Instagram is a SPA: patch history and listen for popstate.
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function (...a) {
      const r = orig.apply(this, a);
      setTimeout(reportContext, 50);
      return r;
    };
  }
  window.addEventListener("popstate", () => setTimeout(reportContext, 50));
  setInterval(reportContext, 1500); // catches soft navigations we miss
  reportContext();

  // --- profile fallback ----------------------------------------------------
  // Instagram server-renders the profile page and embeds the initial data in
  // the HTML, so opening a profile fires no request for us to read. This asks
  // for the same JSON the page would have fetched, once, from the page's own
  // origin and session — the one request ReelSense ever initiates.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "FETCH_PROFILE") return;
    (async () => {
      try {
        const res = await fetch(
          `/api/v1/users/web_profile_info/?username=${encodeURIComponent(msg.username)}`,
          {
            credentials: "include",
            headers: { "x-ig-app-id": "936619743392459", "x-requested-with": "XMLHttpRequest" },
          }
        );
        if (!res.ok) return sendResponse({ ok: false, error: `HTTP ${res.status}` });
        sendResponse({ ok: true, body: await res.json() });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  });

  // --- profile header from the DOM -----------------------------------------
  // The counts are rendered on the page whether or not the JSON endpoint
  // answers, so read them there as a fallback. Instagram abbreviates them
  // ("12.8K"), but the follower link carries the exact figure in its title.
  const parseCount = (s) => {
    if (!s) return null;
    const t = String(s).replace(/[\s, ]/g, "").toLowerCase();
    const m = t.match(/^([\d.]+)([km])?/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1));
  };

  function readProfileDom(username) {
    const pick = (href) =>
      document.querySelector(`a[href="/${username}/${href}/"] span[title], a[href="/${username}/${href}/"] span`);

    const followersEl = pick("followers");
    const followingEl = pick("following");
    const exact = followersEl?.getAttribute?.("title");

    // Posts has no link, so fall back to the header's first statistic.
    const items = [...document.querySelectorAll("header section ul li, header ul li")];
    const postsText = items[0]?.innerText || "";

    const bio = document.querySelector("header section > div:last-child")?.innerText || "";
    const profile = {
      username,
      followers: parseCount(exact) ?? parseCount(followersEl?.innerText) ?? 0,
      following: parseCount(followingEl?.innerText) ?? 0,
      media_count: parseCount(postsText) ?? 0,
      biography: bio.split("\n").slice(1).join(" ").slice(0, 400),
      full_name: document.querySelector("header section h2, header h2")?.innerText || "",
    };
    return profile.followers || profile.media_count ? profile : null;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "READ_PROFILE_DOM") return;
    try {
      const profile = readProfileDom(msg.username);
      sendResponse(profile ? { ok: true, profile } : { ok: false, error: "header topilmadi" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return true;
  });

  // --- media fetch helper --------------------------------------------------
  // Instagram CDN often rejects server-side requests. The page itself can fetch
  // its own video, so the backend asks us to do it and we forward the bytes.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "FETCH_MEDIA") return;
    (async () => {
      try {
        const res = await fetch(msg.url, { credentials: "omit" });
        const buf = await res.arrayBuffer();
        let bin = "";
        const bytes = new Uint8Array(buf);
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        sendResponse({ ok: true, b64: btoa(bin), bytes: bytes.length });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true; // async response
  });

  console.debug("[ReelSense] content script ready");
})();
