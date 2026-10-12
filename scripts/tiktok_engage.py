"""Find and interact with TikTok videos through a RoxyBrowser profile, for the "Tương tác" tab.

Usage: tiktok_engage.py '<json>' with ROXY_PROFILE_ID set to the account's profile.
  {"mode": "discover", "queries": ["decorphongtro"], "limit": 12, "skip": [url, ...], "skipHandles": [...]}
      prints {"type": "video", "url", "author", "desc", "views"} per video found
  {"mode": "act", "url": ..., "like": true, "comment": "...", "repost": false}
      prints {"type": "result", "like": "done|already|error: ...", "comment": ..., "repost": ...}
Every action is one the account owner approved in the dashboard; the script only performs it at a
human pace. It stops on a verification (captcha) page instead of trying to pass it.
"""

import json
import random
import re
import sys
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "third_party/luno-automation/backend"))

import roxy_browser
from playwright.sync_api import sync_playwright


COMMENTS_TAB = re.compile(r"^\s*(Bình luận|Comments)")


class Verification(Exception):
    pass


def pause(page, low, high):
    page.wait_for_timeout(random.randint(low, high))


def check_verification(page):
    if page.locator("#captcha-verify-container, #captcha_container, .captcha-verify-container").count():
        raise Verification("TikTok yêu cầu xác minh (captcha) — mở profile này trong Roxy và tự xác minh")


def emit(row):
    print(json.dumps(row, ensure_ascii=False), flush=True)


def discover(page, request):
    skip = set(request.get("skip", []))
    skip_handles = {h.lower() for h in request.get("skipHandles", [])}
    limit = int(request.get("limit", 12))
    found = 0
    for query in request.get("queries", []):
        page.goto(f"https://www.tiktok.com/search/video?q={quote(query)}", wait_until="domcontentloaded", timeout=45000)
        pause(page, 4000, 6000)
        check_verification(page)
        for _ in range(2):
            page.mouse.wheel(0, 1400)
            pause(page, 1500, 2500)
        items = page.evaluate("""() => [...document.querySelectorAll('[data-e2e=search_video-item]')].map((item) => {
            const box = item.parentElement;
            const link = box.querySelector('a[href*="/video/"]');
            return {
              url: (link?.href || '').split('?')[0],
              desc: (box.querySelector('[data-e2e=search-card-video-caption]')?.innerText || box.querySelector('[data-e2e=search-card-desc]')?.innerText || '').replace(/\\s+/g, ' ').trim(),
              views: box.querySelector('[data-e2e=video-views]')?.innerText || ''
            };
        })""")
        picked = []
        for item in items:
            url = item["url"]
            author = url.split("/@")[1].split("/")[0] if "/@" in url else ""
            if not url or "/video/" not in url or url in skip or author.lower() in skip_handles:
                continue
            skip.add(url)
            picked.append({**item, "author": author})
            if found + len(picked) >= limit:
                break
        for item in picked:
            row = {"type": "video", "url": item["url"], "author": item["author"], "desc": item["desc"][:300], "views": item["views"], "query": query}
            if request.get("frameDir"):
                try:
                    row.update(inspect(page, item["url"], Path(request["frameDir"])))
                except Verification:
                    raise
                except Exception as error:
                    print(f"inspect {item['url']}: {error}", file=sys.stderr)
            emit(row)
            found += 1
        if found >= limit:
            return


# Two frames of the video and its top comments, so the comment writer knows what the video shows.
def inspect(page, url, frame_dir):
    frame_dir.mkdir(parents=True, exist_ok=True)
    video_id = url.rstrip("/").split("/")[-1]
    page.goto(url, wait_until="domcontentloaded", timeout=45000)
    pause(page, 3500, 5000)
    check_verification(page)
    item = page.locator("[data-e2e=recommend-list-item-container]").first
    video = (item if item.count() else page).locator("video").first
    frames = []
    for index in range(2):
        target = frame_dir / f"{video_id}-{index}.jpg"
        try:
            video.screenshot(path=str(target), type="jpeg", quality=80, timeout=8000)
            frames.append(str(target))
        except Exception as error:
            print(f"frame {video_id}-{index}: {error}", file=sys.stderr)
        pause(page, 2500, 3500)
    comments = []
    box = page.locator("[data-e2e=comment-input] [contenteditable], div[contenteditable=true][role=textbox]").first
    if not box.is_visible():
        tab = page.locator("button:visible", has_text=COMMENTS_TAB).first
        if tab.count():
            tab.click()
            pause(page, 2000, 3000)
    try:
        comments = page.evaluate("""() => [...document.querySelectorAll('[data-e2e=comment-level-1]')].slice(0, 6)
            .map((element) => element.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean)""")
    except Exception:
        pass
    return {"frames": frames, "comments": [text[:150] for text in comments]}


def act(page, request):
    result = {"type": "result", "like": "skip", "comment": "skip", "repost": "skip"}
    page.goto(request["url"], wait_until="domcontentloaded", timeout=45000)
    pause(page, 4000, 6000)
    check_verification(page)
    # The video page is a feed; the requested video is always its first item.
    item = page.locator("[data-e2e=recommend-list-item-container]").first
    if not item.count():
        item = page.locator("body")
    pause(page, 4000, 9000)  # watch a little before reacting

    if request.get("like"):
        try:
            like = item.locator("[data-e2e=like-icon]").first
            if like.get_attribute("aria-pressed") == "true":
                result["like"] = "already"
            else:
                like.click()
                pause(page, 1200, 2000)
                result["like"] = "done" if like.get_attribute("aria-pressed") == "true" else "error: chưa thấy tym được bật"
        except Exception as error:
            result["like"] = f"error: {str(error)[:120]}"

    text = (request.get("comment") or "").strip()
    if text:
        try:
            # The comment panel is often open already; the icon toggles it, so only click when closed.
            # The side panel may show "Bạn có thể thích" instead of the comments tab.
            box = page.locator("[data-e2e=comment-input] [contenteditable], div[contenteditable=true][role=textbox]").first
            if not box.is_visible():
                tab = page.locator("button:visible", has_text=COMMENTS_TAB).first
                if tab.count() and tab.is_visible():
                    tab.click()
                    pause(page, 1500, 2500)
            if not box.is_visible():
                item.locator("[data-e2e=comment-icon]").first.click()
                pause(page, 2000, 3000)
                check_verification(page)
            if not box.is_visible():
                tab = page.locator("button:visible", has_text=COMMENTS_TAB).first
                if tab.count() and tab.is_visible():
                    tab.click()
                    pause(page, 1500, 2500)
            box.wait_for(state="visible", timeout=15000)
            # The "Thêm bình luận..." placeholder sits on top of the editor, as for a person clicking it.
            box.click(force=True)
            if not box.evaluate("(element) => element === document.activeElement || element.contains(document.activeElement)"):
                box.focus()
            pause(page, 600, 1200)
            page.keyboard.type(text, delay=random.randint(70, 130))
            pause(page, 800, 1500)
            page.locator("[data-e2e=comment-post]").first.click()
            pause(page, 2500, 3500)
            check_verification(page)
            left = box.inner_text().strip()
            result["comment"] = "done" if not left else "error: bình luận chưa gửi được"
        except Verification:
            raise
        except Exception as error:
            result["comment"] = f"error: {str(error)[:120]}"

    if request.get("repost"):
        try:
            item.locator("[data-e2e=share-icon]").first.click()
            pause(page, 1500, 2500)
            repost = page.locator("[data-e2e=share-repost]").first
            label = repost.inner_text().strip().lower()
            if "xóa" in label or "remove" in label:
                result["repost"] = "already"
            else:
                repost.click()
                pause(page, 1500, 2500)
                result["repost"] = "done"
            page.keyboard.press("Escape")
        except Exception as error:
            result["repost"] = f"error: {str(error)[:120]}"
    emit(result)


def main():
    request = json.loads(sys.argv[1])
    with sync_playwright() as playwright:
        browser, context = roxy_browser.connect(playwright)
        page = context.new_page()
        try:
            if request.get("mode") == "discover":
                discover(page, request)
            else:
                act(page, request)
        except Verification as error:
            emit({"type": "error", "verification": True, "error": str(error)})
        except Exception as error:
            emit({"type": "error", "error": str(error)[:300]})
        finally:
            page.close()
            browser.close()


if __name__ == "__main__":
    main()
