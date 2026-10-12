import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

from playwright.sync_api import Error, sync_playwright


def collect_nodes(node, found):
    if isinstance(node, dict):
        identity = str(node.get('aweme_id', ''))
        if re.fullmatch(r'\d{15,25}', identity) and isinstance(node.get('video'), dict):
            stats = node.get('statistics') or {}
            found[identity] = {
                'url': f'https://www.douyin.com/video/{identity}',
                'title': str(node.get('desc') or '')[:250],
                'author': str((node.get('author') or {}).get('nickname') or '')[:150],
                'created_at': node.get('create_time'),
                'duration': (node.get('video') or {}).get('duration', 0) / 1000,
                'likes': stats.get('digg_count'), 'comments': stats.get('comment_count'),
                'shares': stats.get('share_count'), 'views': stats.get('play_count'),
            }
        for value in node.values():
            collect_nodes(value, found)
    elif isinstance(node, list):
        for value in node:
            collect_nodes(value, found)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('kind', choices=['keyword', 'channel', 'feed', 'category', 'check'])
    parser.add_argument('value')
    parser.add_argument('--login', action='store_true')
    parser.add_argument('--anonymous', action='store_true')
    args = parser.parse_args()
    if args.kind == 'check':
        url = 'https://www.douyin.com/'
    elif args.kind == 'feed':
        url = 'https://www.douyin.com/jingxuan'
    elif args.kind == 'category':
        identity = re.fullmatch(r'https://www\.douyin\.com/channel/(\d{6})', args.value)
        if not identity:
            raise ValueError('Expected a Douyin category URL')
        url = f'https://www.douyin.com/channel/{identity.group(1)}'
    elif args.kind == 'channel':
        parsed = urlparse(args.value)
        if parsed.scheme != 'https' or parsed.hostname != 'www.douyin.com' or not re.fullmatch(r'/user/[\w-]+/?', parsed.path):
            raise ValueError('Expected a Douyin channel URL')
        url = args.value
    else:
        url = 'https://www.douyin.com/search/' + quote(args.value, safe='') + '?type=video'
    found = {}
    with sync_playwright() as playwright:
        profile = Path(__file__).resolve().parents[1] / 'data' / 'douyin-discovery-profile'
        browser = None
        if args.anonymous and not args.login:
            browser = playwright.chromium.launch(channel='chrome', headless=True)
            context = browser.new_context(locale='zh-CN', timezone_id='Asia/Shanghai')
        else:
            context = playwright.chromium.launch_persistent_context(
                str(profile), channel='chrome', headless=not args.login,
                locale='zh-CN', timezone_id='Asia/Shanghai',
            )
        try:
            # Cookies pasted in the dashboard (data/douyin-cookie.json) sign the scanner in without a QR scan.
            cookie_file = Path(__file__).resolve().parents[1] / 'data' / 'douyin-cookie.json'
            if not args.anonymous and cookie_file.is_file():
                context.add_cookies(json.loads(cookie_file.read_text(encoding='utf-8')))
            page = context.pages[0] if context.pages else context.new_page()
            if args.kind == 'check':
                page.goto(url, wait_until='domcontentloaded', timeout=45000)
                page.wait_for_timeout(4000)
                # passport/account/info answers "该应用无权限" on douyin.com; profile/self returns the signed-in user.
                info = page.evaluate("""() => fetch('/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383', {credentials: 'include'})
                    .then(r => r.json()).catch(e => ({error: String(e)}))""")
                user = (info or {}).get('user') or {}
                if (info or {}).get('status_code') == 0 and (user.get('uid') or user.get('sec_uid')):
                    print(json.dumps({'loggedIn': True, 'name': user.get('nickname') or ''}, ensure_ascii=True))
                else:
                    print(json.dumps({'loggedIn': False}))
                return
            if args.login:
                page.goto('https://www.douyin.com/', wait_until='domcontentloaded', timeout=45000)
                try:
                    while context.pages:
                        page.wait_for_timeout(1000)
                except Error:
                    pass
                return

            def response_received(response):
                parsed = urlparse(response.url)
                if parsed.hostname and parsed.hostname.endswith('.douyin.com') and ('search' in parsed.path or '/aweme/' in parsed.path):
                    try:
                        collect_nodes(response.json(), found)
                    except (Error, ValueError, TypeError):
                        pass

            page.on('response', response_received)
            response = page.goto(url, wait_until='domcontentloaded', timeout=45000)
            if not response or response.status >= 400:
                raise RuntimeError(f'Douyin HTTP {response.status if response else "no response"}')
            for _ in range(3):
                page.wait_for_timeout(3500)
                for script in page.locator('script[type="application/json"], script#RENDER_DATA').all_text_contents():
                    try:
                        collect_nodes(json.loads(unquote(script)), found)
                    except (ValueError, TypeError):
                        pass
                for link in page.locator('a[href*="/video/"], a[href*="modal_id="]').evaluate_all(
                    'nodes => nodes.map(n => ({url: n.href, title: n.textContent || ""}))'
                ):
                    identity = re.search(r'(?:/video/|modal_id=)(\d{15,25})', link['url'])
                    if identity and identity.group(1) not in found:
                        found[identity.group(1)] = {'url': f'https://www.douyin.com/video/{identity.group(1)}', 'title': link['title'].strip()[:250]}
                page.mouse.wheel(0, 850)
            if not found:
                raise RuntimeError('Douyin did not return public video results. This source may require login or verification; try the public feed instead.')
            print(json.dumps({'items': list(found.values())[:50]}, ensure_ascii=True))
        finally:
            context.close()
            if browser:
                browser.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
