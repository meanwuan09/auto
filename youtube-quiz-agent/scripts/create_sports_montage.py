from __future__ import annotations

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
from app.rendering.video import inspect_video, qa_video


OUTPUT = ROOT / "output" / "sports-demo-v2"
ASSETS = [
    ROOT / "assets" / "backgrounds" / "var-tackle-original.png",
    ROOT / "assets" / "backgrounds" / "var-controversy-original.png",
    ROOT / "assets" / "backgrounds" / "var-room-original.png",
    ROOT / "assets" / "backgrounds" / "var-review-original.png",
]
SHOT_ORDER = [0, 1, 0, 2, 0, 3, 2, 3]


class MontageScript(BaseModel):
    headline: str = Field(min_length=8, max_length=58)
    narration: list[str]
    disclaimer: str = "Tình huống giả định"

    @model_validator(mode="after")
    def validate_content(self):
        if len(self.narration) != 4:
            raise ValueError("narration phải có đúng bốn đoạn")
        count = len(self.full_text.split())
        # DeepSeek occasionally treats Vietnamese punctuation as word boundaries
        # differently. Duration remains the final production gate.
        if not 90 <= count <= 170:
            raise ValueError(f"narration phải có 90-170 từ, hiện có {count}")
        forbidden = ("tập sau", "theo dõi", "đăng ký", "hẹn gặp")
        if any(value in self.full_text.lower() for value in forbidden):
            raise ValueError("không được có CTA hoặc nội dung nối tập")
        return self

    @property
    def full_text(self):
        return " ".join(part.strip() for part in self.narration)


def selected_font(size: int, bold=False):
    return ImageFont.truetype(
        str(Path("C:/Windows/Fonts") / ("arialbd.ttf" if bold else "arial.ttf")), size
    )


def cover(source: Image.Image) -> Image.Image:
    ratio = max(1080 / source.width, 1920 / source.height)
    resized = source.resize(
        (round(source.width * ratio), round(source.height * ratio)), Image.Resampling.LANCZOS
    )
    left = (resized.width - 1080) // 2
    top = (resized.height - 1920) // 2
    return resized.crop((left, top, left + 1080, top + 1920))


def wrap(draw: ImageDraw.ImageDraw, text: str, font, max_width: int):
    lines, current = [], ""
    for word in text.split():
        candidate = f"{current} {word}".strip()
        if draw.textbbox((0, 0), candidate, font=font)[2] <= max_width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return "\n".join(lines)


def prepare_still(source_path: Path, target: Path, headline: str, first=False):
    image = cover(Image.open(source_path).convert("RGB"))
    image = ImageEnhance.Contrast(image).enhance(1.08)
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw.rectangle((0, 0, 1080, 330), fill=(0, 8, 20, 165))
    draw.rectangle((0, 1580, 1080, 1920), fill=(0, 0, 0, 105))
    draw.rounded_rectangle((50, 55, 364, 111), 18, fill=(220, 38, 38, 235))
    draw.text((207, 83), "TÌNH HUỐNG GIẢ ĐỊNH", font=selected_font(24, True),
              fill="white", anchor="mm")
    if first:
        title = wrap(draw, headline.upper(), selected_font(62, True), 950)
        draw.multiline_text((55, 155), title, font=selected_font(62, True),
                            fill="white", spacing=8)
    else:
        draw.text((55, 165), "GÓC NHÌN VAR", font=selected_font(34, True), fill="#22D3EE")
    Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB").save(target, quality=95)


def generate_script() -> MontageScript:
    provider = DeepSeekLLMProvider(
        os.environ["DEEPSEEK_API_KEY"],
        os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        os.getenv("DEEPSEEK_API_BASE_URL", "https://api.deepseek.com"),
        ROOT / "app" / "prompts",
    )
    payload = {
        "language": "vi",
        "duration_seconds": 32,
        "format": "continuous sports commentary over full-screen still-image montage",
        "topic": "VAR và thẻ vàng thứ hai theo Luật Bóng đá 2026/27",
    }
    last_error = None
    for _ in range(3):
        try:
            return provider.structured("sports_montage", payload, MontageScript)
        except Exception as exc:
            last_error = exc
            payload["retry_instruction"] = str(exc)
    raise RuntimeError(f"DeepSeek không tạo được kịch bản hợp lệ: {last_error}")


def synthesize(script: MontageScript):
    provider = GenmaxTTSProvider(
        os.environ["GENMAX_API_KEY"],
        os.getenv("GENMAX_API_BASE_URL", "https://api.genmax.io/v1"),
        os.environ["GENMAX_VOICE_ID"],
        os.getenv("GENMAX_MODEL_ID", "eleven_v3"),
        os.getenv("GENMAX_ENGINE", "elevenlabs"),
        "vi",
    )
    voice = provider.synthesize(script.full_text, OUTPUT / "voice.wav")
    if not 25 <= voice.duration_seconds <= 45:
        speed = min(1.15, max(0.85, voice.duration_seconds / 32))
        voice = provider.synthesize(script.full_text, OUTPUT / "voice.wav", speed)
    if not 25 <= voice.duration_seconds <= 45:
        raise RuntimeError(f"Voice {voice.duration_seconds:.2f}s nằm ngoài khoảng 25-45s")
    return voice


def ass_time(seconds: float):
    centiseconds = round(seconds * 100)
    hours, remainder = divmod(centiseconds, 360_000)
    minutes, remainder = divmod(remainder, 6_000)
    secs, cs = divmod(remainder, 100)
    return f"{hours}:{minutes:02}:{secs:02}.{cs:02}"


def create_ass(text: str, duration: float, target: Path):
    words = text.split()
    chunks, index = [], 0
    while index < len(words):
        take = min(7, len(words) - index)
        chunks.append(" ".join(words[index:index + take]))
        index += take
    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "PlayResX: 1080",
        "PlayResY: 1920",
        "WrapStyle: 2",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Caption,Arial,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H99000000,"
        "-1,0,0,0,100,100,0,0,3,3,0,2,70,70,185,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    cursor = 0.0
    total_words = max(len(words), 1)
    for chunk in chunks:
        chunk_duration = duration * len(chunk.split()) / total_words
        end = min(duration, cursor + chunk_duration)
        lines.append(
            f"Dialogue: 0,{ass_time(cursor)},{ass_time(end)},Caption,,0,0,0,,{chunk}"
        )
        cursor = end
    target.write_text("\n".join(lines), encoding="utf-8-sig")


def render(script: MontageScript, voice):
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    prepared = []
    for index, asset in enumerate(ASSETS):
        target = OUTPUT / f"still_{index + 1}.jpg"
        prepare_still(asset, target, script.headline, first=index == 0)
        prepared.append(target)

    shot_duration = voice.duration_seconds / len(SHOT_ORDER)
    clips = []
    for index, asset_index in enumerate(SHOT_ORDER):
        clip = OUTPUT / f"shot_{index + 1}.mp4"
        zoom = "min(zoom+0.0007,1.07)" if index % 2 == 0 else "if(eq(on,1),1.07,max(zoom-0.0007,1.0))"
        command = [
            ffmpeg, "-y", "-loop", "1", "-framerate", "30", "-i", str(prepared[asset_index]),
            "-t", f"{shot_duration:.4f}",
            "-vf", f"zoompan=z='{zoom}':x='iw/2-(iw/zoom/2)':"
                   "y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30,format=yuv420p",
            "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", str(clip),
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=180)
        if result.returncode:
            raise RuntimeError(result.stderr[-2500:])
        clips.append(clip)

    concat = OUTPUT / "shots.ffconcat"
    concat.write_text(
        "ffconcat version 1.0\n" + "\n".join(
            f"file '{clip.resolve().as_posix()}'" for clip in clips
        ),
        encoding="utf-8",
    )
    captions = OUTPUT / "captions.ass"
    create_ass(script.full_text, voice.duration_seconds, captions)
    silent = OUTPUT / "montage-silent.mp4"
    join = subprocess.run(
        [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
         "-c", "copy", str(silent)],
        capture_output=True, text=True, timeout=180,
    )
    if join.returncode:
        raise RuntimeError(join.stderr[-2500:])

    video = OUTPUT / "sports_var_montage.mp4"
    subtitle_filter = "subtitles=output/sports-demo-v2/captions.ass"
    mux = subprocess.run(
        [ffmpeg, "-y", "-i", str(silent), "-i", str(voice.audio_path),
         "-t", f"{voice.duration_seconds:.3f}", "-vf", subtitle_filter,
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
         "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", str(video)],
        cwd=ROOT, capture_output=True, text=True, timeout=300,
    )
    if mux.returncode:
        raise RuntimeError(mux.stderr[-3000:])
    return video


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    script = generate_script()
    (OUTPUT / "script.json").write_text(script.model_dump_json(indent=2), encoding="utf-8")
    voice = synthesize(script)
    video = render(script, voice)
    technical = inspect_video(video)
    qa = qa_video(video)
    (OUTPUT / "qa.json").write_text(qa.model_dump_json(indent=2), encoding="utf-8")
    manifest = {
        "video": str(video),
        "script": str(OUTPUT / "script.json"),
        "voice": str(voice.audio_path),
        "duration_seconds": technical["duration"],
        "word_count": len(script.full_text.split()),
        "llm": "deepseek",
        "tts": "genmax",
        "style": "continuous full-screen still montage with Ken Burns motion",
        "has_next_episode": False,
        "qa_passed": qa.passed,
        "technical": technical,
    }
    (OUTPUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
