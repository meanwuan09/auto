"""Post one pending affiliate comment using the saved TikTok session.

This command never retries a send whose outcome is uncertain.
Use --verify-only to inspect an existing comment without sending anything.
"""

import argparse
import re
import sqlite3
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "third_party/luno-automation/backend"))

import server
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


def publication(publication_id):
    with sqlite3.connect(ROOT / "data/app.db") as connection:
        return connection.execute(
            """SELECT platform, mode, status, comment_status, comment_url
               FROM reup_publications WHERE id = ?""",
            (publication_id,),
        ).fetchone()


def validate_post_url(value):
    parts = urlsplit(value)
    if parts.scheme != "https" or parts.hostname not in {"www.tiktok.com", "tiktok.com"}:
        raise ValueError("Expected an HTTPS TikTok video URL")
    if not re.fullmatch(r"/@[\w.]+/video/\d+/?", parts.path):
        raise ValueError("Expected a TikTok URL in /@account/video/id format")
    return f"https://www.tiktok.com{parts.path.rstrip('/')}"


def visible_comment(page, link):
    # Check comments, never the editor or unrelated text elsewhere on the page.
    entries = page.locator('[data-e2e="comment-level-1"]')
    for index in range(entries.count()):
        if link in entries.nth(index).inner_text():
            return True
    return False


def open_comments(page):
    page.get_by_text("Bình luận", exact=True).last.click(timeout=15000)
    page.locator('[data-e2e="comment-input"] [contenteditable="true"]').wait_for(timeout=15000)


def check_challenge(page, wait_for_verification=False):
    if page.get_by_text("Verification timed out. Try again later.").is_visible():
        raise RuntimeError("TikTok verification timed out; comment outcome is unconfirmed")
    challenge = page.get_by_text("Kéo thanh trượt để ghép hình")
    if not challenge.is_visible():
        return
    if not wait_for_verification:
        raise RuntimeError("TikTok requires manual verification; comment outcome is unconfirmed")
    print("MANUAL_VERIFICATION_REQUIRED", flush=True)
    try:
        challenge.wait_for(state="hidden", timeout=180000)
    except PlaywrightTimeoutError as error:
        raise RuntimeError("Manual verification was not completed; comment outcome is unconfirmed") from error
    if page.get_by_text("Verification timed out. Try again later.").is_visible():
        raise RuntimeError("TikTok verification timed out; comment outcome is unconfirmed")
    print("MANUAL_VERIFICATION_CLEARED", flush=True)


def wait_for_comments(page, list_responses, wait_for_verification=False):
    for _ in range(40):
        check_challenge(page, wait_for_verification)
        if page.locator('[data-e2e="comment-level-1"]').count():
            return
        if list_responses and list_responses[-1] == 0:
            return
        page.wait_for_timeout(500)
    raise RuntimeError("Comment list did not load; comment outcome is unconfirmed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("publication_id", help="Publication ID, or 'external' for a post outside the dashboard")
    parser.add_argument("post_url")
    parser.add_argument("--link", help="Shopee affiliate link, required for an external post")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--wait-for-verification", action="store_true")
    args = parser.parse_args()
    post_url = validate_post_url(args.post_url)
    if args.publication_id == "external":
        if not args.link or not re.fullmatch(r"https://s\.shopee\.vn/[A-Za-z0-9]+", args.link):
            raise ValueError("External post requires --link with a Shopee affiliate URL")
        link, status = args.link, "pending"
    else:
        try:
            args.publication_id = int(args.publication_id)
        except ValueError as error:
            raise ValueError("Publication ID must be a number or 'external'") from error
        row = publication(args.publication_id)
        if not row or row[0:3] != ("tiktok", "schedule", "done") or not row[4]:
            raise RuntimeError("Publication is not a completed TikTok post with an affiliate link")
        link, status = row[4], row[3]
        if args.link and args.link != link:
            raise ValueError("--link does not match the publication affiliate link")
    if status == "posted" and not args.verify_only:
        raise RuntimeError("Comment is already marked posted; use --verify-only")
    if status != "pending" and not args.verify_only:
        raise RuntimeError("Comment is not pending")

    server._apply_active_account()

    with sync_playwright() as playwright:
        browser, context = server.tk.ensure_login(playwright)
        try:
            page = context.new_page()
            publish_results = []
            list_responses = []

            def record_response(response):
                route = urlsplit(response.url).path
                if route not in {"/api/comment/publish/", "/api/comment/list/"}:
                    return
                try:
                    body = response.json()
                    if route == "/api/comment/publish/":
                        publish_results.append((response.status, body.get("status_code"), body.get("status_msg")))
                    elif route == "/api/comment/list/" and response.status == 200 and body.get("status_code") == 0:
                        comments = body.get("comments")
                        if isinstance(comments, list):
                            list_responses.append(len(comments))
                except Exception:
                    if route == "/api/comment/publish/":
                        publish_results.append((response.status, None, "unreadable response"))

            page.on("response", record_response)
            if args.publication_id == "external":
                page.goto("https://www.tiktok.com/tiktokstudio/content", timeout=60000)
                page.locator('a[href*="/video/"]').first.wait_for(timeout=20000)
                studio_urls = page.locator('a[href*="/video/"]').evaluate_all(
                    "elements => elements.map(element => element.href.split('?')[0])"
                )
                if post_url not in studio_urls:
                    raise RuntimeError("Video is not visible in the active account's TikTok Studio")
            page.goto(post_url, timeout=60000)
            check_challenge(page, args.wait_for_verification)
            open_comments(page)
            wait_for_comments(page, list_responses, args.wait_for_verification)

            if visible_comment(page, link):
                print("COMMENT_ALREADY_VISIBLE")
            elif args.verify_only:
                raise RuntimeError("Affiliate link was not found in the loaded comments")
            else:
                field = page.locator('[data-e2e="comment-input"] [contenteditable="true"]')
                field.fill(link)
                button = page.locator('[data-e2e="comment-post"]')
                if not button.is_enabled():
                    raise RuntimeError("TikTok Send button is disabled; no comment was sent")
                button.click()
                page.wait_for_timeout(2500)
                report = repr(publish_results or "none").encode("ascii", errors="backslashreplace").decode("ascii")
                print("PUBLISH_RESPONSE", report)
                check_challenge(page, args.wait_for_verification)

            list_responses.clear()
            page.reload(timeout=60000)
            check_challenge(page, args.wait_for_verification)
            open_comments(page)
            wait_for_comments(page, list_responses, args.wait_for_verification)
            if not visible_comment(page, link):
                raise RuntimeError("Affiliate comment is missing after reload; status remains pending")
            print("COMMENT_PERSISTED_AFTER_RELOAD")
            if not args.verify_only and args.publication_id != "external":
                with sqlite3.connect(ROOT / "data/app.db") as connection:
                    connection.execute(
                        """UPDATE reup_publications SET comment_status = 'posted',
                           comment_posted_at = CURRENT_TIMESTAMP
                           WHERE id = ? AND comment_status = 'pending'""",
                        (args.publication_id,),
                    )
                print("PUBLICATION_MARKED_POSTED")
            server.tk.save_session_state(context)
        finally:
            browser.close()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, PlaywrightTimeoutError) as error:
        print(f"COMMENT_NOT_CONFIRMED: {error}", file=sys.stderr)
        sys.exit(1)
