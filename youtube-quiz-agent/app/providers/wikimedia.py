from __future__ import annotations

import html
import json
import re
import subprocess
from pathlib import Path

import imageio_ffmpeg
import numpy as np
import requests
from pydantic import BaseModel

from app.rendering.video import inspect_video


class CommonsVideo(BaseModel):
    title: str
    source_page: str
    download_url: str
    mime: str
    width: int
    height: int
    duration_seconds: float
    author: str
    license_name: str
    license_url: str
    attribution: str
    description: str = ""
    categories: list[str] = []
    requires_share_alike: bool = False


class ExtractedClip(BaseModel):
    source: CommonsVideo
    original_path: Path
    clip_path: Path
    start_second: float
    duration_seconds: float
    motion_score: float


class WikimediaCommonsVideoProvider:
    """Downloads only Commons videos whose reuse license is explicitly allowed."""

    API_URL = "https://commons.wikimedia.org/w/api.php"
    ALLOWED_LICENSE_MARKERS = (
        "cc by ",
        "cc-by-",
        "creative commons attribution",
        "public domain",
        "cc0",
    )

    def __init__(self, session=None, timeout=90, allow_share_alike=False):
        self.session = session or requests.Session()
        self.session.headers.update({
            "User-Agent": "YouTubeQuizAgent/0.1 (licensed-media-ingestion-test)"
        })
        self.timeout = timeout
        self.allow_share_alike = allow_share_alike

    @staticmethod
    def _plain(value: str) -> str:
        value = re.sub(r"<[^>]+>", " ", value or "")
        return " ".join(html.unescape(value).split())

    def resolve(self, filename: str) -> CommonsVideo:
        title = filename if filename.startswith("File:") else f"File:{filename}"
        response = self.session.get(
            self.API_URL,
            params={
                "action": "query",
                "format": "json",
                "formatversion": "2",
                "prop": "imageinfo|categories",
                "titles": title,
                "iiprop": "url|mime|size|extmetadata",
                "cllimit": "max",
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        page = response.json()["query"]["pages"][0]
        if page.get("missing"):
            raise FileNotFoundError(title)
        info = page["imageinfo"][0]
        if not info.get("mime", "").startswith("video/"):
            raise ValueError(f"{title} is not a video")
        metadata = info.get("extmetadata", {})

        def meta(name):
            return self._plain((metadata.get(name) or {}).get("value", ""))

        license_name = meta("LicenseShortName") or meta("UsageTerms")
        license_url = meta("LicenseUrl")
        searchable = f"{license_name} {license_url} {meta('Copyrighted')}".lower()
        share_alike = "by-sa" in searchable or "by sa" in searchable
        allowed = any(marker in searchable for marker in self.ALLOWED_LICENSE_MARKERS)
        if share_alike and self.allow_share_alike:
            allowed = True
        if not allowed:
            raise PermissionError(f"License is not in the allowlist: {license_name or 'unknown'}")
        author = meta("Artist") or meta("Credit") or "Unknown"
        attribution = meta("Attribution") or f"{author} — {license_name}"
        return CommonsVideo(
            title=page["title"],
            source_page=info["descriptionurl"],
            download_url=info["url"],
            mime=info["mime"],
            width=int(info.get("width") or 0),
            height=int(info.get("height") or 0),
            duration_seconds=float(info.get("duration") or 0),
            author=author,
            license_name=license_name,
            license_url=license_url,
            attribution=attribution,
            description=meta("ImageDescription"),
            categories=[item["title"] for item in page.get("categories", [])],
            requires_share_alike=share_alike,
        )

    def download(self, asset: CommonsVideo, target: Path, max_bytes=250_000_000) -> Path:
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_suffix(f"{target.suffix}.part")
        total = 0
        with self.session.get(asset.download_url, stream=True, timeout=self.timeout) as response:
            response.raise_for_status()
            declared = int(response.headers.get("Content-Length") or 0)
            if declared and declared > max_bytes:
                raise ValueError(f"Video is too large: {declared} bytes")
            with temp.open("wb") as handle:
                for chunk in response.iter_content(1024 * 1024):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > max_bytes:
                        raise ValueError(f"Video exceeded {max_bytes} bytes")
                    handle.write(chunk)
        temp.replace(target)
        return target

    @staticmethod
    def choose_high_motion_window(path: Path, clip_seconds=10, sample_fps=2):
        """Cheap CPU-only selector: grayscale frame differences, no vision model."""
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        result = subprocess.run(
            [
                ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(path),
                "-vf", f"fps={sample_fps},scale=160:90,format=gray",
                "-f", "rawvideo", "-pix_fmt", "gray", "-",
            ],
            capture_output=True,
            timeout=180,
        )
        if result.returncode:
            raise RuntimeError(result.stderr.decode(errors="replace")[-2000:])
        frame_size = 160 * 90
        frame_count = len(result.stdout) // frame_size
        if frame_count < 2:
            return 0.0, 0.0
        frames = np.frombuffer(result.stdout[:frame_count * frame_size], dtype=np.uint8)
        frames = frames.reshape(frame_count, 90, 160).astype(np.int16)
        differences = np.abs(frames[1:] - frames[:-1]).mean(axis=(1, 2))
        window = max(1, round(clip_seconds * sample_fps))
        if len(differences) <= window:
            return 0.0, float(differences.mean())
        rolling = np.convolve(differences, np.ones(window) / window, mode="valid")
        best = int(np.argmax(rolling))
        duration = inspect_video(path)["duration"]
        start = min(best / sample_fps, max(0.0, duration - clip_seconds))
        return round(start, 3), round(float(rolling[best]), 4)

    @staticmethod
    def cut_vertical(source: Path, target: Path, start_second: float, duration_seconds=10):
        target.parent.mkdir(parents=True, exist_ok=True)
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        filters = (
            "[0:v]split=2[bg0][fg0];"
            "[bg0]scale=1080:1920:force_original_aspect_ratio=increase,"
            "crop=1080:1920,gblur=sigma=28[bg];"
            "[fg0]scale=1080:1920:force_original_aspect_ratio=decrease[fg];"
            "[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[outv]"
        )
        result = subprocess.run(
            [
                ffmpeg, "-y", "-ss", str(start_second), "-i", str(source),
                "-t", str(duration_seconds), "-filter_complex", filters,
                "-map", "[outv]", "-map", "0:a?", "-r", "30",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
                "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(target),
            ],
            capture_output=True, text=True, timeout=240,
        )
        if result.returncode:
            raise RuntimeError(result.stderr[-3000:])
        return target

    def fetch_best_clip(self, filename: str, output_dir: Path, clip_seconds=10) -> ExtractedClip:
        asset = self.resolve(filename)
        suffix = Path(asset.download_url.split("?")[0]).suffix or ".webm"
        original = self.download(asset, output_dir / f"source{suffix}")
        start, score = self.choose_high_motion_window(original, clip_seconds)
        clip = self.cut_vertical(
            original, output_dir / "real_people_vertical.mp4", start, clip_seconds
        )
        result = ExtractedClip(
            source=asset,
            original_path=original,
            clip_path=clip,
            start_second=start,
            duration_seconds=clip_seconds,
            motion_score=score,
        )
        (output_dir / "license-and-source.json").write_text(
            result.model_dump_json(indent=2), encoding="utf-8"
        )
        return result
