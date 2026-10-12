import argparse
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from playwright.sync_api import Error, sync_playwright

import sys
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'third_party/luno-automation/backend'))
import roxy_browser


STATUS = ROOT / 'data' / 'tiktok-login-status.json'
UPLOAD = 'https://www.tiktok.com/tiktokstudio/upload?lang=vi-VN'


def report(state, **extra):
    STATUS.write_text(json.dumps({'state': state, 'pid': os.getpid(), **extra}, ensure_ascii=True), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('backend')
    args = parser.parse_args()
    backend = urlparse(args.backend)
    if backend.scheme != 'http' or backend.hostname not in {'127.0.0.1', 'localhost'}:
        raise ValueError('Expected the local LUNO backend')
    report('opening')
    with sync_playwright() as playwright:
        if roxy_browser.selected():
            browser, context = roxy_browser.connect(playwright)
            try:
                page = context.new_page()
                page.goto(UPLOAD, wait_until='domcontentloaded', timeout=45000)
                report('login_required')
                for _ in range(300):
                    cookies = context.cookies('https://www.tiktok.com/')
                    signed_in = any(c['name'] in {'sessionid', 'sessionid_ss'} and c['value'] for c in cookies)
                    if signed_in and page.locator('input[type="file"]').count():
                        report('ready', browser='roxy')
                        return
                    page.wait_for_timeout(2000)
                report('error', error='TikTok login was not completed in RoxyBrowser')
                return
            finally:
                browser.close()
        context = playwright.chromium.launch_persistent_context(
            str(ROOT / 'data' / 'tiktok-login-profile'), channel='chrome', headless=False,
            locale='vi-VN', viewport=None, args=['--start-maximized'],
        )
        try:
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(UPLOAD, wait_until='domcontentloaded', timeout=45000)
            report('login_required')
            navigated = False
            limit_reported = False
            while context.pages:
                cookies = context.cookies('https://www.tiktok.com/')
                signed_in = any(c['name'] in {'sessionid', 'sessionid_ss'} and c['value'] for c in cookies)
                if signed_in:
                    if '/tiktokstudio/upload' not in page.url and not navigated:
                        page.goto(UPLOAD, wait_until='domcontentloaded', timeout=45000)
                        navigated = True
                    if '/tiktokstudio/upload' in page.url and page.locator('input[type="file"]').count():
                        payload = {'label': 'TikTok đăng nhập trên máy', 'cookie': '; '.join(f"{c['name']}={c['value']}" for c in cookies)}
                        request = Request(args.backend.rstrip('/') + '/accounts', data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'}, method='POST')
                        with urlopen(request, timeout=20) as response:
                            account = json.load(response)
                        account_id = account['id']
                        if not re.fullmatch(r'[a-f0-9]{8}', account_id):
                            raise ValueError('Invalid account ID from LUNO')
                        destination = ROOT / 'third_party' / 'luno-automation' / 'backend' / 'accounts' / account_id / 'session.json'
                        context.storage_state(path=str(destination))
                        report('ready', accountId=account_id)
                        return
                elif not limit_reported and 'Đã đạt số lần thử tối đa' in page.locator('body').inner_text():
                    report('rate_limited')
                    limit_reported = True
                page.wait_for_timeout(2000)
            report('closed')
        except Error:
            if context.pages:
                raise
            report('closed')
        finally:
            context.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        report('error', error=str(error)[:1000])
        raise
