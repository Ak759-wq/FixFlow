import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CFG = window.FF_CONFIG;
const db = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DAY = 864e5;
const URG_RANK = { High: 0, Medium: 1, Low: 2 };
const CATS = ["Water", "Electricity", "Wi-Fi", "Food", "Hygiene", "Safety", "Maintenance", "Other"];

/* ---------------- state ---------------- */
let profile = JSON.parse(localStorage.getItem("ff_profile") || "null");
let wardenCode = sessionStorage.getItem("ff_warden") || null;
let lastAnalysis = null;
let pendingAfterProfile = null;

/* ---------------- utils ---------------- */
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}
function busy(btn, on, label) {
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || "Working…"; btn.classList.add("loading"); }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.classList.remove("loading"); }
}
const daysBetween = (a, b = Date.now()) => Math.max(0, Math.floor((new Date(b) - new Date(a)) / DAY));
const fmtDate = (d) => new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

async function ai(action, payload) {
  const r = await fetch(CFG.AI_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "AI unavailable");
  return j;
}

/* Offline fallback so the app still works if the AI is down */
function localAnalyze(text) {
  const t = text.toLowerCase();
  const rules = [
    ["Water", /water|paani|pani|tap|leak|seepage|flush|bathroom|shower|drain/],
    ["Electricity", /power|light|fan|bijli|current|switch|spark|geyser|socket|ac\b|inverter/],
    ["Wi-Fi", /wifi|wi-fi|internet|network|router|net\b/],
    ["Food", /food|khana|meal|dal|rice|lunch|dinner|breakfast|insect|keede|mess/],
    ["Hygiene", /dirty|clean|garbage|smell|cockroach|rat|mosquito|dust|toilet/],
    ["Safety", /lock|door|security|guard|cctv|unsafe|theft|stolen|fire/],
    ["Maintenance", /broken|crack|bed|chair|table|window|paint|cupboard/],
  ];
  const category = (rules.find(([, re]) => re.test(t)) || ["Other"])[0];
  const urgency = /spark|fire|no water|paani nahi|pani nahi|insect|keede|unsafe|theft|lock|no power|bijli nahi/.test(t) ? "High" : /wifi|wi-fi|food|khana|broken|geyser|internet/.test(t) ? "Medium" : "Low";
  const title = text.split(/[.!?\n]/)[0].slice(0, 60);
  const who = profile ? `${profile.name}, Room ${profile.room}` : "Resident";
  return {
    category, urgency, title: title.charAt(0).toUpperCase() + title.slice(1), summary: text.slice(0, 140),
    draft: `Dear Warden,\n\nI would like to report a ${category.toLowerCase()} issue: ${text.trim()}\n\nThis is affecting my daily routine. I request you to look into it and get it fixed at the earliest, ideally within 24–48 hours. Please let me know once it has been addressed.\n\nThank you,\n${who}`,
    offline: true,
  };
}

/* ---------------- tabs + nav ---------------- */
function showTab(name) {
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".pill").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
  if (name === "track") loadMine();
  if (name === "warden") initWarden();
  if (name === "movein") loadMovein();
  if (name === "deposit" && !$("#dRows").children.length) seedDeductions();
}
$$(".tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
$$("a[data-tab]").forEach((a) => a.addEventListener("click", () => showTab(a.dataset.tab)));

/* ---------------- hero scroll ---------------- */
const hero = $(".hero");
const nav = $("#nav");
function onScroll() {
  const max = hero.offsetHeight - innerHeight;
  const p = Math.min(1, Math.max(0, scrollY / max));
  hero.style.setProperty("--p", p.toFixed(4));
  nav.classList.toggle("solid", scrollY > max * 0.62);
}
addEventListener("scroll", onScroll, { passive: true });
addEventListener("resize", onScroll);
onScroll();

/* ---------------- profile ---------------- */
function renderProfile() {
  const chip = $("#profileChip");
  if (profile) { chip.textContent = `${profile.name} · Room ${profile.room} · ${profile.code}`; chip.classList.add("set"); }
  else { chip.textContent = "Join your PG"; chip.classList.remove("set"); }
}
function openProfile(after) {
  pendingAfterProfile = after || null;
  if (profile) { $("#pName").value = profile.name; $("#pRoom").value = profile.room; $("#pCode").value = profile.code; }
  $("#pErr").textContent = "";
  $("#profileDlg").showModal();
}
$("#profileChip").addEventListener("click", () => openProfile());
$("#profileForm").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "save") { pendingAfterProfile = null; return; }
  e.preventDefault();
  const name = $("#pName").value.trim(), room = $("#pRoom").value.trim(), code = $("#pCode").value.trim().toUpperCase();
  if (!name || !room || !code) return ($("#pErr").textContent = "Fill all fields.");
  const { data, error } = await db.from("ff_pgs").select("code,name").eq("code", code).maybeSingle();
  if (error || !data) return ($("#pErr").textContent = "PG code not found. Try SUNRISE24.");
  profile = { name, room, code, pgName: data.name };
  localStorage.setItem("ff_profile", JSON.stringify(profile));
  renderProfile();
  $("#profileDlg").close();
  toast(`Joined ${data.name}`);
  loadHeroStats();
  const fn = pendingAfterProfile; pendingAfterProfile = null;
  if (fn) fn();
});
const needProfile = (fn) => (profile ? fn() : openProfile(fn));

/* ---------------- hero stats ---------------- */
async function loadHeroStats() {
  const code = profile?.code || "SUNRISE24";
  const { data } = await db.from("ff_complaints").select("status,created_at,fixed_at").eq("pg_code", code);
  if (!data) return;
  const fixed = data.filter((c) => c.status === "Fixed");
  $("#statOpen").textContent = data.length - fixed.length;
  $("#statFixed").textContent = fixed.length;
  const avg = fixed.length ? fixed.reduce((s, c) => s + (new Date(c.fixed_at) - new Date(c.created_at)) / DAY, 0) / fixed.length : 0;
  $("#statAvg").textContent = avg.toFixed(1);
}

/* ---------------- report ---------------- */
$$("#examples .chip").forEach((c) => c.addEventListener("click", () => { $("#issueText").value = c.textContent; $("#issueText").focus(); }));

// voice input (Web Speech API)
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
$("#micBtn").addEventListener("click", () => {
  if (!SR) return toast("Voice input isn't supported in this browser. Try Chrome.");
  if (rec) { rec.stop(); return; }
  rec = new SR();
  rec.lang = "en-IN"; rec.interimResults = true; rec.continuous = false;
  const base = $("#issueText").value ? $("#issueText").value + " " : "";
  rec.onresult = (e) => { $("#issueText").value = base + [...e.results].map((r) => r[0].transcript).join(" "); };
  rec.onend = () => { $("#micBtn").classList.remove("rec"); rec = null; };
  rec.onerror = (e) => toast(e.error === "not-allowed" ? "Microphone permission denied" : "Couldn't hear that, try again");
  $("#micBtn").classList.add("rec");
  rec.start();
});

$("#analyzeBtn").addEventListener("click", async () => {
  const text = $("#issueText").value.trim();
  if (text.length < 5) return toast("Describe the issue in a few words first");
  const btn = $("#analyzeBtn");
  busy(btn, true, "Analysing…");
  try {
    lastAnalysis = await ai("analyze", { text, resident: profile?.name, room: profile?.room, pg: profile?.pgName });
  } catch {
    lastAnalysis = localAnalyze(text);
  }
  lastAnalysis.text = text;
  busy(btn, false);
  renderAnalysis();
});

async function renderAnalysis() {
  const a = lastAnalysis;
  $("#resultEmpty").hidden = true;
  $("#resultBody").hidden = false;
  $("#rCategory").textContent = a.category;
  $("#rUrgency").textContent = `${a.urgency} urgency`;
  $("#rUrgency").className = `badge ${a.urgency}`;
  $("#rTitle").textContent = a.title;
  $("#rSummary").textContent = a.offline ? `${a.summary} (offline mode: AI unavailable)` : a.summary;
  $("#rDraft").value = a.draft;
  // duplicate detection: open complaints in the same PG + category in the last 3 days
  const box = $("#dupeBox");
  box.hidden = true;
  const code = profile?.code || "SUNRISE24";
  const { data } = await db.from("ff_complaints").select("id,title,room,supporters,created_at").eq("pg_code", code).eq("category", a.category).neq("status", "Fixed").gte("created_at", new Date(Date.now() - 3 * DAY).toISOString()).order("created_at", { ascending: false }).limit(1);
  if (data?.length && profile && data[0].room !== profile.room) {
    const d = data[0];
    box.innerHTML = `<b>${d.supporters} resident${d.supporters > 1 ? "s" : ""} already reported a ${esc(a.category)} issue:</b> "${esc(d.title)}". Add your support to push its priority, or submit yours separately.<div class="row"><button class="btn small primary" id="supportBtn" type="button">Add my support</button></div>`;
    box.hidden = false;
    $("#supportBtn").onclick = () => needProfile(async () => {
      const { error } = await db.from("ff_complaints").update({ supporters: d.supporters + 1 }).eq("id", d.id);
      if (error) return toast("Couldn't add support");
      box.innerHTML = "✓ Your support was added. The warden sees this as a group complaint.";
      toast("Support added");
    });
  }
}

$("#copyDraft").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#rDraft").value); toast("Complaint copied"); } catch { toast("Copy failed"); }
});

$("#submitBtn").addEventListener("click", () => needProfile(async () => {
  const a = lastAnalysis;
  if (!a) return;
  const btn = $("#submitBtn");
  busy(btn, true, "Submitting…");
  const { error } = await db.from("ff_complaints").insert({
    pg_code: profile.code, resident_name: profile.name, room: profile.room,
    text: a.text, title: a.title, summary: a.summary, draft: $("#rDraft").value,
    category: a.category, urgency: a.urgency,
  });
  busy(btn, false);
  if (error) return toast("Couldn't submit: " + error.message);
  toast("Sent to your warden");
  $("#issueText").value = "";
  $("#resultBody").hidden = true; $("#resultEmpty").hidden = false;
  lastAnalysis = null;
  loadHeroStats();
  showTab("track");
}));

/* ---------------- my complaints ---------------- */
function statCards(list) {
  return list.map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");
}
function stageOf(c) { return c.status === "Fixed" ? 4 : c.status === "In progress" ? 3 : c.seen_at ? 2 : 1; }

async function loadMine() {
  const list = $("#myList");
  if (!profile) {
    $("#myStats").innerHTML = "";
    list.innerHTML = `<div class="card empty"><div class="empty-icon">☰</div><p>Join your PG to see your complaints.</p><p><button class="btn primary" id="joinBtn" type="button">Join your PG</button></p></div>`;
    $("#joinBtn").onclick = () => openProfile(loadMine);
    return;
  }
  list.innerHTML = `<p class="muted">Loading…</p>`;
  const { data, error } = await db.from("ff_complaints").select("*").eq("pg_code", profile.code).eq("resident_name", profile.name).eq("room", profile.room).order("created_at", { ascending: false });
  if (error) return (list.innerHTML = `<p class="error">${esc(error.message)}</p>`);
  const open = data.filter((c) => c.status !== "Fixed");
  const oldest = open.length ? Math.max(...open.map((c) => daysBetween(c.created_at))) : 0;
  const fixed = data.filter((c) => c.status === "Fixed");
  const avg = fixed.length ? (fixed.reduce((s, c) => s + (new Date(c.fixed_at) - new Date(c.created_at)) / DAY, 0) / fixed.length).toFixed(1) : "–";
  $("#myStats").innerHTML = statCards([[open.length, "Open complaints"], [fixed.length, "Fixed"], [oldest, "Days, oldest unfixed"], [avg, "Avg. days to fix"]]);
  if (!data.length) return (list.innerHTML = `<div class="card empty"><div class="empty-icon">✓</div><p>No complaints yet. Hope it stays that way!</p></div>`);
  list.innerHTML = data.map((c) => {
    const d = c.status === "Fixed" ? daysBetween(c.created_at, c.fixed_at) : daysBetween(c.created_at);
    const st = stageOf(c);
    const nextLevel = Math.min(3, c.escalation_level + 1);
    const levelName = ["", "WhatsApp reminder", "Formal notice", "Consumer complaint"][nextLevel];
    return `<article class="item" data-id="${c.id}">
      <div>
        <div class="badges"><span class="badge">${esc(c.category)}</span><span class="badge ${c.urgency}">${c.urgency}</span><span class="badge status-${c.status.replace(" ", ".")}">${c.status}</span>${c.supporters > 1 ? `<span class="badge ai">+${c.supporters - 1} residents</span>` : ""}</div>
        <h4>${esc(c.title)}</h4>
        <p>${esc(c.text)}</p>
        ${c.warden_note ? `<p class="meta"><b>Warden:</b> ${esc(c.warden_note)}</p>` : ""}
        <div class="timeline" title="Raised → Seen → In progress → Fixed">${[1, 2, 3, 4].map((i) => `<i class="${i <= st ? "on" : ""}"></i>`).join("")}</div>
        <p class="meta">Raised ${fmtDate(c.created_at)}${c.fixed_at ? ` · Fixed ${fmtDate(c.fixed_at)}` : ""}${c.escalation_level ? ` · Escalation level ${c.escalation_level}/3` : ""}</p>
        <div class="esc-out"></div>
      </div>
      <div class="side">
        <div class="days ${c.status === "Fixed" ? "done" : d >= 3 ? "hot" : ""}"><b>${d}</b><span>${c.status === "Fixed" ? "days to fix" : "days unfixed"}</span></div>
        ${c.status !== "Fixed" ? `<button class="btn small primary act-esc" data-level="${nextLevel}" type="button">${c.escalation_level >= 3 ? "Regenerate complaint" : "Escalate: " + levelName}</button>
        <button class="btn small ghost act-fixed" type="button">It's fixed</button>` : ""}
      </div>
    </article>`;
  }).join("");

  $$(".act-esc", list).forEach((b) => b.addEventListener("click", async () => {
    const id = b.closest(".item").dataset.id;
    const c = data.find((x) => x.id === id);
    const level = +b.dataset.level;
    busy(b, true, "Drafting…");
    let msg;
    try { msg = (await ai("escalate", { complaint: c, level, days: daysBetween(c.created_at) })).message; }
    catch {
      msg = [
        `Hi, gentle reminder about my complaint "${c.title}" (Room ${c.room}) raised on ${fmtDate(c.created_at)}. It's still not fixed. Please look into it today. Thanks, ${c.resident_name}`,
        `To the PG Owner,\n\nThis is a formal notice regarding my complaint "${c.title}" raised on ${fmtDate(c.created_at)}, unresolved for ${daysBetween(c.created_at)} days. I request resolution within 48 hours.\n\n${c.resident_name}, Room ${c.room}`,
        `Consumer complaint (National Consumer Helpline, 1915 / consumerhelpline.gov.in)\n\nDeficiency in service by PG accommodation: "${c.title}". Reported on ${fmtDate(c.created_at)}, unresolved for ${daysBetween(c.created_at)} days despite reminders.\n\nComplainant: ${c.resident_name}, Room ${c.room}`,
      ][level - 1];
    }
    busy(b, false);
    await db.from("ff_complaints").update({ escalation_level: level }).eq("id", id);
    const out = $(".esc-out", b.closest(".item"));
    out.innerHTML = `<div class="escalation">${esc(msg)}</div><div class="row"><button class="btn small ghost cp" type="button">Copy</button>${level === 1 ? `<a class="btn small ghost" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">Send on WhatsApp</a>` : ""}${level === 3 ? `<a class="btn small ghost" target="_blank" rel="noopener" href="https://consumerhelpline.gov.in/">Open consumer helpline</a>` : ""}</div>`;
    $(".cp", out).onclick = async () => { await navigator.clipboard.writeText(msg).catch(() => {}); toast("Copied"); };
    c.escalation_level = level;
    b.dataset.level = Math.min(3, level + 1);
    b.textContent = level >= 3 ? "Regenerate complaint" : "Escalate: " + ["", "WhatsApp reminder", "Formal notice", "Consumer complaint"][level + 1];
    toast(`Escalation level ${level} drafted`);
  }));
  $$(".act-fixed", list).forEach((b) => b.addEventListener("click", async () => {
    const id = b.closest(".item").dataset.id;
    const { error } = await db.from("ff_complaints").update({ status: "Fixed", fixed_at: new Date().toISOString(), warden_note: "Confirmed fixed by resident" }).eq("id", id);
    if (error) return toast("Couldn't update");
    toast("Marked as fixed");
    loadMine(); loadHeroStats();
  }));
}

/* ---------------- warden ---------------- */
CATS.forEach((c) => $("#fCat").insertAdjacentHTML("beforeend", `<option>${c}</option>`));
function initWarden() {
  $("#wardenLock").hidden = !!wardenCode;
  $("#wardenBody").hidden = !wardenCode;
  if (wardenCode) loadWarden();
}
$("#wLogin").addEventListener("click", async () => {
  const code = $("#wCode").value.trim().toUpperCase(), pin = $("#wPin").value.trim();
  const { data, error } = await db.rpc("ff_check_pin", { p_code: code, p_pin: pin });
  if (error || !data) return ($("#wErr").textContent = "Wrong PG code or PIN.");
  $("#wErr").textContent = "";
  wardenCode = code;
  sessionStorage.setItem("ff_warden", code);
  initWarden();
});
$("#fCat").addEventListener("change", loadWarden);
$("#fStatus").addEventListener("change", loadWarden);
$("#wRefresh").addEventListener("click", loadWarden);

async function loadWarden() {
  const { data, error } = await db.from("ff_complaints").select("*").eq("pg_code", wardenCode);
  if (error) return toast(error.message);
  const active = data.filter((c) => c.status !== "Fixed");
  const weekFixed = data.filter((c) => c.status === "Fixed" && Date.now() - new Date(c.fixed_at) < 7 * DAY);
  const fixed = data.filter((c) => c.status === "Fixed");
  const avg = fixed.length ? (fixed.reduce((s, c) => s + (new Date(c.fixed_at) - new Date(c.created_at)) / DAY, 0) / fixed.length).toFixed(1) : "–";
  $("#wStats").innerHTML = statCards([[active.filter((c) => c.urgency === "High").length, "High urgency open"], [active.length, "Open + in progress"], [weekFixed.length, "Fixed this week"], [avg, "Avg. days to fix"]]);
  // category chart (active)
  const counts = CATS.map((c) => [c, active.filter((x) => x.category === c).length]).filter(([, n]) => n);
  const max = Math.max(1, ...counts.map(([, n]) => n));
  $("#wChart").innerHTML = `<b style="font-size:13px">Open issues by category</b>` + (counts.length ? counts.map(([c, n]) => `<div class="bar"><span>${c}</span><div style="width:${(n / max) * 100}%"></div><b>${n}</b></div>`).join("") : `<p class="muted">Nothing open. Nice work!</p>`);
  // list
  const fc = $("#fCat").value, fs = $("#fStatus").value;
  let rows = data.filter((c) => (!fc || c.category === fc) && (fs === "" ? true : fs === "active" ? c.status !== "Fixed" : c.status === fs));
  rows.sort((a, b) => (a.status === "Fixed") - (b.status === "Fixed") || URG_RANK[a.urgency] - URG_RANK[b.urgency] || b.supporters - a.supporters || new Date(a.created_at) - new Date(b.created_at));
  $("#wList").innerHTML = rows.length ? rows.map((c) => {
    const d = c.status === "Fixed" ? daysBetween(c.created_at, c.fixed_at) : daysBetween(c.created_at);
    return `<article class="item" data-id="${c.id}">
      <div>
        <div class="badges"><span class="badge">${esc(c.category)}</span><span class="badge ${c.urgency}">${c.urgency}</span><span class="badge status-${c.status.replace(" ", ".")}">${c.status}</span>${c.supporters > 1 ? `<span class="badge ai">Group · ${c.supporters} residents</span>` : ""}${c.escalation_level ? `<span class="badge High">Escalated L${c.escalation_level}</span>` : ""}</div>
        <h4>${esc(c.title)}</h4>
        <p>${esc(c.text)}</p>
        <p class="meta">${esc(c.resident_name)} · Room ${esc(c.room)} · ${fmtDate(c.created_at)}${c.warden_note ? ` · Note: ${esc(c.warden_note)}` : ""}</p>
      </div>
      <div class="side">
        <div class="days ${c.status === "Fixed" ? "done" : d >= 3 ? "hot" : ""}"><b>${d}</b><span>${c.status === "Fixed" ? "days to fix" : "days open"}</span></div>
        ${c.status === "Open" ? `<button class="btn small ghost w-prog" type="button">Start work</button>` : ""}
        ${c.status !== "Fixed" ? `<button class="btn small primary w-fix" type="button">Mark fixed</button>` : ""}
      </div>
    </article>`;
  }).join("") : `<div class="card empty"><p>No complaints match.</p></div>`;
  $$(".w-prog").forEach((b) => b.addEventListener("click", async () => {
    const id = b.closest(".item").dataset.id;
    const note = prompt("Note for the resident (optional)", "Technician assigned") || null;
    await db.from("ff_complaints").update({ status: "In progress", seen_at: new Date().toISOString(), warden_note: note }).eq("id", id);
    toast("Marked in progress"); loadWarden(); loadHeroStats();
  }));
  $$(".w-fix").forEach((b) => b.addEventListener("click", async () => {
    const id = b.closest(".item").dataset.id;
    const note = prompt("What was done? (optional)", "Issue resolved") || null;
    await db.from("ff_complaints").update({ status: "Fixed", fixed_at: new Date().toISOString(), seen_at: new Date().toISOString(), warden_note: note }).eq("id", id);
    toast("Marked fixed"); loadWarden(); loadHeroStats();
  }));
}

/* ---------------- move-in ---------------- */
let mImage = null;
$("#mFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  mImage = await shrink(f, 900, 0.72);
  $("#mPreview").src = mImage; $("#mPreview").hidden = false; $("#dropText").hidden = true;
  $("#mScan").disabled = false;
});
function shrink(file, maxW, q) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, maxW / img.width);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      res(c.toDataURL("image/jpeg", q));
    };
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}
$("#mScan").addEventListener("click", () => needProfile(async () => {
  const btn = $("#mScan"), area = $("#mArea").value;
  busy(btn, true, "Scanning…");
  let r;
  try { r = await ai("inspect", { image: mImage, area }); }
  catch { r = { issues: [], summary: "AI check unavailable. Photo saved with timestamp as evidence." }; }
  const { error } = await db.from("ff_movein").insert({ pg_code: profile.code, resident_name: profile.name, room: profile.room, area, image: mImage, issues: r.issues || [], summary: r.summary });
  busy(btn, false);
  if (error) return toast("Couldn't save: " + error.message);
  toast("Photo locked with timestamp");
  mImage = null; $("#mFile").value = ""; $("#mPreview").hidden = true; $("#dropText").hidden = false; btn.disabled = true;
  loadMovein();
}));
async function loadMovein() {
  const g = $("#mGallery");
  if (!profile) return (g.innerHTML = `<p class="muted">Join your PG to start your move-in record.</p>`);
  const { data, error } = await db.from("ff_movein").select("*").eq("pg_code", profile.code).eq("resident_name", profile.name).eq("room", profile.room).order("created_at", { ascending: false });
  if (error) return (g.innerHTML = `<p class="error">${esc(error.message)}</p>`);
  g.innerHTML = data.length ? data.map((m) => `<div class="shot"><img src="${m.image}" alt="${esc(m.area)}" /><div>
    <h4>${esc(m.area)}</h4><span class="lock">🔒 Locked ${fmtDate(m.created_at)}</span>
    <p class="muted" style="margin:6px 0 0">${esc(m.summary || "")}</p>
    ${m.issues?.length ? `<ul>${m.issues.map((i) => `<li><b>${esc(i.item)}</b> · ${esc(i.location)} <span class="badge ${i.severity === "Major" ? "High" : i.severity === "Moderate" ? "Medium" : "Low"}">${esc(i.severity)}</span></li>`).join("")}</ul>` : ""}
  </div></div>`).join("") : `<p class="muted">No photos yet.</p>`;
}

/* ---------------- deposit ---------------- */
function addDeduction(label = "", amount = "") {
  $("#dRows").insertAdjacentHTML("beforeend", `<div class="drow"><input placeholder="e.g. Wall repainting" value="${esc(label)}" /><input type="number" placeholder="₹" value="${esc(amount)}" /><button type="button" aria-label="Remove">✕</button></div>`);
  const row = $("#dRows").lastElementChild;
  $("button", row).onclick = () => row.remove();
}
function seedDeductions() { addDeduction("Wall repainting", 3000); addDeduction("Broken bathroom tap", 800); addDeduction("Deep cleaning", 1500); }
$("#dAdd").addEventListener("click", () => addDeduction());
$("#dCheck").addEventListener("click", () => needProfile(async () => {
  const deductions = $$("#dRows .drow").map((r) => ({ label: $$("input", r)[0].value.trim(), amount: +$$("input", r)[1].value || 0 })).filter((d) => d.label && d.amount);
  if (!deductions.length) return toast("Add at least one deduction");
  const btn = $("#dCheck");
  busy(btn, true, "Checking…");
  const [{ data: mv }, { data: cs }] = await Promise.all([
    db.from("ff_movein").select("area,issues,created_at").eq("pg_code", profile.code).eq("resident_name", profile.name).eq("room", profile.room),
    db.from("ff_complaints").select("title,category,status,created_at").eq("pg_code", profile.code).eq("resident_name", profile.name).eq("room", profile.room),
  ]);
  const movein = (mv || []).flatMap((m) => (m.issues || []).map((i) => ({ area: m.area, ...i, recorded: m.created_at?.slice(0, 10) })));
  const complaints = (cs || []).map((c) => ({ title: c.title, category: c.category, status: c.status, raised: c.created_at.slice(0, 10) }));
  const deposit = +$("#dAmount").value || 0;
  let r;
  try { r = await ai("deposit", { deductions, movein, complaints, resident: profile.name, room: profile.room, deposit }); }
  catch {
    const ev = [...movein.map((m) => `${m.item} ${m.area}`), ...complaints.map((c) => `${c.title} ${c.category}`)].join(" ").toLowerCase();
    const items = deductions.map((d) => {
      const hit = d.label.toLowerCase().split(/\s+/).some((w) => w.length > 3 && ev.includes(w));
      return { ...d, verdict: hit ? "Unfair" : /clean|paint/i.test(d.label) ? "Unclear" : "Fair", reason: hit ? "Matches pre-existing damage or a reported issue." : "No matching evidence on record." };
    });
    const claim = items.filter((i) => i.verdict === "Unfair").reduce((s, i) => s + i.amount, 0);
    r = { items, refund_claim: claim, notice: `Dear Owner,\n\nI dispute deductions of ₹${claim} from my deposit of ₹${deposit}. These relate to damage recorded at move-in or issues I reported that were not fixed. My timestamped records are available on FixFlow. Kindly refund this amount within 7 days.\n\n${profile.name}, Room ${profile.room}` };
  }
  busy(btn, false);
  const total = deductions.reduce((s, d) => s + d.amount, 0);
  // Never trust the model's arithmetic: the claim is the sum of deductions judged unfair.
  r.items = (r.items || []).map((i, k) => ({ ...i, amount: Number(i.amount) || deductions[k]?.amount || 0 }));
  r.refund_claim = Math.min(total, r.items.filter((i) => i.verdict === "Unfair").reduce((s, i) => s + i.amount, 0));
  $("#dResult").innerHTML = `<h3>Verdict</h3><p class="muted">Based on ${movein.length} move-in finding${movein.length === 1 ? "" : "s"} and ${complaints.length} complaint${complaints.length === 1 ? "" : "s"} on record.</p>
    ${(r.items || []).map((i) => `<div class="verdict"><div>${esc(i.label)} · ₹${Number(i.amount).toLocaleString("en-IN")}<small>${esc(i.reason)}</small></div><span class="v-${i.verdict}">${i.verdict}</span></div>`).join("")}
    <div class="refund">You can claim back <b>₹${Number(r.refund_claim || 0).toLocaleString("en-IN")}</b> of ₹${total.toLocaleString("en-IN")} deducted.</div>
    <label class="lbl">Refund notice</label><textarea id="dNotice" rows="9">${esc(r.notice)}</textarea>
    <div class="row"><button class="btn ghost" id="dCopy" type="button">Copy notice</button></div>`;
  $("#dCopy").onclick = async () => { await navigator.clipboard.writeText($("#dNotice").value).catch(() => {}); toast("Notice copied"); };
}));

/* ---------------- boot ---------------- */
renderProfile();
loadHeroStats();
