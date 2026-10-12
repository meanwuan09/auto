"""List video URLs visible in TikTok Studio using the saved account."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "third_party/luno-automation/backend"))

import server
from playwright.sync_api import sync_playwright

server._apply_active_account()
with sync_playwright() as playwright:
    browser, context = server.tk.ensure_login(playwright)
    try:
        page = context.new_page()
        page.goto("https://www.tiktok.com/tiktokstudio/content", timeout=60000)
        page.wait_for_timeout(8000)
        posts = page.locator('a[href*="/video/"]').evaluate_all(
            "elements => [...new Map(elements.map(element => [element.href, "
            "{url: element.href, text: (element.closest('tr') || element.parentElement).innerText.slice(0, 300)}])).values()]"
        )
        print("STUDIO_URL", page.url)
        for post in posts:
            print("VIDEO_URL", post["url"])
            print("POST_TEXT", post["text"].encode("ascii", errors="backslashreplace").decode("ascii"))
    finally:
        browser.close()
