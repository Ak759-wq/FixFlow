"""FixFlow v3 (Firebase) end-to-end test (Playwright).
Local (full run, against the Firebase emulators):
    firebase emulators:start --only auth,firestore,storage --project demo-fixflow
    FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 node scripts/seed-demo.mjs demo-fixflow
    NODE_USE_ENV_PROXY=1 node dev-server.js
    python3 tests/e2e.py http://localhost:3000
Live URL: landing, demo, privacy and mobile journeys run by default; add FF_E2E_BACKEND=1 to also run the
account journeys against the real Firebase project (needs Auth providers, Firestore, Storage, rules and seed in place).
"""
import asyncio, sys, time, os, re, json, hashlib
from playwright.async_api import async_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000").rstrip("/")
LOCAL = "localhost" in BASE or "127.0.0.1" in BASE
BACKEND = LOCAL or os.environ.get("FF_E2E_BACKEND") == "1"
IMG = "/workspace/test_room.png"
IMG2 = os.path.join(os.path.dirname(__file__), "..", "public", "img", "demo", "bathroom.webp")
SHOTS = "/workspace/work/fixflow_shots"
TAG = os.environ.get("SHOT_TAG", "v3")
os.makedirs(SHOTS, exist_ok=True)
IMG_SHA = hashlib.sha256(open(IMG, "rb").read()).hexdigest()
results = []
from urllib.parse import urlparse
proxy = None
_px = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
if _px:
    u = urlparse(_px)
    proxy = {"server": f"{u.scheme}://{u.hostname}:{u.port}", "bypass": "localhost,127.0.0.1"}
    if u.username: proxy.update(username=u.username, password=u.password or "")

def check(name, ok, info=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{info}]" if info else ""), flush=True)

async def soft(name, coro):
    """Run a step; record a failure instead of aborting the whole run."""
    try:
        return await coro
    except Exception as e:
        check(name, False, f"{e.__class__.__name__}: {str(e)[:160]}")
        return None

async def shot(pg, name, full=False):
    try:
        await pg.wait_for_function("!document.querySelector('#toast') || !document.querySelector('#toast').classList.contains('show')", timeout=8000)
        await pg.wait_for_timeout(450)
    except Exception:
        pass
    try:
        await pg.screenshot(path=f"{SHOTS}/{name}.png", full_page=full, timeout=15000)
    except Exception as e:
        print("  (screenshot skipped:", e.__class__.__name__, ")")

N = lambda s: int(re.sub(r"\D", "", s or "") or 0)

CLIENT = """async ({email, pw}) => {
  const G = 'https://www.gstatic.com/firebasejs/10.14.1/firebase-';
  const [A, Au, F, St] = await Promise.all(['app', 'auth', 'firestore', 'storage'].map((m) => import(G + m + '.js')));
  const emu = /^(localhost|127\\.0\\.0\\.1)$/.test(location.hostname) && localStorage.getItem('ff_emu') === '1';
  const cfg = emu ? { ...FF_CONFIG.FIREBASE_CONFIG, projectId: 'demo-fixflow', authDomain: 'demo-fixflow.firebaseapp.com', storageBucket: 'demo-fixflow.appspot.com' } : FF_CONFIG.FIREBASE_CONFIG;
  const app = A.initializeApp(cfg, 't' + Math.random());
  const a = Au.getAuth(app), d = F.getFirestore(app), s = St.getStorage(app);
  if (emu) { Au.connectAuthEmulator(a, 'http://127.0.0.1:9099', { disableWarnings: true }); F.connectFirestoreEmulator(d, '127.0.0.1', 8085); St.connectStorageEmulator(s, '127.0.0.1', 9199); }
  let user = null;
  if (email) { try { user = (await Au.signInWithEmailAndPassword(a, email, pw)).user; } catch (e) { return { loginError: e.code }; } }
  const ok = async (p) => { try { await p; return true; } catch (e) { return false; } };
  return await (CODE)({ a, d, s, F, St, user, ok });
}"""
async def client(pg, body, email=None, pw=None):
    return await pg.evaluate(CLIENT.replace("CODE", body), {"email": email, "pw": pw})

import urllib.request
def emu_get(url):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(url, headers={"Authorization": "Bearer owner"})
    return json.loads(op.open(req, timeout=10).read() or b"{}")

async def main():
    ts = int(time.time())
    email_a, email_b, pw = f"fftest{ts}a@fixflowdemo.dev", f"fftest{ts}b@fixflowdemo.dev", "testpass123"
    async with async_playwright() as p:
        b = await p.chromium.launch(proxy=proxy, args=["--ignore-certificate-errors"])
        ctx = await b.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and "favicon" not in m.text else None)
        pg.set_default_timeout(45000)

        # ================= landing =================
        await pg.goto(BASE + ("/?emu=1" if LOCAL else ""), wait_until="networkidle")
        await pg.wait_for_timeout(1500)
        check("hero quick headline + CTAs visible on load", await pg.is_visible("#heroQuick") and "Your PG. Your Proof. Your Deposit Protected." in await pg.inner_text("#heroQuick")
              and await pg.locator("#heroQuick .btn").count() == 2)
        body = await pg.inner_text("body")
        check("no unsourced numbers / placeholder claims", "₹5k" not in body and "typically lost" not in body and "avg. days" not in body)
        check("3-step flow present", all(t in body for t in ["Move-in evidence", "Complaint tracking", "Deposit protection"]))
        check("verified facts cite sources", await pg.locator(".why a[href*='mohua.gov.in']").count() == 1 and await pg.locator(".why a[href*='consumerhelpline.gov.in']").count() == 1)
        hrefs = await pg.eval_on_selector_all("header a[href], footer a[href]", "els => els.map(e => e.getAttribute('href'))")
        missing = [h for h in hrefs if h.startswith("#") and h != "#top" and not await pg.locator(h).count()]
        check("all nav anchors resolve", not missing and "/privacy" in hrefs, str(missing))
        await shot(pg, f"{TAG}_hero")
        await pg.evaluate("window.scrollTo(0, document.querySelector('.hero').offsetHeight*0.55)")
        await pg.wait_for_timeout(600)
        op = await pg.evaluate("getComputedStyle(document.querySelector('.hero-copy')).opacity")
        check("scroll reveals headline", float(op) > 0.5 and "Protected" in await pg.inner_text(".hero-copy .headline"), op)
        await shot(pg, f"{TAG}_hero_scrolled")

        # privacy page
        r = await pg.request.get(BASE + "/privacy")
        ptxt = await r.text()
        check("/privacy page served", r.status == 200 and "Correction &amp; deletion policy" in ptxt and "Delete my account" in ptxt and "Gemini" in ptxt, r.status)

        # ================= demo =================
        await pg.goto(BASE, wait_until="networkidle")
        await pg.click("#heroQuick [data-go=demo]")
        await pg.wait_for_selector("#s-dashboard.active")
        check("demo labelled fictional", "fictional" in (await pg.inner_text("#demoBar")).lower())
        check("demo deposit prominent", (await pg.inner_text("#dDeposit")) == "₹20,000" and await pg.is_visible(".deposit-hero"))
        check("demo protected ₹4,500", (await pg.inner_text("#dProtected")) == "₹4,500")
        check("PG details + last updated shown", "Owner" in await pg.inner_text("#dPg") and "Last updated" in await pg.inner_text("#dUpdated"))
        check("tabs: PG details, scan, complaints, audit, notices", [t.strip() for t in await pg.eval_on_selector_all(".nav-item .l", "e=>e.map(x=>x.textContent)")] == ["PG details", "Move-in scan", "Complaints", "Deposit audit", "Notices"])
        await pg.evaluate("window.scrollTo(0, document.querySelector('#appView').getBoundingClientRect().top + scrollY - 76)")
        await pg.wait_for_timeout(500)
        await shot(pg, f"{TAG}_dashboard")
        await pg.click(".nav-item[data-screen=scan]")
        check("scan areas Bedroom/Bathroom/Walls/Furniture", [re.sub(r"\d", "", t).strip() for t in await pg.eval_on_selector_all(".area", "e=>e.map(x=>x.textContent)")] == ["Bedroom", "Bathroom", "Walls", "Furniture"])
        check("demo locked photos with hashes", await pg.locator(".photo .badge.lock").count() == 3 and await pg.locator(".photo .hash").count() == 3)
        check("demo correction note shown", "Correction" in await pg.inner_text(".corrections"))
        async with pg.expect_download() as dl:
            await pg.click("#reportBtn")
        d = await dl.value
        path = await d.path()
        check("evidence report PDF downloads", path and os.path.getsize(path) > 5000 and d.suggested_filename.startswith("FixFlow-evidence"), d.suggested_filename)
        await pg.click(".nav-item[data-screen=complaints]")
        txt = await pg.inner_text("#cList")
        check("demo complaint refs + counters", re.search(r"FF-\d{4}-[0-9A-Z]{4}", txt) and "days unresolved" in txt)
        await pg.click("#cList .item:first-child .hist summary")
        check("status history visible", "In progress" in await pg.inner_text("#cList .item:first-child .hist") and "warden" in await pg.inner_text("#cList .item:first-child .hist"))
        await pg.click(".nav-item[data-screen=claim]")
        check("demo audit numbers", (await pg.inner_text("#kDeposit")) == "₹20,000" and (await pg.inner_text("#kDispute")) == "₹6,500" and (await pg.inner_text("#kRefund")) == "₹18,500",
              f"{await pg.inner_text('#kDispute')} {await pg.inner_text('#kRefund')}")
        check("demo linked evidence shown", await pg.locator(".ded.unfair img").count() == 1 and "Not legal advice" in await pg.inner_text("#s-claim .disclaimer"))
        await pg.click(".ded.unclear [data-pos=accept]")
        check("tenant can accept a charge", (await pg.inner_text("#kDispute")) == "₹4,500" and (await pg.inner_text("#kRefund")) == "₹16,500")
        await pg.click(".ded.unclear [data-pos='']")
        check("reset to AI finding", (await pg.inner_text("#kDispute")) == "₹6,500")
        await pg.evaluate("window.scrollTo(0, document.querySelector('#s-claim').getBoundingClientRect().top + scrollY - 76)")
        await pg.wait_for_timeout(300)
        await shot(pg, f"{TAG}_deposit_audit")
        await pg.click("#toNoticeBtn")
        await pg.wait_for_selector("#s-notices.active")
        await pg.wait_for_function("document.querySelector('.notice[data-kind=formal] textarea').value.length > 100", timeout=90000)
        vals = await pg.eval_on_selector_all(".notice textarea", "els=>els.map(e=>e.value)")
        check("dispute notice drafts generated with amounts", all(len(v) > 40 for v in vals) and re.search(r"6,?500|4,?500", "".join(vals)) is not None, vals[1][:100])
        await pg.click("[data-npv=formal]")
        await pg.wait_for_selector("#previewDlg[open]")
        pv = await pg.inner_text("#pvBody")
        check("preview shows annexes (evidence, refs, amounts)", "annex a" in pv.lower() and bool(re.search(r"FF-\d{4}-[0-9A-Z]{4}", pv)) and "₹" in pv, pv[-160:])
        check("final needs review tick", await pg.is_disabled("#pvFinal"))
        await pg.check("#pvAgree"); await pg.click("#pvFinal")
        await pg.wait_for_function("document.querySelector('#pvState').textContent.startsWith('Final')")
        async with pg.expect_download() as dl:
            await pg.click("#pvPdf")
        d = await dl.value
        check("notice PDF downloads", os.path.getsize(await d.path()) > 2000, d.suggested_filename)
        await pg.click("#pvClose")
        async with pg.expect_download() as dl:
            await pg.click("#pdfBtn")
        d = await dl.value
        check("full pack PDF downloads", os.path.getsize(await d.path()) > 2000)
        await pg.click("#accountBtn")
        async with pg.expect_download() as dl:
            await pg.click("#exportBtn")
        d = await dl.value
        dj = json.load(open(await d.path()))
        check("demo export JSON", "Demo" in dj.get("note", "") and len(dj["complaints"]) == 3)
        await pg.click("#demoBar [data-go=signup]")
        await pg.wait_for_selector("#authView:not([hidden])")
        check("exit demo -> sign up", await pg.is_visible("#aName"))

        # ---- google button ----
        try:
            async with pg.expect_popup(timeout=15000) as pp:
                await pg.click("#googleBtn")
            pop = await pp.value
            purl = pop.url
            await pop.close()
            check("google button opens sign-in popup", bool(purl), purl[:80])
        except Exception as e:
            check("google button opens sign-in popup", False, str(e)[:120])
        await pg.wait_for_timeout(800)
        if not BACKEND:
            print("(account journeys skipped: set FF_E2E_BACKEND=1 to run them against this deployment)")
        else:
            await pg.evaluate("document.querySelector('#app').scrollIntoView()")
            await pg.wait_for_selector("#authView:not([hidden])")

            # ================= live user A =================
            await pg.click(".seg-btn[data-auth=signup]")
            await pg.click("#aSubmit")
            check("signup validation", "name" in (await pg.inner_text("#aErr")).lower())
            await pg.fill("#aName", "Tester A"); await pg.fill("#aEmail", email_a); await pg.fill("#aPass", pw)
            await pg.click("#aSubmit")
            await pg.wait_for_selector("#s-setup.active")
            check("signup -> add PG screen", True)
            await pg.click("#pgSave")
            check("PG form validation", "PG name" in await pg.inner_text("#pgErr"))
            await pg.fill("#fPg", "Sunrise Co-living"); await pg.fill("#fRoom", "301"); await pg.fill("#fOwner", "Mahesh")
            await pg.fill("#fOwnerPhone", "+91 98450 11223"); await pg.fill("#fAddr", "Srinivaspura, Bengaluru")
            await pg.fill("#fRent", "9000"); await pg.fill("#fDep", "18000"); await pg.fill("#fIn", "2026-08-15"); await pg.fill("#fCode", "SUNRISE24")
            await pg.click("#pgSave")
            await pg.wait_for_selector("#s-scan.active")
            check("PG saved -> scan", True)

            # ---- scan ----
            await pg.set_input_files("#photoInput", files=[{"name": "notes.txt", "mimeType": "text/plain", "buffer": b"not an image"}])
            await pg.wait_for_function("document.querySelector('#scanErr').textContent.length > 0")
            check("file type validation", "JPEG, PNG or WebP" in await pg.inner_text("#scanErr"))
            await pg.set_input_files("#photoInput", files=[{"name": "big.jpg", "mimeType": "image/jpeg", "buffer": b"\xff\xd8" + b"0" * (10 * 1024 * 1024 + 10)}])
            await pg.wait_for_function("document.querySelector('#scanErr').textContent.includes('10 MB')")
            check("file size validation (10 MB)", True)
            await pg.click(".area[data-area=wall]")
            await pg.set_input_files("#photoInput", IMG)
            await pg.wait_for_selector("#scanReview:not([hidden])")
            rv = await pg.inner_text("#rvMeta")
            check("review step shows client SHA-256", IMG_SHA in rv, rv[-80:])
            check("nothing saved before review", await pg.locator(".photo").count() == 0)
            await pg.click("#rvSave")
            await pg.wait_for_selector(".photo", timeout=90000)
            tags = await pg.locator(".photo .tag").count()
            check("photo uploaded + Gemini description", tags > 0 and len(await pg.input_value(".photo textarea")) > 20, f"{tags} tags")
            row = await client(pg, "async ({d, F, user}) => { const q = await F.getDocs(F.query(F.collection(d, 'photos'), F.where('owner', '==', user.uid))); const x = q.docs[0].data(); return { file_sha256: x.file_sha256, file_bytes: x.file_bytes, area: x.area }; }", email_a, pw)
            check("SHA-256 stored in DB matches file", row and row["file_sha256"] == IMG_SHA and row["file_bytes"] == os.path.getsize(IMG) and row["area"] == "wall", str(row)[:120])
            await pg.fill(".photo textarea", "Damp patch near the window, roughly 20 cm wide (edited before lock).")
            await pg.click(".photo [data-sumsave]")
            await pg.wait_for_function("document.querySelector('.photo textarea').value.includes('edited before lock')")
            check("edit description before lock", True)
            await pg.set_input_files("#photoInput", IMG)
            await pg.wait_for_function("document.querySelector('#scanErr').textContent.includes('already')")
            check("duplicate photo rejected", True)
            await pg.click(".area[data-area=bathroom]")
            await pg.set_input_files("#photoInput", IMG2)
            await pg.wait_for_selector("#scanReview:not([hidden])")
            await pg.click("#rvSave")
            await pg.wait_for_function("document.querySelectorAll('.photo').length === 2", timeout=90000)
            await pg.click(".photo [data-del]")
            await pg.wait_for_function("document.querySelectorAll('.photo').length === 1")
            check("remove before lock", True)
            await pg.click("#lockBtn")
            check("lock needs confirmation tick", await pg.is_disabled("#lockConfirm"))
            await pg.check("#lockAgree"); await pg.click("#lockConfirm")
            await pg.wait_for_selector(".photo .badge.lock")
            check("lock record", "Locked" in await pg.inner_text(".photo"))
            await pg.click(".photo .add-note summary")
            await pg.fill(".photo [data-note]", "Correction: the patch is near the door, not the window.")
            await pg.click(".photo [data-notesave]")
            await pg.wait_for_selector(".photo .corrections")
            check("correction added as dated note", "near the door" in await pg.inner_text(".photo .corrections"))
            ok_hist = await soft("evidence history shows lock + correction", pg.wait_for_function("(t => t.includes('Locked') && t.toLowerCase().includes('correction'))(document.querySelector('#evHistory').textContent)", timeout=15000))
            if ok_hist is not None: check("evidence history shows lock + correction", True)
            async with pg.expect_download() as dl:
                await pg.click("#reportBtn")
            d = await dl.value
            check("live evidence report PDF", os.path.getsize(await d.path()) > 5000)
            await shot(pg, f"{TAG}_scan")
            tamper = await client(pg, """async ({d, F, s, St, user, ok}) => {
                const q = await F.getDocs(F.query(F.collection(d, 'photos'), F.where('owner', '==', user.uid)));
                const p = q.docs[0], pd = p.data();
                const u = await ok(F.updateDoc(p.ref, { ai_summary: 'hacked', file_sha256: '0'.repeat(64) }));
                const u2 = await ok(F.updateDoc(p.ref, { locked: false, locked_at: null }));
                const del = await ok(F.deleteDoc(p.ref));
                const after = (await F.getDoc(p.ref)).data();
                const nq = await F.getDocs(F.query(F.collection(d, 'evidence_notes'), F.where('owner', '==', user.uid)));
                const nu = await ok(F.updateDoc(nq.docs[0].ref, { note: 'changed' }));
                const nd = await ok(F.deleteDoc(nq.docs[0].ref));
                const rm = await ok(St.deleteObject(St.ref(s, pd.storage_path)));
                const still = await ok(St.getMetadata(St.ref(s, pd.storage_path)));
                const aq = await F.getDocs(F.query(F.collection(d, 'audit_log'), F.where('owner', '==', user.uid)));
                const au = await ok(F.updateDoc(aq.docs[0].ref, { action: 'fake' }));
                const ad = await ok(F.deleteDoc(aq.docs[0].ref));
                return { u, u2, del, summary: after.ai_summary, sha: after.file_sha256, nu, nd, rm, still, au, ad, uid: user.uid };
            }""", email_a, pw)
            a_uid = tamper and tamper.get("uid")
            check("locked photo + hash read-only in DB", tamper and not tamper["u"] and not tamper["u2"] and not tamper["del"] and tamper["summary"] != "hacked" and tamper["sha"] == IMG_SHA, str(tamper)[:200])
            check("corrections can't be edited/deleted", tamper and not tamper["nu"] and not tamper["nd"])
            check("locked photo file can't be deleted from storage", tamper and not tamper["rm"] and tamper["still"], str(tamper and (tamper["rm"], tamper["still"])))
            check("audit log is append-only", tamper and not tamper["au"] and not tamper["ad"])

            # ---- complaints ----
            await pg.click(".nav-item[data-screen=complaints]")
            await pg.fill("#cText", "wifi bahut slow hai aur raat ko band ho jata hai")
            await pg.click("#cAnalyze")
            await pg.wait_for_selector("#cBody:not([hidden])", timeout=60000)
            check("AI suggests category (Wi-Fi)", (await pg.input_value("#rCatSel")) == "Wi-Fi", await pg.input_value("#rCatSel"))
            check("not offline fallback", await pg.is_hidden("#rMode"))
            await pg.fill("#rDesc", "Wi-Fi is very slow and disconnects every night (edited by me).")
            await pg.wait_for_selector("#similar:not([hidden])", timeout=10000)
            await pg.click("#similar [data-support]")
            await pg.wait_for_selector("#similar button:has-text('Added')")
            check("+1 on similar PG issue", True)
            await pg.set_input_files("#cPhoto", IMG2)
            await shot(pg, f"{TAG}_complaint_ai")
            await pg.click("#cSave")
            await pg.wait_for_selector("#cList .item")
            first = await pg.inner_text("#cList .item")
            ref_a = (re.search(r"FF-\d{4}-[0-9A-Z]{4}", first) or [None])[0]
            check("complaint gets unique ref ID", ref_a is not None, ref_a)
            check("edited description saved + photo attached", "(edited by me)" in first and await pg.locator("#cList .item .thumb").count() == 1)
            check("submission + last-updated dates", "Submitted" in first and "Last updated" in first)
            await pg.fill("#cText", "Geyser not working since 2 days, only cold water")
            await pg.click("#cAnalyze"); await pg.wait_for_selector("#cBody:not([hidden])", timeout=60000)
            await pg.click("#cSave"); await pg.wait_for_function("document.querySelectorAll('#cList .item').length === 2")
            refs = re.findall(r"FF-\d{4}-[0-9A-Z]{4}", await pg.inner_text("#cList"))
            check("refs unique", len(set(refs)) == 2, str(refs))
            await pg.click("#cList .item:first-child [data-status=in_progress]")
            await pg.wait_for_function("document.querySelector('#cList .item:first-child .badge.in_progress')")
            await pg.click("#cList .item:first-child [data-reply]")
            await pg.fill("#cList .item:first-child .reply textarea", "Warden said the plumber comes Friday")
            await pg.select_option("#cList .item:first-child .reply select", "fixed")
            await pg.click("#cList .item:first-child .reply button[type=submit]")
            await pg.wait_for_selector("#cList .days.done")
            await pg.click("#cList .item:has(.days.done) .hist summary")
            hist = await pg.inner_text("#cList .item:has(.days.done) .hist")
            check("status history: created → in progress → reply → resolved", all(s in hist for s in ["Logged as Open", "Open → In progress", "plumber comes Friday", "In progress → Resolved"]), hist[:200])
            await pg.select_option("#fStatus", "fixed")
            check("status filter (Resolved)", await pg.locator("#cList .item").count() == 1)
            await pg.select_option("#fStatus", "")
            await shot(pg, f"{TAG}_complaints")

            # ---- deposit audit ----
            await pg.click(".nav-item[data-screen=claim]")
            check("audit shows original deposit", (await pg.inner_text("#kDeposit")) == "₹18,000")
            await pg.fill("#dReason", "Wall repainting and repair for damp patch and marks"); await pg.fill("#dAmount", "4000")
            await pg.click("#dAdd")
            await pg.wait_for_selector(".ded .verdict:not(.pending)", timeout=90000)
            v1 = await pg.inner_text(".ded .verdict")
            check("deduction audited", v1.lower() in ("unsupported by evidence", "unclear: ask for proof", "looks fair"), v1)
            await pg.fill("#dReason", "Room cleaning charge at move-out"); await pg.fill("#dAmount", "800")
            await pg.click("#dAdd")
            await pg.wait_for_function("document.querySelectorAll('.ded .verdict:not(.pending)').length === 2", timeout=90000)
            total, disp, ref = await pg.inner_text("#kTotal"), await pg.inner_text("#kDispute"), await pg.inner_text("#kRefund")
            check("audit math consistent", N(total) == 4800 and N(disp) <= 4800 and 18000 - 4800 <= N(ref) <= 18000 and N(ref) == 18000 - (4800 - N(disp)), f"{total} {disp} {ref}")
            await pg.click(".ded:first-child [data-pos=dispute]")
            await pg.wait_for_function("document.querySelector('.ded:first-child [data-pos=dispute]').getAttribute('aria-pressed') === 'true'")
            check("tenant position saved", N(await pg.inner_text("#kDispute")) >= 4000)
            await shot(pg, f"{TAG}_claim_live")

            # ---- notices ----
            await pg.click("#toNoticeBtn")
            await pg.wait_for_function("document.querySelector('.notice[data-kind=grievance] textarea').value.length > 80", timeout=90000)
            await pg.fill(".notice[data-kind=whatsapp] textarea", "Edited WhatsApp draft for test purposes.")
            await pg.click("[data-nsave=whatsapp]")
            await pg.wait_for_function("document.querySelector('.notice[data-kind=whatsapp] small').textContent.includes('Draft saved')")
            check("notice edited + saved", True)
            await pg.click("[data-npv=formal]")
            await pg.wait_for_selector("#previewDlg[open]")
            check("live preview includes complaint ref", ref_a in await pg.inner_text("#pvBody"))
            await pg.check("#pvAgree"); await pg.click("#pvFinal")
            await pg.wait_for_function("document.querySelector('#pvState').textContent.startsWith('Final')")
            async with pg.expect_download() as dl:
                await pg.click("#pvPdf")
            check("final notice PDF", os.path.getsize(await (await dl.value).path()) > 2000)
            await pg.click("#pvClose")
            check("final notice is read-only until reopened", await pg.get_attribute(".notice[data-kind=formal] textarea", "readonly") is not None)

            # ---- privacy & data ----
            await pg.click("#accountBtn")
            await pg.wait_for_function("document.querySelectorAll('#auditList li').length > 8", timeout=15000)
            al = await pg.inner_text("#auditList")
            check("audit log lists actions", all(s in al for s in ["Locked", "correction", "Logged complaint", "Marked formal notice final"]), al[:200])
            async with pg.expect_download() as dl:
                await pg.click("#exportBtn")
            ex = json.load(open(await (await dl.value).path()))
            check("data export JSON complete", ex["user"]["email"] == email_a and ex["photos"][0]["file_sha256"] == IMG_SHA and len(ex["complaints"]) == 2
                  and len(ex["complaint_events"]) >= 5 and len(ex["evidence_notes"]) == 1 and len(ex["audit_log"]) > 8 and len(ex["notices"]) == 3)
            await shot(pg, f"{TAG}_account")

            # ---- persistence ----
            await pg.click("#signOutBtn")
            await pg.wait_for_selector("#authView:not([hidden])")
            await pg.click(".seg-btn[data-auth=login]")
            await pg.fill("#aEmail", email_a); await pg.fill("#aPass", "wrongpass")
            await pg.click("#aSubmit")
            await pg.wait_for_function("document.querySelector('#aErr').textContent.length > 0")
            check("wrong password rejected", "Wrong" in await pg.inner_text("#aErr"))
            await pg.fill("#aPass", pw); await pg.click("#aSubmit")
            await pg.wait_for_selector("#s-dashboard.active")
            check("login restores data", (await pg.inner_text("#dDeposit")) == "₹18,000" and (await pg.inner_text("#dPhotos")).startswith("1"))
            await pg.click(".nav-item[data-screen=notices]")
            check("edited + final notices persisted", "Edited WhatsApp" in await pg.input_value(".notice[data-kind=whatsapp] textarea") and "Final since" in await pg.inner_text(".notice[data-kind=formal] small"))
            await pg.click("#signOutBtn"); await pg.wait_for_selector("#authView:not([hidden])")

            # ---- isolation: user B sees nothing of A ----
            await pg.click(".seg-btn[data-auth=signup]")
            await pg.fill("#aName", "Tester B"); await pg.fill("#aEmail", email_b); await pg.fill("#aPass", pw)
            await pg.click("#aSubmit"); await pg.wait_for_selector("#s-setup.active")
            LEAK = """async ({d, F, user, ok}) => {
                const A = 'A_UID', out = {};
                for (const t of ['photos', 'evidence_notes', 'complaints', 'complaint_events', 'deductions', 'audit_log']) out[t] = await ok(F.getDocs(F.query(F.collection(d, t), F.where('owner', '==', A))));
                out.tenancy = await ok(F.getDoc(F.doc(d, 'tenancies', A)));
                out.profile = await ok(F.getDoc(F.doc(d, 'profiles', A)));
                out.notices = await ok(F.getDocs(F.collection(d, 'users', A, 'notices')));
                out.all_complaints = await ok(F.getDocs(F.collection(d, 'complaints')));
                out.pin_secret = await ok(F.getDoc(F.doc(d, 'pg_secrets', 'SUNRISE24')));
                out.write_other = await ok(F.setDoc(F.doc(d, 'tenancies', A), { owner: user ? user.uid : 'x', deposit: 1, monthly_rent: 1 }));
                return out;
            }""".replace("A_UID", str(a_uid))
            leak = await client(pg, LEAK, email_b, pw)
            anon = await client(pg, LEAK)
            check("rules: other user can't read/write A's records", leak and not any(leak.values()), str(leak))
            check("rules: signed-out visitor can't read records", anon and not any(anon.values()), str(anon))

            # ---- delete account (user B) ----
            await pg.fill("#fPg", "Temp PG"); await pg.fill("#fRoom", "1"); await pg.fill("#fRent", "5000"); await pg.fill("#fDep", "10000"); await pg.fill("#fIn", "2026-09-01")
            await pg.click("#pgSave"); await pg.wait_for_selector("#s-scan.active")
            await pg.set_input_files("#photoInput", IMG2); await pg.wait_for_selector("#scanReview:not([hidden])"); await pg.click("#rvSave")
            await pg.wait_for_selector(".photo", timeout=90000)
            await pg.click("#lockBtn"); await pg.check("#lockAgree"); await pg.click("#lockConfirm"); await pg.wait_for_selector(".photo .badge.lock")
            b_uid = await client(pg, "async ({user}) => user.uid", email_b, pw)
            await pg.click("#accountBtn")
            check("delete needs typed confirmation", await pg.is_disabled("#deleteBtn"))
            await pg.fill("#delConfirm", "DELETE")
            await pg.click("#deleteBtn")
            await pg.wait_for_selector("#authView:not([hidden])", timeout=30000)
            gone = await client(pg, "async () => 1", email_b, pw)
            if LOCAL:
                files = emu_get(f"http://127.0.0.1:9199/v0/b/demo-fixflow.appspot.com/o?prefix=users/{b_uid}/").get("items", [])
                check("account deletion removes login + locked evidence file", gone and "loginError" in gone and len(files) == 0, f"{gone} files_left={len(files)}")
            else:
                check("account deletion removes login", gone and "loginError" in gone, str(gone))

            # ---- warden ----
            await pg.evaluate("document.querySelector('#warden').scrollIntoView()")
            await pg.fill("#wPin", "0000"); await pg.click("#wGo")
            await pg.wait_for_function("document.querySelector('#wErr').textContent.length > 0")
            check("warden wrong PIN rejected", "Wrong" in await pg.inner_text("#wErr"))
            await pg.fill("#wPin", "1234"); await pg.click("#wGo")
            await pg.wait_for_selector("#wBoard:not([hidden])")
            wl = await pg.inner_text("#wList")
            check("warden sees tester complaint with ref", "Tester A" in wl and ref_a in wl)
            firstb = await pg.inner_text("#wList .item .badges")
            check("warden list sorted (open High first)", "High" in firstb and "Open" in firstb, firstb)
            item = pg.locator("#wList .item", has_text=ref_a)
            await item.locator(".w-note").fill("Router reset done, monitoring tonight")
            await item.locator("[data-s=fixed]").click()
            await pg.wait_for_function(f"[...document.querySelectorAll('#wList .item')].some(e => e.textContent.includes('{ref_a}') && e.querySelector('.days.done'))")
            ev = await client(pg, f"""async ({{d, F, user}}) => {{
                const cs = await F.getDocs(F.query(F.collection(d, 'complaints'), F.where('owner', '==', user.uid)));
                const cm = cs.docs.find((x) => x.data().ref === '{ref_a}');
                const es = await F.getDocs(F.query(F.collection(d, 'complaint_events'), F.where('owner', '==', user.uid)));
                return es.docs.map((x) => x.data()).filter((e) => e.complaint_id === cm.id).map((e) => ({{ kind: e.kind, actor: e.actor, note: e.note, to_status: e.to_status }}));
            }}""", email_a, pw)
            check("warden change logged to resident history", ev and any(e["actor"] == "warden" and e["to_status"] == "fixed" and "Router reset" in (e["note"] or "") for e in ev), str(ev)[:200])
            await shot(pg, f"{TAG}_warden")

        # ================= mobile =================
        m = await b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        await m.goto(BASE, wait_until="networkidle")
        await m.wait_for_timeout(1200)
        ov0 = await m.evaluate("document.documentElement.scrollWidth - innerWidth")
        check("mobile hero CTAs visible, no overflow", await m.is_visible("#heroQuick .btn.primary") and ov0 <= 1, ov0)
        await shot(m, f"{TAG}_mobile_hero")
        await m.click("#heroQuick [data-go=demo]")
        await m.wait_for_selector("#s-dashboard.active")
        ov = await m.evaluate("document.documentElement.scrollWidth - innerWidth")
        check("mobile dashboard no horizontal overflow", ov <= 1, ov)
        check("mobile bottom nav", (await m.evaluate("getComputedStyle(document.querySelector('.side')).position")) == "fixed")
        await m.wait_for_timeout(1200); await m.evaluate("window.scrollTo(0, document.querySelector('#s-dashboard .screen-head').getBoundingClientRect().top + scrollY - 70)"); await m.wait_for_timeout(800)
        await shot(m, f"{TAG}_mobile")
        bad_ov = []
        for scr in ["scan", "complaints", "claim", "notices"]:
            await m.click(f".nav-item[data-screen={scr}]")
            await m.wait_for_timeout(300)
            o = await m.evaluate("document.documentElement.scrollWidth - innerWidth")
            if o > 1: bad_ov.append((scr, o))
        check("mobile screens no overflow", not bad_ov, str(bad_ov))
        await shot(m, f"{TAG}_mobile_notices")
        t = await b.new_page(viewport={"width": 820, "height": 1180})
        await t.goto(BASE + "/privacy", wait_until="networkidle")
        check("privacy page renders on tablet", "Correction & deletion policy" in await t.inner_text("#policy") and await t.evaluate("document.documentElement.scrollWidth - innerWidth") <= 1)

        bad = [e for e in errors if "Failed to load resource" not in e]
        check("no console errors", not bad, "; ".join(bad[:3]))
        await b.close()
    passed = sum(ok for _, ok in results)
    print(f"\n{passed}/{len(results)} passed")

asyncio.run(main())
