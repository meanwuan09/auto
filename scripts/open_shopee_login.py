"""Keep an interactive Chrome window open for Shopee Affiliate sign-in."""

import json
import time
from pathlib import Path

from playwright.sync_api import Error, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT / "data" / "shopee-affiliate-chrome"
STATUS = ROOT / "data" / "shopee-affiliate-browser.json"
CUSTOM_LINK = "https://affiliate.shopee.vn/offer/custom_link"


def report(state):
    STATUS.write_text(json.dumps({"state": state}, ensure_ascii=False), encoding="utf-8")


def main():
    PROFILE.mkdir(parents=True, exist_ok=True)
    report("opening")
    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=str(PROFILE), channel="chrome", headless=False,
                viewport=None, args=["--start-maximized"]
            )
            page = context.pages[0] if context.pages else context.new_page()
            if not page.url.startswith(CUSTOM_LINK):
                page.goto(CUSTOM_LINK, wait_until="domcontentloaded", timeout=45000)
            report("login_required")
            while context.pages:
                try:
                    if any("/verify/" in p.url for p in context.pages):
                        report("verification_required")
                    elif any(p.url.startswith(CUSTOM_LINK) and "Shopee Affiliate" in p.title() for p in context.pages):
                        report("ready")
                    else:
                        report("login_required")
                except Error:
                    break
                time.sleep(2)
            report("closed")
    except Exception as error:
        report(f"error: {type(error).__name__}: {error}")
        raise


if __name__ == "__main__":
    main()
