"""Publish one reviewed local video immediately using the active TikTok account."""

import argparse
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "third_party/luno-automation/backend"))
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

import server
from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job_id", type=int)
    parser.add_argument("--caption", required=True)
    args = parser.parse_args()
    caption = args.caption.strip()
    if "https://" in caption or "http://" in caption:
        raise RuntimeError("Affiliate URLs belong in comments")
    for tag in ("#viral", "#xuhuong"):
        if tag not in caption.split():
            caption += " " + tag
    with sqlite3.connect(ROOT / "data/app.db") as db:
        row = db.execute("SELECT status, dubbed_path, rights_confirmed, title FROM reup_jobs WHERE id=?", (args.job_id,)).fetchone()
        if not row or row[0] != "review" or not row[2] or not Path(row[1]).is_file():
            raise RuntimeError("Job has no reviewed video ready for upload")
        if db.execute("SELECT id FROM reup_publications WHERE job_id=? AND mode='schedule' AND status IN ('running','done')", (args.job_id,)).fetchone():
            raise RuntimeError("Job already has a live or running publication")

    server._apply_active_account()
    tk = server.tk
    publication_id = None
    with sync_playwright() as playwright:
        browser, context = tk.ensure_login(playwright)
        try:
            page = context.new_page()
            page.goto(tk.CONFIG["upload_url"], timeout=60000)
            if not tk.check_login(page):
                raise RuntimeError("TikTok login is not ready")
            tk.upload_video_file(page, row[1])
            tk.set_caption(page, caption)
            tk.set_schedule(page, None, None)
            page.mouse.wheel(0, 2000)
            page.wait_for_timeout(1000)
            public = page.get_by_text("Mọi người", exact=True)
            if not public.count() or not public.first.is_visible():
                private = page.get_by_text("Chỉ mình tôi", exact=True)
                if private.count() and private.first.is_visible():
                    private.first.click()
                    public.first.click(timeout=10000)
            page.screenshot(path=str(ROOT / "data/tiktok-post-ready.png"))
            if not public.count() or not public.first.is_visible():
                print("UPLOAD_OPTIONS", page.locator("body").inner_text()[-6000:], flush=True)
                raise RuntimeError("Public visibility could not be confirmed; nothing submitted")
            with sqlite3.connect(ROOT / "data/app.db") as db:
                db.execute("UPDATE reup_jobs SET caption=?, approved=1 WHERE id=?", (caption, args.job_id))
                publication_id = db.execute("INSERT INTO reup_publications(job_id,platform,mode,status) VALUES (?,'tiktok','schedule','running')", (args.job_id,)).lastrowid
            print("PUBLICATION_STARTED", publication_id, flush=True)
            tk.publish(page)
            tk.save_session_state(context)
            page.goto("https://www.tiktok.com/tiktokstudio/content", timeout=60000)
            page.wait_for_timeout(5000)
            posts = page.locator('a[href*="/video/"]').evaluate_all("els => els.map(e => ({url:e.href,text:e.innerText}))")
            matches = [post for post in posts if post["text"].strip() == caption]
            if len(matches) != 1:
                raise RuntimeError("TikTok submission finished, but its Studio post could not be uniquely verified")
            print("STUDIO_POST", matches[0], flush=True)
            page.screenshot(path=str(ROOT / "data/tiktok-post-result.png"))
            with sqlite3.connect(ROOT / "data/app.db") as db:
                db.execute("UPDATE reup_publications SET status='done', error='' WHERE id=?", (publication_id,))
            print("PUBLICATION_DONE", publication_id, flush=True)
        except Exception as error:
            if publication_id:
                with sqlite3.connect(ROOT / "data/app.db") as db:
                    db.execute("UPDATE reup_publications SET status='review_needed',error=? WHERE id=?", (str(error), publication_id))
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    main()
