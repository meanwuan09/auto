"""Find the URL of a just-published TikTok video by its caption, in TikTok Studio's content list.

Uses the same browser session as posting (set ROXY_PROFILE_ID to pick the Roxy profile).
Prints POST_URL <url> and exits 0, or exits 2 when no listed post matches yet.
"""

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "third_party/luno-automation/backend"))

import server
from playwright.sync_api import sync_playwright


def normalise(text, keep_tags=False):
    """Caption text as TikTok shows it: hashtags and spacing vary, so compare plain words."""
    text = unicodedata.normalize("NFC", text if keep_tags else re.sub(r"#\S+", " ", text or "")).lower()
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", text)).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("caption")
    parser.add_argument("--exclude", default="[]", help="JSON list of post URLs already linked to other publications")
    args = parser.parse_args()
    # A caption made only of hashtags is matched on the hashtags themselves.
    keep_tags = len(normalise(args.caption)) < 6
    wanted = normalise(args.caption, keep_tags)[:40]
    if len(wanted) < 6:
        raise SystemExit("Caption is too short to identify the post")
    excluded = set(json.loads(args.exclude))

    server._apply_active_account()
    with sync_playwright() as playwright:
        browser, context = server.tk.ensure_login(playwright)
        page = context.new_page()
        try:
            page.goto("https://www.tiktok.com/tiktokstudio/content", timeout=60000)
            page.wait_for_timeout(8000)
            posts = page.locator('a[href*="/video/"]').evaluate_all(
                "elements => [...new Map(elements.map(element => [element.href, "
                "{url: element.href, text: (element.closest('tr') || element.closest('[data-tt]') || element.parentElement).innerText}])).values()]"
            )
            for post in posts:
                url = re.sub(r"\?.*$", "", post["url"])
                if re.search(r"/@[\w.]+/video/\d+$", url) and url not in excluded and wanted in normalise(post["text"], keep_tags):
                    print("POST_URL", url, flush=True)
                    return
            sys.exit(2)
        finally:
            page.close()
            browser.close()


if __name__ == "__main__":
    main()
