"""End-to-end test of FixFlow against a running server. Usage: python3 tests/e2e.py [base_url]"""
import os, sys, time, json
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"
OUT = "/workspace/work/fixflow_shots"
os.makedirs(OUT, exist_ok=True)
NAME = f"Tester{int(time.time()) % 100000}"
results, errors = [], []

def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))

proxy = None
px = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
if px:
    u = urlparse(px)
    proxy = {"server": f"{u.scheme}://{u.hostname}:{u.port}", "bypass": "localhost,127.0.0.1"}
    if u.username: proxy.update(username=u.username, password=u.password or "")

with sync_playwright() as p:
    br = p.chromium.launch(proxy=proxy, args=["--ignore-certificate-errors"])
    ctx = br.new_context(viewport={"width": 1440, "height": 900}, ignore_https_errors=True)
    page = ctx.new_page()
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept())
    page.goto(BASE, wait_until="networkidle")
    page.wait_for_timeout(1800)
    page.screenshot(path=f"{OUT}/1_hero_top.png")
    check("hero title visible", page.locator(".title").is_visible())
    check("hero stats loaded", page.locator("#statOpen").inner_text().strip().isdigit(), page.locator("#statOpen").inner_text())
    for i, frac in enumerate([0.25, 0.5, 0.85]):
        h = page.evaluate("document.querySelector('.hero').offsetHeight - innerHeight")
        page.evaluate(f"scrollTo(0, {h*frac})"); page.wait_for_timeout(500)
        page.screenshot(path=f"{OUT}/2_hero_scroll_{i}.png")
    check("headline revealed on scroll", float(page.evaluate("getComputedStyle(document.querySelector('.hero-copy')).opacity")) > 0.9)
    check("nav turns solid", "solid" in page.get_attribute("#nav", "class"))

    # Join PG
    page.click("#profileChip")
    page.fill("#pName", NAME); page.fill("#pRoom", "204"); page.fill("#pCode", "sunrise24")
    page.click("#pSave"); page.wait_for_timeout(1500)
    check("profile saved", NAME in page.inner_text("#profileChip"), page.inner_text("#profileChip"))

    # Report via AI
    page.click(".tab[data-tab=report]")
    page.fill("#issueText", "Room ke fan se sparks aa rahe hain aur switch jal gaya hai, raat se light nahi hai")
    page.click("#analyzeBtn")
    page.wait_for_selector("#resultBody:not([hidden])", timeout=45000)
    page.wait_for_timeout(1200)
    cat, urg = page.inner_text("#rCategory"), page.inner_text("#rUrgency")
    check("AI categorised", cat == "Electricity", cat)
    check("AI urgency High", "High" in urg, urg)
    check("AI draft written", len(page.input_value("#rDraft")) > 120)
    check("not offline fallback", "offline" not in page.inner_text("#rSummary"))
    page.screenshot(path=f"{OUT}/3_report.png", full_page=False)
    page.click("#submitBtn")
    page.wait_for_selector("#panel-track.active .item", timeout=20000)
    page.wait_for_timeout(800)
    check("complaint appears in tracker", page.locator("#myList .item").count() >= 1)
    check("unfixed-days counter shown", page.locator("#myList .days").first.is_visible())
    # Escalate level 1
    page.locator("#myList .act-esc").first.click()
    page.wait_for_selector("#myList .escalation", timeout=45000)
    check("escalation drafted", len(page.locator("#myList .escalation").first.inner_text()) > 40)
    check("WhatsApp link present", page.locator("#myList a[href^='https://wa.me']").count() == 1)
    page.screenshot(path=f"{OUT}/4_track.png")

    # Duplicate detection: a second resident reporting a similar issue
    page.evaluate("localStorage.setItem('ff_profile', JSON.stringify({name:'" + NAME + "b',room:'305',code:'SUNRISE24',pgName:'Sunrise Co-living'}))")
    page.reload(wait_until="networkidle"); page.wait_for_timeout(800)
    page.evaluate("document.querySelector('#app').scrollIntoView()")
    page.fill("#issueText", "No power in my room, switchboard burnt and sparking")
    page.click("#analyzeBtn")
    page.wait_for_selector("#resultBody:not([hidden])", timeout=45000); page.wait_for_timeout(2000)
    dupe = page.locator("#dupeBox:not([hidden])").count() == 1
    check("duplicate/group detection shown", dupe, page.inner_text("#rCategory"))
    if dupe:
        page.click("#supportBtn"); page.wait_for_timeout(1500)
        check("support added", "support was added" in page.inner_text("#dupeBox"))
    # restore profile
    page.evaluate("localStorage.setItem('ff_profile', JSON.stringify({name:'" + NAME + "',room:'204',code:'SUNRISE24',pgName:'Sunrise Co-living'}))")
    page.reload(wait_until="networkidle"); page.wait_for_timeout(800)

    # Warden
    page.click(".tab[data-tab=warden]")
    page.fill("#wPin", "0000"); page.click("#wLogin"); page.wait_for_timeout(1200)
    check("wrong PIN rejected", "Wrong" in page.inner_text("#wErr"))
    page.fill("#wPin", "1234"); page.click("#wLogin")
    page.wait_for_selector("#wardenBody:not([hidden]) #wList .item", timeout=15000); page.wait_for_timeout(600)
    first = page.locator("#wList .item").first.inner_text()
    check("warden list sorted High first", "High" in first.split("\n")[1] if "\n" in first else "High" in first)
    mine = page.locator("#wList .item", has_text=NAME).first
    check("warden sees new complaint", mine.count() == 1)
    check("group badge on complaint", "Group" in mine.inner_text(), mine.inner_text()[:80])
    page.screenshot(path=f"{OUT}/5_warden.png")
    mine.locator(".w-prog").click(); page.wait_for_timeout(2500)
    mine = page.locator("#wList .item", has_text=NAME).first
    check("status -> In progress", "In progress" in mine.inner_text(), mine.inner_text()[:120].replace("\n"," | "))
    mine.locator(".w-fix").click(); page.wait_for_timeout(1500)
    page.select_option("#fStatus", ""); page.wait_for_timeout(1200)
    check("status -> Fixed", "Fixed" in page.locator("#wList .item", has_text=NAME).first.inner_text())
    page.click(".tab[data-tab=track]"); page.wait_for_timeout(1500)
    check("resident sees Fixed + warden note", "Fixed" in page.inner_text("#myList") )

    # Move-in proof
    page.click(".tab[data-tab=movein]")
    page.set_input_files("#mFile", "/workspace/test_room.png"); page.wait_for_timeout(800)
    page.click("#mScan")
    page.wait_for_selector("#mGallery .shot", timeout=60000); page.wait_for_timeout(500)
    g = page.inner_text("#mGallery")
    check("move-in photo locked", "Locked" in g)
    check("AI found damage", page.locator("#mGallery .shot li").count() >= 1, g[:160].replace("\n", " "))
    page.screenshot(path=f"{OUT}/6_movein.png")

    # Deposit
    page.click(".tab[data-tab=deposit]")
    page.click("#dCheck")
    page.wait_for_selector("#dResult .refund", timeout=60000)
    check("deposit verdicts", page.locator("#dResult .verdict").count() == 3)
    check("unfair deduction flagged", page.locator("#dResult .v-Unfair").count() >= 1, page.inner_text("#dResult .refund"))
    rt = page.inner_text("#dResult .refund").replace(",", "")
    import re as _re
    nums = [int(x) for x in _re.findall(r"₹(\d+)", rt)]
    check("refund claim <= total deducted", len(nums) == 2 and nums[0] <= nums[1], rt)
    page.screenshot(path=f"{OUT}/7_deposit.png")

    # Mobile hero
    m = br.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, ignore_https_errors=True).new_page()
    m.goto(BASE, wait_until="networkidle"); m.wait_for_timeout(1500)
    m.screenshot(path=f"{OUT}/8_mobile.png")
    m.evaluate("document.querySelector('#app').scrollIntoView()"); m.wait_for_timeout(500)
    m.screenshot(path=f"{OUT}/9_mobile_app.png")
    br.close()

errs = [e for e in errors if "favicon" not in e]
check("no console errors", not errs, "; ".join(errs[:3]))
print(json.dumps({"passed": sum(r[1] for r in results), "total": len(results), "tester": NAME}))
