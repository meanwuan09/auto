from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageEnhance, ImageFont
from pydantic import BaseModel, Field, model_validator

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.providers.deepseek import DeepSeekLLMProvider
from app.providers.genmax import GenmaxTTSProvider
from app.rendering.video import inspect_video


BACKGROUND = ROOT / "assets" / "backgrounds" / "var-controversy-original.png"
OUTPUT = ROOT / "output" / "sports-demo"


class SportsScene(BaseModel):
    scene: int = Field(ge=1, le=6)
    voiceover: str
    on_screen_text: str = Field(min_length=1, max_length=42)


class SportsShort(BaseModel):
    title: str = Field(min_length=5, max_length=55)
    scenes: list[SportsScene]
    disclaimer: str = "Tình huống giả định"

    @model_validator(mode="after")
    def validate_script(self):
        if len(self.scenes) != 6 or [scene.scene for scene in self.scenes] != list(range(1, 7)):
            raise ValueError("Cần đúng sáu cảnh được đánh số từ 1 đến 6")
        count = len(self.voiceover.split())
        if not 100 <= count <= 125:
            raise ValueError(f"Lời đọc phải có 100-125 từ, hiện có {count}")
        return self

    @property
    def voiceover(self) -> str:
        return " ".join(scene.voiceover.strip() for scene in self.scenes)


def font(size: int, bold: bool = False):
    filename = "arialbd.ttf" if bold else "arial.ttf"
    return ImageFont.truetype(str(Path("C:/Windows/Fonts") / filename), size)


def wrap(draw: ImageDraw.ImageDraw, text: str, selected_font, width: int) -> str:
    lines: list[str] = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}".strip()
        if draw.textbbox((0, 0), candidate, font=selected_font)[2] <= width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return "\n".join(lines)


def fit_background(source: Image.Image, index: int) -> Image.Image:
    target_ratio = 1080 / 1920
    src_ratio = source.width / source.height
    if src_ratio > target_ratio:
        crop_width = int(source.height * target_ratio)
        left = (source.width - crop_width) // 2
        source = source.crop((left, 0, left + crop_width, source.height))
    else:
        crop_height = int(source.width / target_ratio)
        top = max(0, (source.height - crop_height) // 2)
        source = source.crop((0, top, source.width, top + crop_height))
    zoom = 1 + index * 0.012
    enlarged = source.resize((int(1080 * zoom), int(1920 * zoom)), Image.Resampling.LANCZOS)
    left = (enlarged.width - 1080) // 2
    top = min((enlarged.height - 1920) // 2 + index * 5, enlarged.height - 1920)
    return enlarged.crop((left, top, left + 1080, top + 1920))


def create_scene(background: Image.Image, script: SportsShort, scene: SportsScene,
                 index: int, duration: float, path: Path):
    image = fit_background(background, index)
    image = ImageEnhance.Brightness(image).enhance(0.56)
    image = ImageEnhance.Color(image).enhance(0.78)
    overlay = Image.new("RGBA", image.size, (2, 10, 24, 0))
    od = ImageDraw.Draw(overlay)
    od.rectangle((0, 0, 1080, 580), fill=(2, 10, 24, 190))
    od.rectangle((0, 1260, 1080, 1920), fill=(2, 10, 24, 205))
    image = Image.alpha_composite(image.convert("RGBA"), overlay)
    draw = ImageDraw.Draw(image)

    accent = "#22D3EE" if index not in {2, 3} else "#FB7185"
    draw.rounded_rectangle((64, 70, 405, 132), 20, fill="#DC2626")
    draw.text((235, 101), "TÌNH HUỐNG GIẢ ĐỊNH", font=font(26, True),
              fill="white", anchor="mm")
    draw.text((65, 185), "GÓC TRANH CÃI", font=font(35, True), fill=accent)
    title = wrap(draw, script.title.upper(), font(58, True), 930)
    draw.multiline_text((65, 245), title, font=font(58, True), fill="white", spacing=12)

    main = wrap(draw, scene.on_screen_text, font(72, True), 900)
    bbox = draw.multiline_textbbox((0, 0), main, font=font(72, True), spacing=16, align="center")
    box_height = bbox[3] - bbox[1] + 90
    y = 870
    draw.rounded_rectangle((55, y - box_height // 2, 1025, y + box_height // 2),
                           28, fill=(2, 10, 24, 220), outline=accent, width=4)
    draw.multiline_text((540, y), main, font=font(72, True), fill="white",
                        anchor="mm", align="center", spacing=16)

    caption = wrap(draw, scene.voiceover, font(38, True), 900)
    draw.rounded_rectangle((55, 1380, 1025, 1740), 26, fill=(0, 0, 0, 190))
    draw.multiline_text((540, 1560), caption, font=font(38, True), fill="white",
                        anchor="mm", align="center", spacing=14)

    draw.rounded_rectangle((65, 1810, 1015, 1840), 15, fill="#334155")
    progress = 65 + int(950 * (index + 1) / 6)
    draw.rounded_rectangle((65, 1810, progress, 1840), 15, fill=accent)
    draw.text((65, 1875), f"VAR • LUẬT BÓNG ĐÁ  |  {index + 1}/6",
              font=font(27, True), fill="#E2E8F0")
    image.convert("RGB").save(path, quality=94)


def generate_script() -> SportsShort:
    provider = DeepSeekLLMProvider(
        os.environ["DEEPSEEK_API_KEY"],
        os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        os.getenv("DEEPSEEK_API_BASE_URL", "https://api.deepseek.com"),
        prompt_dir=ROOT / "app" / "prompts",
    )
    payload = {
        "language": "vi",
        "format": "vertical short",
        "target_duration_seconds": 32,
        "topic": "VAR và thẻ vàng thứ hai theo Luật Bóng đá 2026/27",
        "tone": "căng thẳng, khách quan, dễ hiểu",
    }
    error = None
    for _ in range(3):
        try:
            return provider.structured("sports_demo", payload, SportsShort)
        except Exception as exc:
            error = exc
            payload["retry_instruction"] = str(exc)
    raise RuntimeError(f"DeepSeek không tạo được kịch bản hợp lệ: {error}")


def synthesize(script: SportsShort, output_path: Path):
    provider = GenmaxTTSProvider(
        os.environ["GENMAX_API_KEY"],
        os.getenv("GENMAX_API_BASE_URL", "https://api.genmax.io/v1"),
        os.environ["GENMAX_VOICE_ID"],
        os.getenv("GENMAX_MODEL_ID", "eleven_v3"),
        os.getenv("GENMAX_ENGINE", "elevenlabs"),
        "vi",
    )
    voice = provider.synthesize(script.voiceover, output_path)
    if not 25 <= voice.duration_seconds <= 45:
        rate = min(1.15, max(0.85, voice.duration_seconds / 32))
        voice = provider.synthesize(script.voiceover, output_path, speech_rate=rate)
    if not 25 <= voice.duration_seconds <= 45:
        raise RuntimeError(f"Voice dài {voice.duration_seconds:.2f}s, ngoài khoảng 25-45s")
    return voice


def render(script: SportsShort, audio_path: Path, duration: float, output_path: Path):
    background = Image.open(BACKGROUND).convert("RGB")
    weights = [0.10, 0.17, 0.15, 0.16, 0.25, 0.17]
    durations = [round(duration * weight, 3) for weight in weights]
    durations[-1] = round(duration - sum(durations[:-1]), 3)
    concat_lines = ["ffconcat version 1.0"]
    cursor = 0.0
    srt: list[str] = []
    for index, (scene, scene_duration) in enumerate(zip(script.scenes, durations)):
        scene_path = OUTPUT / f"scene_{index + 1}.jpg"
        create_scene(background, script, scene, index, scene_duration, scene_path)
        concat_lines += [f"file '{scene_path.resolve().as_posix()}'", f"duration {scene_duration}"]
        srt.append(
            f"{index + 1}\n{timestamp(cursor)} --> {timestamp(cursor + scene_duration)}\n"
            f"{scene.voiceover}\n"
        )
        cursor += scene_duration
    concat_lines.append(f"file '{(OUTPUT / 'scene_6.jpg').resolve().as_posix()}'")
    concat_path = OUTPUT / "scenes.ffconcat"
    concat_path.write_text("\n".join(concat_lines), encoding="utf-8")
    (OUTPUT / "sports_demo.srt").write_text("\n".join(srt), encoding="utf-8")

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    command = [
        ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat_path),
        "-i", str(audio_path), "-t", f"{duration:.3f}",
        "-vf", "scale=1080:1920,format=yuv420p", "-r", "30", "-vsync", "cfr",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart",
        str(output_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=240)
    if result.returncode:
        raise RuntimeError(result.stderr[-3000:])


def timestamp(seconds: float) -> str:
    milliseconds = round(seconds * 1000)
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02},{millis:03}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reuse-script", action="store_true")
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    script_path = OUTPUT / "script.json"
    if args.reuse_script and script_path.exists():
        script = SportsShort.model_validate_json(script_path.read_text(encoding="utf-8"))
    else:
        script = generate_script()
        script_path.write_text(script.model_dump_json(indent=2), encoding="utf-8")
    voice = synthesize(script, OUTPUT / "voice.wav")
    video_path = OUTPUT / "sports_var_complete.mp4"
    render(script, Path(voice.audio_path), voice.duration_seconds, video_path)
    info = inspect_video(video_path)
    manifest = {
        "script": str(script_path),
        "background": str(BACKGROUND),
        "voice": str(voice.audio_path),
        "video": str(video_path),
        "voice_provider": voice.provider,
        "voice_id": voice.voice_id,
        "llm_provider": "deepseek",
        "model": os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        "word_count": len(script.voiceover.split()),
        "technical": info,
        "disclaimer": script.disclaimer,
    }
    (OUTPUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
