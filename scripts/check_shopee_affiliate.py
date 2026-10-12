"""Report whether the saved Chrome profile can access Shopee Custom Link."""

from pathlib import Path
import sys
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT / "data/shopee-affiliate-chrome"

with sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE), channel="chrome", headless="--headed" not in sys.argv
    )
    page = context.pages[0] if context.pages else context.new_page()
    for url in (
        "https://affiliate.shopee.vn/dashboard",
        "https://affiliate.shopee.vn/offer/custom_link",
    ):
        page.goto(url, timeout=45000)
        page.wait_for_timeout(6000)
        parsed = urlsplit(page.url)
        print("REQUESTED", url)
        print("PAGE", parsed.hostname, parsed.path)
        print("TITLE", page.title())
        print("TEXT", page.locator("body").inner_text()[:1000])
        if "/verify/" in parsed.path:
            break
    context.close()
