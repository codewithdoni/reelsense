// ReelSense interceptor — runs in the MAIN world of instagram.com at document_start.
//
// Instagram's own web app loads every profile, reel and comment through its private
// REST + GraphQL endpoints. Rather than scraping the DOM (fragile) or calling those
// endpoints ourselves (rate limited, doc_id rotates every few weeks), we simply read
// the responses the page already fetched for the logged-in user.
//
// Nothing is requested that the page would not have requested anyway.

(() => {
  const TAG = "reelsense";
  const INTERESTING = [/\/graphql\/query/, /\/api\/v1\//];

  const wanted = (url) => {
    try {
      return INTERESTING.some((re) => re.test(url));
    } catch {
      return false;
    }
  };

  const emit = (url, body) => {
    try {
      // Keep the payload small enough for structured clone / postMessage.
      window.postMessage({ source: TAG, url, body }, window.location.origin);
    } catch {
      /* payload not cloneable — skip it */
    }
  };

  // --- fetch ---------------------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (wanted(url)) {
        res
          .clone()
          .json()
          .then((body) => emit(url, body))
          .catch(() => {});
      }
    } catch {
      /* never break the page */
    }
    return res;
  };

  // --- XMLHttpRequest ------------------------------------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__rs_url = url;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        const url = this.__rs_url || "";
        if (!wanted(url)) return;
        const ct = this.getResponseHeader("content-type") || "";
        if (!ct.includes("json")) return;
        emit(url, JSON.parse(this.responseText));
      } catch {
        /* not json — skip */
      }
    });
    return origSend.apply(this, args);
  };

  console.debug("[ReelSense] interceptor active");
})();
