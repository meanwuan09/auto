from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="chrome", headless=True)
    for name, width, height in (("desktop", 1440, 900), ("mobile", 390, 844)):
        page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
        page.goto("http://127.0.0.1:3210", wait_until="networkidle")
        page.get_by_role("heading", name="Nhập video Douyin").wait_for()
        assert "VideoLingo" in page.locator("#reup-services").inner_text()
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        page.screenshot(path=ROOT / "data" / f"ui-{name}.png", full_page=True)
        sample = {
            "jobs": [{
                "id": 99, "source_url": "https://www.douyin.com/video/1234567890123456789",
                "title": "Máy xay cầm tay", "caption": "Video giới thiệu máy xay cầm tay",
                "status": "review", "approved": 1, "error": "", "source_path": "source.mp4",
                "dubbed_path": "vietnamese.mp4", "tiktok_product_id": "123456789",
                "shopee_product_query": "Máy xay cầm tay", "shopee_product_id": "987654321"
            }],
            "publications": [{
                "id": 8, "job_id": 99, "platform": "shopee", "mode": "schedule",
                "status": "done", "comment_status": "pending", "error": ""
            }], "services": {"dtk": False, "videoLingo": False, "luno": True}
        }
        page.route("**/api/reup", lambda route: route.fulfill(json=sample))
        page.route("**/api/douyin/discovery", lambda route: route.fulfill(json={
            "enabled": False, "autoQueue": False, "publicOnly": True, "scanning": False, "loginOpen": True,
            "sources": [{"id": 2, "kind": "feed", "value": "https://www.douyin.com/jingxuan", "rights_confirmed": 0, "error": "", "last_scan": ""}],
            "candidates": [{"id": 4, "source_url": "https://www.douyin.com/video/1234567890123456791", "title": "Video đồ bếp đề xuất", "author": "Creator", "source_name": "厨房好物", "likes": 1200, "shares": 50, "comments": 30, "score": 25.5, "growth": None, "status": "new", "rights_confirmed": 0}]
        }))
        page.route("**/api/reup/publications/8/comment", lambda route: route.fulfill(json={
            "publicationId": 8, "comment": "https://s.shopee.vn/test", "status": "pending"
        }))
        page.reload(wait_until="networkidle")
        assert page.locator("#discovery-candidates").get_by_role("link", name="Video đồ bếp đề xuất").is_visible()
        assert not page.locator("#discovery-scan").is_disabled()
        page.get_by_role("button", name="Kiểm tra").click()
        assert page.locator(".modal-content").is_visible()
        page.evaluate("navigator.clipboard.writeText = async text => { window.copiedComment = text; }")
        page.get_by_role("button", name="Sao chép link").click()
        page.wait_for_function("window.copiedComment === 'https://s.shopee.vn/test'")
        assert page.evaluate("window.copiedComment") == "https://s.shopee.vn/test"
        assert page.locator("#reup-edit-caption").input_value() == "Video giới thiệu máy xay cầm tay"
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        assert page.locator(".modal-content").evaluate("element => element.scrollWidth <= element.clientWidth")
        page.get_by_role("button", name="Thực hiện").scroll_into_view_if_needed()
        button = page.get_by_role("button", name="Thực hiện").bounding_box()
        assert button and button["y"] >= 0 and button["y"] + button["height"] <= height
        page.screenshot(path=ROOT / "data" / f"ui-{name}-modal.png", full_page=True)
        page.close()
    browser.close()
