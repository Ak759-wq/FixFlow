"""FixFlow end-to-end test (Playwright). Run with the dev server on :3000.
python3 tests/e2e.py  [base_url]
"""
import asyncio, sys, time, os, re
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"
IMG = "/workspace/test_room.png"
SHOTS = "/workspace/work/fixflow_shots"
os.makedirs(SHOTS, exist_ok=True)
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

async def shot(pg, name, full=False):
    try:
        await pg.screenshot(path=f"{SHOTS}/{name}.png", full_page=full, timeout=15000)
    except Exception as e:
        print("  (screenshot skipped:", e.__class__.__name__, ")")

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

        # ---- hero ----
        await pg.goto(BASE, wait_until="networkidle")
        await pg.wait_for_function("document.querySelector('#statOpen').textContent !== '–'")
        check("hero stats load from DB", (await pg.inner_text("#statOpen")).isdigit())
        await shot(pg, "v2_1_hero")
        await pg.evaluate("window.scrollTo(0, document.querySelector('.hero').offsetHeight*0.55)")
        await pg.wait_for_timeout(500)
        op = await pg.evaluate("getComputedStyle(document.querySelector('.hero-copy')).opacity")
        check("scroll reveals headline", float(op) > 0.5, op)
        await shot(pg, "v2_2_hero_scrolled")

        # ---- demo ----
        await pg.click(".hero-actions [data-go=demo]")
        await pg.wait_for_selector("#s-dashboard.active")
        check("demo dashboard deposit", (await pg.inner_text("#dDeposit")) == "₹20,000")
        check("demo protected ₹4,500", (await pg.inner_text("#dProtected")) == "₹4,500")
        await pg.evaluate("document.querySelector('#app').scrollIntoView()")
        await shot(pg, "v2_3_demo_dashboard")
        await pg.click(".nav-item[data-screen=scan]")
        check("demo scan shows locked photos", await pg.locator(".photo .badge.lock").count() == 3)
        await shot(pg, "v2_4_demo_scan")
        await pg.click(".nav-item[data-screen=complaints]")
        txt = await pg.inner_text("#cList")
        check("demo complaint day counter", "14" in txt and "days unfixed" in txt)
        await pg.click(".nav-item[data-screen=claim]")
        check("demo claim numbers", (await pg.inner_text("#kDispute")) == "₹6,500" and (await pg.inner_text("#kRefund")) == "₹18,500",
              f"{await pg.inner_text('#kDispute')} {await pg.inner_text('#kRefund')}")
        check("demo matched photo shown", await pg.locator(".ded.unfair img").count() == 1)
        await shot(pg, "v2_5_demo_claim")
        await pg.click(".nav-item[data-screen=notices]")
        await pg.click("#genBtn")
        await pg.wait_for_function("document.querySelector('.notice[data-kind=formal] textarea').value.length > 100", timeout=60000)
        vals = await pg.eval_on_selector_all(".notice textarea", "els=>els.map(e=>e.value)")
        check("3 AI notices generated", all(len(v) > 40 for v in vals) and re.search(r"6,?500|4,?500", "".join(vals)) is not None, vals[0][:120])
        await shot(pg, "v2_6_demo_notices")
        async with pg.expect_download() as dl:
            await pg.click("#pdfBtn")
        d = await dl.value
        path = await d.path()
        check("PDF downloads", path and os.path.getsize(path) > 2000, d.suggested_filename)
        await pg.click("#demoBar [data-go=signup]")
        await pg.wait_for_selector("#authView:not([hidden])")
        check("exit demo -> sign up", await pg.is_visible("#aName"))

        # ---- sign up user A ----
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
        await pg.set_input_files("#photoInput", IMG)
        await pg.wait_for_selector(".photo", timeout=60000)
        tags = await pg.locator(".photo .tag").count()
        check("photo uploaded + AI tags", tags > 0, f"{tags} tags")
        await pg.click(".area[data-area=bathroom]")
        await pg.set_input_files("#photoInput", IMG)
        await pg.wait_for_function("document.querySelectorAll('.photo').length === 2", timeout=60000)
        await pg.click(".photo [data-del]")
        await pg.wait_for_function("document.querySelectorAll('.photo').length === 1")
        check("remove before lock", True)
        await pg.click("#lockBtn"); await pg.click("#lockConfirm")
        await pg.wait_for_selector(".photo .badge.lock")
        check("lock record", "Locked" in await pg.inner_text(".photo"))
        await shot(pg, "v2_7_scan")
        tamper = await pg.evaluate("""async () => {
            const m = await import('https://esm.sh/@supabase/supabase-js@2.45.4');
            const c = m.createClient(FF_CONFIG.SUPABASE_URL, FF_CONFIG.SUPABASE_ANON_KEY);
            await c.auth.signInWithPassword({ email: '%s', password: '%s' });
            const { data } = await c.from('ff_photos').select('id').limit(1);
            const u = await c.from('ff_photos').update({ ai_summary: 'hacked' }).eq('id', data[0].id);
            const d = await c.from('ff_photos').delete().eq('id', data[0].id);
            const after = await c.from('ff_photos').select('ai_summary').eq('id', data[0].id).single();
            return { u: u.error && u.error.message, d: d.error && d.error.message, summary: after.data.ai_summary };
        }""" % (email_a, pw))
        check("locked photo is read-only in DB", tamper["u"] and tamper["d"] and tamper["summary"] != "hacked", str(tamper))

        # ---- complaints ----
        await pg.click(".nav-item[data-screen=complaints]")
        await pg.fill("#cText", "wifi bahut slow hai aur raat ko band ho jata hai")
        await pg.click("#cAnalyze")
        await pg.wait_for_selector("#cBody:not([hidden])", timeout=60000)
        check("AI categorises (Wi-Fi)", (await pg.inner_text("#rCat")) == "Wi-Fi", await pg.inner_text("#rCat"))
        check("not offline fallback", await pg.is_hidden("#rMode"))
        await pg.wait_for_selector("#similar:not([hidden])", timeout=10000)
        await pg.click("#similar [data-support]")
        await pg.wait_for_selector("#similar button:has-text('Added')")
        check("+1 on similar PG issue", True)
        await shot(pg, "v2_8_complaint_ai")
        await pg.click("#cSave")
        await pg.wait_for_selector("#cList .item")
        check("complaint logged with counter", "0" in await pg.inner_text("#cList .days") and "unfixed" in await pg.inner_text("#cList .days"))
        await pg.fill("#cText", "Geyser not working since 2 days, only cold water")
        await pg.click("#cAnalyze"); await pg.wait_for_selector("#cBody:not([hidden])", timeout=60000)
        await pg.click("#cSave"); await pg.wait_for_function("document.querySelectorAll('#cList .item').length === 2")
        await pg.click("#cList [data-fix]")
        await pg.wait_for_selector("#cList .days.done")
        check("mark fixed", True)
        await pg.select_option("#fStatus", "fixed")
        check("status filter", await pg.locator("#cList .item").count() == 1)
        await pg.select_option("#fStatus", "")
        await shot(pg, "v2_9_complaints")

        # ---- claim ----
        await pg.click(".nav-item[data-screen=claim]")
        await pg.fill("#dReason", "Wall repainting and repair for stains and marks"); await pg.fill("#dAmount", "4000")
        await pg.click("#dAdd")
        await pg.wait_for_selector(".ded .verdict:not(.pending)", timeout=60000)
        v1 = await pg.inner_text(".ded .verdict")
        check("deduction audited by AI", v1.lower() in ("unfair deduction", "unclear — needs proof", "fair deduction"), v1)
        await pg.fill("#dReason", "Room cleaning charge at move-out"); await pg.fill("#dAmount", "800")
        await pg.click("#dAdd")
        await pg.wait_for_function("document.querySelectorAll('.ded .verdict:not(.pending)').length === 2", timeout=60000)
        total = await pg.inner_text("#kTotal"); disp = await pg.inner_text("#kDispute"); ref = await pg.inner_text("#kRefund")
        n = lambda s: int(re.sub(r"\D", "", s) or 0)
        check("claim math consistent", n(total) == 4800 and n(disp) <= 4800 and n(ref) <= 18000 and n(ref) >= 18000 - 4800, f"{total} {disp} {ref}")
        await shot(pg, "v2_10_claim")

        # ---- notices ----
        await pg.click(".nav-item[data-screen=notices]")
        if n(disp) > 0:
            await pg.click("#genBtn")
            await pg.wait_for_function("document.querySelector('.notice[data-kind=grievance] textarea').value.length > 80", timeout=60000)
            await pg.fill(".notice[data-kind=whatsapp] textarea", "Edited WhatsApp draft for test purposes.")
            await pg.click("[data-nsave=whatsapp]")
            check("notices generated + edit saved", True)
        else:
            check("notices generated + edit saved", True, "skipped: nothing disputed")

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
        if n(disp) > 0:
            check("edited notice persisted", "Edited WhatsApp" in await pg.input_value(".notice[data-kind=whatsapp] textarea"))
        await pg.click("#signOutBtn"); await pg.wait_for_selector("#authView:not([hidden])")

        # ---- isolation: user B sees nothing of A ----
        await pg.click(".seg-btn[data-auth=signup]")
        await pg.fill("#aName", "Tester B"); await pg.fill("#aEmail", email_b); await pg.fill("#aPass", pw)
        await pg.click("#aSubmit"); await pg.wait_for_selector("#s-setup.active")
        leak = await pg.evaluate("""async () => {
            const m = await import('https://esm.sh/@supabase/supabase-js@2.45.4');
            const c = m.createClient(FF_CONFIG.SUPABASE_URL, FF_CONFIG.SUPABASE_ANON_KEY);
            await c.auth.signInWithPassword({ email: '%s', password: '%s' });
            const a = await c.from('ff_complaints').select('id'); const b = await c.from('ff_photos').select('id');
            const anon = m.createClient(FF_CONFIG.SUPABASE_URL, FF_CONFIG.SUPABASE_ANON_KEY, { auth: { persistKey: 'x', storageKey: 'anon-x' } });
            await anon.auth.signOut();
            const z = await anon.from('ff_complaints').select('id');
            return { comp: (a.data||[]).length, photos: (b.data||[]).length, anon: (z.data||[]).length };
        }""" % (email_b, pw))
        check("RLS: other user + anon see no private data", leak["comp"] == 0 and leak["photos"] == 0 and leak["anon"] == 0, str(leak))
        await pg.click("#signOutBtn")

        # ---- warden ----
        await pg.evaluate("document.querySelector('#warden').scrollIntoView()")
        await pg.fill("#wPin", "0000"); await pg.click("#wGo")
        await pg.wait_for_function("document.querySelector('#wErr').textContent.length > 0")
        check("warden wrong PIN rejected", "Wrong" in await pg.inner_text("#wErr"))
        await pg.fill("#wPin", "1234"); await pg.click("#wGo")
        await pg.wait_for_selector("#wBoard:not([hidden])")
        wl = await pg.inner_text("#wList")
        check("warden sees tester complaint", "Tester A" in wl)
        first = await pg.inner_text("#wList .item .badges")
        check("warden list sorted (open High first)", "High" in first and "Open" in first, first)
        await pg.click("#wList [data-s=in_progress]")
        await pg.wait_for_function("document.querySelector('#wStats .stat:nth-child(2) b').textContent !== '0'")
        check("warden start work", True)
        await shot(pg, "v2_11_warden")

        # ---- mobile ----
        m = await b.new_page(viewport={"width": 390, "height": 844})
        await m.goto(BASE, wait_until="networkidle")
        await shot(m, "v2_12_mobile_hero")
        await m.click(".hero-actions [data-go=demo]")
        await m.wait_for_selector("#s-dashboard.active")
        ov = await m.evaluate("document.documentElement.scrollWidth - innerWidth")
        check("mobile no horizontal overflow", ov <= 1, ov)
        check("mobile bottom nav", (await m.evaluate("getComputedStyle(document.querySelector('.side')).position")) == "fixed")
        await m.wait_for_timeout(1200); await m.evaluate("document.querySelector('#app').scrollIntoView()"); await m.wait_for_timeout(800)
        await shot(m, "v2_13_mobile_app")
        await m.click(".nav-item[data-screen=claim]")
        ov2 = await m.evaluate("document.documentElement.scrollWidth - innerWidth")
        check("mobile claim no overflow", ov2 <= 1, ov2)
        await shot(m, "v2_14_mobile_claim")

        bad = [e for e in errors if "Failed to load resource" not in e]
        check("no console errors", not bad, "; ".join(bad[:3]))
        await b.close()
    passed = sum(ok for _, ok in results)
    print(f"\n{passed}/{len(results)} passed")

asyncio.run(main())
