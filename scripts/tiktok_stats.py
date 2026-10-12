"""Read public stats of TikTok posts and channels through a RoxyBrowser profile.

Usage: tiktok_stats.py '<json>' where json is {"videos": [url, ...], "profiles": [handle, ...]}.
Set ROXY_PROFILE_ID to the profile to browse with. Prints one JSON object per line:
  {"type": "video", "url": ..., "views": ..., "likes": ..., "comments": ..., "shares": ..., "saves": ...}
  {"type": "profile", "handle": ..., "followers": ..., "likes": ..., "videos": ...}
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "third_party/luno-automation/backend"))

import roxy_browser
from playwright.sync_api import sync_playwright


def rehydration(page):
    raw = page.evaluate("() => (document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__') || {}).textContent || ''")
    return json.loads(raw).get("__DEFAULT_SCOPE__", {}) if raw else {}


def number(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def main():
    request = json.loads(sys.argv[1])
    with sync_playwright() as playwright:
        browser, context = roxy_browser.connect(playwright)
        page = context.new_page()
        try:
            for url in request.get("videos", []):
                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=45000)
                    page.wait_for_timeout(3000)
                    item = rehydration(page).get("webapp.video-detail", {}).get("itemInfo", {}).get("itemStruct", {})
                    stats = item.get("statsV2") or item.get("stats") or {}
                    if not stats:
                        print(json.dumps({"type": "video", "url": url, "error": "no stats on page"}), flush=True)
                        continue
                    print(json.dumps({"type": "video", "url": url, "views": number(stats.get("playCount")),
                                      "likes": number(stats.get("diggCount")), "comments": number(stats.get("commentCount")),
                                      "shares": number(stats.get("shareCount")), "saves": number(stats.get("collectCount")),
                                      "createTime": number(item.get("createTime"))}), flush=True)
                except Exception as error:  # one broken page must not stop the others
                    print(json.dumps({"type": "video", "url": url, "error": str(error)[:200]}), flush=True)
            for handle in request.get("profiles", []):
                try:
                    page.goto(f"https://www.tiktok.com/@{handle}", wait_until="domcontentloaded", timeout=45000)
                    page.wait_for_timeout(3000)
                    info = rehydration(page).get("webapp.user-detail", {}).get("userInfo", {})
                    stats = info.get("statsV2") or info.get("stats") or {}
                    print(json.dumps({"type": "profile", "handle": handle, "followers": number(stats.get("followerCount")),
                                      "likes": number(stats.get("heartCount") or stats.get("heart")), "videos": number(stats.get("videoCount"))}), flush=True)
                except Exception as error:
                    print(json.dumps({"type": "profile", "handle": handle, "error": str(error)[:200]}), flush=True)
        finally:
            page.close()
            browser.close()


if __name__ == "__main__":
    main()
