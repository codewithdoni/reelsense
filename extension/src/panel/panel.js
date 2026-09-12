// ReelSense side panel.

const API = "http://localhost:8000";

const $ = (s) => document.querySelector(s);
const el = (id) => document.getElementById(id);

let state = {
  me: null, context: { kind: "other" }, target: null, mine: null,
  suggested: [], known: [], recent: [], stats: { payloads: 0, matched: 0 },
  totals: { reels: 0, profiles: 0 },
};
const cache = {};      // keyed result cache so a demo can be repeated offline
let activeTab = "profile";
let selectedCode = null;   // reel chosen from the feed list

const fmt = (n) => {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
const status = (t, spin = false) => {
  el("status").innerHTML = (spin ? '<span class="spin"></span> ' : "") + esc(t);
};

// --- backend ---------------------------------------------------------------

async function api(path, body) {
  const res = await fetch(API + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let data;
  try {
    data = JSON.parse(txt);
  } catch {
    throw new Error(`Backend ${res.status}: ${txt.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(describeError(data, res.status));
  return data;
}

/** FastAPI returns validation failures as a list of objects; rendering that
 *  straight into an Error gives "[object Object]" and hides the real cause. */
function describeError(data, statusCode) {
  const d = data?.detail ?? data?.error;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) {
    return d
      .map((e) => {
        const where = Array.isArray(e.loc) ? e.loc.filter((p) => p !== "body").join(".") : "";
        return `${where || "payload"}: ${e.msg || JSON.stringify(e)}`;
      })
      .join("\n");
  }
  if (d) return JSON.stringify(d);
  return `Backend ${statusCode}`;
}

const lang = () => el("lang").value;

function bg(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

/** Resolve when the service worker broadcasts `type`, or reject on timeout. */
function waitFor(type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(handler);
      reject(new Error(`${type} kutish vaqti tugadi`));
    }, timeoutMs);
    function handler(msg) {
      if (msg?.type !== type) return;
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(handler);
      resolve(msg);
    }
    chrome.runtime.onMessage.addListener(handler);
  });
}

// --- state -----------------------------------------------------------------

let healedAt = 0;

async function refresh(rerender = true) {
  const s = await bg({ type: "GET_STATE" });
  if (s) state = s;

  // An Instagram tab reporting no context has an orphaned content script,
  // normally left behind by an extension reload. Refresh it once rather than
  // showing an empty panel that looks broken.
  if (state.stale && Date.now() - healedAt > 20_000) {
    healedAt = Date.now();
    status("sahifa yangilanmoqda…", true);
    await bg({ type: "REFRESH_TABS" });
  }

  renderCtx();
  if (rerender) render();
}

function renderCtx() {
  const c = state.context || { kind: "other" };
  const t = state.target;
  const st = state.stats || {};
  let main = "Instagram sahifasini oching…";

  if (c.kind === "profile") {
    const isMe = state.me && c.username === state.me;
    main = `@${c.username}${isMe ? " (siz)" : ""}`;
  } else if (c.kind === "reel") {
    main = t ? `Reel · @${t.username}` : `Reel ${c.code}`;
  } else if (c.kind === "feed") {
    main = { reels: "Reels lentasi", explore: "Explore", home: "Bosh lenta" }[c.source] || "Lenta";
  } else if (c.kind === "dashboard") {
    main = "Professional Dashboard";
  }

  // The capture counters are always shown: they separate "nothing was
  // intercepted" from "intercepted but this page has nothing to offer".
  const tot = state.totals || { reels: 0, profiles: 0 };
  const sub = state.stale
    ? "sahifa yangilanmoqda…"
    : st.payloads
    ? `${tot.reels} reel · ${tot.profiles} profil yig'ildi · ${st.payloads} so'rov o'qildi`
    : state.onInstagram
    ? "aylantiring — ma'lumot yig'ila boshlaydi"
    : "Instagram'ni oching";

  $(".ctx-main").textContent = main;
  $(".ctx-sub").textContent = sub;
}

// --- generic render helpers ------------------------------------------------

function loading(view, text) {
  el(view).innerHTML = `<div class="empty"><span class="spin"></span><br><br>${esc(text)}</div>`;
}
function failure(view, e) {
  el(view).innerHTML = `<div class="card"><div class="err">${esc(e.message || e)}</div>
    <div class="small muted" style="margin-top:8px">Backend ishlayaptimi? <code>uvicorn app.main:app</code></div></div>`;
}
function listHtml(items) {
  if (!items?.length) return "";
  return `<ul class="list">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
}

// --- profile ---------------------------------------------------------------

function renderProfile() {
  const v = "view-profile";
  const c = state.context;
  const onProfile = c.kind === "profile";
  const t = state.target;

  if (cache.profileReport && cache.profileReportFor === (t?.username || state.me)) {
    return paintProfileReport(cache.profileReport, t);
  }

  if (!onProfile && !state.mine) {
    el(v).innerHTML = `<div class="empty">Instagram'da <b>o'z profilingizni</b> oching,<br>so'ng "Profilni tahlil qilish" tugmasini bosing.</div>`;
    return;
  }

  const subject = t || state.mine;
  const isMe = state.me && subject?.username === state.me;

  el(v).innerHTML = `
    ${subject ? profileHead(subject, isMe) : ""}
    ${
      subject && !isMe
        ? `<div class="card small muted">Bu sizning profilingiz emas.
             <button class="ghost tiny" id="setme">Bu menman</button> yoki
             <b>Raqobatchi</b> tabiga o'ting.</div>`
        : ""
    }
    <button class="primary" id="run" ${subject ? "" : "disabled"}>Profilni tahlil qilish</button>
    <div class="small muted" style="margin-top:8px">
      Agent avval profilingizni fon tabida oxirigacha o'qiydi, keyin tahlil qiladi.
      Siz hech narsa aylantirishingiz shart emas.
    </div>`;

  el("setme")?.addEventListener("click", async () => {
    await bg({ type: "SET_ME", username: subject.username });
    await refresh();
  });

  el("run")?.addEventListener("click", async () => {
    // Collect first: the analysis is only as good as the reels captured, and
    // asking a creator to hand-scroll their own account is work the agent can
    // do itself.
    loading(v, "Agent profilingizni oxirigacha o'qiyapti…");
    status("reellar yig'ilmoqda…", true);
    try {
      await bg({ type: "COLLECT_PROFILE", username: subject.username });
      await waitFor("COLLECT_DONE", 160_000);
      await refresh(false);
    } catch {
      status("yig'ish tugamadi — mavjud ma'lumot bilan davom etilmoqda");
    }

    const fresh = (state.me && state.me === subject.username ? state.mine : state.target) || subject;

    loading(v, "Profil tahlil qilinmoqda…");
    status("profil tahlili…", true);
    try {
      const rep = await api("/analyze/profile", {
        profile: fresh.profile || subject.profile,
        reels: fresh.reels?.length ? fresh.reels : subject.reels,
        lang: lang(),
      });
      cache.profileReport = rep;
      cache.profileReportFor = subject.username;
      paintProfileReport(rep, fresh);
      status(`profil tahlili tayyor · ${rep.metrics?.reel_count ?? 0} reel asosida`);
    } catch (e) {
      failure(v, e);
      status("xato");
    }
  });
}

function profileHead(s, isMe) {
  const p = s.profile || {};
  return `<div class="card">
    <h4>@${esc(s.username)} ${isMe ? '<span class="badge good">siz</span>' : ""}</h4>
    <div class="stats">
      <div class="stat"><b>${fmt(p.followers)}</b><span>obunachi</span></div>
      <div class="stat"><b>${fmt(p.media_count)}</b><span>post</span></div>
      <div class="stat"><b>${s.reel_count}</b><span>reel yig'ildi</span></div>
    </div>
    ${p.biography ? `<div class="small muted">${esc(p.biography.slice(0, 160))}</div>` : ""}
  </div>`;
}

function paintProfileReport(r, subject) {
  const m = r.metrics || {};
  el("view-profile").innerHTML = `
    ${subject ? profileHead(subject, true) : ""}
    <div class="stats">
      <div class="stat"><b>${r.score ?? "—"}/100</b><span>profil ball</span></div>
      <div class="stat"><b>${fmt(m.median_views)}</b><span>median ko'rish</span></div>
      <div class="stat"><b>${m.engagement_rate != null ? m.engagement_rate.toFixed(1) + "%" : "—"}</b><span>engagement</span></div>
    </div>

    <div class="card">
      <h4>Nishа va ovoz</h4>
      <div class="kv"><span>Nishа</span><span>${esc(r.niche || "—")}</span></div>
      <div class="small" style="margin-top:6px">${esc(r.voice || "")}</div>
    </div>

    <div class="card"><h4>Kontent ustunlari</h4>${listHtml(r.pillars)}</div>
    <div class="card"><h4>Nima ishlayapti <span class="badge good">kuchli</span></h4>${listHtml(r.what_works)}</div>
    <div class="card"><h4>Nima ishlamayapti</h4>${listHtml(r.what_fails)}</div>
    <div class="card">
      <h4>Chiqarish ritmi</h4>
      <div class="small">${esc(r.cadence || "—")}</div>
    </div>
    <div class="card"><h4>3 ta aniq tavsiya</h4>${listHtml(r.recommendations)}</div>

    <button class="primary" id="toideas">Shu tahlil asosida g'oyalar →</button>`;

  el("toideas")?.addEventListener("click", () => switchTab("ideas", true));
}

// --- reel ------------------------------------------------------------------

function findReel(code) {
  return (
    state.target?.reels?.find((r) => r.code === code) ||
    state.recent?.find((r) => r.code === code) ||
    null
  );
}

function renderReel() {
  const v = "view-reel";
  const c = state.context;
  const code = c.kind === "reel" ? c.code : selectedCode;

  // On a feed there is no reel in the URL, so offer everything captured while
  // the user was scrolling. This is the reels feed's whole value: it streams
  // other creators' best work past you, and now none of it is thrown away.
  if (!code) {
    const list = state.recent || [];
    if (!list.length) {
      el(v).innerHTML = `<div class="empty">Reels lentasini aylantiring yoki biror reelni oching —<br>ko'rilgan reellar shu yerda to'planadi.</div>`;
      return;
    }
    el(v).innerHTML =
      `<div class="small muted" style="margin-bottom:9px">Aylantirish davomida ${list.length} ta reel yig'ildi. Birini tanlang:</div>` +
      list
        .map(
          (r) => `<div class="card pick" data-code="${esc(r.code)}" style="cursor:pointer">
            <h4>@${esc(r.username || "—")}
              <span class="badge">${r.views ? fmt(r.views) + " ko'rish" : fmt(r.likes) + " like"}</span>
            </h4>
            <div class="small muted">${esc((r.caption || "(caption yo'q)").slice(0, 90))}</div>
          </div>`
        )
        .join("");
    document.querySelectorAll("#view-reel .pick").forEach((card) =>
      card.addEventListener("click", () => {
        selectedCode = card.dataset.code;
        renderReel();
      })
    );
    return;
  }

  const reel = findReel(code);
  const cached = cache["reel:" + code];
  if (cached) return paintReel(cached, reel, code);

  const back = c.kind === "reel" ? "" : `<button class="ghost tiny" id="back">← ro'yxat</button>`;
  el(v).innerHTML = `
    ${back}
    ${reel ? reelHead(reel) : `<div class="card small muted">Reel metadatasi hali yig'ilmadi — sahifani yangilang.</div>`}
    <button class="primary" id="dec">Bu reelni dekodlash</button>
    <div class="small muted" style="margin-top:8px">
      Video ko'riladi va eshitiladi: hook, struktura, ekran matni, temp va CTA ajratiladi.
    </div>`;

  el("back")?.addEventListener("click", () => {
    selectedCode = null;
    renderReel();
  });

  el("dec")?.addEventListener("click", async () => {
    loading(v, "Video ko'rilmoqda va tahlil qilinmoqda…");
    status("reel dekodlanmoqda…", true);
    try {
      let videoB64 = null;
      if (reel?.video_url) {
        const probe = await bg({ type: "FETCH_MEDIA_VIA_PAGE", url: reel.video_url });
        if (probe?.ok && probe.bytes < 19_000_000) videoB64 = probe.b64;
      }
      const rep = await api("/analyze/reel", {
        reel: reel || { code },
        comments: state.target?.comments?.[code] || [],
        my_profile: state.mine?.profile || null,
        video_b64: videoB64,
        lang: lang(),
      });
      cache["reel:" + code] = rep;
      paintReel(rep, reel, code);
      status("reel dekodlandi" + (rep.saw_video ? " (video ko'rildi)" : " (metadata rejimi)"));
    } catch (e) {
      failure(v, e);
      status("xato");
    }
  });
}

function reelHead(r) {
  return `<div class="card">
    <h4>@${esc(r.username || "—")} <span class="badge">${r.duration ? Math.round(r.duration) + "s" : "reel"}</span></h4>
    <div class="stats">
      <div class="stat"><b>${fmt(r.views)}</b><span>ko'rish</span></div>
      <div class="stat"><b>${fmt(r.likes)}</b><span>like</span></div>
      <div class="stat"><b>${fmt(r.comments)}</b><span>izoh</span></div>
    </div>
    ${r.caption ? `<div class="small muted">${esc(r.caption.slice(0, 180))}</div>` : ""}
  </div>`;
}

function paintReel(rep, reel, code) {
  el("view-reel").innerHTML = `
    ${selectedCode ? `<button class="ghost tiny" id="back2">← ro'yxat</button>` : ""}
    ${reel ? reelHead(reel) : ""}
    <div class="card">
      <h4>Hook (0–3s) <span class="badge ${rep.hook_score >= 7 ? "good" : "hot"}">${rep.hook_score ?? "—"}/10</span></h4>
      <div class="small">${esc(rep.hook || "")}</div>
      ${rep.hook_type ? `<div class="small muted" style="margin-top:5px">Tur: ${esc(rep.hook_type)}</div>` : ""}
    </div>
    <div class="card"><h4>Struktura</h4>${listHtml(rep.structure)}</div>
    ${rep.on_screen_text?.length ? `<div class="card"><h4>Ekrandagi matn</h4>${listHtml(rep.on_screen_text)}</div>` : ""}
    <div class="card"><h4>Nega ishlagan</h4>${listHtml(rep.why_it_works)}</div>
    ${
      rep.audience_questions?.length
        ? `<div class="card"><h4>Izohlardagi savollar</h4>${listHtml(rep.audience_questions)}</div>`
        : ""
    }
    ${rep.transcript ? `<div class="card"><h4>Transkript</h4><pre class="script">${esc(rep.transcript)}</pre></div>` : ""}
    <div class="card">
      <h4>Siz uchun qayta ishlangan ssenariy
        <button class="ghost tiny" id="copy">Nusxa</button>
      </h4>
      <pre class="script" id="rs">${esc(rep.remake_script || "")}</pre>
    </div>`;

  el("copy")?.addEventListener("click", () => {
    navigator.clipboard.writeText(rep.remake_script || "");
    status("ssenariy nusxalandi");
  });
  el("back2")?.addEventListener("click", () => {
    selectedCode = null;
    renderReel();
  });
  void code;
}

// --- competitor ------------------------------------------------------------

async function renderCompetitor() {
  const v = "view-competitor";
  const c = state.context;
  const t = state.target;

  if (!state.me) {
    el(v).innerHTML = `<div class="empty">Avval <b>Profil</b> tabida o'z akkauntingizni belgilang.</div>`;
    return;
  }
  if (c.kind !== "profile" || c.username === state.me) {
    el(v).innerHTML = await watchlistHtml();
    await wireWatchlist();
    return;
  }

  const cached = cache["cmp:" + c.username];
  if (cached) return paintCompetitor(cached, c.username);

  el(v).innerHTML = `
    ${t ? profileHead(t, false) : ""}
    <button class="primary" id="cmp" ${t && state.mine ? "" : "disabled"}>@${esc(c.username)} bilan solishtirish</button>
    <div class="row end" style="margin-top:7px">
      <button class="ghost tiny" id="addwatch">+ kuzatuv ro'yxatiga</button>
    </div>
    <div class="small muted" style="margin-top:8px">
      Uning Reels tabini aylantiring — breakout (median×3) reellari aniqlanadi va format shabloni ajratiladi.
    </div>`;

  el("addwatch")?.addEventListener("click", async () => {
    const w = (await bg({ type: "GET_WATCH" })).watch;
    const names = [...new Set([...w.usernames, c.username])];
    await bg({ type: "SET_WATCH", patch: { usernames: names } });
    status(`@${c.username} kuzatuv ro'yxatiga qo'shildi`);
  });

  el("cmp")?.addEventListener("click", async () => {
    loading(v, "Raqobatchi tahlil qilinmoqda…");
    status("raqobatchi tahlili…", true);
    try {
      const rep = await api("/compare", {
        me: { profile: state.mine.profile, reels: state.mine.reels },
        them: { profile: t.profile, reels: t.reels },
        them_comments: Object.values(t.comments || {}).flat().slice(0, 60),
        lang: lang(),
      });
      cache["cmp:" + c.username] = rep;
      paintCompetitor(rep, c.username);
      status("solishtirish tayyor");
    } catch (e) {
      failure(v, e);
      status("xato");
    }
  });
}

// --- watchlist: the agent visits competitors itself ------------------------

async function watchlistHtml() {
  const { watch, crawl, digest } = await bg({ type: "GET_WATCH" });
  cache.watch = watch;

  const progress = crawl?.running
    ? `<div class="card">
         <h4><span class="spin"></span> Agent ishlayapti</h4>
         <div class="small">Hozir: <b>@${esc(crawl.current?.username || "…")}</b> —
           ${crawl.current?.reels ?? 0} reel yig'ildi</div>
         <div class="small muted" style="margin-top:4px">
           Tugadi: ${crawl.done?.length || 0} / ${(crawl.done?.length || 0) + (crawl.queue?.length || 0)}</div>
         <div class="row end" style="margin-top:7px">
           <button class="ghost tiny" id="cancelsweep">To'xtatish</button>
         </div>
       </div>`
    : crawl?.done?.length
    ? `<div class="card"><h4>Oxirgi yurish</h4>
         ${crawl.done
           .map((d) => `<div class="kv"><span>@${esc(d.username)}</span><span>${d.reels} reel ${d.gained ? `(+${d.gained})` : ""}</span></div>`)
           .join("")}</div>`
    : "";

  const digestHtml = digest?.competitors?.length
    ? `<div class="card">
         <h4>Kunlik xulosa <span class="badge">${new Date(digest.at).toLocaleString()}</span></h4>
         ${digest.competitors
           .map((cmp) => {
             const steal = cmp.report?.steal_these?.[0];
             return `<div style="margin-bottom:9px">
               <div style="font-weight:600;font-size:12px">@${esc(cmp.username)} · ${cmp.reels} reel</div>
               ${cmp.report?.gaps?.[0] ? `<div class="small muted">Bo'shliq: ${esc(cmp.report.gaps[0].slice(0, 130))}</div>` : ""}
               ${steal ? `<div class="small">O'zlashtiring: ${esc(steal.format.slice(0, 110))}</div>` : ""}
             </div>`;
           })
           .join("")}
       </div>`
    : "";

  return `
    <div class="card">
      <h4>Raqobatchilar ro'yxati</h4>
      <div class="small muted">Agent har birining profiliga o'zi kiradi, Reels tabini aylantiradi va ma'lumotni yig'adi.</div>
      <label class="f">Har qatorga bitta username</label>
      <textarea class="f" id="wl" placeholder="sport.hamrohingiz&#10;another_account">${esc((watch.usernames || []).join("\n"))}</textarea>
      <div style="height:8px"></div>
      <button class="primary" id="sweep">Hozir tahlil qilish</button>
    </div>

    <div class="card">
      <h4>Har kuni avtomatik</h4>
      <div class="row" style="gap:8px;align-items:center">
        <input class="f" id="wtime" type="time" style="width:auto"
               value="${String(watch.hour).padStart(2, "0")}:${String(watch.minute).padStart(2, "0")}" />
        <label class="small" style="display:flex;gap:6px;align-items:center;margin:0">
          <input type="checkbox" id="wen" ${watch.enabled ? "checked" : ""} /> yoqilgan
        </label>
      </div>
      <div class="small muted" style="margin-top:6px">
        Belgilangan vaqtda agent ro'yxatni aylanib chiqadi va tayyor bo'lganda bildirishnoma yuboradi.
      </div>
    </div>

    ${progress}
    ${digestHtml}

    ${
      state.suggested?.length
        ? `<div class="card"><h4>Instagram taklif qilgan o'xshash akkauntlar</h4>${listHtml(state.suggested)}</div>`
        : ""
    }
    <div class="small muted">Bitta raqobatchini qo'lda solishtirish uchun uning profilini oching.</div>`;
}

async function wireWatchlist() {
  const save = async () => {
    const usernames = (el("wl")?.value || "")
      .split(/[\n,]/)
      .map((s) => s.trim().replace(/^@/, ""))
      .filter(Boolean);
    const [h, m] = (el("wtime")?.value || "09:00").split(":").map(Number);
    return bg({
      type: "SET_WATCH",
      patch: { usernames, hour: h || 0, minute: m || 0, enabled: !!el("wen")?.checked },
    });
  };

  el("wl")?.addEventListener("change", save);
  el("wtime")?.addEventListener("change", async () => {
    await save();
    status("jadval yangilandi");
  });
  el("wen")?.addEventListener("change", async () => {
    const r = await save();
    status(r.watch.enabled ? "kunlik tahlil yoqildi" : "kunlik tahlil o'chirildi");
  });

  el("sweep")?.addEventListener("click", async () => {
    await save();
    const r = await bg({ type: "RUN_SWEEP" });
    if (!r?.ok) return status(r?.error || "xato");
    status("agent raqobatchilarni aylanmoqda…", true);
    renderCompetitor();
  });

  el("cancelsweep")?.addEventListener("click", async () => {
    await bg({ type: "CANCEL_SWEEP" });
    status("to'xtatildi");
  });
}

function paintCompetitor(rep, who) {
  const rows = (rep.table || [])
    .map(
      (r) => `<tr>
        <td>${esc(r.metric)}</td>
        <td class="${r.winner === "me" ? "win" : ""}">${esc(r.me)}</td>
        <td class="${r.winner === "them" ? "win" : ""}">${esc(r.them)}</td>
      </tr>`
    )
    .join("");

  el("view-competitor").innerHTML = `
    <div class="card">
      <h4>Siz vs @${esc(who)}</h4>
      <table class="cmp">
        <tr><td class="muted small">ko'rsatkich</td><td class="muted small">siz</td><td class="muted small">@${esc(who)}</td></tr>
        ${rows}
      </table>
    </div>
    ${
      rep.breakouts?.length
        ? `<div class="card"><h4>Breakout reellari <span class="badge hot">median × 3</span></h4>
            ${rep.breakouts
              .map(
                (b) => `<div class="kv"><span>${esc((b.caption || b.code).slice(0, 46))}</span><span>${fmt(b.views)}</span></div>`
              )
              .join("")}</div>`
        : ""
    }
    <div class="card"><h4>Ular nimada kuchli</h4>${listHtml(rep.they_win_at)}</div>
    <div class="card"><h4>Siz nimada kuchlisiz</h4>${listHtml(rep.i_win_at)}</div>
    <div class="card"><h4>Bo'sh joylar <span class="badge hot">imkoniyat</span></h4>${listHtml(rep.gaps)}</div>
    <div class="card">
      <h4>O'zlashtiring: 5 format</h4>
      ${(rep.steal_these || [])
        .map(
          (s) => `<div style="margin-bottom:9px">
            <div style="font-weight:600;font-size:12px">${esc(s.format)}</div>
            <div class="small muted">${esc(s.why)}</div>
            <div class="small" style="margin-top:3px">Hook: “${esc(s.example_hook)}”</div>
          </div>`
        )
        .join("")}
    </div>
    ${rep.posting_advice ? `<div class="card"><h4>Ritm bo'yicha maslahat</h4><div class="small">${esc(rep.posting_advice)}</div></div>` : ""}
    <button class="primary" id="toideas2">Shu tahlildan g'oyalar →</button>`;

  cache.lastCompetitor = { who, report: rep };
  el("toideas2")?.addEventListener("click", () => switchTab("ideas", true));
}

// --- ideas -----------------------------------------------------------------

function renderIdeas(force = false) {
  const v = "view-ideas";
  if (cache.ideas && !force) return paintIdeas(cache.ideas);

  if (!cache.profileReport) {
    el(v).innerHTML = `<div class="empty">Avval <b>Profil</b> tabida tahlilni ishga tushiring —<br>g'oyalar sizning ovozingizga moslanadi.</div>`;
    return;
  }

  el(v).innerHTML = `
    <div class="card small muted">
      Manba: profil tahlili${cache.lastCompetitor ? ` + @${esc(cache.lastCompetitor.who)} solishtiruvi` : ""}${
    Object.keys(cache).some((k) => k.startsWith("reel:")) ? " + dekodlangan reellar" : ""
  }.
    </div>
    <button class="primary" id="gen">5 ta g'oya va ssenariy yaratish</button>`;

  el("gen")?.addEventListener("click", async () => {
    loading(v, "G'oyalar va ssenariylar yozilmoqda…");
    status("g'oyalar yaratilmoqda…", true);
    try {
      const reels = Object.entries(cache)
        .filter(([k]) => k.startsWith("reel:"))
        .map(([, r]) => r);
      const pack = await api("/generate/ideas", {
        profile_report: cache.profileReport,
        competitor_report: cache.lastCompetitor?.report || null,
        reel_reports: reels,
        lang: lang(),
      });
      cache.ideas = pack;
      paintIdeas(pack);
      status("g'oyalar tayyor");
    } catch (e) {
      failure(v, e);
      status("xato");
    }
  });
}

function paintIdeas(pack) {
  el("view-ideas").innerHTML =
    `<div class="row" style="margin-bottom:10px">
       <div class="small muted spacer">${(pack.ideas || []).length} ta g'oya</div>
       <button class="ghost tiny" id="regen">Qayta</button>
     </div>` +
    (pack.ideas || [])
      .map(
        (i, n) => `<div class="card">
      <h4>${n + 1}. ${esc(i.title)} <span class="badge">${esc(i.format || "reel")}</span></h4>
      <div class="small muted">${esc(i.why_it_fits || "")}</div>
      <div class="small" style="margin-top:7px"><b>Hook variantlari</b></div>
      ${listHtml(i.hooks)}
      <pre class="script">${esc(i.script || "")}</pre>
      ${i.shot_list?.length ? `<div class="small" style="margin-top:7px"><b>Kadrlar</b></div>${listHtml(i.shot_list)}` : ""}
      ${i.caption ? `<div class="small" style="margin-top:7px"><b>Caption</b><br>${esc(i.caption)}</div>` : ""}
      ${i.hashtags?.length ? `<div class="small muted" style="margin-top:5px">${esc(i.hashtags.join(" "))}</div>` : ""}
      ${
        i.lead_magnet
          ? `<div class="card" style="margin:9px 0 0;background:#0e0e14">
               <div class="small"><b>Lead magnit</b> — izohga
                 <span class="badge hot">${esc(i.lead_magnet.keyword)}</span> yozganlarga DM</div>
               <div class="small muted" style="margin-top:4px">${esc(i.lead_magnet.dm_text)}</div>
               <div class="row end" style="margin-top:7px">
                 <button class="ghost tiny arm" data-idea="${n}">Qoidani yoqish →</button>
               </div>
             </div>`
          : ""
      }
      <div class="row end" style="margin-top:8px">
        <button class="ghost tiny cp" data-n="${n}">Ssenariyni nusxalash</button>
      </div>
    </div>`
      )
      .join("");

  el("regen")?.addEventListener("click", () => renderIdeas(true));

  document.querySelectorAll("#view-ideas .cp").forEach((b) =>
    b.addEventListener("click", () => {
      navigator.clipboard.writeText(pack.ideas[+b.dataset.n].script || "");
      status("ssenariy nusxalandi");
    })
  );

  document.querySelectorAll("#view-ideas .arm").forEach((b) =>
    b.addEventListener("click", () => {
      cache.armDraft = pack.ideas[+b.dataset.idea].lead_magnet;
      switchTab("auto", true);
    })
  );
}

// --- automations -----------------------------------------------------------

async function renderAuto() {
  const v = "view-auto";
  el(v).innerHTML = `<div class="empty"><span class="spin"></span></div>`;

  let info = { connected: false, rules: [], events: [] };
  try {
    info = await api("/automation/state");
  } catch (e) {
    el(v).innerHTML = `<div class="card"><div class="err">${esc(e.message)}</div></div>`;
    return;
  }

  const d = cache.armDraft || {};
  el(v).innerHTML = `
    <div class="card">
      <h4>Instagram ulanishi
        <span class="badge ${info.connected ? "good" : "hot"}">${info.connected ? "ulangan" : "ulanmagan"}</span>
      </h4>
      <div class="small muted">${esc(
        info.connected
          ? `@${info.username} — izohlar ${info.poll_seconds}s da bir tekshiriladi`
          : "backend .env da IG_TOKEN va IG_USER_ID ni to'ldiring (qoidalar baribir saqlanadi, yuborish o'rniga 'would send' log bo'ladi)"
      )}</div>
    </div>

    <div class="card">
      <h4>Yangi qoida</h4>
      <label class="f">Kalit so'z (izohda)</label>
      <input class="f" id="kw" value="${esc(d.keyword || "+")}" />
      <label class="f">Ochiq javob (izohga)</label>
      <input class="f" id="pr" value="${esc(d.public_reply || "DM'ga yubordim ✅")}" />
      <label class="f">DM matni</label>
      <textarea class="f" id="dm">${esc(d.dm_text || "")}</textarea>
      <label class="f">Link (ixtiyoriy)</label>
      <input class="f" id="lk" value="${esc(d.link || "")}" />
      <div style="height:9px"></div>
      <button class="primary" id="arm">Qoidani yoqish</button>
    </div>

    <div class="card">
      <h4>Faol qoidalar</h4>
      ${
        info.rules.length
          ? info.rules
              .map(
                (r) => `<div class="kv">
                  <span><span class="badge hot">${esc(r.keyword)}</span> ${esc((r.dm_text || "").slice(0, 40))}…</span>
                  <span>${r.sent_count} ta · <button class="ghost tiny tg" data-id="${esc(r.id)}">${r.active ? "o'chirish" : "yoqish"}</button></span>
                </div>`
              )
              .join("")
          : `<div class="small muted">hali qoida yo'q</div>`
      }
    </div>

    <div class="card">
      <h4>Hodisalar <button class="ghost tiny" id="rf">yangilash</button></h4>
      ${
        info.events.length
          ? info.events
              .slice(-12)
              .reverse()
              .map(
                (e) => `<div class="evt"><b>@${esc(e.username)}</b> “${esc(e.text)}” →
                  ${esc(e.action)} <span class="muted">${esc(e.at)}</span></div>`
              )
              .join("")
          : `<div class="small muted">hali hodisa yo'q — ikkinchi akkauntdan izoh yozib ko'ring</div>`
      }
    </div>`;

  el("arm")?.addEventListener("click", async () => {
    status("qoida saqlanmoqda…", true);
    try {
      await api("/automation/rules", {
        keyword: el("kw").value.trim(),
        public_reply: el("pr").value.trim(),
        dm_text: el("dm").value.trim(),
        link: el("lk").value.trim(),
      });
      cache.armDraft = null;
      status("qoida yoqildi — izohlar kuzatilmoqda");
      renderAuto();
    } catch (e) {
      status("xato: " + e.message);
    }
  });

  el("rf")?.addEventListener("click", renderAuto);
  document.querySelectorAll("#view-auto .tg").forEach((b) =>
    b.addEventListener("click", async () => {
      await api("/automation/rules/toggle", { id: b.dataset.id });
      renderAuto();
    })
  );
}

// --- chat ------------------------------------------------------------------

/**
 * Minimal markdown renderer for model replies.
 *
 * Everything is HTML-escaped first, so model output can never inject markup —
 * only the small set of patterns below is turned back into tags. A full parser
 * would be a dependency, and the CDN allowlist plus a side panel's size budget
 * do not justify one for headings, bold and bullets.
 */
function md(src) {
  const lines = esc(src).split("\n");
  const out = [];
  let list = null;

  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      if (list !== "ul") {
        closeList();
        out.push('<ul class="md">');
        list = "ul";
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      if (list !== "ol") {
        closeList();
        out.push('<ol class="md">');
        list = "ol";
      }
      out.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }

    if (!line.trim()) {
      closeList();
      continue;
    }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("");
}

const chatLog = [];

function renderChat() {
  const v = "view-chat";
  if (!el(v).dataset.ready) {
    el(v).dataset.ready = "1";
    el(v).innerHTML = `
      <div id="chatlog"></div>
      <div class="card" style="position:sticky;bottom:0">
        <textarea class="f" id="q" placeholder="Masalan: shu reelga kuchliroq hook yozib ber"></textarea>
        <div style="height:7px"></div>
        <button class="primary" id="ask">So'rash</button>
      </div>`;
    el("ask").addEventListener("click", ask);
    el("q").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask();
    });
  }
  paintChat();
}

function paintChat() {
  const log = el("chatlog");
  if (!log) return;
  log.innerHTML = chatLog.length
    ? chatLog
        .map(
          (m) => `<div class="card${m.role === "user" ? " mine" : ""}">
            <div class="small muted" style="margin-bottom:5px">${m.role === "user" ? "Siz" : "ReelSense"}</div>
            <div class="md-body">${m.role === "user" ? esc(m.content) : md(m.content)}</div>
          </div>`
        )
        .join("")
    : `<div class="empty">Ochiq turgan profil yoki reel haqida so'rang.<br>
         Agent nima yig'ilganini ko'rib turadi.</div>`;
  log.lastElementChild?.scrollIntoView({ block: "end", behavior: "smooth" });
}

async function ask() {
  const q = el("q").value.trim();
  if (!q) return;
  el("q").value = "";
  chatLog.push({ role: "user", content: q });
  paintChat();
  status("o'ylanmoqda…", true);

  try {
    // Hand over what is on screen plus whatever has already been analysed, so
    // the answer is about this account rather than social media in general.
    const res = await api("/chat", {
      question: q,
      lang: lang(),
      history: chatLog.slice(0, -1),
      context: {
        page: state.context,
        me: state.mine?.profile || null,
        my_reels: (state.mine?.reels || []).slice(0, 20),
        on_screen_account: state.target?.profile || null,
        on_screen_reels: (state.target?.reels || []).slice(0, 20),
        profile_report: cache.profileReport || null,
        competitor_report: cache.lastCompetitor?.report || null,
        decoded_reels: Object.entries(cache)
          .filter(([k]) => k.startsWith("reel:"))
          .map(([, r]) => r)
          .slice(0, 3),
      },
    });
    chatLog.push({ role: "assistant", content: res.answer });
    status("tayyor");
  } catch (e) {
    chatLog.push({ role: "assistant", content: "Xato: " + e.message });
    status("xato");
  }
  paintChat();
}

// --- tabs ------------------------------------------------------------------

function switchTab(name) {
  activeTab = name;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("active", s.id === "view-" + name));
  render();
}

function render() {
  if (activeTab === "profile") renderProfile();
  else if (activeTab === "reel") renderReel();
  else if (activeTab === "competitor") renderCompetitor();
  else if (activeTab === "ideas") renderIdeas();
  else if (activeTab === "auto") renderAuto();
  else if (activeTab === "chat") renderChat();
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => switchTab(t.dataset.tab))
);

// Clicking the status bar copies a shape report. Instagram moves fields between
// releases, and this says exactly which ones a captured reel carries today.
el("status").style.cursor = "pointer";
el("status").title = "Diagnostikani nusxalash";
el("status").addEventListener("click", () => {
  const diag = {
    context: state.context,
    me: state.me,
    totals: state.totals,
    payloads: state.stats?.payloads,
    sampleReelFields: state.stats?.sample || null,
    firstCapturedReel: state.recent?.[0] || null,
    profileCaptured: state.mine?.profile || state.target?.profile || null,
  };
  navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
  status("diagnostika nusxalandi — menga yuboring");
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "CONTEXT_CHANGED") {
    // A new page means a new subject: re-render so the tab matches what is on screen.
    state.context = msg.context;
    refresh();
  } else if (msg?.type === "STATE_CHANGED") {
    // More reels captured. Refresh the counters, but never wipe a rendered report
    // or a half-filled automation form out from under the user.
    refresh(false);
  } else if (msg?.type === "CRAWL_PROGRESS") {
    if (activeTab === "competitor") renderCompetitor();
    const cur = msg.crawl?.current;
    if (cur) status(`@${cur.username} o'qilmoqda — ${cur.reels} reel`, true);
  } else if (msg?.type === "DIGEST_READY") {
    if (activeTab === "competitor") renderCompetitor();
    status("kunlik xulosa tayyor");
  }
});

setInterval(async () => {
  const before = state.totals?.reels || 0;
  await refresh(false);
  // Keep the feed list growing as the user scrolls, but never redraw over a
  // rendered report or a reel they already picked.
  if (activeTab === "reel" && !selectedCode && state.context?.kind === "feed") {
    if ((state.totals?.reels || 0) !== before) renderReel();
  }
}, 2500);
refresh();
