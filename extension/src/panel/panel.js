// ReelSense side panel.

const API = "http://localhost:8000";

const $ = (s) => document.querySelector(s);
const el = (id) => document.getElementById(id);

let state = { me: null, context: { kind: "other" }, target: null, mine: null, suggested: [], known: [] };
const cache = {};      // keyed result cache so a demo can be repeated offline
let activeTab = "profile";

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
  if (!res.ok) throw new Error(data.detail || data.error || `Backend ${res.status}`);
  return data;
}

const lang = () => el("lang").value;

function bg(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

// --- state -----------------------------------------------------------------

async function refresh(rerender = true) {
  const s = await bg({ type: "GET_STATE" });
  if (s) state = s;
  renderCtx();
  if (rerender) render();
}

function renderCtx() {
  const c = state.context || { kind: "other" };
  const t = state.target;
  let main = "Instagram sahifasini oching…";
  let sub = "";

  if (c.kind === "profile") {
    const isMe = state.me && c.username === state.me;
    main = `@${c.username}${isMe ? " (siz)" : ""}`;
    sub = t
      ? `${fmt(t.profile?.followers)} obunachi · ${t.reel_count} reel yig'ildi`
      : "ma'lumot kutilmoqda — sahifani yangilang";
  } else if (c.kind === "reel") {
    main = `Reel ${c.code}`;
    sub = t ? `@${t.username} · ${t.reel_count} reel yig'ildi` : "reel ma'lumoti kutilmoqda";
  } else if (c.kind === "dashboard") {
    main = "Professional Dashboard";
    sub = "insights yig'ilmoqda";
  }

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
      Reels tabini bir-ikki marta pastga aylantiring — qancha ko'p reel yig'ilsa, tahlil shuncha aniq.
    </div>`;

  el("setme")?.addEventListener("click", async () => {
    await bg({ type: "SET_ME", username: subject.username });
    await refresh();
  });

  el("run")?.addEventListener("click", async () => {
    loading(v, "Profil tahlil qilinmoqda…");
    status("profil tahlili…", true);
    try {
      const rep = await api("/analyze/profile", {
        profile: subject.profile,
        reels: subject.reels,
        lang: lang(),
      });
      cache.profileReport = rep;
      cache.profileReportFor = subject.username;
      paintProfileReport(rep, subject);
      status("profil tahlili tayyor");
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

function renderReel() {
  const v = "view-reel";
  const c = state.context;

  if (c.kind !== "reel") {
    el(v).innerHTML = `<div class="empty">Biror <b>reel</b>ni oching (o'zingizniki yoki raqobatchiniki),<br>keyin uni dekodlang.</div>`;
    return;
  }

  const t = state.target;
  const reel = t?.reels?.find((r) => r.code === c.code);
  const cached = cache["reel:" + c.code];
  if (cached) return paintReel(cached, reel, c.code);

  el(v).innerHTML = `
    ${reel ? reelHead(reel) : `<div class="card small muted">Reel metadatasi hali yig'ilmadi — sahifani yangilang.</div>`}
    <button class="primary" id="dec">Bu reelni dekodlash</button>
    <div class="small muted" style="margin-top:8px">
      Video ko'riladi va eshitiladi: hook, struktura, ekran matni, temp va CTA ajratiladi.
    </div>`;

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
        reel: reel || { code: c.code },
        comments: t?.comments?.[c.code] || [],
        my_profile: state.mine?.profile || null,
        video_b64: videoB64,
        lang: lang(),
      });
      cache["reel:" + c.code] = rep;
      paintReel(rep, reel, c.code);
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
  void code;
}

// --- competitor ------------------------------------------------------------

function renderCompetitor() {
  const v = "view-competitor";
  const c = state.context;
  const t = state.target;

  if (!state.me) {
    el(v).innerHTML = `<div class="empty">Avval <b>Profil</b> tabida o'z akkauntingizni belgilang.</div>`;
    return;
  }
  if (c.kind !== "profile" || c.username === state.me) {
    el(v).innerHTML = `
      <div class="empty">Raqobatchining profilini oching, so'ng bu yerga qayting.</div>
      ${
        state.suggested?.length
          ? `<div class="card"><h4>Instagram taklif qilgan o'xshash akkauntlar</h4>
               ${listHtml(state.suggested)}</div>`
          : ""
      }`;
    return;
  }

  const cached = cache["cmp:" + c.username];
  if (cached) return paintCompetitor(cached, c.username);

  el(v).innerHTML = `
    ${t ? profileHead(t, false) : ""}
    <button class="primary" id="cmp" ${t && state.mine ? "" : "disabled"}>@${esc(c.username)} bilan solishtirish</button>
    <div class="small muted" style="margin-top:8px">
      Uning Reels tabini aylantiring — breakout (median×3) reellari aniqlanadi va format shabloni ajratiladi.
    </div>`;

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

// --- tabs ------------------------------------------------------------------

function switchTab(name, force = false) {
  activeTab = name;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("active", s.id === "view-" + name));
  render(force);
}

function render(force = false) {
  if (activeTab === "profile") renderProfile();
  else if (activeTab === "reel") renderReel();
  else if (activeTab === "competitor") renderCompetitor();
  else if (activeTab === "ideas") renderIdeas(force && !cache.ideas ? false : false);
  else if (activeTab === "auto") renderAuto();
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => switchTab(t.dataset.tab))
);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "CONTEXT_CHANGED") {
    state.context = msg.context;
    renderCtx();
    if (activeTab === "reel" || activeTab === "competitor" || activeTab === "profile") {
      refresh();
    }
  } else if (msg?.type === "STATE_CHANGED") {
    refresh(activeTab === "profile" || activeTab === "competitor" ? false : false);
    renderCtx();
  }
});

setInterval(() => refresh(false), 2500);
refresh();
