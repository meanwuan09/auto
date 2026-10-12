"""Check one TikTok Studio post with the account already saved in LUNO."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "third_party/luno-automation/backend"))

import server
from playwright.sync_api import sync_playwright


def main():
    post_id = sys.argv[1]
    server._apply_active_account()
    with sync_playwright() as playwright:
        browser, context = server.tk.ensure_login(playwright)
        page = context.new_page()
        page.goto("https://www.tiktok.com/tiktokstudio/content", timeout=60000)
        page.wait_for_timeout(4000)
        post = page.locator(f'a[href*="/video/{post_id}"]').first
        if post.count():
            row = post.locator('xpath=ancestor::*[.//button[contains(., "Chỉ mình tôi") or contains(., "Mọi người")]][1]')
            print("STUDIO_ROW", row.inner_text()[:1000] if row.count() else post.inner_text())
            print("POST_URL", post.get_attribute("href"))
        else:
            print("POST_NOT_FOUND")
        page.goto(f"https://www.tiktok.com/@wuan0409/video/{post_id}", timeout=60000)
        page.wait_for_timeout(4000)
        notice = page.get_by_role("button", name="Đã hiểu", exact=True)
        if notice.count():
            notice.first.click()
            page.wait_for_timeout(1000)
        if "--open-comments" in sys.argv:
            tabs = page.get_by_text("Bình luận", exact=True)
            print("COMMENT_TABS", tabs.count())
            tabs.last.click()
            page.wait_for_timeout(2000)
        print("VIDEO_URL", page.url)
        print("VIDEO_TEXT", page.locator("body").inner_text()[:1800])
        print("COMMENT_BOXES", page.locator('[data-e2e="comment-input"], [contenteditable="true"]').count())
        print("COMMENT_INPUTS", page.locator('textarea, input, [contenteditable="true"]').evaluate_all('(els) => els.map(e => [e.tagName, e.getAttribute("placeholder"), e.getAttribute("data-e2e")])'))
        page.screenshot(path=str(ROOT / "data/tiktok-comment-page.png"))
        browser.close()


if __name__ == "__main__":
    main()
