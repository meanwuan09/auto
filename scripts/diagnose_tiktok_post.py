"""Read visibility and moderation signals for one TikTok post."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "third_party/luno-automation/backend"))
sys.stdout.reconfigure(encoding="utf-8")

import server
from playwright.sync_api import sync_playwright

POST_ID = sys.argv[1] if len(sys.argv) > 1 else "7690813839671069973"
if not POST_ID.isdigit():
    raise ValueError("Expected a numeric TikTok post ID")
POST_URL = f"https://www.tiktok.com/@wuan0409/video/{POST_ID}"

server._apply_active_account()
with sync_playwright() as playwright:
    browser, context = server.tk.ensure_login(playwright)
    try:
        page = context.new_page()
        page.goto("https://www.tiktok.com/tiktokstudio/content", timeout=60000)
        post = page.locator(f'a[href*="/video/{POST_ID}"]').first
        post.wait_for(timeout=20000)
        row = post.locator("xpath=ancestor::tr[1]")
        print("STUDIO_ROW", row.inner_text() if row.count() else post.inner_text(), flush=True)
        print("ROW_BUTTONS", row.locator("button").evaluate_all(
            "els => els.map(e => ({text:e.innerText, title:e.title, aria:e.getAttribute('aria-label')}))"
        ), flush=True)
    finally:
        browser.close()

    guest = playwright.chromium.launch(channel="chrome", headless=True)
    try:
        page = guest.new_page(locale="vi-VN")
        page.goto(POST_URL, timeout=60000)
        page.wait_for_timeout(5000)
        text = page.locator("body").inner_text()
        print("GUEST_URL", page.url, flush=True)
        print("GUEST_HAS_CAPTION", POST_ID in page.url and ("#viral" in text or "#xuhuong" in text), flush=True)
        print("GUEST_HAS_VIDEO", page.locator("video").count() > 0, flush=True)
        print("GUEST_NOTICE", text[-650:], flush=True)
    finally:
        guest.close()
