import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signInWithPopup, signOut, updateProfile } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, query, where, orderBy, setDoc, addDoc, updateDoc, deleteDoc, writeBatch, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";

const CFG = window.FF_CONFIG;
const firebaseConfig = CFG.FIREBASE_CONFIG;
const firebaseConfigured = ["apiKey", "authDomain", "projectId", "storageBucket", "messagingSenderId", "appId"]
  .every((key) => firebaseConfig?.[key] && !String(firebaseConfig[key]).startsWith("REPLACE_"));
const firebaseApp = firebaseConfigured ? initializeApp(firebaseConfig) : null;
const auth = firebaseApp ? getAuth(firebaseApp) : null;
const db = firebaseApp ? getFirestore(firebaseApp) : null;
const storage = firebaseApp ? getStorage(firebaseApp) : null;
const functions = firebaseApp ? getFunctions(firebaseApp, CFG.FUNCTIONS_REGION || "us-central1") : null;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DAY = 864e5;
const CATS = ["Water", "Electricity", "Wi-Fi", "Food", "Hygiene", "Safety", "Maintenance", "Other"];
const AREAS = ["bed", "wall", "bathroom", "wardrobe", "floor"];
const URG = { High: 0, Medium: 1, Low: 2 };
const STATUS_LABEL = { open: "Open", in_progress: "In progress", fixed: "Fixed" };
const rupee = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const daysSince = (a, b = Date.now()) => Math.max(0, Math.floor((new Date(b) - new Date(a)) / DAY));
const fmtDate = (d) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const fmtStamp = (d) => new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
const cap = (s) => String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

/* ================= state ================= */
const S = {
  mode: null, // "live" | "demo"
  user: null, profile: null, tenancy: null,
  photos: [], complaints: [], deductions: [], notices: {},
  area: "wall", screen: "dashboard", analysis: null, cPhoto: null,
};

/* ================= ui utils ================= */
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", err);
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2800);
}
function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.textContent = label || "Working…"; btn.classList.add("loading"); btn.disabled = true; }
  else { btn.innerHTML = btn.dataset.label || btn.innerHTML; btn.classList.remove("loading"); btn.disabled = false; }
}
async function ai(action, payload) {
  const r = await fetch(CFG.AI_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "AI unavailable");
  return j;
}
function openImg(src) { $("#imgBig").src = src; $("#imgDlg").showModal(); }
$("#imgClose").addEventListener("click", () => $("#imgDlg").close());
$("#imgDlg").addEventListener("click", (e) => { if (e.target.id === "imgDlg") $("#imgDlg").close(); });
document.addEventListener("click", (e) => { const z = e.target.closest("[data-zoom]"); if (z) openImg(z.dataset.zoom); });

/** Shrink a photo to <=1280px JPEG: keeps uploads and AI calls small. */
function compress(file, max = 1280) {
  return new Promise((res, rej) => {
    if (!file || !/^image\//.test(file.type)) return rej(new Error("Please choose an image file."));
    if (file.size > 15 * 1024 * 1024) return rej(new Error("Image is too large."));
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL("image/jpeg", 0.82);
      c.toBlob((blob) => res({ blob, dataUrl }), "image/jpeg", 0.82);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => rej(new Error("Could not read that image."));
    img.src = URL.createObjectURL(file);
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
}
addEventListener("scroll", onScroll, { passive: true });
addEventListener("resize", onScroll);
onScroll();

async function loadHeroStats() {
  if (!functions) return;
  try {
    const { data } = await httpsCallable(functions, "getPublicStats")({});
    $("#statOpen").textContent = data.open_count;
    $("#statFixed").textContent = data.fixed_count;
    $("#statAvg").textContent = data.avg_days ?? "–";
  } catch (error) {
    console.error("Could not load public complaint stats:", error);
  }
}

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
    category, urgency, title, summary: text.slice(0, 140), offline: true,
    draft: `Dear ${S.tenancy?.owner_name || "Sir/Madam"},\n\nI would like to report a ${category.toLowerCase()} issue in Room ${S.tenancy?.room || ""}: ${text.trim()}\n\nPlease get this fixed within 24–48 hours and let me know once it is done.\n\nThank you,\n${S.profile?.name || "Resident"}`,
  };
}
function localAudit(deds) {
  return deds.map((d) => {
    const r = d.reason.toLowerCase();
    const hit = S.photos.find((p) => p.locked && (r.includes(p.area) || p.ai_tags.some((t) => t.split(" ").some((w) => w.length > 3 && r.includes(w)))));
    if (hit) return { id: d.id, verdict: "unfair", reason: `Your locked ${hit.area} photo from ${fmtDate(hit.captured_at)} already shows: ${hit.ai_tags.join(", ") || "this area"}.`, matchedPhotoId: hit.id };
    if (/clean|sanit/.test(r) && d.amount <= 2500) return { id: d.id, verdict: "fair", reason: "A modest, itemised cleaning charge is usually reasonable if it was agreed at move-in." };
    return { id: d.id, verdict: "unclear", reason: "No specific damage is identified. Ask the owner for an itemised bill or photo." };
  });
}
function localNotices(ctx) {
  const t = S.tenancy, name = S.profile?.name || "Tenant";
  const owner = t.owner_name || "Sir/Madam";
  const lines = ctx.disputedList.map((d) => `- ${d.reason}: ${rupee(d.amount)} (${d.ai_verdict})`).join("\n");
  return {
    whatsapp: `Hi ${owner}, this is ${name} from Room ${t.room}. I've checked the deductions against my move-in photos, which were timestamped on ${fmtDate(ctx.firstPhoto || t.move_in)}. ${rupee(ctx.disputed)} of the charges are for damage that was already there or isn't itemised. Please refund ${rupee(ctx.disputed)} within 7 days. Happy to share the photos. Thanks!`,
    formal: `Subject: Request for refund of security deposit – Room ${t.room}, ${t.pg_name}\n\nDear ${owner},\n\nI stayed in Room ${t.room} at ${t.pg_name} from ${fmtDate(t.move_in)}${t.move_out ? ` to ${fmtDate(t.move_out)}` : ""} and paid a security deposit of ${rupee(t.deposit)}.\n\nThe following deductions are disputed:\n${lines}\n\nMy move-in photos were locked with a server timestamp and show this damage was pre-existing. I request a refund of ${rupee(ctx.disputed)} within 7 days of this notice, and itemised bills for any other deduction.\n\nRegards,\n${name}`,
    grievance: `To: National Consumer Helpline (1915 / consumerhelpline.gov.in)\n\nComplainant: ${name}\nService provider: ${t.pg_name}, ${t.address || "Bengaluru"} (owner: ${owner})\n\nI paid a security deposit of ${rupee(t.deposit)}. At move-out, the PG deducted amounts for damage that my timestamped move-in photos show was pre-existing. Disputed deductions:\n${lines}\n\nRelief sought: refund of ${rupee(ctx.disputed)}.`,
  };
}

/* ================= demo data ================= */
function demoData() {
  const now = Date.now(), t0 = now - 94 * DAY;
  return {
    profile: { name: "Riya Sharma", phone: "+91 98801 44510", city: "Bengaluru" },
    tenancy: { id: "demo", pg_code: "SUNRISE24", pg_name: "Sunrise PG", owner_name: "Mahesh Gowda", owner_phone: "+91 98450 11223", address: "18th Main, 4th Block, Koramangala, Bengaluru 560034", room: "Room 204", monthly_rent: 11500, deposit: 20000, move_in: new Date(t0).toISOString().slice(0, 10), move_out: new Date(now).toISOString().slice(0, 10) },
    photos: [
      { id: "p-wall", area: "wall", photo_url: "img/demo/wall.webp", ai_tags: ["water stain", "peeling plaster", "dark scuff mark"], ai_summary: "Pre-existing grey damp stain, a peeling plaster patch and dark scuff marks beside the switchboard.", captured_at: new Date(t0 + 2 * 36e5).toISOString(), locked: true },
      { id: "p-bath", area: "bathroom", photo_url: "img/demo/bathroom.webp", ai_tags: ["hard water scaling", "loose faucet", "tile stain"], ai_summary: "Hard-water calcium deposits on the wall tiles and a slightly tilted basin tap.", captured_at: new Date(t0 + 2 * 36e5 + 18e4).toISOString(), locked: true },
      { id: "p-ward", area: "wardrobe", photo_url: "img/demo/wardrobe.webp", ai_tags: ["loose hinge", "peeling laminate"], ai_summary: "Top door hinge is loose and the bottom laminate edge is peeling.", captured_at: new Date(t0 + 2 * 36e5 + 36e4).toISOString(), locked: true },
    ],
    complaints: [
      { id: "c-wifi", category: "Wi-Fi", urgency: "Medium", title: "Wi-Fi drops every evening", description: "2nd floor router disconnects every evening between 7 PM and 11 PM; reported on the WhatsApp group twice.", draft: "", status: "open", supporters: 4, reported_at: new Date(now - 14 * DAY).toISOString() },
      { id: "c-water", category: "Water", urgency: "High", title: "No hot water in Room 204 bathroom", description: "Solar geyser hot water unavailable; only a lukewarm trickle in the mornings.", draft: "", status: "open", supporters: 2, reported_at: new Date(now - 6 * DAY).toISOString() },
      { id: "c-food", category: "Food", urgency: "High", title: "Insect found in lunch dal", description: "Insect found in dal served at lunch.", draft: "", status: "fixed", supporters: 1, reported_at: new Date(now - 30 * DAY).toISOString(), fixed_at: new Date(now - 29 * DAY).toISOString() },
    ],
    deductions: [
      { id: "d1", reason: "Wall repainting for damp stain and scuff marks near switchboard", amount: 4500, ai_verdict: "unfair", ai_reason: "Your locked move-in wall photo from check-in day already shows the damp stain, peeling plaster and scuff marks beside the switchboard.", matched_photo_id: "p-wall", created_at: new Date(now - 36e5).toISOString() },
      { id: "d2", reason: "Standard room & mattress deep cleaning at move-out", amount: 1500, ai_verdict: "fair", ai_reason: "An itemised end-of-stay cleaning fee is reasonable if it was agreed at move-in.", created_at: new Date(now - 3e6).toISOString() },
      { id: "d3", reason: "General building & corridor maintenance surcharge", amount: 2000, ai_verdict: "unclear", ai_reason: "A vague blanket charge with no specific room damage. Ask for an itemised bill.", created_at: new Date(now - 24e5).toISOString() },
    ],
    notices: {},
  };
}
const demoPgOpen = () => [
  { id: "x1", title: "Wi-Fi drops every evening", category: "Wi-Fi", urgency: "Medium", supporters: 4 },
  { id: "x2", title: "Geyser not heating water", category: "Water", urgency: "High", supporters: 2 },
  { id: "x3", title: "Room door lock is broken", category: "Safety", urgency: "High", supporters: 1 },
];

/* ================= data layer ================= */
const live = () => S.mode === "live";
function requireFirebase() {
  if (!firebaseConfigured) throw new Error("Firebase is not configured. Add your Firebase web app settings to public/config.js.");
}
function rowFromDoc(snapshot) {
  if (!snapshot.exists()) return null;
  const row = { id: snapshot.id, ...snapshot.data() };
  for (const key of ["captured_at", "locked_at", "reported_at", "fixed_at", "created_at", "updated_at"]) {
    const value = row[key];
    if (value?.toDate) row[key] = value.toDate().toISOString();
    else if (value instanceof Date) row[key] = value.toISOString();
  }
  return row;
}
async function ownerRows(name, sortField, direction = "asc") {
  const q = query(collection(db, name), where("owner", "==", S.user.uid), orderBy(sortField, direction));
  const result = await getDocs(q);
  return result.docs.map(rowFromDoc);
}

async function loadLive() {
  const id = S.user.uid;
  const [profileSnapshot, tenancySnapshot, photos, complaints, deductions, noticeSnapshots] = await Promise.all([
    getDoc(doc(db, "profiles", id)),
    getDoc(doc(db, "tenancies", id)),
    ownerRows("photos", "captured_at", "desc"),
    ownerRows("complaints", "reported_at", "desc"),
    ownerRows("deductions", "created_at"),
    getDocs(collection(db, "users", id, "notices")),
  ]);
  let profile = rowFromDoc(profileSnapshot);
  if (!profile) {
    const profileRef = doc(db, "profiles", id);
    await runTransaction(db, async (transaction) => {
      const current = await transaction.get(profileRef);
      if (!current.exists()) {
        transaction.set(profileRef, { name: S.user.displayName || S.user.email.split("@")[0], phone: "", created_at: serverTimestamp() });
      }
    });
    profile = rowFromDoc(await getDoc(profileRef));
  }
  S.profile = profile;
  S.tenancy = rowFromDoc(tenancySnapshot);
  S.photos = photos;
  S.complaints = complaints;
  S.deductions = deductions;
  S.notices = Object.fromEntries(noticeSnapshots.docs.map((n) => [n.id, n.data().body]));
}

const api = {
  async saveTenancy(t) {
    if (!live()) { S.tenancy = { ...S.tenancy, ...t }; return; }
    const tenancyRef = doc(db, "tenancies", S.user.uid);
    const existing = await getDoc(tenancyRef);
    await setDoc(tenancyRef, { ...t, owner: S.user.uid, created_at: existing.exists() ? existing.data().created_at : serverTimestamp(), updated_at: serverTimestamp() }, { merge: true });
    S.tenancy = rowFromDoc(await getDoc(tenancyRef));
  },
  async addPhoto(file, area) {
    const { blob, dataUrl } = await compress(file);
    let ins = { tags: [], summary: "AI inspection unavailable right now. The photo is still saved with its timestamp." };
    try { ins = await ai("inspect", { image: dataUrl, area }); } catch {}
    const row = { area, ai_tags: ins.tags || [], ai_summary: ins.summary || "" };
    if (live()) {
      const photoRef = doc(collection(db, "photos"));
      const path = `users/${S.user.uid}/movein/${photoRef.id}`;
      await setDoc(photoRef, { ...row, owner: S.user.uid, photo_url: "", storage_path: path, captured_at: serverTimestamp(), locked: false, locked_at: null });
      try {
        await uploadBytes(ref(storage, path), blob, { contentType: "image/jpeg" });
        await updateDoc(photoRef, { photo_url: await getDownloadURL(ref(storage, path)) });
        S.photos.unshift(rowFromDoc(await getDoc(photoRef)));
      } catch (error) {
        try { await deleteObject(ref(storage, path)); }
        catch (cleanupError) {
          if (cleanupError.code !== "storage/object-not-found") {
            throw new AggregateError([error, cleanupError], "Photo upload failed and its stored file could not be removed.");
          }
        }
        try { await deleteDoc(photoRef); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "Photo upload failed and its record could not be removed."); }
        throw error;
      }
    } else {
      S.photos.unshift({ ...row, photo_url: URL.createObjectURL(blob), id: uid(), captured_at: new Date().toISOString(), locked: false });
    }
  },
  async deletePhoto(id) {
    if (live()) {
      const photoRef = doc(db, "photos", id);
      const snapshot = await getDoc(photoRef);
      const photo = rowFromDoc(snapshot);
      if (!photo || photo.owner !== S.user.uid || photo.locked) throw new Error("This photo can't be removed.");
      await deleteObject(ref(storage, photo.storage_path));
      await deleteDoc(photoRef);
    }
    S.photos = S.photos.filter((p) => p.id !== id);
  },
  async lockPhotos(ids) {
    if (live()) {
      const batch = writeBatch(db);
      ids.forEach((id) => batch.update(doc(db, "photos", id), { locked: true, locked_at: serverTimestamp() }));
      await batch.commit();
      for (const id of ids) {
        const row = rowFromDoc(await getDoc(doc(db, "photos", id)));
        const i = S.photos.findIndex((p) => p.id === id);
        if (row && i > -1) S.photos[i] = row;
      }
    } else S.photos.forEach((p) => { if (ids.includes(p.id)) { p.locked = true; p.locked_at = new Date().toISOString(); } });
  },
  async addComplaint(c) {
    const row = { ...c, owner: S.user?.uid || null, resident_name: S.profile.name, room: S.tenancy.room, pg_code: S.tenancy.pg_code || null };
    if (live()) {
      const ref = await addDoc(collection(db, "complaints"), { ...row, status: "open", supporters: 1, reported_at: serverTimestamp(), fixed_at: null });
      S.complaints.unshift(rowFromDoc(await getDoc(ref)));
    } else S.complaints.unshift({ ...row, id: uid(), status: "open", supporters: 1, reported_at: new Date().toISOString() });
  },
  async setComplaintStatus(id, status) {
    if (live()) {
      const ref = doc(db, "complaints", id);
      await updateDoc(ref, { status, fixed_at: status === "fixed" ? serverTimestamp() : null });
      const row = rowFromDoc(await getDoc(ref));
      S.complaints = S.complaints.map((c) => (c.id === id ? row : c));
    } else S.complaints = S.complaints.map((c) => (c.id === id ? { ...c, status, fixed_at: status === "fixed" ? new Date().toISOString() : null } : c));
  },
  async pgOpen() {
    if (!live()) return demoPgOpen();
    if (!S.tenancy?.pg_code) return [];
    const { data } = await httpsCallable(functions, "listSimilarComplaints")({ code: S.tenancy.pg_code });
    return data.complaints || [];
  },
  async support(id) {
    if (!live()) return 0;
    const { data } = await httpsCallable(functions, "supportComplaint")({ id });
    return data.supporters;
  },
  async addDeduction(d) {
    if (live()) {
      const ref = await addDoc(collection(db, "deductions"), { ...d, owner: S.user.uid, created_at: serverTimestamp() });
      const row = rowFromDoc(await getDoc(ref));
      S.deductions.push(row);
      return row;
    }
    const r = { ...d, id: uid(), created_at: new Date().toISOString() }; S.deductions.push(r); return r;
  },
  async updateDeduction(id, patch) {
    if (live()) await updateDoc(doc(db, "deductions", id), patch);
    S.deductions = S.deductions.map((d) => (d.id === id ? { ...d, ...patch } : d));
  },
  async deleteDeduction(id) {
    if (live()) await deleteDoc(doc(db, "deductions", id));
    S.deductions = S.deductions.filter((d) => d.id !== id);
  },
  async saveNotices(obj) {
    if (live()) {
      const batch = writeBatch(db);
      Object.entries(obj).forEach(([kind, body]) => batch.set(doc(db, "users", S.user.uid, "notices", kind), { owner: S.user.uid, body, updated_at: serverTimestamp() }, { merge: true }));
      await batch.commit();
    }
    S.notices = { ...S.notices, ...obj };
  },
};

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
function go(screen) {
  S.screen = screen;
  const noPg = !S.tenancy;
  $$(".nav-item").forEach((b) => { b.classList.toggle("active", b.dataset.screen === screen); b.disabled = noPg; });
  $$(".screen").forEach((s) => s.classList.toggle("active", s.id === `s-${screen}`));
  $("#sidePg").textContent = S.tenancy?.pg_name || "Your PG";
  $("#sideRoom").textContent = S.tenancy ? `${S.tenancy.room} · ${rupee(S.tenancy.deposit)} deposit` : "Add your PG to start";
  ({ setup: renderSetup, dashboard: renderDashboard, scan: renderScan, complaints: renderComplaints, claim: renderClaim, notices: renderNotices })[screen]?.();
}
$$(".nav-item").forEach((b) => b.addEventListener("click", () => { go(b.dataset.screen); $("#app").scrollIntoView({ behavior: "smooth" }); }));

document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-go]");
  if (!a) return;
  e.preventDefault();
  if (a.dataset.go === "demo") startDemo();
  else if (S.mode === "demo") { exitDemo(); setAuthMode("signup"); }
  showView();
  $("#app").scrollIntoView({ behavior: "smooth" });
});

function startDemo() {
  Object.assign(S, { mode: "demo", user: null, screen: "dashboard", analysis: null }, demoData());
  sessionStorage.setItem("ff_demo", "1");
  showView();
  toast("Demo loaded: Riya's Room 204");
}
function exitDemo() {
  sessionStorage.removeItem("ff_demo");
  Object.assign(S, { mode: null, profile: null, tenancy: null, photos: [], complaints: [], deductions: [], notices: {}, screen: "dashboard" });
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
  $$(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.auth === m));
  $("#aSubmit").textContent = m === "signup" ? "Create account & continue" : "Log in";
  $("#aPass").autocomplete = m === "signup" ? "new-password" : "current-password";
  $("#aErr").textContent = "";
}
$$(".seg-btn").forEach((b) => b.addEventListener("click", () => setAuthMode(b.dataset.auth)));
$("#googleBtn").addEventListener("click", async () => {
  const btn = $("#googleBtn");
  busy(btn, true, "Opening Google…");
  $("#aErr").textContent = "";
  try {
    requireFirebase();
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await signInWithPopup(auth, provider);
  } catch (error) {
    const messages = {
      "auth/popup-blocked": "Your browser blocked the Google sign-in window. Allow pop-ups and try again.",
      "auth/popup-closed-by-user": "Google sign-in was cancelled.",
      "auth/unauthorized-domain": "This site isn't authorized for Firebase Authentication. Add its domain in Firebase Console.",
      "auth/operation-not-allowed": "Enable Google sign-in in Firebase Console under Authentication providers.",
    };
    $("#aErr").textContent = messages[error.code] || error.message || "Unable to start Google sign-in.";
  } finally { busy(btn, false); }
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
      const { user } = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(user, { displayName: name });
      await setDoc(doc(db, "profiles", user.uid), { name, phone: phone || "", created_at: serverTimestamp() });
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (ex) {
    const messages = {
      "auth/email-already-in-use": "This email already has an account. Log in instead.",
      "auth/invalid-credential": "Wrong email or password.",
      "auth/user-not-found": "Wrong email or password.",
      "auth/wrong-password": "Wrong email or password.",
      "auth/weak-password": "Password needs at least 6 characters.",
      "auth/invalid-email": "Enter a valid email.",
      "auth/unauthorized-domain": "This site isn't authorized for Firebase Authentication. Add its domain in Firebase Console.",
      "auth/operation-not-allowed": "Enable email/password sign-in in Firebase Console under Authentication providers.",
    };
    err(messages[ex.code] || ex.message || "Authentication failed.");
  } finally { busy(btn, false); }
});

async function onSession(user) {
  if (user) {
    sessionStorage.removeItem("ff_demo");
    S.mode = "live"; S.user = user;
    try { await loadLive(); } catch (e) { toast(e.message, true); }
  } else if (S.mode === "live") {
    exitDemo(); S.user = null;
  } else if (sessionStorage.getItem("ff_demo") && !S.mode) {
    return startDemo();
  }
  showView();
}
let authInitialized = false;
if (auth) onAuthStateChanged(auth, (user) => {
  if (user && S.mode === "live" && S.user?.uid === user.uid) return;
  const isInitialState = !authInitialized;
  authInitialized = true;
  void onSession(user).then(() => {
    if (user && !isInitialState) toast(`Welcome${S.profile?.name ? ", " + S.profile.name.split(" ")[0] : ""}!`);
  }).catch((error) => toast(error.message, true));
});

/* ================= setup ================= */
function renderSetup() {
  const t = S.tenancy;
  $("#setupTitle").textContent = t ? "PG details" : "Add your PG";
  $("#pgSave").textContent = t ? "Save PG details" : "Save PG & start move-in scan";
  $("#pgCancel").hidden = !t;
  $("#fPg").value = t?.pg_name || ""; $("#fRoom").value = t?.room || ""; $("#fOwner").value = t?.owner_name || "";
  $("#fOwnerPhone").value = t?.owner_phone || ""; $("#fAddr").value = t?.address || ""; $("#fRent").value = t?.monthly_rent || "";
  $("#fDep").value = t?.deposit || ""; $("#fIn").value = t?.move_in || ""; $("#fOut").value = t?.move_out || ""; $("#fCode").value = t?.pg_code || "";
  $("#pgErr").textContent = "";
}
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
    if (t.pg_code && live()) {
      if (!(await getDoc(doc(db, "pgs", t.pg_code))).exists()) { busy(btn, false); return err("That PG code isn't registered. Leave it empty, or try SUNRISE24."); }
    }
    const first = !S.tenancy;
    await api.saveTenancy(t);
    toast(first ? "PG added! Let's scan your room." : "PG details updated.");
    go(first ? "scan" : "dashboard");
  } catch (ex) { err(ex.message); }
  finally { busy(btn, false); }
});

/* ================= numbers ================= */
function money() {
  const ds = S.deductions;
  const sum = (v) => ds.filter((d) => d.ai_verdict === v).reduce((s, d) => s + d.amount, 0);
  const total = ds.reduce((s, d) => s + d.amount, 0);
  const unfair = sum("unfair"), unclear = sum("unclear"), fair = sum("fair");
  const deposit = S.tenancy?.deposit || 0;
  return { total, unfair, unclear, fair, disputed: unfair + unclear, refund: Math.max(0, deposit - fair - ds.filter((d) => !d.ai_verdict).reduce((s, d) => s + d.amount, 0)), deposit };
}

/* ================= dashboard ================= */
function renderDashboard() {
  const t = S.tenancy, m = money();
  const open = S.complaints.filter((c) => c.status !== "fixed");
  const locked = S.photos.filter((p) => p.locked);
  $("#hello").textContent = `Hi ${S.profile?.name?.split(" ")[0] || "there"}, here's your stay at ${t.pg_name}`;
  $("#dDeposit").textContent = rupee(t.deposit);
  $("#dDepositSub").textContent = `Rent ${rupee(t.monthly_rent)}/month · since ${fmtDate(t.move_in)}`;
  $("#dProtected").textContent = rupee(m.unfair);
  $("#dProtectedSub").textContent = S.deductions.length ? `${S.deductions.filter((d) => d.ai_verdict === "unfair").length} unfair deduction(s) caught` : "No move-out deductions logged";
  $("#dOpen").textContent = open.length;
  const longest = open.reduce((mx, c) => Math.max(mx, daysSince(c.reported_at)), 0);
  $("#dOpenSub").textContent = open.length ? `Longest unfixed: ${longest} day${longest === 1 ? "" : "s"}` : "All logged issues resolved";
  $("#dPhotos").textContent = `${locked.length} locked`;
  const covered = new Set(locked.map((p) => p.area));
  $("#dPhotosSub").textContent = `${covered.size} of ${AREAS.length} areas · ${S.photos.length - locked.length} pending`;
  const steps = [
    ["Add your PG details", true, null],
    ["Scan & lock move-in photos (3+ areas)", covered.size >= 3, "scan"],
    ["Log issues as they happen", S.complaints.length > 0, "complaints"],
    ["Add deductions at move-out", S.deductions.length > 0, "claim"],
    ["Generate your refund notices", Object.keys(S.notices).length > 0, "notices"],
  ];
  $("#dSteps").innerHTML = steps.map(([label, done, scr]) => `<li class="${done ? "done" : ""}"><span>${esc(label)}</span>${!done && scr ? `<button class="btn small ghost" data-jump="${scr}">Start</button>` : ""}</li>`).join("");
  $("#dIssues").innerHTML = open.length
    ? open.sort((a, b) => new Date(a.reported_at) - new Date(b.reported_at)).slice(0, 4).map((c) => `<div class="mini"><span>${esc(c.title)}</span><b>${daysSince(c.reported_at)}d</b></div>`).join("")
    : `<div class="empty-list">Nothing open. Nice.</div>`;
}
document.addEventListener("click", (e) => { const j = e.target.closest("[data-jump]"); if (j) go(j.dataset.jump); });

/* ================= scan ================= */
function renderScan() {
  const counts = Object.fromEntries(AREAS.map((a) => [a, S.photos.filter((p) => p.area === a).length]));
  $("#areaPick").innerHTML = AREAS.map((a) => `<button type="button" class="area ${a === S.area ? "active" : ""}" data-area="${a}">${cap(a)}${counts[a] ? `<span class="n">${counts[a]}</span>` : ""}</button>`).join("");
  $("#dropText").textContent = `Capture or upload ${S.area} photo`;
  const pending = S.photos.filter((p) => !p.locked);
  const lb = $("#lockBtn");
  lb.disabled = !pending.length;
  lb.textContent = pending.length ? `Lock move-in record (${pending.length})` : S.photos.length ? "All photos locked" : "Lock move-in record";
  $("#photoGrid").innerHTML = S.photos.length ? S.photos.map((p) => `
    <article class="photo" data-id="${p.id}">
      <img src="${esc(p.photo_url)}" alt="${esc(p.area)} move-in photo" data-zoom="${esc(p.photo_url)}" loading="lazy" />
      <div class="pb">
        <h5>${esc(p.area)} ${p.locked ? `<span class="badge lock">🔒 Locked</span>` : `<span class="badge ghost">Pending lock</span>`}</h5>
        <div class="tags">${(p.ai_tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("") || `<span class="stamp">No defects tagged</span>`}</div>
        <p>${esc(p.ai_summary)}</p>
        <span class="stamp">Captured ${fmtStamp(p.captured_at)}${p.locked_at ? ` · locked ${fmtStamp(p.locked_at)}` : ""}</span>
        ${p.locked ? "" : `<button type="button" class="link" data-del="${p.id}">Remove before lock</button>`}
      </div>
    </article>`).join("") : `<div class="empty-list" style="grid-column:1/-1">No photos yet. Start with the wall: stains and cracks are the most common deduction.</div>`;
}
$("#areaPick").addEventListener("click", (e) => { const b = e.target.closest("[data-area]"); if (b) { S.area = b.dataset.area; renderScan(); } });
async function handlePhoto(file) {
  if (!file) return;
  $("#scanErr").textContent = "";
  if (file.size > 5 * 1024 * 1024) return ($("#scanErr").textContent = "That photo is over 5 MB. Try a smaller one.");
  const drop = $("#drop");
  drop.classList.add("busy");
  $("#dropText").textContent = "Uploading and analysing defects with Gemini…";
  try { await api.addPhoto(file, S.area); toast("Photo scanned with Gemini."); }
  catch (ex) { $("#scanErr").textContent = ex.message || "Upload or AI inspection failed."; }
  finally { drop.classList.remove("busy"); $("#photoInput").value = ""; renderScan(); }
}
$("#photoInput").addEventListener("change", (e) => handlePhoto(e.target.files[0]));
const drop = $("#drop");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => handlePhoto(e.dataTransfer.files[0]));
$("#photoGrid").addEventListener("click", async (e) => {
  const d = e.target.closest("[data-del]");
  if (!d) return;
  try { await api.deletePhoto(d.dataset.del); toast("Photo removed."); renderScan(); } catch (ex) { toast(ex.message, true); }
});
$("#lockBtn").addEventListener("click", () => {
  const n = S.photos.filter((p) => !p.locked).length;
  $("#lockText").textContent = `Locking stamps the server date and time on ${n} photo(s) and makes them permanently read-only. You can still add more areas later, but locked photos can't be changed or deleted, even by you.`;
  $("#lockDlg").showModal();
});
$("#lockCancel").addEventListener("click", () => $("#lockDlg").close());
$("#lockConfirm").addEventListener("click", async () => {
  const btn = $("#lockConfirm");
  busy(btn, true, "Locking…");
  try { await api.lockPhotos(S.photos.filter((p) => !p.locked).map((p) => p.id)); toast("Move-in record locked with timestamp."); }
  catch (ex) { toast(ex.message, true); }
  finally { busy(btn, false); $("#lockDlg").close(); renderScan(); }
});

/* ================= complaints ================= */
$("#fCat").innerHTML += CATS.map((c) => `<option>${c}</option>`).join("");
function renderComplaints() {
  const open = S.complaints.filter((c) => c.status !== "fixed").length;
  $("#cCount").textContent = `${open} open issue${open === 1 ? "" : "s"} tracked with live day counters`;
  const fs = $("#fStatus").value, fc = $("#fCat").value;
  const list = S.complaints.filter((c) => (!fs || c.status === fs) && (!fc || c.category === fc));
  const phone = (S.tenancy?.owner_phone || "").replace(/\D/g, "");
  $("#cList").innerHTML = list.length ? list.map((c) => {
    const d = daysSince(c.reported_at), fixed = c.status === "fixed";
    const took = fixed && c.fixed_at ? daysSince(c.reported_at, c.fixed_at) : 0;
    const msg = c.draft || `Hi ${S.tenancy?.owner_name || ""}, reminder about my complaint "${c.title}" (Room ${S.tenancy?.room}), reported on ${fmtDate(c.reported_at)}. It has been unfixed for ${d} days. Please fix it soon.`;
    return `<article class="item" data-id="${c.id}">
      <div>
        <div class="badges"><span class="badge">${esc(c.category)}</span><span class="badge ${esc(c.urgency)}">${esc(c.urgency)}</span><span class="badge ${esc(c.status)}">${STATUS_LABEL[c.status]}</span>${c.supporters > 1 ? `<span class="badge ghost">+${c.supporters - 1} residents</span>` : ""}</div>
        <h4>${esc(c.title)}</h4>
        <p>${esc(c.description)}</p>
        ${c.photo_url ? `<img class="thumb" src="${esc(c.photo_url)}" alt="Complaint photo" data-zoom="${esc(c.photo_url)}" />` : ""}
        <div class="meta">Reported ${fmtStamp(c.reported_at)}${c.warden_note ? ` · Warden: ${esc(c.warden_note)}` : ""}</div>
        <div class="acts">
          ${fixed ? "" : `<button class="btn small primary" data-fix="${c.id}">Mark fixed</button>`}
          <button class="btn small ghost" data-copy="${encodeURIComponent(msg)}">Copy message</button>
          ${phone && !fixed ? `<a class="btn small ghost" target="_blank" rel="noopener noreferrer" href="https://wa.me/${phone}?text=${encodeURIComponent(msg)}">WhatsApp owner</a>` : ""}
        </div>
      </div>
      <div class="days ${fixed ? "done" : d >= 3 ? "hot" : ""}">${fixed ? `<b>Fixed</b><span>on ${fmtDate(c.fixed_at)} · took ${took}d</span>` : `<b>${d}</b><span>day${d === 1 ? "" : "s"} unfixed</span>`}</div>
    </article>`;
  }).join("") : `<div class="empty-list">${S.complaints.length ? "No matching complaints. Try clearing the filters." : "No complaints yet. Log the first one above."}</div>`;
}
$("#fStatus").addEventListener("change", renderComplaints);
$("#fCat").addEventListener("change", renderComplaints);
$("#cExamples").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (c) { $("#cText").value = c.textContent; $("#cText").focus(); } });
$("#cPhoto").addEventListener("change", (e) => {
  S.cPhoto = e.target.files[0] || null;
  $("#cPhotoLbl").textContent = S.cPhoto ? `📎 ${S.cPhoto.name} (change)` : "📎 Attach photo (optional)";
});
$("#cAnalyze").addEventListener("click", async () => {
  const text = $("#cText").value.trim();
  $("#cErr").textContent = "";
  if (text.length < 5) return ($("#cErr").textContent = "Describe the issue in a few words first.");
  const btn = $("#cAnalyze");
  busy(btn, true, "Analysing…");
  let out;
  try { out = await ai("analyze", { text, resident: S.profile?.name, room: S.tenancy?.room, pg: S.tenancy?.pg_name }); }
  catch { out = localAnalyze(text); }
  S.analysis = { ...out, text };
  $("#cEmpty").hidden = true; $("#cBody").hidden = false;
  $("#rCat").textContent = out.category;
  $("#rUrg").textContent = out.urgency; $("#rUrg").className = `badge ${out.urgency}`;
  $("#rMode").hidden = !out.offline;
  $("#rTitle").value = out.title; $("#rDraft").value = out.draft;
  busy(btn, false);
  // similar open issues in the same PG
  const box = $("#similar");
  box.hidden = true;
  try {
    const sim = (await api.pgOpen()).filter((x) => x.category === out.category && !S.complaints.some((c) => c.id === x.id));
    if (sim.length) {
      box.innerHTML = `<b>Others in your PG reported something similar</b>` + sim.slice(0, 3).map((x) => `<div class="s-row"><span>${esc(x.title)} · ${x.supporters} resident${x.supporters === 1 ? "" : "s"}</span><button class="btn small ghost" data-support="${x.id}">+1 me too</button></div>`).join("");
      box.hidden = false;
    }
  } catch {}
});
$("#similar").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-support]");
  if (!b) return;
  try { const n = await api.support(b.dataset.support); b.textContent = "Added ✓"; b.disabled = true; toast(n ? `Added your voice: ${n} residents now` : "Added your voice to this complaint"); }
  catch (ex) { toast(ex.message, true); }
});
$("#cDiscard").addEventListener("click", resetComposer);
function resetComposer() {
  S.analysis = null; S.cPhoto = null;
  $("#cText").value = ""; $("#cPhoto").value = ""; $("#cPhotoLbl").textContent = "📎 Attach photo (optional)";
  $("#cEmpty").hidden = false; $("#cBody").hidden = true; $("#similar").hidden = true;
}
$("#cSave").addEventListener("click", async () => {
  if (!S.analysis) return;
  const btn = $("#cSave");
  busy(btn, true, "Saving…");
  try {
    let photo_url = null;
    let photo_path = null;
    if (S.cPhoto) {
      const { blob } = await compress(S.cPhoto);
      if (live()) {
        photo_path = `users/${S.user.uid}/complaints/${Date.now()}-${uid()}.jpg`;
        await uploadBytes(ref(storage, photo_path), blob, { contentType: "image/jpeg" });
        photo_url = await getDownloadURL(ref(storage, photo_path));
      } else photo_url = URL.createObjectURL(blob);
    }
    await api.addComplaint({ category: S.analysis.category, urgency: S.analysis.urgency, title: $("#rTitle").value.trim() || S.analysis.title, description: S.analysis.text, draft: $("#rDraft").value, photo_url, photo_path });
    toast("Complaint logged. The day counter has started.");
    resetComposer(); renderComplaints();
  } catch (ex) { toast(ex.message, true); }
  finally { busy(btn, false); }
});
$("#cList").addEventListener("click", async (e) => {
  const f = e.target.closest("[data-fix]"), c = e.target.closest("[data-copy]");
  if (f) {
    busy(f, true, "Saving…");
    try { await api.setComplaintStatus(f.dataset.fix, "fixed"); toast("Marked fixed."); renderComplaints(); }
    catch (ex) { toast(ex.message, true); busy(f, false); }
  }
  if (c) {
    try { await navigator.clipboard.writeText(decodeURIComponent(c.dataset.copy)); toast("Copied."); }
    catch { toast("Couldn't access the clipboard. Select and copy manually.", true); }
  }
});

// voice input
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
$("#micBtn").addEventListener("click", () => {
  if (!SR) return toast("Voice input isn't supported in this browser. Try Chrome.", true);
  const mic = $("#micBtn");
  if (mic._rec) { mic._rec.stop(); return; }
  const rec = new SR();
  rec.lang = "en-IN"; rec.interimResults = true;
  const base = $("#cText").value ? $("#cText").value + " " : "";
  rec.onresult = (e) => { $("#cText").value = base + [...e.results].map((r) => r[0].transcript).join(""); };
  rec.onend = () => { mic.classList.remove("rec"); mic._rec = null; };
  rec.onerror = () => toast("Couldn't hear that. Check mic permission.", true);
  mic._rec = rec; mic.classList.add("rec"); rec.start();
});

/* ================= deposit claim ================= */
function renderClaim() {
  const m = money();
  $("#kTotal").textContent = rupee(m.total);
  $("#kDispute").textContent = rupee(m.disputed);
  $("#kRefund").textContent = rupee(m.refund);
  $("#kRefundSub").textContent = `${rupee(m.deposit)} deposit − ${rupee(m.deposit - m.refund)} fair deductions`;
  $("#auditBtn").disabled = !S.deductions.length;
  $("#dedList").innerHTML = S.deductions.length ? S.deductions.map((d) => {
    const ph = S.photos.find((p) => p.id === d.matched_photo_id);
    const v = d.ai_verdict || "pending";
    return `<article class="ded ${v}">
      <div>
        <h4><span>${esc(d.reason)}</span><span class="amt">${rupee(d.amount)}</span></h4>
        <span class="verdict ${v}">${v === "unfair" ? "Unfair deduction" : v === "fair" ? "Fair deduction" : v === "unclear" ? "Unclear — needs proof" : "Not audited yet"}</span>
        <p>${esc(d.ai_reason || "Run the AI audit to check this against your move-in photos.")}</p>
        <button type="button" class="link" data-ddel="${d.id}">Remove</button>
      </div>
      ${ph ? `<div><img src="${esc(ph.photo_url)}" alt="Matched move-in photo" data-zoom="${esc(ph.photo_url)}" /><div class="proof">🔒 ${esc(ph.area)} · ${fmtDate(ph.captured_at)}</div></div>` : `<div class="proof" style="align-self:center">No matching move-in photo</div>`}
    </article>`;
  }).join("") : `<div class="empty-list">No move-out deductions yet. Add each charge the owner listed and FixFlow checks it against your locked photos.</div>`;
}
async function audit(ids) {
  const deds = S.deductions.filter((d) => !ids || ids.includes(d.id));
  if (!deds.length) return;
  const photos = S.photos.filter((p) => p.locked).map((p) => ({ id: p.id, area: p.area, tags: p.ai_tags, summary: p.ai_summary, capturedAt: p.captured_at }));
  const complaints = S.complaints.filter((c) => c.status !== "fixed").map((c) => ({ title: c.title, category: c.category, daysUnfixed: daysSince(c.reported_at) }));
  let results;
  try { results = (await ai("audit", { deductions: deds.map((d) => ({ id: d.id, reason: d.reason, amount: d.amount })), photos, complaints, deposit: S.tenancy.deposit })).results; }
  catch { results = localAudit(deds); }
  for (const d of deds) {
    const r = results.find((x) => x.id === d.id) || localAudit([d])[0];
    const verdict = ["fair", "unfair", "unclear"].includes(r.verdict) ? r.verdict : "unclear";
    const matched = photos.some((p) => p.id === r.matchedPhotoId) ? r.matchedPhotoId : null;
    await api.updateDeduction(d.id, { ai_verdict: verdict, ai_reason: String(r.reason || ""), matched_photo_id: matched });
  }
}
$("#dedForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const reason = $("#dReason").value.trim(), amount = Math.round(Number($("#dAmount").value));
  const err = (m) => ($("#dErr").textContent = m);
  err("");
  if (reason.length < 4) return err("Describe the deduction as the owner wrote it.");
  if (!(amount > 0)) return err("Enter the amount deducted.");
  const btn = $("#dAdd");
  busy(btn, true, "Auditing…");
  try {
    const d = await api.addDeduction({ reason, amount });
    $("#dReason").value = ""; $("#dAmount").value = "";
    await audit([d.id]);
    const v = S.deductions.find((x) => x.id === d.id)?.ai_verdict;
    toast(v === "unfair" ? "Unfair deduction caught!" : "Deduction audited.");
  } catch (ex) { err(ex.message); }
  finally { busy(btn, false); renderClaim(); }
});
$("#auditBtn").addEventListener("click", async () => {
  const btn = $("#auditBtn");
  busy(btn, true, "Re-auditing…");
  try { await audit(); toast("All deductions re-audited."); } catch (ex) { toast(ex.message, true); }
  finally { busy(btn, false); renderClaim(); }
});
$("#dedList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-ddel]");
  if (!b) return;
  try { await api.deleteDeduction(b.dataset.ddel); toast("Deduction removed."); renderClaim(); } catch (ex) { toast(ex.message, true); }
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
    disputedList: S.deductions.filter((d) => d.ai_verdict === "unfair" || d.ai_verdict === "unclear"),
    firstPhoto: S.photos.filter((p) => p.locked).map((p) => p.captured_at).sort()[0],
  };
}
function renderNotices() {
  const ctx = noticeCtx();
  const has = Object.keys(S.notices).length > 0;
  $("#nContext").textContent = ctx.disputed
    ? `You're disputing ${rupee(ctx.disputed)} across ${ctx.disputedList.length} deduction(s), backed by ${S.photos.filter((p) => p.locked).length} locked photo(s) and ${S.complaints.filter((c) => c.status !== "fixed").length} unfixed complaint(s).`
    : "Add and audit deductions on the Deposit claim screen first. The notices quote that evidence.";
  $("#genBtn").textContent = has ? "Regenerate all 3" : "Generate 3 drafts";
  $("#pdfBtn").disabled = !has;
  const phone = (S.tenancy?.owner_phone || "").replace(/\D/g, "");
  $("#nList").innerHTML = KINDS.map(([k, title, sub], i) => `
    <div class="card notice" data-kind="${k}">
      <h4><span>0${i + 1}</span>${title}</h4><small>${sub}</small>
      <textarea aria-label="${title}" placeholder="Generate drafts to fill this in.">${esc(S.notices[k] || "")}</textarea>
      <div class="row">
        <button type="button" class="btn small ghost" data-ncopy="${k}">Copy text</button>
        ${k === "whatsapp" && phone ? `<button type="button" class="btn small ghost" data-nwa="${k}">Open in WhatsApp</button>` : ""}
        <button type="button" class="btn small ghost" data-nsave="${k}">Save edits</button>
      </div>
    </div>`).join("");
}
$("#genBtn").addEventListener("click", async () => {
  const ctx = noticeCtx();
  if (!ctx.disputed) { toast("Add deductions on the Deposit claim screen first.", true); return go("claim"); }
  const btn = $("#genBtn");
  busy(btn, true, "Writing drafts…");
  let out;
  try {
    out = await ai("notices", {
      tenant: S.profile.name, tenancy: S.tenancy, disputed: ctx.disputed,
      photos: S.photos.filter((p) => p.locked).map((p) => ({ area: p.area, tags: p.ai_tags, lockedOn: fmtDate(p.captured_at) })),
      complaints: S.complaints.filter((c) => c.status !== "fixed").map((c) => ({ title: c.title, reportedOn: fmtDate(c.reported_at), daysUnfixed: daysSince(c.reported_at) })),
      deductions: S.deductions.map((d) => ({ reason: d.reason, amount: d.amount, verdict: d.ai_verdict, why: d.ai_reason })),
    });
    if (!out.whatsapp || !out.formal || !out.grievance) throw new Error("incomplete");
  } catch { out = localNotices(ctx); }
  try { await api.saveNotices({ whatsapp: out.whatsapp, formal: out.formal, grievance: out.grievance }); toast("All 3 notice drafts generated."); }
  catch (ex) { toast(ex.message, true); }
  finally { busy(btn, false); renderNotices(); }
});
$("#nList").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const k = b.dataset.ncopy || b.dataset.nwa || b.dataset.nsave;
  const text = $(`.notice[data-kind="${k}"] textarea`).value;
  if (b.dataset.ncopy) {
    try { await navigator.clipboard.writeText(text); toast("Copied."); } catch { toast("Couldn't access the clipboard. Select and copy manually.", true); }
  } else if (b.dataset.nwa) {
    window.open(`https://wa.me/${S.tenancy.owner_phone.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`, "_blank", "noopener");
  } else if (b.dataset.nsave) {
    if (text.trim().length < 10) return toast("Draft can't be shorter than 10 characters.", true);
    try { await api.saveNotices({ [k]: text }); toast("Draft edits saved."); } catch (ex) { toast(ex.message, true); }
  }
});
$("#pdfBtn").addEventListener("click", async () => {
  const btn = $("#pdfBtn");
  busy(btn, true, "Building PDF…");
  try {
    const { jsPDF } = await import("https://esm.sh/jspdf@2.5.1");
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const clean = (s) => String(s || "").replace(/₹/g, "Rs ").replace(/[–—]/g, "-").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[^\x00-\xFF]/g, "");
    const W = 515; let y = 56;
    const line = (txt, size = 10.5, bold = false, gap = 6) => {
      doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(size);
      for (const l of doc.splitTextToSize(clean(txt), W)) { if (y > 790) { doc.addPage(); y = 56; } doc.text(l, 40, y); y += size * 1.35; }
      y += gap;
    };
    const t = S.tenancy, m = money();
    line("FixFlow - Deposit evidence & notice", 18, true, 4);
    line(`Generated ${fmtStamp(Date.now())}`, 9, false, 14);
    line(`${S.profile.name} · ${t.room}, ${t.pg_name}${t.address ? ", " + t.address : ""}`, 11, true);
    line(`Deposit ${rupee(t.deposit)} · Move-in ${fmtDate(t.move_in)}${t.move_out ? " · Move-out " + fmtDate(t.move_out) : ""}`, 10, false, 12);
    line("Locked move-in evidence", 12, true, 2);
    S.photos.filter((p) => p.locked).forEach((p) => line(`• ${cap(p.area)} (locked ${fmtStamp(p.locked_at || p.captured_at)}): ${p.ai_tags.join(", ") || "no defects"}. ${p.ai_summary}`, 10, false, 2));
    y += 8; line("Deduction audit", 12, true, 2);
    S.deductions.forEach((d) => line(`• ${d.reason} - ${rupee(d.amount)} - ${(d.ai_verdict || "not audited").toUpperCase()}: ${d.ai_reason || ""}`, 10, false, 2));
    line(`Disputed: ${rupee(m.disputed)} · Refund due: ${rupee(m.refund)}`, 11, true, 14);
    KINDS.forEach(([k, title]) => { if (S.notices[k]) { line(title, 12, true, 2); line(S.notices[k], 10, false, 12); } });
    line("FixFlow helps you communicate with evidence. It is not legal advice.", 8.5);
    doc.save(`FixFlow-${t.room.replace(/\W+/g, "-")}-deposit-notice.pdf`);
    toast("PDF downloaded.");
  } catch (ex) { toast("Couldn't build the PDF: " + ex.message, true); }
  finally { busy(btn, false); }
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
    const { data } = await httpsCallable(functions, "checkWardenPin")({ code, pin });
    if (!data.ok) { $("#wBoard").hidden = true; $("#wErr").textContent = "Wrong PG code or PIN."; return; }
    W = { code, pin };
    await loadWarden();
  } catch (error) {
    $("#wBoard").hidden = true;
    $("#wErr").textContent = error.message || "Unable to verify the PG PIN.";
  } finally { busy(btn, false); }
});
async function loadWarden() {
  const { data } = await httpsCallable(functions, "listWardenComplaints")({ code: W.code, pin: W.pin });
  const rank = { open: 0, in_progress: 1, fixed: 2 };
  const list = data.complaints.sort((a, b) => rank[a.status] - rank[b.status] || URG[a.urgency] - URG[b.urgency] || b.supporters - a.supporters || new Date(a.reported_at) - new Date(b.reported_at));
  const n = (s) => list.filter((c) => c.status === s).length;
  $("#wStats").innerHTML = `<div class="stat warn"><span>Open</span><b>${n("open")}</b></div><div class="stat"><span>In progress</span><b>${n("in_progress")}</b></div><div class="stat good"><span>Fixed</span><b>${n("fixed")}</b></div>`;
  $("#wList").innerHTML = list.map((c) => {
    const d = daysSince(c.reported_at), fixed = c.status === "fixed";
    return `<article class="item">
      <div>
        <div class="badges"><span class="badge">${esc(c.category)}</span><span class="badge ${esc(c.urgency)}">${esc(c.urgency)}</span><span class="badge ${esc(c.status)}">${STATUS_LABEL[c.status]}</span>${c.supporters > 1 ? `<span class="badge ghost">${c.supporters} residents</span>` : ""}</div>
        <h4>${esc(c.title)}</h4><p>${esc(c.description)}</p>
        <div class="meta">${esc(c.resident_name)} · Room ${esc(c.room || "-")} · ${fmtStamp(c.reported_at)}</div>
        ${fixed ? "" : `<div class="acts">${c.status === "open" ? `<button class="btn small ghost" data-w="${c.id}" data-s="in_progress">Start work</button>` : ""}<button class="btn small primary" data-w="${c.id}" data-s="fixed">Mark fixed</button></div>`}
      </div>
      <div class="days ${fixed ? "done" : d >= 3 ? "hot" : ""}">${fixed ? `<b>Fixed</b><span>${fmtDate(c.fixed_at)}</span>` : `<b>${d}</b><span>day${d === 1 ? "" : "s"} open</span>`}</div>
    </article>`;
  }).join("") || `<div class="empty-list">No complaints in this PG yet.</div>`;
  $("#wBoard").hidden = false;
}
$("#wList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-w]");
  if (!b) return;
  busy(b, true, "Saving…");
  try {
    await httpsCallable(functions, "setWardenComplaintStatus")({ code: W.code, pin: W.pin, id: b.dataset.w, status: b.dataset.s });
    toast(b.dataset.s === "fixed" ? "Marked fixed. The resident sees it now." : "Marked in progress.");
    await loadWarden(); loadHeroStats();
  } catch (error) { toast(error.message, true); }
  finally { busy(b, false); }
});

/* ================= boot ================= */
new IntersectionObserver(([e]) => document.body.classList.toggle("in-app", e.isIntersecting), { rootMargin: "0px 0px -30% 0px" }).observe($("#app"));
setAuthMode("signup");
loadHeroStats();
