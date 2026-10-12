"""Set one existing Studio post to public and read it again after reload."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "third_party/luno-automation/backend"))
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

import server
from playwright.sync_api import sync_playwright

post_id = sys.argv[1]
if not post_id.isdigit():
    raise ValueError("Expected a numeric TikTok video ID")
server._apply_active_account()
with sync_playwright() as playwright:
    browser, context = server.tk.ensure_login(playwright)
    try:
        page = context.new_page()
        page.goto("https://www.tiktok.com/tiktokstudio/content", timeout=60000)
        link = page.locator(f'a[href*="/video/{post_id}"]').first
        link.wait_for(timeout=20000)
        row = link.locator('xpath=ancestor::*[.//button[contains(., "Chỉ mình") or contains(., "Mọi người")]][1]')
        print("BEFORE", row.inner_text(), flush=True)
        private = row.get_by_role("button", name="Chỉ mình", exact=False)
        if private.count():
            private.click()
            page.screenshot(path=str(ROOT / "data/tiktok-privacy-options.png"))
            print("OPTIONS", page.locator("body").inner_text()[-4000:], flush=True)
            public = page.get_by_text("Mọi người", exact=True).last
            if public.is_visible():
                public.click()
                page.wait_for_timeout(1500)
                print("AFTER_CHANGE", page.locator("body").inner_text()[-2500:], flush=True)
        page.reload(timeout=60000)
        link.wait_for(timeout=20000)
        print("AFTER_RELOAD", row.inner_text(), flush=True)
        page.screenshot(path=str(ROOT / "data/tiktok-public-result.png"))
    finally:
        browser.close()
