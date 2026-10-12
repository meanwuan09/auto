from __future__ import annotations

import re
import subprocess
import time
from pathlib import Path

import imageio_ffmpeg
import requests

from app.models.schemas import VoiceResult
from app.providers.base import TTSProvider


class GenmaxTTSProvider(TTSProvider):
    """Genmax async TTS adapter using its documented external API."""

    name = "genmax"

    def __init__(self, api_key: str, base_url: str, voice_id: str,
                 model_id: str = "eleven_v3", engine: str = "elevenlabs",
                 language: str = "vi", timeout: float = 180, session=None):
        if (not api_key or not voice_id) and session is None:
            raise ValueError("GENMAX_API_KEY and GENMAX_VOICE_ID are required when tts_provider=genmax")
        self.api_key, self.base_url, self.voice_id = api_key, base_url.rstrip("/"), voice_id
        self.model_id, self.engine, self.language = model_id, engine, language
        self.timeout, self.session = timeout, session or requests.Session()

    @property
    def headers(self):
        return {"xi-api-key": self.api_key, "Content-Type": "application/json"}

    def synthesize(self, text: str, output_path: Path, speech_rate: float = 1) -> VoiceResult:
        response = self.session.post(
            f"{self.base_url}/text-to-speech/{self.voice_id}",
            headers=self.headers,
            json={
                "text": text,
                "model_id": self.model_id,
                "provider": self.engine,
                "language_code": self.language,
                "voice_settings": {
                    "stability": .5,
                    "similarity_boost": .75,
                    "style": .15,
                    "use_speaker_boost": True,
                    "speed": speech_rate,
                },
                "export_transcript": False,
            },
            timeout=30,
        )
        response.raise_for_status()
        task_id = response.json()["id"]
        deadline, delay = time.monotonic() + self.timeout, 1.0
        task = None
        while time.monotonic() < deadline:
            status_response = self.session.get(
                f"{self.base_url}/history/{task_id}",
                headers={"xi-api-key": self.api_key},
                timeout=30,
            )
            status_response.raise_for_status()
            task = status_response.json()
            if task.get("status") == "completed":
                break
            if task.get("status") == "failed":
                raise RuntimeError(f"Genmax TTS failed: {task.get('error') or 'unknown error'}")
            time.sleep(delay)
            delay = min(delay * 1.5, 5)
        else:
            raise TimeoutError(f"Genmax TTS task did not finish within {self.timeout}s")
        audio_url = (task.get("result") or {}).get("audio_url")
        if not audio_url:
            raise RuntimeError("Genmax completed task has no audio_url")
        audio_response = self.session.get(audio_url, timeout=60)
        audio_response.raise_for_status()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        downloaded = output_path.with_suffix(".download.mp3")
        downloaded.write_bytes(audio_response.content)
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        conversion = subprocess.run(
            [ffmpeg, "-y", "-i", str(downloaded), "-ac", "1", "-ar", "24000", str(output_path)],
            capture_output=True, text=True, timeout=120,
        )
        downloaded.unlink(missing_ok=True)
        if conversion.returncode:
            raise RuntimeError(conversion.stderr[-2000:])
        duration = self._duration(output_path)
        words = text.split()
        timestamps = [
            {"word": word, "start": i * duration / max(len(words), 1),
             "end": (i + 1) * duration / max(len(words), 1)}
            for i, word in enumerate(words)
        ]
        return VoiceResult(
            audio_path=output_path, duration_seconds=duration, provider=self.name,
            voice_id=self.voice_id, speech_rate=speech_rate, word_timestamps=timestamps,
        )

    @staticmethod
    def _duration(path: Path) -> float:
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        result = subprocess.run([ffmpeg, "-hide_banner", "-i", str(path)],
                                capture_output=True, text=True, timeout=30)
        match = re.search(r"Duration: (\d+):(\d+):([\d.]+)", result.stderr)
        if not match:
            raise RuntimeError("Could not read Genmax audio duration")
        return int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3])
