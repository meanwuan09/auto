import argparse
import json
import re
import shutil
import subprocess
import tempfile
from http.cookiejar import Cookie, MozillaCookieJar
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
YTDLP = ROOT / "tools" / "yt-dlp.exe"
FFMPEG = ROOT / "tools" / "ffmpeg.exe"
# The ffmpeg installer has unpacked into different tools/ subfolders over time; use whichever ffprobe exists.
FFPROBE = next((path for path in [ROOT / "tools" / "ffprobe.exe", *sorted((ROOT / "tools").glob("*/ffmpeg-*/bin/ffprobe.exe"))]
                if path.is_file()), Path(shutil.which("ffprobe") or "ffprobe"))


def video_url(value):
    parsed = urlparse(value)
    if parsed.scheme != 'https' or parsed.hostname not in {'douyin.com', 'www.douyin.com', 'v.douyin.com'}:
        raise ValueError('Expected a Douyin HTTPS URL')
    match = re.fullmatch(r'/video/(\d{15,25})/?', parsed.path)
    identity = match.group(1) if match else parse_qs(parsed.query).get('modal_id', [''])[0]
    if re.fullmatch(r'\d{15,25}', identity):
        return f'https://www.douyin.com/video/{identity}'
    if parsed.hostname == 'v.douyin.com' and re.fullmatch(r'/[\w-]+/?', parsed.path):
        return value
    raise ValueError('Expected a single video link')


def cookie_jar(cookies, destination):
    jar = MozillaCookieJar(str(destination))
    for entry in cookies:
        if not entry["name"]:
            continue
        domain = entry["domain"]
        jar.set_cookie(Cookie(
            version=0, name=entry["name"], value=entry["value"],
            port=None, port_specified=False, domain=domain,
            domain_specified=True, domain_initial_dot=domain.startswith("."),
            path=entry["path"], path_specified=True, secure=entry["secure"],
            expires=int(entry["expires"]) if entry["expires"] > 0 else None,
            discard=entry["expires"] <= 0, comment=None, comment_url=None,
            rest={"HttpOnly": entry.get("httpOnly", False)}, rfc2109=False,
        ))
    jar.save(ignore_discard=True, ignore_expires=True)


def probe(file):
    return json.loads(subprocess.check_output([
        str(FFPROBE), '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(file)
    ], text=True))


def find_detail(node, identity):
    if isinstance(node, dict):
        if str(node.get('aweme_id')) == identity and isinstance(node.get('video'), dict):
            return node
        for value in node.values():
            found = find_detail(value, identity)
            if found:
                return found
    elif isinstance(node, list):
        for value in node:
            found = find_detail(value, identity)
            if found:
                return found
    return None


def best_stream(video):
    """Highest-bitrate rendition; play_addr is the fallback when no bit_rate list is present."""
    options = [(entry.get('bit_rate') or 0, (entry.get('play_addr') or {}).get('url_list') or [])
               for entry in video.get('bit_rate') or []]
    options.append((0, (video.get('play_addr') or {}).get('url_list') or []))
    options = [(rate, urls) for rate, urls in options if urls]
    if not options:
        raise RuntimeError('Douyin did not return a playable stream')
    return max(options, key=lambda option: option[0])[1]


def download_embed(playwright, identity, output):
    """Douyin's official embed player signs its own detail request, which plain yt-dlp can no longer do.
    Read the stream list from that response and fetch the file with the same browser session."""
    browser = playwright.chromium.launch(channel="chrome", headless=True)
    try:
        context = browser.new_context()
        page = context.new_page()
        details = []

        def response_received(response):
            if '/aweme/v1/web/aweme/detail/' in response.url:
                try:
                    details.append(response.json())
                except Exception:
                    pass

        page.on('response', response_received)
        page.goto(f'https://open.douyin.com/player/video?vid={identity}&autoplay=0', wait_until='domcontentloaded', timeout=45000)
        for _ in range(30):
            if details:
                break
            page.wait_for_timeout(500)
        detail = next((found for found in (find_detail(body, identity) for body in details) if found), None)
        if not detail:
            raise RuntimeError('Douyin embed player did not return video details')
        last_error = None
        for stream in best_stream(detail['video']):
            response = context.request.get(stream, headers={'Referer': 'https://open.douyin.com/'}, timeout=300000)
            if response.ok and response.body():
                output.write_bytes(response.body())
                return {'id': identity, 'title': detail.get('desc', ''),
                        'uploader': (detail.get('author') or {}).get('nickname', ''), 'download_backend': 'douyin-embed'}
            last_error = f'HTTP {response.status}'
        raise RuntimeError(f'Could not download the Douyin stream ({last_error})')
    finally:
        browser.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    url = video_url(args.url)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    identity = re.search(r'/video/(\d{15,25})', url)

    if identity:
        with tempfile.TemporaryDirectory(prefix='douyin-', dir=args.output.parent) as temporary:
            downloaded = Path(temporary) / 'video.mp4'
            try:
                print('Downloading Douyin video via embed player...', flush=True)
                with sync_playwright() as playwright:
                    metadata = download_embed(playwright, identity.group(1), downloaded)
                info = probe(downloaded)
                duration = float(info['format']['duration'])
                if duration <= 0 or not any(stream['codec_type'] == 'video' for stream in info['streams']):
                    raise RuntimeError('Downloaded file is not a playable video')
                metadata.update({'source_url': url, 'duration': duration, 'bytes': downloaded.stat().st_size})
                downloaded.replace(args.output)
                args.output.with_suffix('.download.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
                print(f'Download verified: {duration:.2f}s, {metadata["bytes"]} bytes', flush=True)
                return
            except Exception as error:
                print(f'Embed download failed ({error}); falling back to yt-dlp', flush=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="chrome", headless=True)
        context = browser.new_context(locale="zh-CN", timezone_id="Asia/Shanghai")
        page = context.new_page()
        response = page.goto(url, wait_until="domcontentloaded", timeout=45000)
        if not response or response.status >= 400:
            raise RuntimeError(f"Douyin returned HTTP {response.status if response else 'no response'}")
        page.wait_for_timeout(6000)
        # Douyin sometimes redirects a valid video to its feed; keep the requested link then.
        try:
            url = video_url(page.url)
        except ValueError:
            pass
        cookies = context.cookies()
        browser.close()

    with tempfile.TemporaryDirectory(prefix='douyin-', dir=args.output.parent) as temporary:
        folder = Path(temporary)
        cookie_path = folder / 'cookies.txt'
        cookie_jar(cookies, cookie_path)
        print('Downloading Douyin video...', flush=True)
        subprocess.run([
            str(YTDLP), "--cookies", cookie_path, "--no-playlist",
            "--write-info-json", "--socket-timeout", "30", "--retries", "3",
            "--ffmpeg-location", str(FFMPEG),
            "-f", "bv*+ba/b", "--merge-output-format", "mp4",
            "-o", str(folder / 'video.%(ext)s'), url,
        ], check=True, timeout=480)
        downloaded = folder / 'video.mp4'
        if not downloaded.exists() or downloaded.stat().st_size == 0:
            raise RuntimeError('Downloader did not return an MP4 video')
        info = probe(downloaded)
        duration = float(info['format']['duration'])
        if duration <= 0 or not any(stream['codec_type'] == 'video' for stream in info['streams']):
            raise RuntimeError('Downloaded file is not a playable video')
        info = json.loads((folder / 'video.info.json').read_text(encoding='utf-8'))
        metadata = {'id': info['id'], 'title': info.get('title', ''), 'source_url': url,
                    'duration': duration, 'bytes': downloaded.stat().st_size,
                    'uploader': info.get('uploader', ''), 'download_backend': 'chrome+yt-dlp'}
        downloaded.replace(args.output)
        args.output.with_suffix('.download.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'Download verified: {duration:.2f}s, {metadata["bytes"]} bytes', flush=True)


if __name__ == "__main__":
    main()
