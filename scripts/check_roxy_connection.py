"""Confirm Playwright can attach to the selected RoxyBrowser profile."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "third_party/luno-automation/backend"))

import roxy_browser
from playwright.sync_api import sync_playwright

with sync_playwright() as playwright:
    browser, context = roxy_browser.connect(playwright)
    try:
        print("ROXY_CONNECTED", "contexts", len(browser.contexts), "tabs", len(context.pages))
    finally:
        browser.close()
