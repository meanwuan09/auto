from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.goto("http://127.0.0.1:3210", wait_until="networkidle")
    page.get_by_role("button", name="Kiểm tra", exact=True).first.click()
    page.wait_for_function("document.querySelectorAll('.preview-grid video').length === 2 && [...document.querySelectorAll('.preview-grid video')].every(v => v.readyState >= 2)")
    dubbed = page.locator(".preview-grid video").nth(1)
    metadata = dubbed.evaluate("v => ({duration: v.duration, width: v.videoWidth, height: v.videoHeight})")
    assert abs(metadata["duration"] - 65.733333) < 0.1
    assert metadata["width"] == 1280 and metadata["height"] == 720
    dubbed.evaluate("async v => { v.muted = true; v.currentTime = 10; await v.play(); }")
    page.wait_for_timeout(1500)
    assert dubbed.evaluate("v => !v.paused && v.currentTime > 10")
    page.screenshot(path=ROOT / "data" / "reup-real-preview.png", full_page=True)
    print("Real MP4 plays in Chrome: 1280x720, 65.73s")
    browser.close()
