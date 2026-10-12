import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel='chrome', headless=True)
    try:
        page = browser.new_page(locale='zh-CN')
        response = page.goto(sys.argv[1] if len(sys.argv) > 1 else 'https://www.douyin.com/jingxuan', wait_until='domcontentloaded', timeout=45000)
        page.wait_for_timeout(8000)
        print(json.dumps({
            'status': response.status if response else None,
            'url': page.url, 'title': page.title(),
            'text': page.locator('body').inner_text()[:3500],
            'links': page.locator('a[href]').evaluate_all('ns => ns.slice(0, 30).map(n => ({href: n.href, text: n.textContent}))'),
            'videos': page.locator('video').count(),
            'video_links': page.locator('a[href*="modal_id="], a[href*="/video/"]').evaluate_all('ns => ns.slice(0, 3).map(n => ({href: n.href, text: n.textContent}))'),
            'scripts': page.locator('script[type="application/json"], script#RENDER_DATA').evaluate_all('ns => ns.map(n => ({id:n.id, size:n.textContent.length}))'),
        }, ensure_ascii=True))
        page.screenshot(path=str(Path(__file__).resolve().parents[1] / 'data' / 'douyin-public-probe.png'))
    finally:
        browser.close()
