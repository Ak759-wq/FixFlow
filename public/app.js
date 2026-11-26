import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, connectAuthEmulator, GoogleAuthProvider, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signInWithPopup, signInAnonymously, signOut, updateProfile, deleteUser } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, connectFirestoreEmulator, collection, doc, getDoc, getDocs, query, where, writeBatch, serverTimestamp, increment } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getStorage, connectStorageEmulator, ref, uploadBytes, getDownloadURL, deleteObject, listAll } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";

const CFG = window.FF_CONFIG;
// Local testing against the Firebase emulators (localhost only, never in production): open /?emu=1
const EMU = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && (new URLSearchParams(location.search).has("emu") || localStorage.getItem("ff_emu") === "1");
if (EMU) localStorage.setItem("ff_emu", "1");
const FB = EMU ? { ...CFG.FIREBASE_CONFIG, projectId: "demo-fixflow", authDomain: "demo-fixflow.firebaseapp.com", storageBucket: "demo-fixflow.appspot.com" } : CFG.FIREBASE_CONFIG;
const configured = ["apiKey", "authDomain", "projectId", "storageBucket", "appId"].every((k) => FB?.[k] && !String(FB[k]).startsWith("REPLACE_"));
function connect(app) {
  const a = getAuth(app), d = getFirestore(app), s = getStorage(app);
  if (EMU) {
    connectAuthEmulator(a, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(d, "127.0.0.1", 8085);
    connectStorageEmulator(s, "127.0.0.1", 9199);
  }
  return { a, d, s };
}
const fbApp = configured ? initializeApp(FB) : null;
const { a: auth, d: db, s: storage } = fbApp ? connect(fbApp) : {};
// Wardens use a separate, anonymous Firebase session so they never replace a tenant's login on the same device.
let WARDEN = null;
const wardenClient = () => (WARDEN ||= connect(initializeApp(FB, "warden")));

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DAY = 864e5;
const CATS = ["Water", "Electricity", "Wi-Fi", "Food", "Hygiene", "Safety", "Maintenance", "Other"];
// UI areas. Legacy rows (wardrobe, floor, other) still display and count toward the closest area.
const AREAS = [["bed", "Bedroom"], ["bathroom", "Bathroom"], ["wall", "Walls"], ["furniture", "Furniture"]];
const AREA_LABEL = { bed: "Bedroom", bathroom: "Bathroom", wall: "Walls", furniture: "Furniture", wardrobe: "Furniture (wardrobe)", floor: "Bedroom (floor)", other: "Other" };
const AREA_GROUP = { bed: "bed", floor: "bed", bathroom: "bathroom", wall: "wall", furniture: "furniture", wardrobe: "furniture" };
const areaName = (a) => AREA_LABEL[a] || a;
const URG = { High: 0, Medium: 1, Low: 2 };
const STATUS_LABEL = { open: "Open", in_progress: "In progress", fixed: "Resolved" };
const OK_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024;
const rupee = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const daysSince = (a, b = Date.now()) => Math.max(0, Math.floor((new Date(b) - new Date(a)) / DAY));
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "–");
const fmtStamp = (d) => (d ? new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "–");
const cap = (s) => String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const shortHash = (h) => (h ? h.slice(0, 12) + "…" : "not recorded");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/* ================= state ================= */
const S = {
  mode: null, // "live" | "demo"
  user: null, profile: null, tenancy: null,
  photos: [], notes: [], complaints: [], events: [], deductions: [], notices: {}, audit: [],
  area: "wall", screen: "dashboard", analysis: null, cPhoto: null, review: null,
};

/* ================= ui utils ================= */
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", err);
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3200);
}
function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.textContent = label || "Working…"; btn.classList.add("loading"); btn.disabled = true; }
  else { btn.innerHTML = btn.dataset.label || btn.innerHTML; btn.classList.remove("loading"); btn.disabled = false; }
}
async function ai(action, payload) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 35000);
  try {
    const r = await fetch(CFG.AI_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }), signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "AI unavailable");
    return j;
  } finally { clearTimeout(timer); }
}
function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function openImg(src) { $("#imgBig").src = src; $("#imgDlg").showModal(); }
$("#imgClose").addEventListener("click", () => $("#imgDlg").close());
$("#imgDlg").addEventListener("click", (e) => { if (e.target.id === "imgDlg") $("#imgDlg").close(); });
document.addEventListener("click", (e) => { const z = e.target.closest("[data-zoom]"); if (z) openImg(z.dataset.zoom); });

function checkImage(file) {
  if (!file) return "Choose a photo first.";
  if (!OK_TYPES.includes(file.type)) return "Use a JPEG, PNG or WebP photo.";
  if (file.size > MAX_BYTES) return `That photo is ${fmtBytes(file.size)}. The limit is 10 MB.`;
  if (file.size < 100) return "That file looks empty.";
  return "";
}
async function sha256(blob) {
  const buf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** Shrink a photo to <=max px JPEG for AI calls and previews (the original file is what gets stored). */
function compress(file, max = 1280, q = 0.82) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL("image/jpeg", q);
      c.toBlob((blob) => res({ blob, dataUrl, w: c.width, h: c.height }), "image/jpeg", q);
      if (file instanceof Blob) URL.revokeObjectURL(img.src);
    };
    img.onerror = () => rej(new Error("Could not read that image."));
    img.src = file instanceof Blob ? URL.createObjectURL(file) : file;
  });
}

/* ================= hero ================= */
const hero = $(".hero");
const nav = $("#nav");
function onScroll() {
  const max = hero.offsetHeight - innerHeight;
  const p = Math.min(1, Math.max(0, scrollY / max));
  hero.style.setProperty("--p", p.toFixed(4));
  nav.classList.toggle("solid", scrollY > max * 0.62);
  $("#heroQuick").classList.toggle("off", p > 0.25);
}
addEventListener("scroll", onScroll, { passive: true });
addEventListener("resize", onScroll);
onScroll();

/* ================= offline fallbacks ================= */
function localAnalyze(text) {
  const t = text.toLowerCase();
  const rules = [
    ["Water", /water|paani|pani|tap|leak|seepage|flush|shower|drain|geyser|hot water/],
    ["Electricity", /power|light|fan|bijli|current|switch|spark|socket|\bac\b|inverter/],
    ["Wi-Fi", /wifi|wi-fi|internet|network|router/],
    ["Food", /food|khana|meal|dal|rice|lunch|dinner|breakfast|insect|keede|mess/],
    ["Hygiene", /dirty|clean|garbage|smell|cockroach|rat|mosquito|dust|toilet/],
    ["Safety", /lock|door|security|guard|cctv|unsafe|theft|stolen|fire/],
    ["Maintenance", /broken|crack|bed|chair|table|window|paint|cupboard|wardrobe/],
  ];
  const category = (rules.find(([, re]) => re.test(t)) || ["Other"])[0];
  const urgency = /spark|fire|no water|paani nahi|pani nahi|insect|keede|unsafe|theft|lock|no power|bijli nahi/.test(t) ? "High" : /wifi|wi-fi|food|khana|broken|geyser|internet|hot water/.test(t) ? "Medium" : "Low";
  const title = cap(text.split(/[.!?\n]/)[0].slice(0, 60));
  return {
    category, urgency, title, summary: text.slice(0, 140), description: cap(text.trim()), offline: true,
    draft: `Dear ${S.tenancy?.owner_name || "Sir/Madam"},\n\nI would like to report a ${category.toLowerCase()} issue in Room ${S.tenancy?.room || ""}: ${text.trim()}\n\nPlease get this fixed within 24–48 hours and let me know once it is done.\n\nThank you,\n${S.profile?.name || "Resident"}`,
  };
}
const WORDS = (s) => String(s || "").toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
function localAudit(deds) {
  return deds.map((d) => {
    const r = d.reason.toLowerCase(), rw = WORDS(r);
    const hit = S.photos.find((p) => p.locked && (r.includes(p.area) || r.includes(areaName(p.area).toLowerCase().replace(/s$/, "")) || (p.ai_tags || []).some((t) => WORDS(t).some((w) => rw.includes(w)))));
    const comp = S.complaints.find((c) => WORDS(c.title + " " + c.category).some((w) => rw.includes(w)));
    if (hit) return { id: d.id, verdict: "unfair", reason: `Your locked ${areaName(hit.area).toLowerCase()} photo from ${fmtDate(hit.captured_at)} already shows: ${(hit.ai_tags || []).join(", ") || "this area"}. Damage recorded at move-in can't be charged to you.`, matchedPhotoId: hit.id, matchedComplaintId: comp?.id || null };
    if (comp && comp.status !== "fixed") return { id: d.id, verdict: "unfair", reason: `You reported this as ${comp.ref || "a complaint"} on ${fmtDate(comp.reported_at)} and it is still unresolved, so the PG was responsible for fixing it.`, matchedComplaintId: comp.id };
    if (/clean|sanit/.test(r) && d.amount <= 2500) return { id: d.id, verdict: "fair", reason: "A modest, itemised cleaning charge is usually reasonable if it was agreed at move-in." };
    return { id: d.id, verdict: "unclear", reason: "No specific damage is identified and none of your evidence covers it. Ask the owner for an itemised bill or a photo.", matchedComplaintId: comp?.id || null };
  });
}
function evidenceLines() {
  return S.photos.filter((p) => p.locked).map((p) => `- ${areaName(p.area)} photo, locked ${fmtStamp(p.locked_at || p.captured_at)}${p.file_sha256 ? `, SHA-256 ${p.file_sha256.slice(0, 16)}…` : ""}: ${(p.ai_tags || []).join(", ") || "no defects"}`).join("\n");
}
function complaintLines() {
  return S.complaints.map((c) => `- ${c.ref || "Complaint"}: ${c.title} (reported ${fmtDate(c.reported_at)}, ${STATUS_LABEL[c.status]}${c.status === "fixed" ? "" : `, ${daysSince(c.reported_at)} days unresolved`})`).join("\n");
}
function localNotices(ctx) {
  const t = S.tenancy, name = S.profile?.name || "Tenant";
  const owner = t.owner_name || "Sir/Madam";
  const lines = ctx.disputedList.map((d) => `- ${d.reason}: ${rupee(d.amount)} (${d.ai_verdict === "unfair" ? "contradicted by my evidence" : "not itemised"})`).join("\n");
  const comps = complaintLines();
  return {
    whatsapp: `Hi ${owner}, this is ${name} from Room ${t.room}. I've checked the deductions against my move-in photos, locked on ${fmtDate(ctx.firstPhoto || t.move_in)}. ${rupee(ctx.disputed)} of the charges are for damage that was already there or isn't itemised. Please refund ${rupee(ctx.disputed)} within 7 days. Happy to share the photos and complaint references. Thanks!`,
    formal: `Subject: Request for refund of security deposit – Room ${t.room}, ${t.pg_name}\n\nDate: ${fmtDate(Date.now())}\n\nDear ${owner},\n\nI stayed in Room ${t.room} at ${t.pg_name} from ${fmtDate(t.move_in)}${t.move_out ? ` to ${fmtDate(t.move_out)}` : ""} and paid a security deposit of ${rupee(t.deposit)}.\n\nThe following deductions are disputed:\n${lines}\n\nMy move-in photos were locked with a server timestamp and a SHA-256 fingerprint:\n${evidenceLines() || "- (no locked photos)"}\n${comps ? `\nIssues I reported during my stay:\n${comps}\n` : ""}\nI request a refund of ${rupee(ctx.disputed)} within 7 days of this notice, and itemised bills for any other deduction.\n\nRegards,\n${name}`,
    grievance: `To: National Consumer Helpline (1915 / consumerhelpline.gov.in)\n\nComplainant: ${name}\nService provider: ${t.pg_name}, ${t.address || "Bengaluru"} (owner: ${owner})\n\nI paid a security deposit of ${rupee(t.deposit)} on moving in on ${fmtDate(t.move_in)}. At move-out, the PG deducted amounts for damage that my timestamped move-in photos show was pre-existing, or that it never itemised. Disputed deductions:\n${lines}\n\nEvidence: ${S.photos.filter((p) => p.locked).length} locked move-in photos${S.complaints.length ? `; complaint references ${S.complaints.map((c) => c.ref).filter(Boolean).join(", ")}` : ""}.\n\nRelief sought: refund of ${rupee(ctx.disputed)}.`,
  };
}

/* ================= demo data (fictional) ================= */
function demoData() {
  const now = Date.now(), t0 = now - 94 * DAY;
  const at = (ms) => new Date(ms).toISOString();
  const H = (s) => s.repeat(64 / s.length);
  const complaints = [
    { id: "c-wifi", ref: "FF-2026-9001", category: "Wi-Fi", urgency: "Medium", title: "Wi-Fi drops every evening", description: "2nd floor router disconnects every evening between 7 PM and 11 PM; reported on the WhatsApp group twice.", draft: "", status: "in_progress", supporters: 4, reported_at: at(now - 14 * DAY), updated_at: at(now - 10 * DAY), warden_note: "Technician booked" },
    { id: "c-water", ref: "FF-2026-9002", category: "Water", urgency: "High", title: "No hot water in Room 204 bathroom", description: "Solar geyser hot water unavailable; only a lukewarm trickle in the mornings.", draft: "", status: "open", supporters: 2, reported_at: at(now - 6 * DAY), updated_at: at(now - 6 * DAY) },
    { id: "c-food", ref: "FF-2026-9003", category: "Food", urgency: "High", title: "Insect found in lunch dal", description: "Insect found in dal served at lunch.", draft: "", status: "fixed", supporters: 1, reported_at: at(now - 30 * DAY), fixed_at: at(now - 29 * DAY), updated_at: at(now - 29 * DAY) },
  ];
  const events = [
    { id: 1, complaint_id: "c-wifi", kind: "created", to_status: "open", actor: "resident", created_at: at(now - 14 * DAY) },
    { id: 2, complaint_id: "c-wifi", kind: "response", note: "Warden on WhatsApp: router will be replaced this week.", actor: "resident", created_at: at(now - 12 * DAY) },
    { id: 3, complaint_id: "c-wifi", kind: "status", from_status: "open", to_status: "in_progress", note: "Technician booked", actor: "warden", created_at: at(now - 10 * DAY) },
    { id: 4, complaint_id: "c-water", kind: "created", to_status: "open", actor: "resident", created_at: at(now - 6 * DAY) },
    { id: 5, complaint_id: "c-food", kind: "created", to_status: "open", actor: "resident", created_at: at(now - 30 * DAY) },
    { id: 6, complaint_id: "c-food", kind: "status", from_status: "open", to_status: "fixed", note: "Mess vessels now covered", actor: "warden", created_at: at(now - 29 * DAY) },
  ];
  const photos = [
    { id: "p-wall", area: "wall", photo_url: "img/demo/wall.webp", ai_tags: ["water stain", "peeling plaster", "dark scuff mark"], ai_summary: "Pre-existing grey damp stain, a peeling plaster patch and dark scuff marks beside the switchboard.", captured_at: at(t0 + 2 * 36e5), locked: true, locked_at: at(t0 + 3 * 36e5), file_sha256: H("a3f1"), file_name: "wall.webp", file_type: "image/webp", file_bytes: 18420 },
    { id: "p-bath", area: "bathroom", photo_url: "img/demo/bathroom.webp", ai_tags: ["hard water scaling", "loose faucet", "tile stain"], ai_summary: "Hard-water calcium deposits on the wall tiles and a slightly tilted basin tap.", captured_at: at(t0 + 2 * 36e5 + 18e4), locked: true, locked_at: at(t0 + 3 * 36e5), file_sha256: H("7c2e"), file_name: "bathroom.webp", file_type: "image/webp", file_bytes: 21233 },
    { id: "p-ward", area: "furniture", photo_url: "img/demo/wardrobe.webp", ai_tags: ["loose hinge", "peeling laminate"], ai_summary: "Wardrobe top door hinge is loose and the bottom laminate edge is peeling.", captured_at: at(t0 + 2 * 36e5 + 36e4), locked: true, locked_at: at(t0 + 3 * 36e5), file_sha256: H("51bd"), file_name: "wardrobe.webp", file_type: "image/webp", file_bytes: 19876 },
  ];
  return {
    profile: { name: "Riya Sharma", phone: "+91 90000 00000", city: "Bengaluru" },
    tenancy: { id: "demo", pg_code: "SUNRISE24", pg_name: "Sunrise PG", owner_name: "Mahesh (demo owner)", owner_phone: "", address: "Koramangala, Bengaluru (fictional address)", room: "Room 204", monthly_rent: 11500, deposit: 20000, move_in: at(t0).slice(0, 10), move_out: at(now).slice(0, 10), created_at: at(t0) },
    photos,
    notes: [{ id: "n1", photo_id: "p-bath", note: "Correction: the loose tap is on the basin, not the shower.", created_at: at(t0 + 5 * DAY) }],
    complaints, events,
    deductions: [
      { id: "d1", reason: "Wall repainting for damp stain and scuff marks near switchboard", amount: 4500, ai_verdict: "unfair", ai_reason: "Your locked move-in wall photo from check-in day already shows the damp stain, peeling plaster and scuff marks beside the switchboard.", matched_photo_id: "p-wall", ai_source: "gemini", audited_at: at(now - 36e5), created_at: at(now - 36e5) },
      { id: "d2", reason: "Standard room & mattress deep cleaning at move-out", amount: 1500, ai_verdict: "fair", ai_reason: "An itemised end-of-stay cleaning fee is reasonable if it was agreed at move-in.", ai_source: "gemini", audited_at: at(now - 3e6), created_at: at(now - 3e6) },
      { id: "d3", reason: "General building & corridor maintenance surcharge", amount: 2000, ai_verdict: "unclear", ai_reason: "A vague blanket charge with no specific room damage. Ask for an itemised bill.", ai_source: "gemini", audited_at: at(now - 24e5), created_at: at(now - 24e5) },
    ],
    notices: {},
    audit: [],
  };
}
const demoPgOpen = () => [
  { id: "x1", title: "Wi-Fi drops every evening", category: "Wi-Fi", urgency: "Medium", supporters: 4 },
  { id: "x2", title: "Geyser not heating water", category: "Water", urgency: "High", supporters: 2 },
  { id: "x3", title: "Room door lock is broken", category: "Safety", urgency: "High", supporters: 1 },
];
/** Demo has no database, so its activity feed is derived from the records themselves. */
function demoAudit() {
  const a = [];
  if (S.tenancy) a.push({ action: "insert", entity: "tenancies", detail: { pg: S.tenancy.pg_name, deposit: S.tenancy.deposit }, created_at: S.tenancy.created_at || S.tenancy.move_in });
  S.photos.forEach((p) => { a.push({ action: "insert", entity: "photos", detail: { area: p.area, sha256: p.file_sha256 }, created_at: p.captured_at }); if (p.locked) a.push({ action: "lock", entity: "photos", detail: { area: p.area }, created_at: p.locked_at || p.captured_at }); });
  S.notes.forEach((n) => a.push({ action: "correction", entity: "evidence_notes", detail: { note: n.note }, created_at: n.created_at }));
  S.complaints.forEach((c) => a.push({ action: "insert", entity: "complaints", detail: { ref: c.ref, title: c.title }, created_at: c.reported_at }));
  S.events.filter((e) => e.kind === "status").forEach((e) => { const c = S.complaints.find((x) => x.id === e.complaint_id); a.push({ action: "status", entity: "complaints", detail: { ref: c?.ref, from: e.from_status, to: e.to_status }, created_at: e.created_at }); });
  S.deductions.forEach((d) => { a.push({ action: "insert", entity: "deductions", detail: { reason: d.reason, amount: d.amount }, created_at: d.created_at }); if (d.ai_verdict) a.push({ action: "audit", entity: "deductions", detail: { reason: d.reason, verdict: d.ai_verdict }, created_at: d.audited_at || d.created_at }); });
  Object.entries(S.notices).forEach(([k, n]) => a.push({ action: n.finalized_at ? "finalize" : "save", entity: "notices", detail: { kind: k }, created_at: n.finalized_at || n.updated_at }));
  return a.concat(S.audit).sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
}

/* ================= data layer (Firebase) ================= */
const live = () => S.mode === "live";
function requireFirebase() {
  if (!configured) throw new Error("Firebase isn't configured. Copy the web app config into public/config.js.");
}
const iso = (v) => (v?.toDate ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : v ?? null);
function rowFrom(snap) {
  if (!snap.exists()) return null;
  const r = { id: snap.id, ...snap.data() };
  for (const k of Object.keys(r)) if (/_at$/.test(k)) r[k] = iso(r[k]);
  return r;
}
const byDate = (k, dir = 1) => (a, b) => dir * (new Date(a[k] || 0) - new Date(b[k] || 0));
async function ownerRows(name) {
  const snap = await getDocs(query(collection(db, name), where("owner", "==", S.user.id)));
  return snap.docs.map(rowFrom);
}
const clean = (o) => JSON.parse(JSON.stringify(o ?? {}));
/** Append-only audit entry, written in the same batch as the change it describes. */
function auditOp(batch, action, entity, entity_id, detail = {}) {
  batch.set(doc(collection(db, "audit_log")), { owner: S.user.id, action, entity, entity_id: entity_id || null, detail: clean(detail), created_at: serverTimestamp() });
  S.audit.unshift({ action, entity, entity_id, detail: clean(detail), created_at: new Date().toISOString() });
}
function fbError(e) {
  const m = { "permission-denied": "That isn't allowed for your account.", unavailable: "Can't reach the server. Check your connection and try again.", "storage/unauthorized": "That file upload isn't allowed.", "storage/quota-exceeded": "Storage is full right now." };
  return new Error(m[e?.code] || e?.message || "Something went wrong.");
}

async function loadSupport() {
  const mine = S.complaints.filter((c) => c.pg_code);
  const boards = await Promise.all(mine.map((c) => getDoc(doc(db, "pgs", c.pg_code, "open", c.id)).catch(() => null)));
  boards.forEach((b, i) => { if (b?.exists()) mine[i].supporters = b.data().supporters || 1; });
}
async function loadLive() {
  const id = S.user.id;
  const [profile, tenancy, photos, notes, complaints, events, deductions, notices, auditRows] = await Promise.all([
    getDoc(doc(db, "profiles", id)), getDoc(doc(db, "tenancies", id)),
    ownerRows("photos"), ownerRows("evidence_notes"), ownerRows("complaints"), ownerRows("complaint_events"),
    ownerRows("deductions"), getDocs(collection(db, "users", id, "notices")), ownerRows("audit_log"),
  ]);
  S.profile = rowFrom(profile);
  if (!S.profile) {
    S.profile = { name: S.user.name || S.user.email.split("@")[0], phone: "" };
    await writeBatch(db).set(doc(db, "profiles", id), { name: S.profile.name, phone: "", created_at: serverTimestamp() }).commit();
  }
  S.tenancyRaw = tenancy.exists() ? tenancy.data() : null;
  S.tenancy = rowFrom(tenancy);
  S.photos = photos.sort(byDate("captured_at", -1));
  S.notes = notes.sort(byDate("created_at"));
  S.complaints = complaints.sort(byDate("reported_at", -1)).map((c) => ({ supporters: 1, ...c }));
  S.events = events.sort(byDate("created_at"));
  S.deductions = deductions.sort(byDate("created_at"));
  S.notices = Object.fromEntries(notices.docs.map((n) => [n.id, rowFrom(n)]));
  S.audit = auditRows.sort(byDate("created_at", -1)).slice(0, 300);
  await loadSupport();
}
async function refreshAudit() {
  if (!live()) return;
  try { S.audit = (await ownerRows("audit_log")).sort(byDate("created_at", -1)).slice(0, 300); } catch {}
}
async function refreshEvents() {
  if (!live()) return;
  S.events = (await ownerRows("complaint_events")).sort(byDate("created_at"));
}
async function logAction(action, detail = {}) {
  if (live()) { try { const b = writeBatch(db); auditOp(b, action, "account", null, detail); await b.commit(); } catch {} }
  else S.audit.push({ action, entity: "account", detail, created_at: new Date().toISOString() });
}
const REF_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newRef = () => `FF-${new Date().getFullYear()}-${Array.from(crypto.getRandomValues(new Uint8Array(4)), (n) => REF_CHARS[n % 32]).join("")}`;

const api = {
  async saveTenancy(t) {
    if (!live()) { S.tenancy = { ...S.tenancy, ...t }; return; }
    const r = doc(db, "tenancies", S.user.id);
    const prev = await getDoc(r);
    const b = writeBatch(db);
    b.set(r, { ...t, owner: S.user.id, created_at: prev.exists() ? prev.data().created_at : serverTimestamp(), updated_at: serverTimestamp() });
    auditOp(b, prev.exists() ? "update" : "insert", "tenancies", S.user.id, { pg: t.pg_name, room: t.room, deposit: t.deposit });
    try { await b.commit(); } catch (e) { throw fbError(e); }
    S.tenancy = rowFrom(await getDoc(r));
  },
  async addPhoto(file, area, hash) {
    const small = await compress(file);
    let ins = { tags: [], summary: "AI description unavailable right now. The photo is saved with its timestamp and fingerprint; you can describe the damage yourself before locking.", offline: true };
    try { ins = await ai("inspect", { image: small.dataUrl, area: areaName(area) }); } catch {}
    const row = {
      area, ai_tags: (ins.tags || []).map(String), ai_summary: String(ins.summary || ""), file_sha256: hash, file_name: (file.name || "photo").slice(0, 120),
      file_type: file.type, file_bytes: file.size, file_modified_at: file.lastModified ? new Date(file.lastModified).toISOString() : null,
    };
    if (!live()) { S.photos.unshift({ ...row, id: uid(), photo_url: URL.createObjectURL(file), captured_at: new Date().toISOString(), locked: false }); return !ins.offline; }
    const pr = doc(collection(db, "photos"));
    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[file.type];
    const path = `users/${S.user.id}/movein/${pr.id}`;
    const b = writeBatch(db);
    b.set(pr, { ...row, owner: S.user.id, photo_url: null, storage_path: path, storage_ext: ext, captured_at: serverTimestamp(), locked: false, locked_at: null });
    auditOp(b, "insert", "photos", pr.id, { area, sha256: hash });
    try { await b.commit(); } catch (e) { throw fbError(e); }
    try {
      await uploadBytes(ref(storage, path), file, { contentType: file.type, customMetadata: { sha256: hash } });
      const url = await getDownloadURL(ref(storage, path));
      await writeBatch(db).update(pr, { photo_url: url }).commit();
    } catch (e) {
      try { const d = writeBatch(db); d.delete(pr); await d.commit(); } catch {}
      throw new Error("Upload failed: " + fbError(e).message);
    }
    S.photos.unshift(rowFrom(await getDoc(pr)));
    return !ins.offline;
  },
  async updatePhoto(id, patch) {
    if (live()) {
      const b = writeBatch(db); b.update(doc(db, "photos", id), patch);
      auditOp(b, "review", "photos", id, { area: S.photos.find((p) => p.id === id)?.area });
      try { await b.commit(); } catch (e) { throw fbError(e); }
    }
    S.photos = S.photos.map((p) => (p.id === id ? { ...p, ...patch } : p));
  },
  async deletePhoto(id) {
    const p = S.photos.find((x) => x.id === id);
    if (live()) {
      if (p?.storage_path && p.photo_url) { try { await deleteObject(ref(storage, p.storage_path)); } catch (e) { if (e.code !== "storage/object-not-found") throw fbError(e); } }
      const b = writeBatch(db); b.delete(doc(db, "photos", id)); auditOp(b, "delete", "photos", id, { area: p?.area });
      try { await b.commit(); } catch (e) { throw fbError(e); }
    }
    S.photos = S.photos.filter((x) => x.id !== id);
  },
  async lockPhotos(ids) {
    if (live()) {
      const b = writeBatch(db);
      ids.forEach((id) => { b.update(doc(db, "photos", id), { locked: true, locked_at: serverTimestamp() }); auditOp(b, "lock", "photos", id, { area: S.photos.find((p) => p.id === id)?.area }); });
      try { await b.commit(); } catch (e) { throw fbError(e); }
      const rows = await Promise.all(ids.map((id) => getDoc(doc(db, "photos", id)).then(rowFrom)));
      rows.forEach((r) => { const i = S.photos.findIndex((p) => p.id === r.id); if (i > -1) S.photos[i] = r; });
    } else S.photos.forEach((p) => { if (ids.includes(p.id)) { p.locked = true; p.locked_at = new Date().toISOString(); } });
  },
  async addNote(photo_id, note) {
    if (!live()) { S.notes.push({ id: uid(), photo_id, note, created_at: new Date().toISOString() }); return; }
    const r = doc(collection(db, "evidence_notes"));
    const b = writeBatch(db);
    b.set(r, { owner: S.user.id, photo_id, note, created_at: serverTimestamp() });
    auditOp(b, "correction", "evidence_notes", r.id, { photo_id, note: note.slice(0, 200) });
    try { await b.commit(); } catch (e) { throw fbError(e); }
    S.notes.push(rowFrom(await getDoc(r)));
  },
  async addComplaint(c) {
    const base = { ...c, resident_name: S.profile.name, room: S.tenancy.room, pg_code: S.tenancy.pg_code || null };
    if (!live()) {
      const now = new Date().toISOString(), id = uid();
      S.complaints.unshift({ ...base, id, ref: newRef(), status: "open", supporters: 1, reported_at: now, updated_at: now });
      S.events.push({ id: uid(), complaint_id: id, kind: "created", to_status: "open", actor: "resident", created_at: now });
      return;
    }
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      const cr = doc(collection(db, "complaints")), reference = newRef();
      const b = writeBatch(db);
      b.set(cr, { ...base, owner: S.user.id, ref: reference, status: "open", warden_note: null, reported_at: serverTimestamp(), updated_at: serverTimestamp(), fixed_at: null });
      b.set(doc(db, "refs", reference), { owner: S.user.id, complaint: cr.id });
      b.set(doc(collection(db, "complaint_events")), { owner: S.user.id, complaint_id: cr.id, kind: "created", from_status: null, to_status: "open", note: null, actor: "resident", created_at: serverTimestamp() });
      if (base.pg_code) b.set(doc(db, "pgs", base.pg_code, "open", cr.id), { owner: S.user.id, title: base.title, category: base.category, urgency: base.urgency, status: "open", supporters: 1, reported_at: serverTimestamp(), updated_at: serverTimestamp() });
      auditOp(b, "insert", "complaints", cr.id, { ref: reference, title: base.title });
      try {
        await b.commit();
        S.complaints.unshift({ supporters: 1, ...rowFrom(await getDoc(cr)) });
        await refreshEvents();
        return;
      } catch (e) { lastErr = e; if (e.code !== "permission-denied") break; } // a taken ref is rejected: try a new one
    }
    throw fbError(lastErr);
  },
  async setComplaintStatus(id, status) {
    const c = S.complaints.find((x) => x.id === id);
    if (!c || c.status === status) return;
    if (!live()) {
      const now = new Date().toISOString();
      S.events.push({ id: uid(), complaint_id: id, kind: "status", from_status: c.status, to_status: status, actor: "resident", created_at: now });
      S.complaints = S.complaints.map((x) => (x.id === id ? { ...x, status, updated_at: now, fixed_at: status === "fixed" ? now : null } : x));
      return;
    }
    const b = writeBatch(db);
    b.update(doc(db, "complaints", id), { status, updated_at: serverTimestamp(), fixed_at: status === "fixed" ? serverTimestamp() : null });
    b.set(doc(collection(db, "complaint_events")), { owner: S.user.id, complaint_id: id, kind: "status", from_status: c.status, to_status: status, note: null, actor: "resident", created_at: serverTimestamp() });
    if (c.pg_code) b.update(doc(db, "pgs", c.pg_code, "open", id), { status, updated_at: serverTimestamp() });
    auditOp(b, "status", "complaints", id, { ref: c.ref, from: c.status, to: status });
    try { await b.commit(); } catch (e) { throw fbError(e); }
    const fresh = rowFrom(await getDoc(doc(db, "complaints", id)));
    S.complaints = S.complaints.map((x) => (x.id === id ? { ...x, ...fresh } : x));
    await refreshEvents();
  },
  async addEvent(complaint_id, kind, note) {
    if (!live()) { S.events.push({ id: uid(), complaint_id, kind, note, actor: "resident", created_at: new Date().toISOString() }); return; }
    const b = writeBatch(db);
    b.set(doc(collection(db, "complaint_events")), { owner: S.user.id, complaint_id, kind, from_status: null, to_status: null, note, actor: "resident", created_at: serverTimestamp() });
    try { await b.commit(); } catch (e) { throw fbError(e); }
    await refreshEvents();
  },
  async pgOpen() {
    if (!live()) return demoPgOpen();
    const code = S.tenancy?.pg_code;
    if (!code) return [];
    const snap = await getDocs(query(collection(db, "pgs", code, "open"), where("status", "in", ["open", "in_progress"])));
    return snap.docs.map(rowFrom).filter((x) => x.owner !== S.user.id).sort((a, b) => b.supporters - a.supporters);
  },
  async support(id) {
    if (!live()) return 0;
    const code = S.tenancy.pg_code, br = doc(db, "pgs", code, "open", id);
    const b = writeBatch(db);
    b.set(doc(db, "pgs", code, "open", id, "supporters", S.user.id), { at: serverTimestamp() });
    b.update(br, { supporters: increment(1) });
    try { await b.commit(); } catch (e) { throw e.code === "permission-denied" ? new Error("You've already added your voice to this one.") : fbError(e); }
    return (await getDoc(br)).data().supporters;
  },
  async addDeduction(d) {
    if (!live()) { const r = { ...d, id: uid(), created_at: new Date().toISOString() }; S.deductions.push(r); return r; }
    const r = doc(collection(db, "deductions"));
    const b = writeBatch(db);
    b.set(r, { ...d, owner: S.user.id, ai_verdict: null, ai_reason: null, matched_photo_id: null, matched_complaint_id: null, tenant_position: null, audited_at: null, ai_source: null, created_at: serverTimestamp() });
    auditOp(b, "insert", "deductions", r.id, { reason: d.reason, amount: d.amount });
    try { await b.commit(); } catch (e) { throw fbError(e); }
    const row = rowFrom(await getDoc(r)); S.deductions.push(row); return row;
  },
  async updateDeduction(id, patch) {
    const d = S.deductions.find((x) => x.id === id);
    if (live()) {
      const b = writeBatch(db); b.update(doc(db, "deductions", id), patch);
      auditOp(b, "tenant_position" in patch ? "position" : "audit", "deductions", id, { reason: d?.reason, verdict: patch.ai_verdict ?? d?.ai_verdict, position: patch.tenant_position ?? null });
      try { await b.commit(); } catch (e) { throw fbError(e); }
    }
    S.deductions = S.deductions.map((x) => (x.id === id ? { ...x, ...patch } : x));
  },
  async deleteDeduction(id) {
    const d = S.deductions.find((x) => x.id === id);
    if (live()) {
      const b = writeBatch(db); b.delete(doc(db, "deductions", id)); auditOp(b, "delete", "deductions", id, { reason: d?.reason, amount: d?.amount });
      try { await b.commit(); } catch (e) { throw fbError(e); }
    }
    S.deductions = S.deductions.filter((x) => x.id !== id);
  },
  async saveNotices(obj) {
    const now = new Date().toISOString();
    if (!live()) { Object.entries(obj).forEach(([kind, body]) => (S.notices[kind] = { kind, body, updated_at: now, finalized_at: null })); return; }
    const b = writeBatch(db);
    Object.entries(obj).forEach(([kind, body]) => { b.set(doc(db, "users", S.user.id, "notices", kind), { owner: S.user.id, kind, body, updated_at: serverTimestamp(), finalized_at: null }); auditOp(b, "save", "notices", kind, { kind }); });
    try { await b.commit(); } catch (e) { throw fbError(e); }
    await Promise.all(Object.keys(obj).map(async (k) => (S.notices[k] = rowFrom(await getDoc(doc(db, "users", S.user.id, "notices", k))))));
  },
  async finalizeNotice(kind, on) {
    if (!live()) { S.notices[kind] = { ...S.notices[kind], finalized_at: on ? new Date().toISOString() : null }; return; }
    const r = doc(db, "users", S.user.id, "notices", kind);
    const b = writeBatch(db);
    b.set(r, { owner: S.user.id, kind, body: S.notices[kind].body, updated_at: serverTimestamp(), finalized_at: on ? serverTimestamp() : null });
    auditOp(b, on ? "finalize" : "save", "notices", kind, { kind });
    try { await b.commit(); } catch (e) { throw fbError(e); }
    S.notices[kind] = rowFrom(await getDoc(r));
  },
};
const nBody = (k) => S.notices[k]?.body || "";

/* ================= views / routing ================= */
function showView() {
  const inApp = !!S.mode;
  $("#authView").hidden = inApp;
  $("#appView").hidden = !inApp;
  $("#demoBar").hidden = S.mode !== "demo";
  $("#navCta").textContent = S.mode === "live" ? "My dashboard" : S.mode === "demo" ? "Sign up free" : "Get started";
  $("#signOutBtn").textContent = S.mode === "demo" ? "Exit demo" : "Log out";
  if (inApp) {
    if (!S.tenancy) return go("setup");
    go(S.screen === "setup" ? "dashboard" : S.screen);
  }
}
const RENDER = {};
function go(screen) {
  if (screen !== "setup" && screen !== "account" && !S.tenancy) screen = "setup";
  S.screen = screen;
  const noPg = !S.tenancy;
  $$(".nav-item").forEach((b) => { b.classList.toggle("active", b.dataset.screen === screen); b.disabled = noPg; b.setAttribute("aria-current", b.dataset.screen === screen ? "page" : "false"); });
  $$(".screen").forEach((s) => s.classList.toggle("active", s.id === `s-${screen}`));
  $("#sidePg").textContent = S.tenancy?.pg_name || "Your PG";
  $("#sideRoom").textContent = S.tenancy ? `${S.tenancy.room} · ${rupee(S.tenancy.deposit)} deposit` : "Add your PG to start";
  RENDER[screen]?.();
}
$$(".nav-item").forEach((b) => b.addEventListener("click", () => { go(b.dataset.screen); $("#app").scrollIntoView({ behavior: "smooth" }); }));
document.addEventListener("click", (e) => { const j = e.target.closest("[data-jump]"); if (j && S.mode) { go(j.dataset.jump); $("#app").scrollIntoView({ behavior: "smooth" }); } });

document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-go]");
  if (!a) return;
  e.preventDefault();
  if (a.dataset.go === "demo") { if (S.mode !== "live") startDemo(); }
  else if (S.mode === "demo") { exitDemo(); setAuthMode("signup"); }
  showView();
  $("#app").scrollIntoView({ behavior: "smooth" });
});

function startDemo() {
  Object.assign(S, { mode: "demo", user: null, screen: "dashboard", analysis: null }, demoData());
  sessionStorage.setItem("ff_demo", "1");
  showView();
  toast("Demo loaded: fictional record for Room 204");
}
function exitDemo() {
  sessionStorage.removeItem("ff_demo");
  Object.assign(S, { mode: null, profile: null, tenancy: null, photos: [], notes: [], complaints: [], events: [], deductions: [], notices: {}, audit: [], screen: "dashboard", review: null });
}
$("#signOutBtn").addEventListener("click", async () => {
  if (S.mode === "demo") { exitDemo(); showView(); return; }
  await signOut(auth);
});
$("#editPgBtn").addEventListener("click", () => go("setup"));

/* ================= auth ================= */
let authMode = "signup";
function setAuthMode(m) {
  authMode = m;
  $("#authView").classList.toggle("login", m === "login");
  $$(".seg-btn").forEach((b) => { b.classList.toggle("active", b.dataset.auth === m); b.setAttribute("aria-selected", b.dataset.auth === m); });
  $("#aSubmit").textContent = m === "signup" ? "Create account & continue" : "Log in";
  $("#aPass").autocomplete = m === "signup" ? "new-password" : "current-password";
  $("#aErr").textContent = "";
}
$$(".seg-btn").forEach((b) => b.addEventListener("click", () => setAuthMode(b.dataset.auth)));
const AUTH_MSG = {
  "auth/email-already-in-use": "This email already has an account. Log in instead.",
  "auth/invalid-credential": "Wrong email or password.",
  "auth/invalid-login-credentials": "Wrong email or password.",
  "auth/user-not-found": "Wrong email or password.",
  "auth/wrong-password": "Wrong email or password.",
  "auth/weak-password": "Password needs at least 6 characters.",
  "auth/invalid-email": "Enter a valid email.",
  "auth/network-request-failed": "Can't reach the server. Check your connection and try again.",
  "auth/too-many-requests": "Too many attempts. Wait a minute and try again.",
  "auth/popup-blocked": "Your browser blocked the Google sign-in window. Allow pop-ups and try again.",
  "auth/popup-closed-by-user": "Google sign-in was cancelled.",
  "auth/cancelled-popup-request": "Google sign-in was cancelled.",
  "auth/unauthorized-domain": "This site isn't authorised for sign-in yet. Use the demo for now.",
  "auth/operation-not-allowed": "This sign-in method isn't switched on yet. Try the demo for now.",
  "auth/configuration-not-found": "Sign-in isn't set up for this site yet. Try the demo for now.",
};
$("#googleBtn").addEventListener("click", async () => {
  const btn = $("#googleBtn");
  busy(btn, true, "Opening Google…");
  $("#aErr").textContent = "";
  try {
    requireFirebase();
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await signInWithPopup(auth, provider);
  } catch (e) { $("#aErr").textContent = AUTH_MSG[e.code] || e.message || "Unable to start Google sign-in."; }
  finally { busy(btn, false); }
});
$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#aEmail").value.trim(), password = $("#aPass").value, name = $("#aName").value.trim(), phone = $("#aPhone").value.trim();
  const err = (m) => ($("#aErr").textContent = m);
  if (authMode === "signup" && name.length < 2) return err("Enter your full name.");
  if (!/^\S+@\S+\.\S+$/.test(email)) return err("Enter a valid email.");
  if (password.length < 6) return err("Password needs at least 6 characters.");
  const btn = $("#aSubmit");
  busy(btn, true, authMode === "signup" ? "Creating account…" : "Logging in…");
  try {
    requireFirebase();
    if (authMode === "signup") {
      pendingProfile = { name, phone };
      const { user } = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(user, { displayName: name });
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (ex) { pendingProfile = null; err(AUTH_MSG[ex.code] || ex.message || "Authentication failed."); }
  finally { busy(btn, false); }
});
let pendingProfile = null;

async function loadWithState() {
  $("#loadState").hidden = false; $("#errState").hidden = true;
  $$(".screen").forEach((s) => s.classList.remove("active"));
  try { await loadLive(); $("#loadState").hidden = true; return true; }
  catch (e) { $("#loadState").hidden = true; $("#errMsg").textContent = fbError(e).message; $("#errState").hidden = false; return false; }
}
$("#retryBtn").addEventListener("click", async () => { if (await loadWithState()) showView(); });

async function onSession(user) {
  if (user) {
    sessionStorage.removeItem("ff_demo");
    if (S.mode === "demo") exitDemo();
    S.mode = "live";
    S.user = { id: user.uid, email: user.email || "", name: user.displayName || pendingProfile?.name || "", created_at: user.metadata?.creationTime || null };
    if (pendingProfile) {
      try { await writeBatch(db).set(doc(db, "profiles", user.uid), { name: pendingProfile.name, phone: pendingProfile.phone || "", created_at: serverTimestamp() }).commit(); } catch {}
      pendingProfile = null;
    }
    $("#authView").hidden = true; $("#appView").hidden = false;
    if (!(await loadWithState())) { $("#demoBar").hidden = true; return; }
  } else if (S.mode === "live") {
    exitDemo(); S.user = null;
  } else if (sessionStorage.getItem("ff_demo") && !S.mode) {
    return startDemo();
  }
  showView();
}
let authReady = false;
if (auth) onAuthStateChanged(auth, (user) => {
  if (user && S.mode === "live" && S.user?.id === user.uid) return;
  const first = !authReady;
  authReady = true;
  onSession(user).then(() => { if (user && !first) toast(`Welcome${S.profile?.name ? ", " + S.profile.name.split(" ")[0] : ""}!`); }).catch((e) => toast(fbError(e).message, true));
});
else setTimeout(() => onSession(null), 0);

/* ================= setup ================= */
RENDER.setup = function renderSetup() {
  const t = S.tenancy;
  $("#setupTitle").textContent = t ? "Edit PG details" : "Add your PG";
  $("#pgSave").textContent = t ? "Save PG details" : "Save PG & start move-in scan";
  $("#pgCancel").hidden = !t;
  $("#fPg").value = t?.pg_name || ""; $("#fRoom").value = t?.room || ""; $("#fOwner").value = t?.owner_name || "";
  $("#fOwnerPhone").value = t?.owner_phone || ""; $("#fAddr").value = t?.address || ""; $("#fRent").value = t?.monthly_rent || "";
  $("#fDep").value = t?.deposit || ""; $("#fIn").value = t?.move_in || ""; $("#fOut").value = t?.move_out || ""; $("#fCode").value = t?.pg_code || "";
  $("#pgErr").textContent = "";
};
$("#pgCancel").addEventListener("click", () => go("dashboard"));
$("#pgForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = (m) => ($("#pgErr").textContent = m);
  const t = {
    pg_name: $("#fPg").value.trim(), room: $("#fRoom").value.trim(), owner_name: $("#fOwner").value.trim() || null,
    owner_phone: $("#fOwnerPhone").value.trim() || null, address: $("#fAddr").value.trim() || null,
    monthly_rent: Number($("#fRent").value), deposit: Number($("#fDep").value),
    move_in: $("#fIn").value, move_out: $("#fOut").value || null, pg_code: $("#fCode").value.trim().toUpperCase() || null,
  };
  if (t.pg_name.length < 2) return err("Enter your PG name.");
  if (!t.room) return err("Enter your room or bed number.");
  if (!(t.monthly_rent > 0 && t.monthly_rent < 1e6)) return err("Enter a valid monthly rent.");
  if (!(t.deposit > 0 && t.deposit < 5e6)) return err("Enter the security deposit you paid.");
  if (!t.move_in) return err("Pick your move-in date.");
  if (t.move_out && t.move_out < t.move_in) return err("Move-out can't be before move-in.");
  const btn = $("#pgSave");
  busy(btn, true, "Saving…");
  try {
    if (t.pg_code && live() && !(await getDoc(doc(db, "pgs", t.pg_code))).exists()) {
      busy(btn, false); return err("That PG code isn't registered. Leave it empty, or use the demo code SUNRISE24.");
    }
    const first = !S.tenancy;
    await api.saveTenancy(t);
    toast(first ? "PG added! Let's scan your room." : "PG details updated.");
    go(first ? "scan" : "dashboard");
  } catch (ex) { err(ex.message); }
  finally { busy(btn, false); }
});

/* ================= numbers ================= */
function position(d) {
  if (d.tenant_position === "dispute") return "dispute";
  if (d.tenant_position === "accept") return "accept";
  if (d.ai_verdict === "fair") return "accept";
  if (d.ai_verdict === "unfair" || d.ai_verdict === "unclear") return "dispute";
  return "pending";
}
function money() {
  const ds = S.deductions;
  const sum = (f) => ds.filter(f).reduce((s, d) => s + d.amount, 0);
  const total = sum(() => true);
  const disputed = sum((d) => position(d) === "dispute"), accepted = sum((d) => position(d) === "accept"), pending = sum((d) => position(d) === "pending");
  const deposit = S.tenancy?.deposit || 0;
  return { total, disputed, accepted, pending, unfair: sum((d) => d.ai_verdict === "unfair"), refund: Math.max(0, deposit - accepted - pending), deposit };
}
function lastUpdated() {
  const ts = [S.tenancy?.created_at, ...S.photos.map((p) => p.locked_at || p.captured_at), ...S.notes.map((n) => n.created_at), ...S.complaints.map((c) => c.updated_at || c.reported_at),
    ...S.events.map((e) => e.created_at), ...S.deductions.map((d) => d.audited_at || d.created_at), ...Object.values(S.notices).map((n) => n.updated_at), ...(S.audit || []).map((a) => a.created_at)].filter(Boolean);
  return ts.length ? ts.reduce((a, b) => (new Date(a) > new Date(b) ? a : b)) : null;
}

/* ================= audit trail text ================= */
function describe(a) {
  const d = a.detail || {};
  const NK = { whatsapp: "WhatsApp", formal: "formal notice", grievance: "consumer helpline" };
  switch (a.entity) {
    case "photos": return { insert: `Added ${areaName(d.area)} photo${d.sha256 ? ` · SHA-256 ${shortHash(d.sha256)}` : ""}`, lock: `Locked ${areaName(d.area)} photo (read-only)`, review: `Edited AI description of ${areaName(d.area)} photo before lock`, delete: `Removed unlocked ${areaName(d.area)} photo` }[a.action] || `Photo ${a.action}`;
    case "evidence_notes": return `Added a dated correction: “${d.note || ""}”`;
    case "complaints": return { insert: `Logged complaint ${d.ref || ""} · ${d.title || ""}`, status: `${d.ref || "Complaint"}: ${STATUS_LABEL[d.from] || d.from} → ${STATUS_LABEL[d.to] || d.to}`, warden_note: `Warden added a note to ${d.ref || "a complaint"}`, edit: `Edited ${d.ref || "a complaint"}`, delete: `Deleted ${d.ref || "a complaint"}` }[a.action] || `Complaint ${a.action}`;
    case "deductions": return { insert: `Added deduction: ${d.reason} (${rupee(d.amount)})`, audit: `Audited “${d.reason}” → ${d.verdict || "pending"}`, position: `You chose to ${d.position || "reset"}: ${d.reason}`, delete: `Removed deduction: ${d.reason}` }[a.action] || `Deduction ${a.action}`;
    case "notices": return a.action === "finalize" ? `Marked ${NK[d.kind] || d.kind} final` : `Saved ${NK[d.kind] || d.kind} draft`;
    case "tenancies": return `Saved PG details${d.deposit ? ` (deposit ${rupee(d.deposit)})` : ""}`;
    case "account": return { evidence_report: "Downloaded the evidence report", notice_pdf: "Downloaded a notice PDF", data_export: "Exported your data" }[a.action] || a.action;
    default: return `${a.entity} ${a.action}`;
  }
}
const auditEntries = () => (live() ? S.audit : demoAudit());
const auditHtml = (list) => list.length ? list.map((a) => `<li><time>${fmtStamp(a.created_at)}</time><span>${esc(describe(a))}</span></li>`).join("") : `<li class="none">Nothing recorded yet.</li>`;

/* ================= PG details (dashboard) ================= */
RENDER.dashboard = function renderDashboard() {
  const t = S.tenancy, m = money();
  const open = S.complaints.filter((c) => c.status !== "fixed");
  const locked = S.photos.filter((p) => p.locked);
  $("#hello").textContent = `Hi ${S.profile?.name?.split(" ")[0] || "there"}, here's your stay at ${t.pg_name}`;
  const lu = lastUpdated();
  $("#dUpdated").textContent = lu ? `Last updated ${fmtStamp(lu)}` : "";
  $("#dDeposit").textContent = rupee(t.deposit);
  const months = t.monthly_rent ? t.deposit / t.monthly_rent : 0;
  $("#dDepositSub").textContent = `${months ? months.toFixed(1).replace(/\.0$/, "") + "× monthly rent · " : ""}paid at move-in`;
  const stayed = daysSince(t.move_in, t.move_out || Date.now());
  $("#dFacts").innerHTML = [
    ["Monthly rent", rupee(t.monthly_rent)], ["Moved in", fmtDate(t.move_in)], [t.move_out ? "Moved out" : "Status", t.move_out ? fmtDate(t.move_out) : "Staying"], ["Days stayed", stayed],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
  $("#dProtected").textContent = rupee(m.unfair);
  $("#dProtectedSub").textContent = S.deductions.length ? `${S.deductions.filter((d) => d.ai_verdict === "unfair").length} unsupported deduction(s) found` : "No move-out deductions logged";
  $("#dOpen").textContent = open.length;
  const longest = open.reduce((mx, c) => Math.max(mx, daysSince(c.reported_at)), 0);
  $("#dOpenSub").textContent = open.length ? `Longest unresolved: ${plural(longest, "day")}` : "All logged issues resolved";
  $("#dPhotos").textContent = `${locked.length} locked`;
  const covered = new Set(locked.map((p) => AREA_GROUP[p.area]).filter(Boolean));
  $("#dPhotosSub").textContent = `${covered.size} of ${AREAS.length} areas · ${S.photos.length - locked.length} pending`;
  $("#dRefund").textContent = S.deductions.length ? rupee(m.refund) : rupee(t.deposit);
  $("#dRefundSub").textContent = S.deductions.length ? `${rupee(m.disputed)} disputed` : "No deductions yet";
  const phone = (t.owner_phone || "").replace(/\D/g, "");
  $("#dPg").innerHTML = [
    ["PG", t.pg_name], ["Room", t.room], ["Address", t.address || "–"], ["Owner / warden", t.owner_name || "–"],
    ["Owner phone", t.owner_phone ? `<a href="https://wa.me/${phone}" target="_blank" rel="noopener noreferrer">${esc(t.owner_phone)}</a>` : "–", true],
    ["PG code", t.pg_code ? `${esc(t.pg_code)} · linked to warden dashboard` : "Not linked", true],
  ].map(([k, v, raw]) => `<div><dt>${k}</dt><dd>${raw ? v : esc(v)}</dd></div>`).join("");
  const steps = [
    ["Add your PG details", true, null],
    ["Scan & lock move-in photos (all 4 areas)", covered.size >= 4, "scan"],
    ["Log issues as they happen", S.complaints.length > 0, "complaints"],
    ["Add deductions at move-out", S.deductions.length > 0, "claim"],
    ["Review & finalise your notice", Object.values(S.notices).some((n) => n.finalized_at), "notices"],
  ];
  $("#dSteps").innerHTML = steps.map(([label, done, scr]) => `<li class="${done ? "done" : ""}"><span>${esc(label)}</span>${!done && scr ? `<button class="btn small ghost" data-jump="${scr}">Start</button>` : ""}</li>`).join("");
  $("#dIssues").innerHTML = open.length
    ? [...open].sort((a, b) => new Date(a.reported_at) - new Date(b.reported_at)).slice(0, 4).map((c) => `<div class="mini"><span><code>${esc(c.ref || "")}</code> ${esc(c.title)}</span><b>${daysSince(c.reported_at)}d</b></div>`).join("")
    : `<div class="empty-list">Nothing open. Nice.</div>`;
  const paint = () => ($("#dActivity").innerHTML = auditHtml(auditEntries().slice(0, 5)));
  paint();
  if (live()) refreshAudit().then(() => S.screen === "dashboard" && paint());
};

/* ================= move-in scan ================= */
RENDER.scan = function renderScan() {
  const counts = Object.fromEntries(AREAS.map(([a]) => [a, S.photos.filter((p) => AREA_GROUP[p.area] === a).length]));
  $("#areaPick").innerHTML = AREAS.map(([a, l]) => `<button type="button" class="area ${a === S.area ? "active" : ""}" data-area="${a}" aria-pressed="${a === S.area}">${l}${counts[a] ? `<span class="n">${counts[a]}</span>` : ""}</button>`).join("");
  $("#dropText").textContent = `Capture or upload a ${areaName(S.area).toLowerCase()} photo`;
  const pending = S.photos.filter((p) => !p.locked);
  const lb = $("#lockBtn");
  lb.disabled = !pending.length;
  lb.textContent = pending.length ? `Lock move-in record (${pending.length})` : S.photos.length ? "All photos locked" : "Lock move-in record";
  $("#reportBtn").disabled = !S.photos.length;
  $("#photoGrid").innerHTML = S.photos.length ? S.photos.map((p) => {
    const notes = S.notes.filter((n) => n.photo_id === p.id);
    return `
    <article class="photo" data-id="${p.id}">
      <img src="${esc(p.photo_url)}" alt="${esc(areaName(p.area))} move-in photo" data-zoom="${esc(p.photo_url)}" loading="lazy" />
      <div class="pb">
        <h5>${esc(areaName(p.area))} ${p.locked ? `<span class="badge lock">🔒 Locked</span>` : `<span class="badge ghost">Pending review</span>`}</h5>
        <div class="tags">${(p.ai_tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("") || `<span class="stamp">No defects tagged</span>`}</div>
        ${p.locked ? `<p>${esc(p.ai_summary)}</p>` : `<label class="lbl" for="sum-${p.id}">Description (edit before locking)</label><textarea id="sum-${p.id}" rows="3" data-sum="${p.id}">${esc(p.ai_summary)}</textarea><button type="button" class="btn small ghost" data-sumsave="${p.id}">Save description</button>`}
        <dl class="kv small">
          <div><dt>Uploaded</dt><dd>${fmtStamp(p.captured_at)}</dd></div>
          ${p.locked_at ? `<div><dt>Locked</dt><dd>${fmtStamp(p.locked_at)}</dd></div>` : ""}
          <div><dt>SHA-256</dt><dd><code class="hash" title="${esc(p.file_sha256 || "")}">${esc(shortHash(p.file_sha256))}</code></dd></div>
          ${p.file_bytes ? `<div><dt>File</dt><dd>${esc((p.file_type || "").replace("image/", "").toUpperCase())} · ${fmtBytes(p.file_bytes)}</dd></div>` : ""}
        </dl>
        ${notes.length ? `<ul class="corrections">${notes.map((n) => `<li><time>${fmtStamp(n.created_at)}</time> ${esc(n.note)}</li>`).join("")}</ul>` : ""}
        ${p.locked ? `<details class="add-note"><summary>Add a correction</summary><textarea rows="2" data-note="${p.id}" placeholder="What should be corrected? The original stays unchanged."></textarea><button type="button" class="btn small ghost" data-notesave="${p.id}">Save dated correction</button></details>`
          : `<button type="button" class="link" data-del="${p.id}">Remove before lock</button>`}
      </div>
    </article>`;
  }).join("") : `<div class="empty-list" style="grid-column:1/-1">No photos yet. Start with the walls: stains and cracks are the most common deduction.</div>`;
  renderEvHistory();
};
function renderEvHistory(fetch = true) {
  const list = auditEntries().filter((a) => a.entity === "photos" || a.entity === "evidence_notes" || a.action === "evidence_report");
  $("#evHistory").innerHTML = auditHtml(list.slice(0, 12));
  if (fetch && live()) refreshAudit().then(() => S.screen === "scan" && renderEvHistory(false));
}
$("#areaPick").addEventListener("click", (e) => { const b = e.target.closest("[data-area]"); if (b) { S.area = b.dataset.area; RENDER.scan(); } });
async function handlePhoto(file) {
  if (!file) return;
  $("#scanErr").textContent = "";
  const bad = checkImage(file);
  if (bad) { $("#photoInput").value = ""; return ($("#scanErr").textContent = bad); }
  try {
    const hash = await sha256(file);
    if (S.photos.some((p) => p.file_sha256 === hash)) { $("#photoInput").value = ""; return ($("#scanErr").textContent = "This exact photo is already in your record."); }
    if (S.review?.url) URL.revokeObjectURL(S.review.url);
    S.review = { file, hash, url: URL.createObjectURL(file) };
    $("#rvImg").src = S.review.url;
    $("#rvMeta").innerHTML = [["File", file.name || "photo"], ["Type", file.type.replace("image/", "").toUpperCase()], ["Size", fmtBytes(file.size)],
      ["Last modified", file.lastModified ? fmtStamp(file.lastModified) : "–"], ["SHA-256", `<code class="hash">${hash}</code>`]]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${k === "SHA-256" ? v : esc(v)}</dd></div>`).join("");
    $("#rvArea").innerHTML = AREAS.map(([a, l]) => `<option value="${a}" ${a === S.area ? "selected" : ""}>${l}</option>`).join("");
    $("#scanReview").hidden = false;
    $("#scanReview").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (ex) { $("#scanErr").textContent = "Couldn't read that file: " + ex.message; }
}
function closeReview() {
  if (S.review?.url) URL.revokeObjectURL(S.review.url);
  S.review = null; $("#scanReview").hidden = true; $("#photoInput").value = "";
}
$("#rvCancel").addEventListener("click", closeReview);
$("#rvSave").addEventListener("click", async () => {
  if (!S.review) return;
  const btn = $("#rvSave"), area = $("#rvArea").value;
  busy(btn, true, "Uploading & analysing…");
  $("#drop").classList.add("busy");
  try {
    const usedAi = await api.addPhoto(S.review.file, area, S.review.hash);
    S.area = area;
    toast(usedAi ? "Photo saved. Gemini described the damage; review it, then lock." : "Photo saved. AI is unavailable, so add a description yourself.", !usedAi);
    closeReview();
  } catch (ex) { $("#scanErr").textContent = ex.message || "Upload failed. Try again."; }
  finally { busy(btn, false); $("#drop").classList.remove("busy"); RENDER.scan(); }
});
$("#photoInput").addEventListener("change", (e) => handlePhoto(e.target.files[0]));
const drop = $("#drop");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => handlePhoto(e.dataTransfer.files[0]));
$("#photoGrid").addEventListener("click", async (e) => {
  const d = e.target.closest("[data-del]"), s = e.target.closest("[data-sumsave]"), n = e.target.closest("[data-notesave]");
  try {
    if (d) { busy(d, true, "Removing…"); await api.deletePhoto(d.dataset.del); toast("Photo removed."); RENDER.scan(); }
    if (s) {
      const v = $(`[data-sum="${s.dataset.sumsave}"]`).value.trim();
      if (v.length < 3) return toast("Add a short description.", true);
      busy(s, true, "Saving…"); await api.updatePhoto(s.dataset.sumsave, { ai_summary: v }); toast("Description saved."); RENDER.scan();
    }
    if (n) {
      const v = $(`[data-note="${n.dataset.notesave}"]`).value.trim();
      if (v.length < 3) return toast("Write the correction first.", true);
      busy(n, true, "Saving…"); await api.addNote(n.dataset.notesave, v); toast("Correction added as a new dated entry."); RENDER.scan();
    }
  } catch (ex) { toast(ex.message, true); RENDER.scan(); }
});
$("#lockBtn").addEventListener("click", () => {
  const pending = S.photos.filter((p) => !p.locked);
  const covered = new Set(S.photos.map((p) => AREA_GROUP[p.area]));
  const missing = AREAS.filter(([a]) => !covered.has(a)).map(([, l]) => l);
  $("#lockText").textContent = `Locking stamps the server time on ${plural(pending.length, "photo")} and makes them permanently read-only: no edits or deletion, even by you. Corrections can still be added as dated notes.${missing.length ? ` Not yet covered: ${missing.join(", ")}.` : ""}`;
  $("#lockList").innerHTML = pending.map((p) => `<li><b>${esc(areaName(p.area))}</b> · ${esc((p.ai_tags || []).join(", ") || "no defects tagged")} · <code>${esc(shortHash(p.file_sha256))}</code></li>`).join("");
  $("#lockAgree").checked = false; $("#lockConfirm").disabled = true;
  $("#lockDlg").showModal();
});
$("#lockAgree").addEventListener("change", (e) => ($("#lockConfirm").disabled = !e.target.checked));
$("#lockCancel").addEventListener("click", () => $("#lockDlg").close());
$("#lockConfirm").addEventListener("click", async () => {
  const btn = $("#lockConfirm");
  busy(btn, true, "Locking…");
  try { await api.lockPhotos(S.photos.filter((p) => !p.locked).map((p) => p.id)); toast("Move-in record locked with a server timestamp."); }
  catch (ex) { toast(ex.message, true); }
  finally { busy(btn, false); $("#lockDlg").close(); await refreshAudit(); RENDER.scan(); }
});

/* ================= PDF helpers ================= */
async function newPdf() {
  const { jsPDF } = await import("https://esm.sh/jspdf@2.5.1");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const clean = (s) => String(s ?? "").replace(/₹/g, "Rs ").replace(/[–—]/g, "-").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/→/g, "->").replace(/…/g, "...").replace(/·/g, "|").replace(/[^\x00-\xFF]/g, "");
  const P = { doc, y: 56, W: 515 };
  P.room = (h) => { if (P.y + h > 790) { doc.addPage(); P.y = 56; } };
  P.line = (txt, size = 10.5, bold = false, gap = 6, font = "helvetica") => {
    doc.setFont(font, bold ? "bold" : "normal"); doc.setFontSize(size);
    for (const l of doc.splitTextToSize(clean(txt), P.W)) { P.room(size * 1.4); doc.text(l, 40, P.y); P.y += size * 1.35; }
    P.y += gap;
  };
  P.rule = () => { P.room(12); doc.setDrawColor(220); doc.line(40, P.y, 555, P.y); P.y += 12; };
  P.image = async (src, maxW = 240, maxH = 170) => {
    try {
      const { dataUrl, w, h } = await compress(src, 900, 0.8);
      const k = Math.min(maxW / w, maxH / h);
      P.room(h * k + 8); doc.addImage(dataUrl, "JPEG", 40, P.y, w * k, h * k); P.y += h * k + 8;
    } catch { P.line("(image could not be embedded; see the photo link)", 8.5); }
  };
  P.header = (title) => {
    if (S.mode === "demo") { doc.setTextColor(200, 60, 40); P.line("DEMO - FICTIONAL DATA - NOT A REAL RECORD", 9, true, 4); doc.setTextColor(0); }
    P.line(title, 18, true, 4);
    P.line(`Generated ${fmtStamp(Date.now())} by FixFlow`, 9, false, 12);
    const t = S.tenancy;
    P.line(`${S.profile?.name || "Tenant"} | ${t.room}, ${t.pg_name}${t.address ? ", " + t.address : ""}`, 11, true);
    P.line(`Deposit ${rupee(t.deposit)} | Rent ${rupee(t.monthly_rent)}/month | Move-in ${fmtDate(t.move_in)}${t.move_out ? " | Move-out " + fmtDate(t.move_out) : ""}`, 10, false, 10);
  };
  P.evidence = (withSummary = true) => {
    const locked = S.photos.filter((p) => p.locked);
    if (!locked.length) return P.line("No locked move-in photos.", 10);
    locked.forEach((p) => P.line(`- ${areaName(p.area)} | uploaded ${fmtStamp(p.captured_at)} | locked ${fmtStamp(p.locked_at || p.captured_at)} | SHA-256 ${p.file_sha256 || "not recorded"}${withSummary ? ` | ${(p.ai_tags || []).join(", ") || "no defects"}` : ""}`, 9, false, 2));
  };
  P.complaints = () => {
    if (!S.complaints.length) return P.line("No complaints logged.", 10);
    S.complaints.forEach((c) => P.line(`- ${c.ref || "-"} | ${c.title} | reported ${fmtDate(c.reported_at)} | ${STATUS_LABEL[c.status]} | last updated ${fmtStamp(c.updated_at || c.reported_at)}`, 9, false, 2));
  };
  P.deductions = () => {
    if (!S.deductions.length) return P.line("No deductions entered.", 10);
    S.deductions.forEach((d) => P.line(`- ${d.reason} | ${rupee(d.amount)} | AI finding: ${(d.ai_verdict || "not audited").toUpperCase()} | your position: ${position(d)}${d.ai_reason ? ` | ${d.ai_reason}` : ""}`, 9, false, 2));
    const m = money();
    P.line(`Deducted ${rupee(m.total)} | Disputed ${rupee(m.disputed)} | Refund due ${rupee(m.refund)}`, 10.5, true, 8);
  };
  return P;
}

$("#reportBtn").addEventListener("click", async () => {
  const btn = $("#reportBtn");
  busy(btn, true, "Building report…");
  try {
    const P = await newPdf();
    P.header("Move-in evidence report");
    P.line("How to verify: download the original photo from FixFlow and compute its SHA-256 (for example `sha256sum photo.jpg` or `certutil -hashfile photo.jpg SHA256`). It must match the fingerprint below. Upload and lock times are set by the database server, not by the phone.", 9, false, 10);
    P.rule();
    for (const p of S.photos) {
      P.line(`${areaName(p.area)} - ${p.locked ? "LOCKED (read-only)" : "PENDING (not locked yet)"}`, 12, true, 2);
      P.line(`Uploaded (server time): ${fmtStamp(p.captured_at)}${p.locked_at ? ` | Locked: ${fmtStamp(p.locked_at)}` : ""}`, 9, false, 2);
      P.line(`File: ${p.file_name || "-"} | ${p.file_type || "-"} | ${p.file_bytes ? fmtBytes(p.file_bytes) : "-"}${p.file_modified_at ? ` | file last modified ${fmtStamp(p.file_modified_at)}` : ""}`, 9, false, 2);
      P.line(`SHA-256: ${p.file_sha256 || "not recorded (uploaded before fingerprinting)"}`, 8.5, false, 2, "courier");
      P.line(`AI tags: ${(p.ai_tags || []).join(", ") || "none"}`, 9, false, 2);
      P.line(`Description: ${p.ai_summary || "-"}`, 9, false, 4);
      S.notes.filter((n) => n.photo_id === p.id).forEach((n) => P.line(`Correction added ${fmtStamp(n.created_at)}: ${n.note}`, 9, false, 2));
      await P.image(p.photo_url);
      P.line(`Photo link: ${/^blob:|^img\//.test(p.photo_url) ? "(demo image)" : p.photo_url}`, 7.5, false, 8);
      P.rule();
    }
    P.line("Evidence history", 12, true, 2);
    auditEntries().filter((a) => a.entity === "photos" || a.entity === "evidence_notes").slice(0, 40).forEach((a) => P.line(`${fmtStamp(a.created_at)} - ${describe(a)}`, 9, false, 1));
    P.y += 8;
    P.line("Correction & deletion policy: locked photos, their timestamps and fingerprints cannot be edited or deleted by anyone using the app, including the tenant. Corrections are added as new dated notes. Deleting the account removes all records and files.", 8.5);
    P.line("FixFlow is not legal advice.", 8.5);
    P.doc.save(`FixFlow-evidence-${S.tenancy.room.replace(/\W+/g, "-")}.pdf`);
    await logAction("evidence_report", { photos: S.photos.length });
    toast("Evidence report downloaded.");
    renderEvHistory();
  } catch (ex) { toast("Couldn't build the report: " + ex.message, true); }
  finally { busy(btn, false); }
});

/* ================= complaints ================= */
$("#fCat").innerHTML += CATS.map((c) => `<option>${c}</option>`).join("");
$("#rCatSel").innerHTML = CATS.map((c) => `<option>${c}</option>`).join("");
const EVT_ACTOR = { resident: "you", warden: "warden", system: "FixFlow" };
function eventText(e) {
  if (e.kind === "created") return `Logged as ${STATUS_LABEL[e.to_status] || "Open"}`;
  if (e.kind === "status") return `${STATUS_LABEL[e.from_status] || e.from_status} → ${STATUS_LABEL[e.to_status] || e.to_status} by ${EVT_ACTOR[e.actor]}${e.note ? `: “${e.note}”` : ""}`;
  if (e.kind === "response") return `Warden's reply (logged by you): “${e.note}”`;
  return `Note from ${EVT_ACTOR[e.actor]}: “${e.note}”`;
}
RENDER.complaints = function renderComplaints() {
  const open = S.complaints.filter((c) => c.status !== "fixed").length;
  $("#cCount").textContent = `${open} unresolved · each with a reference ID and history`;
  const fs = $("#fStatus").value, fc = $("#fCat").value;
  const list = S.complaints.filter((c) => (!fs || c.status === fs) && (!fc || c.category === fc));
  const phone = (S.tenancy?.owner_phone || "").replace(/\D/g, "");
  $("#cList").innerHTML = list.length ? list.map((c) => {
    const d = daysSince(c.reported_at), fixed = c.status === "fixed";
    const took = fixed && c.fixed_at ? daysSince(c.reported_at, c.fixed_at) : 0;
    const ev = S.events.filter((e) => e.complaint_id === c.id);
    const msg = c.draft || `Hi ${S.tenancy?.owner_name || ""}, reminder about my complaint ${c.ref || ""} "${c.title}" (Room ${S.tenancy?.room}), reported on ${fmtDate(c.reported_at)}. It has been unresolved for ${d} days. Please fix it soon.`;
    return `<article class="item" data-id="${c.id}">
      <div>
        <div class="badges"><span class="badge ref">${esc(c.ref || "–")}</span><span class="badge">${esc(c.category)}</span><span class="badge ${esc(c.urgency)}">${esc(c.urgency)}</span><span class="badge ${esc(c.status)}">${STATUS_LABEL[c.status]}</span>${c.supporters > 1 ? `<span class="badge ghost">+${c.supporters - 1} residents</span>` : ""}</div>
        <h4>${esc(c.title)}</h4>
        <p>${esc(c.description)}</p>
        ${c.photo_url ? `<img class="thumb" src="${esc(c.photo_url)}" alt="Complaint photo" data-zoom="${esc(c.photo_url)}" />` : ""}
        <div class="meta">Submitted ${fmtStamp(c.reported_at)} · Last updated ${fmtStamp(c.updated_at || c.reported_at)}${c.warden_note ? ` · Warden: ${esc(c.warden_note)}` : ""}</div>
        <details class="hist"><summary>Status history (${ev.length})</summary><ol class="timeline">${ev.map((e) => `<li><time>${fmtStamp(e.created_at)}</time><span>${esc(eventText(e))}</span></li>`).join("") || `<li class="none">No history yet.</li>`}</ol></details>
        <div class="acts">
          ${fixed ? `<button class="btn small ghost" data-status="open" data-cid="${c.id}">Reopen</button>` : `${c.status === "open" ? `<button class="btn small ghost" data-status="in_progress" data-cid="${c.id}">Mark in progress</button>` : ""}<button class="btn small primary" data-fix="${c.id}">Mark resolved</button>`}
          <button class="btn small ghost" data-reply="${c.id}">Log warden reply</button>
          <button class="btn small ghost" data-copy="${encodeURIComponent(msg)}">Copy message</button>
          ${phone && !fixed ? `<a class="btn small ghost" target="_blank" rel="noopener noreferrer" href="https://wa.me/${phone}?text=${encodeURIComponent(msg)}">WhatsApp owner</a>` : ""}
        </div>
        <form class="reply" data-replyform="${c.id}" hidden>
          <label class="lbl" for="rp-${c.id}">What did the warden or owner say?</label>
          <textarea id="rp-${c.id}" rows="2" placeholder="e.g. Plumber will come on Friday"></textarea>
          <div class="row"><select aria-label="New status"><option value="">Keep status (${STATUS_LABEL[c.status]})</option>${Object.entries(STATUS_LABEL).filter(([k]) => k !== c.status).map(([k, v]) => `<option value="${k}">Change to ${v}</option>`).join("")}</select>
          <button class="btn small primary" type="submit">Save to history</button></div>
        </form>
      </div>
      <div class="days ${fixed ? "done" : d >= 3 ? "hot" : ""}">${fixed ? `<b>Resolved</b><span>on ${fmtDate(c.fixed_at)} · took ${took}d</span>` : `<b>${d}</b><span>day${d === 1 ? "" : "s"} unresolved</span>`}</div>
    </article>`;
  }).join("") : `<div class="empty-list">${S.complaints.length ? "No matching complaints. Try clearing the filters." : "No complaints yet. Log the first one above."}</div>`;
};
$("#fStatus").addEventListener("change", RENDER.complaints);
$("#fCat").addEventListener("change", RENDER.complaints);
$("#cExamples").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (c) { $("#cText").value = c.textContent; $("#cText").focus(); } });
$("#cPhoto").addEventListener("change", (e) => {
  const f = e.target.files[0] || null, bad = f && checkImage(f);
  $("#cErr").textContent = bad || "";
  S.cPhoto = bad ? null : f;
  if (bad) e.target.value = "";
  $("#cPhotoLbl").textContent = S.cPhoto ? `📎 ${S.cPhoto.name} · ${fmtBytes(S.cPhoto.size)} (change)` : "📎 Attach photo (optional)";
  const pv = $("#cPhotoPrev");
  if (S.cPhoto) { pv.src = URL.createObjectURL(S.cPhoto); pv.hidden = false; } else pv.hidden = true;
});
$("#cAnalyze").addEventListener("click", async () => {
  const text = $("#cText").value.trim();
  $("#cErr").textContent = "";
  if (text.length < 5) return ($("#cErr").textContent = "Describe the issue in a few words first.");
  const btn = $("#cAnalyze");
  busy(btn, true, "Analysing…");
  let out;
  try { out = await ai("analyze", { text, resident: S.profile?.name, room: S.tenancy?.room, pg: S.tenancy?.pg_name }); if (!out.category) throw new Error("empty"); }
  catch { out = localAnalyze(text); }
  S.analysis = { ...out, text };
  $("#cEmpty").hidden = true; $("#cBody").hidden = false;
  $("#rCat").textContent = out.category;
  $("#rUrg").textContent = out.urgency; $("#rUrg").className = `badge ${out.urgency}`;
  $("#rMode").hidden = !out.offline;
  $("#rCatSel").value = out.category; $("#rUrgSel").value = out.urgency;
  $("#rCatAi").textContent = `(${out.offline ? "rules" : "AI"} suggests ${out.category})`;
  $("#rTitle").value = out.title || ""; $("#rDesc").value = out.description || out.summary || text; $("#rDraft").value = out.draft || "";
  busy(btn, false);
  const box = $("#similar");
  box.hidden = true;
  try {
    const sim = (await api.pgOpen()).filter((x) => x.category === out.category && !S.complaints.some((c) => c.id === x.id));
    if (sim.length) {
      box.innerHTML = `<b>Others in your PG reported something similar</b>` + sim.slice(0, 3).map((x) => `<div class="s-row"><span>${esc(x.title)} · ${plural(x.supporters, "resident")}</span><button class="btn small ghost" data-support="${x.id}">+1 me too</button></div>`).join("");
      box.hidden = false;
    }
  } catch {}
});
$("#rCatSel").addEventListener("change", (e) => ($("#rCat").textContent = e.target.value));
$("#rUrgSel").addEventListener("change", (e) => { $("#rUrg").textContent = e.target.value; $("#rUrg").className = `badge ${e.target.value}`; });
$("#similar").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-support]");
  if (!b) return;
  try { const n = await api.support(b.dataset.support); b.textContent = "Added ✓"; b.disabled = true; toast(n ? `Added your voice: ${n} residents now` : "Added your voice to this complaint"); }
  catch (ex) { toast(ex.message, true); }
});
$("#cDiscard").addEventListener("click", resetComposer);
function resetComposer() {
  S.analysis = null; S.cPhoto = null;
  $("#cText").value = ""; $("#cPhoto").value = ""; $("#cPhotoLbl").textContent = "📎 Attach photo (optional)"; $("#cPhotoPrev").hidden = true;
  $("#cEmpty").hidden = false; $("#cBody").hidden = true; $("#similar").hidden = true;
}
$("#cSave").addEventListener("click", async () => {
  if (!S.analysis) return;
  const title = $("#rTitle").value.trim(), description = $("#rDesc").value.trim();
  if (title.length < 3) return toast("Add a short title.", true);
  if (description.length < 5) return toast("Add a description.", true);
  const btn = $("#cSave");
  busy(btn, true, "Saving…");
  try {
    let photo_url = null;
    if (S.cPhoto) {
      const { blob } = await compress(S.cPhoto);
      if (live()) {
        const path = `users/${S.user.id}/complaints/c-${Date.now()}.jpg`;
        try { await uploadBytes(ref(storage, path), blob, { contentType: "image/jpeg" }); photo_url = await getDownloadURL(ref(storage, path)); }
        catch (e) { throw new Error("Photo upload failed: " + fbError(e).message); }
      } else photo_url = URL.createObjectURL(blob);
    }
    await api.addComplaint({ category: $("#rCatSel").value, ai_category: S.analysis.offline ? null : S.analysis.category, urgency: $("#rUrgSel").value, title, description, draft: $("#rDraft").value, photo_url });
    toast(`Complaint logged as ${S.complaints[0].ref}. The day counter has started.`);
    resetComposer(); RENDER.complaints();
  } catch (ex) { toast(ex.message, true); }
  finally { busy(btn, false); }
});
$("#cList").addEventListener("click", async (e) => {
  const f = e.target.closest("[data-fix]"), st = e.target.closest("[data-status]"), c = e.target.closest("[data-copy]"), rp = e.target.closest("[data-reply]");
  if (f || st) {
    const b = f || st, id = f ? f.dataset.fix : st.dataset.cid, status = f ? "fixed" : st.dataset.status;
    busy(b, true, "Saving…");
    try { await api.setComplaintStatus(id, status); toast(`Marked ${STATUS_LABEL[status].toLowerCase()}. Added to the history.`); RENDER.complaints(); }
    catch (ex) { toast(ex.message, true); busy(b, false); }
  }
  if (rp) { const form = $(`[data-replyform="${rp.dataset.reply}"]`); form.hidden = !form.hidden; if (!form.hidden) $("textarea", form).focus(); }
  if (c) {
    try { await navigator.clipboard.writeText(decodeURIComponent(c.dataset.copy)); toast("Copied."); }
    catch { toast("Couldn't access the clipboard. Select and copy manually.", true); }
  }
});
$("#cList").addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-replyform]");
  if (!form) return;
  e.preventDefault();
  const id = form.dataset.replyform, note = $("textarea", form).value.trim(), status = $("select", form).value;
  if (note.length < 3 && !status) return toast("Write what they said, or pick a new status.", true);
  const b = $("button[type=submit]", form);
  busy(b, true, "Saving…");
  try {
    if (note.length >= 3) await api.addEvent(id, "response", note);
    if (status) await api.setComplaintStatus(id, status);
    toast("Saved to the complaint history."); RENDER.complaints();
  } catch (ex) { toast(ex.message, true); busy(b, false); }
});

// voice input (Web Speech API) with graceful fallback
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) {
  $("#micBtn").classList.add("off"); $("#micBtn").setAttribute("aria-disabled", "true");
  $("#micHint").textContent = "Voice input isn't available in this browser (try Chrome or Edge). Typing works everywhere.";
  $("#micHint").hidden = false;
}
$("#micBtn").addEventListener("click", () => {
  if (!SR) return toast("Voice input isn't supported here. Please type instead.", true);
  const mic = $("#micBtn");
  if (mic._rec) { mic._rec.stop(); return; }
  const rec = new SR();
  rec.lang = "en-IN"; rec.interimResults = true;
  const base = $("#cText").value ? $("#cText").value + " " : "";
  rec.onresult = (e) => { $("#cText").value = base + [...e.results].map((r) => r[0].transcript).join(""); };
  rec.onend = () => { mic.classList.remove("rec"); mic._rec = null; $("#micHint").hidden = true; };
  rec.onerror = (e) => {
    $("#micHint").textContent = e.error === "not-allowed" ? "Microphone permission is blocked. Allow it in the browser, or type instead." : "Couldn't hear that. Try again or type instead.";
    $("#micHint").hidden = false;
  };
  mic._rec = rec; mic.classList.add("rec");
  $("#micHint").textContent = "Listening… tap the mic again to stop."; $("#micHint").hidden = false;
  try { rec.start(); } catch { mic.classList.remove("rec"); mic._rec = null; }
});

/* ================= deposit audit ================= */
const VERDICT = { unfair: "Unsupported by evidence", fair: "Looks fair", unclear: "Unclear: ask for proof", pending: "Not audited yet" };
RENDER.claim = function renderClaim() {
  const m = money(), t = S.tenancy;
  $("#kDeposit").textContent = rupee(m.deposit);
  $("#kDepositSub").textContent = t.monthly_rent ? `${(m.deposit / t.monthly_rent).toFixed(1).replace(/\.0$/, "")}× monthly rent` : "";
  $("#kTotal").textContent = rupee(m.total);
  $("#kTotalSub").textContent = plural(S.deductions.length, "deduction");
  $("#kDispute").textContent = rupee(m.disputed);
  $("#kRefund").textContent = rupee(m.refund);
  $("#kRefundSub").textContent = `${rupee(m.deposit)} − ${rupee(m.accepted)} accepted${m.pending ? ` − ${rupee(m.pending)} pending` : ""}`;
  const alerts = [];
  if (m.total > m.deposit) alerts.push(`The owner's deductions (${rupee(m.total)}) are more than the deposit (${rupee(m.deposit)}).`);
  if (t.monthly_rent && m.deposit > 2 * t.monthly_rent) alerts.push(`Your deposit is more than two months' rent. The Model Tenancy Act, 2021 proposes a two-month cap for residential premises, but it applies only where your state has adopted it.`);
  if (!S.photos.some((p) => p.locked)) alerts.push("You have no locked move-in photos, so the audit can only judge how specific each charge is.");
  $("#kAlert").innerHTML = alerts.map((a) => `<p>${esc(a)}</p>`).join("");
  $("#kAlert").hidden = !alerts.length;
  $("#auditBtn").disabled = !S.deductions.length;
  $("#dedList").innerHTML = S.deductions.length ? S.deductions.map((d) => {
    const ph = S.photos.find((p) => p.id === d.matched_photo_id);
    const cp = S.complaints.find((c) => c.id === d.matched_complaint_id);
    const v = d.ai_verdict || "pending", pos = position(d);
    return `<article class="ded ${v}" data-id="${d.id}">
      <div>
        <h4><span>${esc(d.reason)}</span><span class="amt">${rupee(d.amount)}</span></h4>
        <span class="verdict ${v}">${VERDICT[v]}</span>${d.ai_source === "rules" ? ` <span class="badge ghost">offline rules</span>` : ""}
        <p>${esc(d.ai_reason || "Run the audit to check this against your move-in photos and complaints.")}</p>
        ${cp ? `<p class="linked">Linked complaint: <b>${esc(cp.ref || "")}</b> ${esc(cp.title)} · reported ${fmtDate(cp.reported_at)} · ${STATUS_LABEL[cp.status]}</p>` : ""}
        <div class="pos" role="group" aria-label="Your position">
          <span>Your position:</span>
          <button type="button" class="btn small ${pos === "dispute" ? "primary" : "ghost"}" data-pos="dispute" aria-pressed="${pos === "dispute"}">Dispute</button>
          <button type="button" class="btn small ${pos === "accept" ? "primary" : "ghost"}" data-pos="accept" aria-pressed="${pos === "accept"}">Accept</button>
          ${d.tenant_position ? `<button type="button" class="link" data-pos="">Use AI finding</button>` : `<small>(following the AI finding)</small>`}
          <button type="button" class="link" data-ddel="${d.id}">Remove</button>
        </div>
      </div>
      ${ph ? `<div class="proof-box"><img src="${esc(ph.photo_url)}" alt="Matched move-in photo" data-zoom="${esc(ph.photo_url)}" /><div class="proof">🔒 ${esc(areaName(ph.area))} · locked ${fmtDate(ph.locked_at || ph.captured_at)}<br /><code>${esc(shortHash(ph.file_sha256))}</code></div></div>` : `<div class="proof" style="align-self:center">No matching move-in photo</div>`}
    </article>`;
  }).join("") : `<div class="empty-list">No move-out deductions yet. Add each charge the owner listed and FixFlow checks it against your locked photos and complaints.</div>`;
};
async function audit(ids) {
  const deds = S.deductions.filter((d) => !ids || ids.includes(d.id));
  if (!deds.length) return;
  const photos = S.photos.filter((p) => p.locked).map((p) => ({ id: p.id, area: areaName(p.area), tags: p.ai_tags, summary: p.ai_summary, lockedOn: fmtDate(p.locked_at || p.captured_at) }));
  const complaints = S.complaints.map((c) => ({ id: c.id, ref: c.ref, title: c.title, category: c.category, status: STATUS_LABEL[c.status], reportedOn: fmtDate(c.reported_at), daysUnresolved: c.status === "fixed" ? 0 : daysSince(c.reported_at) }));
  let results, source = "gemini";
  try { results = (await ai("audit", { deductions: deds.map((d) => ({ id: d.id, reason: d.reason, amount: d.amount })), photos, complaints, deposit: S.tenancy.deposit })).results; if (!results?.length) throw new Error("empty"); }
  catch { results = localAudit(deds); source = "rules"; }
  for (const d of deds) {
    const r = results.find((x) => x.id === d.id) || localAudit([d])[0];
    const verdict = ["fair", "unfair", "unclear"].includes(r.verdict) ? r.verdict : "unclear";
    const matched = photos.some((p) => p.id === r.matchedPhotoId) ? r.matchedPhotoId : null;
    const mc = complaints.some((c) => c.id === r.matchedComplaintId) ? r.matchedComplaintId : null;
    await api.updateDeduction(d.id, { ai_verdict: verdict, ai_reason: String(r.reason || "").slice(0, 600), matched_photo_id: matched, matched_complaint_id: mc, ai_source: source, audited_at: new Date().toISOString() });
  }
  return source;
}
$("#dedForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const reason = $("#dReason").value.trim(), amount = Math.round(Number($("#dAmount").value));
  const err = (m) => ($("#dErr").textContent = m);
  err("");
  if (reason.length < 4) return err("Describe the deduction as the owner wrote it.");
  if (!(amount > 0 && amount < 1e7)) return err("Enter the amount deducted.");
  const btn = $("#dAdd");
  busy(btn, true, "Auditing…");
  try {
    const d = await api.addDeduction({ reason, amount });
    $("#dReason").value = ""; $("#dAmount").value = "";
    const src = await audit([d.id]);
    const v = S.deductions.find((x) => x.id === d.id)?.ai_verdict;
    toast((v === "unfair" ? "Unsupported deduction found." : "Deduction audited.") + (src === "rules" ? " (AI offline: rule-based check)" : ""), src === "rules");
  } catch (ex) { err(ex.message); }
  finally { busy(btn, false); RENDER.claim(); }
});
$("#auditBtn").addEventListener("click", async () => {
  const btn = $("#auditBtn");
  busy(btn, true, "Re-auditing…");
  try { const src = await audit(); toast(src === "rules" ? "AI is offline: re-checked with rules." : "All deductions re-audited.", src === "rules"); } catch (ex) { toast(ex.message, true); }
  finally { busy(btn, false); RENDER.claim(); }
});
$("#toNoticeBtn").addEventListener("click", async () => {
  if (!money().disputed) return toast("Nothing is disputed yet. Add deductions first.", true);
  go("notices");
  if (!Object.keys(S.notices).length) $("#genBtn").click();
});
$("#dedList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-ddel]"), p = e.target.closest("[data-pos]");
  try {
    if (b) { await api.deleteDeduction(b.dataset.ddel); toast("Deduction removed."); RENDER.claim(); }
    else if (p) { const id = p.closest(".ded").dataset.id; await api.updateDeduction(id, { tenant_position: p.dataset.pos || null }); RENDER.claim(); }
  } catch (ex) { toast(ex.message, true); }
});

/* ================= notices ================= */
const KINDS = [
  ["whatsapp", "WhatsApp reminder", "Friendly, firm, 7-day ask"],
  ["formal", "Formal notice", "Dated, itemised, for email or print"],
  ["grievance", "Consumer helpline draft", "National Consumer Helpline (1915)"],
];
function noticeCtx() {
  const m = money();
  return {
    disputed: m.disputed,
    disputedList: S.deductions.filter((d) => position(d) === "dispute"),
    firstPhoto: S.photos.filter((p) => p.locked).map((p) => p.locked_at || p.captured_at).sort()[0],
  };
}
RENDER.notices = function renderNotices() {
  const ctx = noticeCtx();
  const has = Object.keys(S.notices).length > 0;
  $("#nContext").textContent = ctx.disputed
    ? `You're disputing ${rupee(ctx.disputed)} across ${plural(ctx.disputedList.length, "deduction")}, backed by ${plural(S.photos.filter((p) => p.locked).length, "locked photo")} and ${plural(S.complaints.length, "complaint")} with reference IDs. Edit any draft, then preview it to review and finalise.`
    : "Add and audit deductions on the Deposit audit screen first. The notices quote that evidence.";
  $("#genBtn").textContent = has ? "Regenerate drafts" : "Generate 3 drafts";
  $("#pdfBtn").disabled = !has;
  const phone = (S.tenancy?.owner_phone || "").replace(/\D/g, "");
  $("#nList").innerHTML = KINDS.map(([k, title, sub], i) => {
    const n = S.notices[k], fin = !!n?.finalized_at;
    return `
    <div class="card notice ${fin ? "final" : ""}" data-kind="${k}">
      <h4><span>0${i + 1}</span>${title}</h4>
      <small>${sub}${n ? ` · ${fin ? `Final since ${fmtStamp(n.finalized_at)}` : `Draft saved ${fmtStamp(n.updated_at)}`}` : ""}</small>
      <textarea aria-label="${title}" placeholder="Generate drafts to fill this in." ${fin ? "readonly" : ""}>${esc(n?.body || "")}</textarea>
      <div class="row">
        <button type="button" class="btn small primary" data-npv="${k}" ${n ? "" : "disabled"}>Preview${fin ? "" : " & finalise"}</button>
        ${fin ? `<button type="button" class="btn small ghost" data-nreopen="${k}">Reopen to edit</button>` : `<button type="button" class="btn small ghost" data-nsave="${k}">Save edits</button>`}
        <button type="button" class="btn small ghost" data-ncopy="${k}">Copy</button>
        ${k === "whatsapp" && phone ? `<button type="button" class="btn small ghost" data-nwa="${k}">WhatsApp</button>` : ""}
      </div>
    </div>`;
  }).join("");
};
$("#genBtn").addEventListener("click", async () => {
  const ctx = noticeCtx();
  if (!ctx.disputed) { toast("Add deductions on the Deposit audit screen first.", true); return go("claim"); }
  const btn = $("#genBtn");
  busy(btn, true, "Writing drafts…");
  let out, offline = false;
  try {
    out = await ai("notices", {
      tenant: S.profile.name, tenancy: S.tenancy, disputed: ctx.disputed, today: fmtDate(Date.now()),
      photos: S.photos.filter((p) => p.locked).map((p) => ({ area: areaName(p.area), tags: p.ai_tags, lockedOn: fmtDate(p.locked_at || p.captured_at), sha256: (p.file_sha256 || "").slice(0, 16) })),
      complaints: S.complaints.map((c) => ({ ref: c.ref, title: c.title, status: STATUS_LABEL[c.status], reportedOn: fmtDate(c.reported_at), daysUnresolved: c.status === "fixed" ? 0 : daysSince(c.reported_at) })),
      deductions: S.deductions.map((d) => ({ reason: d.reason, amount: d.amount, finding: d.ai_verdict, tenantPosition: position(d), why: d.ai_reason })),
    });
    if (!out.whatsapp || !out.formal || !out.grievance) throw new Error("incomplete");
  } catch { out = localNotices(ctx); offline = true; }
  const keep = KINDS.map(([k]) => k).filter((k) => S.notices[k]?.finalized_at);
  const fresh = Object.fromEntries(KINDS.map(([k]) => [k, out[k]]).filter(([k]) => !keep.includes(k)));
  try {
    if (Object.keys(fresh).length) await api.saveNotices(fresh);
    toast(`${offline ? "AI is offline: template drafts created" : "Drafts generated"}${keep.length ? ". Final notices were kept" : ""}. Review before sending.`, offline);
  } catch (ex) { toast(ex.message, true); }
  finally { busy(btn, false); RENDER.notices(); }
});
$("#nList").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const k = b.dataset.ncopy || b.dataset.nwa || b.dataset.nsave || b.dataset.npv || b.dataset.nreopen;
  if (!k) return;
  const text = $(`.notice[data-kind="${k}"] textarea`).value;
  if (b.dataset.ncopy) {
    try { await navigator.clipboard.writeText(text); toast("Copied."); } catch { toast("Couldn't access the clipboard. Select and copy manually.", true); }
  } else if (b.dataset.nwa) {
    window.open(`https://wa.me/${S.tenancy.owner_phone.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`, "_blank", "noopener");
  } else if (b.dataset.nsave) {
    if (text.trim().length < 10) return toast("Draft can't be shorter than 10 characters.", true);
    try { await api.saveNotices({ [k]: text }); toast("Draft saved."); RENDER.notices(); } catch (ex) { toast(ex.message, true); }
  } else if (b.dataset.nreopen) {
    try { await api.finalizeNotice(k, false); toast("Reopened as a draft."); RENDER.notices(); } catch (ex) { toast(ex.message, true); }
  } else if (b.dataset.npv) {
    if (!S.notices[k]?.finalized_at && text !== nBody(k)) {
      if (text.trim().length < 10) return toast("Draft can't be shorter than 10 characters.", true);
      try { await api.saveNotices({ [k]: text }); } catch (ex) { return toast(ex.message, true); }
    }
    openPreview(k);
  }
});

let PV = null;
function annexHtml() {
  const locked = S.photos.filter((p) => p.locked);
  const rows = (arr) => arr.join("") || `<tr><td colspan="9">None</td></tr>`;
  return `
    <h5>Annex A · Locked move-in evidence</h5>
    <table><thead><tr><th>Area</th><th>Locked</th><th>Findings</th><th>SHA-256</th></tr></thead><tbody>${rows(locked.map((p) => `<tr><td>${esc(areaName(p.area))}</td><td>${fmtStamp(p.locked_at || p.captured_at)}</td><td>${esc((p.ai_tags || []).join(", ") || "none")}</td><td><code>${esc(shortHash(p.file_sha256))}</code></td></tr>`))}</tbody></table>
    <h5>Annex B · Complaints</h5>
    <table><thead><tr><th>Ref</th><th>Issue</th><th>Reported</th><th>Status</th></tr></thead><tbody>${rows(S.complaints.map((c) => `<tr><td>${esc(c.ref || "–")}</td><td>${esc(c.title)}</td><td>${fmtDate(c.reported_at)}</td><td>${STATUS_LABEL[c.status]}</td></tr>`))}</tbody></table>
    <h5>Annex C · Deductions</h5>
    <table><thead><tr><th>Deduction</th><th>Amount</th><th>Finding</th><th>Position</th></tr></thead><tbody>${rows(S.deductions.map((d) => `<tr><td>${esc(d.reason)}</td><td>${rupee(d.amount)}</td><td>${esc(VERDICT[d.ai_verdict || "pending"])}</td><td>${cap(position(d))}</td></tr>`))}</tbody></table>
    <p class="totals">Deposit ${rupee(money().deposit)} · Deducted ${rupee(money().total)} · Disputed ${rupee(money().disputed)} · Refund due ${rupee(money().refund)}</p>`;
}
function openPreview(k) {
  PV = k;
  const n = S.notices[k], t = S.tenancy, fin = !!n?.finalized_at;
  const title = KINDS.find(([x]) => x === k)[1];
  $("#pvTitle").textContent = `Preview · ${title}`;
  $("#pvState").textContent = fin ? `Final · ${fmtStamp(n.finalized_at)}` : "Draft";
  $("#pvBody").innerHTML = `
    ${S.mode === "demo" ? `<p class="demo-badge">Demo · fictional data</p>` : ""}
    <div class="lt-head"><div><b>From</b> ${esc(S.profile?.name)}, ${esc(t.room)}, ${esc(t.pg_name)}</div><div><b>To</b> ${esc(t.owner_name || "PG owner")}</div><div><b>Date</b> ${fmtDate(Date.now())}</div></div>
    <div class="lt-body">${esc(n?.body || "")}</div>
    ${k === "whatsapp" ? "" : annexHtml()}
    <p class="disclaimer">Prepared with FixFlow. Not legal advice.</p>`;
  $("#pvAgree").checked = fin; $("#pvAgree").disabled = fin;
  $("#pvFinal").textContent = fin ? "Final ✓" : "Mark as final"; $("#pvFinal").disabled = !fin ? !$("#pvAgree").checked : true;
  $("#pvPdf").textContent = fin ? "Download PDF" : "Download draft PDF";
  $("#previewDlg").showModal();
}
$("#pvAgree").addEventListener("change", (e) => ($("#pvFinal").disabled = !e.target.checked));
$("#pvClose").addEventListener("click", () => $("#previewDlg").close());
$("#pvFinal").addEventListener("click", async () => {
  const btn = $("#pvFinal");
  busy(btn, true, "Saving…");
  try { await api.finalizeNotice(PV, true); toast("Marked final. You can still reopen it to edit."); busy(btn, false); openPreview(PV); RENDER.notices(); }
  catch (ex) { busy(btn, false); toast(ex.message, true); }
});
async function noticePdf(kinds, filename) {
  const P = await newPdf();
  const allFinal = kinds.every((k) => S.notices[k]?.finalized_at);
  P.header(kinds.length > 1 ? "Deposit evidence & notices" : KINDS.find(([x]) => x === kinds[0])[1]);
  if (!allFinal) { P.doc.setTextColor(200, 60, 40); P.line("DRAFT - review every date and amount, then mark final in FixFlow before sending.", 9.5, true, 8); P.doc.setTextColor(0); }
  kinds.forEach((k) => { if (S.notices[k]) { P.line(KINDS.find(([x]) => x === k)[1], 13, true, 4); P.line(S.notices[k].body, 10.5, false, 14); } });
  P.rule();
  P.line("Annex A - Locked move-in evidence", 12, true, 2); P.evidence(); P.y += 6;
  P.line("Annex B - Complaints", 12, true, 2); P.complaints(); P.y += 6;
  P.line("Annex C - Deductions", 12, true, 2); P.deductions();
  P.line("Each photo's SHA-256 fingerprint can be checked against the original file. FixFlow helps you communicate with evidence. It is not legal advice.", 8.5);
  P.doc.save(filename);
  await logAction("notice_pdf", { kinds });
}
$("#pvPdf").addEventListener("click", async () => {
  const btn = $("#pvPdf");
  busy(btn, true, "Building PDF…");
  try { await noticePdf([PV], `FixFlow-${PV}-${S.tenancy.room.replace(/\W+/g, "-")}.pdf`); toast("PDF downloaded."); }
  catch (ex) { toast("Couldn't build the PDF: " + ex.message, true); }
  finally { busy(btn, false); }
});
$("#pdfBtn").addEventListener("click", async () => {
  const btn = $("#pdfBtn");
  busy(btn, true, "Building PDF…");
  try { await noticePdf(KINDS.map(([k]) => k), `FixFlow-${S.tenancy.room.replace(/\W+/g, "-")}-deposit-notice.pdf`); toast("PDF downloaded."); }
  catch (ex) { toast("Couldn't build the PDF: " + ex.message, true); }
  finally { busy(btn, false); }
});

/* ================= privacy & data ================= */
RENDER.account = function renderAccount() {
  $("#deleteBtn").disabled = true; $("#delConfirm").value = ""; $("#delErr").textContent = "";
  const paint = () => ($("#auditList").innerHTML = auditHtml(auditEntries().slice(0, 100)));
  paint();
  if (live()) refreshAudit().then(() => S.screen === "account" && paint());
};
$("#delConfirm").addEventListener("input", (e) => ($("#deleteBtn").disabled = e.target.value.trim() !== "DELETE"));
$("#exportBtn").addEventListener("click", async () => {
  const btn = $("#exportBtn");
  busy(btn, true, "Preparing…");
  try {
    let data;
    if (live()) { await loadLive(); data = { user: { id: S.user.id, email: S.user.email, created_at: S.user.created_at } }; }
    else data = { note: "Demo mode: fictional data, nothing is stored." };
    Object.assign(data, { app: "FixFlow", exported_at: new Date().toISOString(), profile: S.profile, tenancy: S.tenancy, photos: S.photos, evidence_notes: S.notes,
      complaints: S.complaints, complaint_events: S.events, deductions: S.deductions, notices: Object.values(S.notices), audit_log: auditEntries() });
    download(`fixflow-data-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    await logAction("data_export", {});
    toast("Your data was downloaded.");
  } catch (ex) { toast("Export failed: " + fbError(ex).message, true); }
  finally { busy(btn, false); }
});
async function deleteMany(refs) {
  for (let i = 0; i < refs.length; i += 400) {
    const b = writeBatch(db);
    refs.slice(i, i + 400).forEach((r) => b.delete(r));
    await b.commit();
  }
}
async function removeFolder(path) {
  try {
    const res = await listAll(ref(storage, path));
    await Promise.all(res.items.map((it) => deleteObject(it).catch(() => {})));
  } catch {}
}
$("#deleteBtn").addEventListener("click", async () => {
  if ($("#delConfirm").value.trim() !== "DELETE") return;
  if (!live()) { toast("Demo data isn't stored, so there is nothing to delete."); return; }
  const btn = $("#deleteBtn"), id = S.user.id;
  busy(btn, true, "Deleting…");
  try {
    // 1. tombstone: the only thing that unlocks deletion of locked evidence and history
    const tomb = doc(db, "deletions", id);
    if (!(await getDoc(tomb)).exists()) await writeBatch(db).set(tomb, { requested_at: serverTimestamp() }).commit();
    // 2. files
    await removeFolder(`users/${id}/movein`);
    await removeFolder(`users/${id}/complaints`);
    // 3. records
    const mine = async (name) => (await getDocs(query(collection(db, name), where("owner", "==", id)))).docs.map((d) => d.ref);
    const comps = (await getDocs(query(collection(db, "complaints"), where("owner", "==", id)))).docs;
    const boards = comps.filter((c) => c.data().pg_code).map((c) => doc(db, "pgs", c.data().pg_code, "open", c.id));
    const existingBoards = (await Promise.all(boards.map(async (r) => ((await getDoc(r)).exists() ? r : null)))).filter(Boolean);
    const refsDocs = comps.map((c) => doc(db, "refs", c.data().ref)).filter(Boolean);
    const notices = (await getDocs(collection(db, "users", id, "notices"))).docs.map((d) => d.ref);
    await deleteMany([...existingBoards, ...(await mine("complaint_events")), ...(await mine("evidence_notes")), ...(await mine("deductions")), ...notices]);
    await deleteMany([...comps.map((c) => c.ref), ...refsDocs, ...(await mine("photos")), doc(db, "tenancies", id), ...(await mine("audit_log")), doc(db, "profiles", id)]);
    // 4. login
    await deleteUser(auth.currentUser);
    exitDemo(); S.user = null; showView();
    toast("Your account and all FixFlow data were deleted.");
  } catch (ex) {
    $("#delErr").textContent = ex.code === "auth/requires-recent-login"
      ? "Your data was deleted. To delete the login too, log out, log back in and press Delete again."
      : "Deletion failed: " + fbError(ex).message;
    busy(btn, false);
  }
});

/* ================= warden ================= */
let W = null;
$("#wForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("#wCode").value.trim().toUpperCase(), pin = $("#wPin").value.trim();
  $("#wErr").textContent = "";
  if (!code || !pin) return ($("#wErr").textContent = "Enter your PG code and PIN.");
  const btn = $("#wGo");
  busy(btn, true, "Checking…");
  try {
    requireFirebase();
    const { a, d } = wardenClient();
    if (!a.currentUser) await signInAnonymously(a);
    const pgSnap = await getDoc(doc(d, "pgs", code));
    if (!pgSnap.exists()) throw Object.assign(new Error(), { code: "permission-denied" });
    const mem = doc(d, "pgs", code, "wardens", a.currentUser.uid);
    const have = await getDoc(mem);
    if (have.exists()) { if (have.data().pin !== pin) throw Object.assign(new Error(), { code: "permission-denied" }); }
    else await writeBatch(d).set(mem, { pin, joined_at: serverTimestamp() }).commit(); // rules compare the PIN with the PG's secret
    W = { code, d, uid: a.currentUser.uid };
    busy(btn, false);
    await loadWarden();
  } catch (ex) {
    busy(btn, false);
    $("#wBoard").hidden = true;
    $("#wErr").textContent = ex.code === "permission-denied" ? "Wrong PG code or PIN."
      : /operation-not-allowed|admin-restricted|configuration-not-found/.test(ex.code || "") ? "Warden sign-in isn't switched on yet (Firebase Anonymous sign-in)."
      : "Can't reach the server. Try again.";
  }
});
async function loadWarden() {
  const { code, d } = W;
  let list, boards;
  try {
    const [cs, bs] = await Promise.all([getDocs(query(collection(d, "complaints"), where("pg_code", "==", code))), getDocs(collection(d, "pgs", code, "open"))]);
    boards = Object.fromEntries(bs.docs.map((b) => [b.id, b.data()]));
    list = cs.docs.map(rowFrom).map((c) => ({ ...c, supporters: boards[c.id]?.supporters || 1 }));
  } catch (e) { return ($("#wErr").textContent = fbError(e).message); }
  W.list = list; W.boards = boards;
  const rank = { open: 0, in_progress: 1, fixed: 2 };
  list.sort((a, b) => rank[a.status] - rank[b.status] || URG[a.urgency] - URG[b.urgency] || b.supporters - a.supporters || new Date(a.reported_at) - new Date(b.reported_at));
  const n = (s) => list.filter((c) => c.status === s).length;
  $("#wStats").innerHTML = `<div class="stat warn"><span>Open</span><b>${n("open")}</b></div><div class="stat"><span>In progress</span><b>${n("in_progress")}</b></div><div class="stat good"><span>Resolved</span><b>${n("fixed")}</b></div>`;
  $("#wList").innerHTML = list.map((c) => {
    const dd = daysSince(c.reported_at), fixed = c.status === "fixed";
    return `<article class="item">
      <div>
        <div class="badges"><span class="badge ref">${esc(c.ref || "–")}</span><span class="badge">${esc(c.category)}</span><span class="badge ${esc(c.urgency)}">${esc(c.urgency)}</span><span class="badge ${esc(c.status)}">${STATUS_LABEL[c.status]}</span>${c.supporters > 1 ? `<span class="badge ghost">${c.supporters} residents</span>` : ""}</div>
        <h4>${esc(c.title)}</h4><p>${esc(c.description)}</p>
        <div class="meta">${esc(c.resident_name)} · Room ${esc(c.room || "-")} · submitted ${fmtStamp(c.reported_at)} · updated ${fmtStamp(c.updated_at || c.reported_at)}${c.warden_note ? ` · Your note: ${esc(c.warden_note)}` : ""}</div>
        ${fixed ? "" : `<div class="acts"><label class="sr" for="wn-${c.id}">Note to resident</label><input class="w-note" id="wn-${c.id}" placeholder="Note to resident (optional)" />${c.status === "open" ? `<button class="btn small ghost" data-w="${c.id}" data-s="in_progress">Start work</button>` : ""}<button class="btn small primary" data-w="${c.id}" data-s="fixed">Mark resolved</button></div>`}
      </div>
      <div class="days ${fixed ? "done" : dd >= 3 ? "hot" : ""}">${fixed ? `<b>Resolved</b><span>${fmtDate(c.fixed_at)}</span>` : `<b>${dd}</b><span>day${dd === 1 ? "" : "s"} open</span>`}</div>
    </article>`;
  }).join("") || `<div class="empty-list">No complaints in this PG yet.</div>`;
  $("#wBoard").hidden = false;
}
$("#wList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-w]");
  if (!b || !W) return;
  const c = W.list.find((x) => x.id === b.dataset.w), status = b.dataset.s;
  const note = $(`#wn-${c.id}`)?.value.trim() || null;
  busy(b, true, "Saving…");
  try {
    const { d, code } = W;
    const batch = writeBatch(d);
    batch.update(doc(d, "complaints", c.id), { status, updated_at: serverTimestamp(), fixed_at: status === "fixed" ? serverTimestamp() : null, ...(note ? { warden_note: note } : {}) });
    batch.set(doc(collection(d, "complaint_events")), { owner: c.owner ?? null, complaint_id: c.id, kind: "status", from_status: c.status, to_status: status, note, actor: "warden", created_at: serverTimestamp() });
    if (W.boards[c.id]) batch.update(doc(d, "pgs", code, "open", c.id), { status, updated_at: serverTimestamp() });
    await batch.commit();
    toast(status === "fixed" ? "Marked resolved. It's in the resident's history now." : "Marked in progress.");
    await loadWarden();
  } catch (ex) { toast(fbError(ex).message, true); busy(b, false); }
});

/* ================= boot ================= */
new IntersectionObserver(([e]) => document.body.classList.toggle("in-app", e.isIntersecting), { rootMargin: "0px 0px -30% 0px" }).observe($("#app"));
setAuthMode("signup");
