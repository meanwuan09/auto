from playwright.sync_api import sync_playwright
from urllib.parse import urlparse


URL = "https://www.douyin.com/video/7686432847778982833"

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="chrome", headless=True)
    context = browser.new_context(locale="zh-CN", timezone_id="Asia/Shanghai")
    page = context.new_page()
    try:
        response = page.goto(URL, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(8000)
        print("status:", response.status if response else "none")
        print("url:", page.url)
        print("title:", page.title()[:150].encode("ascii", "backslashreplace").decode())
        print("cookie names:", ", ".join(cookie["name"] for cookie in context.cookies()))
        print("html chars:", len(page.content()))
        sources = page.locator("video").evaluate_all("elements => elements.map(v => ({src: v.src, current: v.currentSrc, duration: v.duration}))")
        for source in sources:
            print("video:", {"src": urlparse(source["src"]).netloc, "current": urlparse(source["current"]).netloc, "duration": source["duration"]})
    finally:
        browser.close()
