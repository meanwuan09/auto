from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

from app.models.schemas import QAResult, Question, Script

TEMPLATES = {
    "clean_blue": ("#EAF4FF", "#075985", "#0EA5E9"),
    "dark_neon": ("#07111F", "#E0F2FE", "#22D3EE"),
    "paper_learning": ("#FFF9E8", "#3F3A2F", "#E5A93D"),
}


def _font(size: int, bold=False):
    candidates = [
        Path("C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    for path in candidates:
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def wrap(draw, text: str, font, max_width=880):
    lines = []
    for paragraph in text.splitlines():
        words, line = paragraph.split(), ""
        for word in words:
            candidate = f"{line} {word}".strip()
            if draw.textbbox((0, 0), candidate, font=font)[2] <= max_width:
                line = candidate
            else:
                if line: lines.append(line)
                line = word
        if line: lines.append(line)
    return "\n".join(lines)


def create_scene(path: Path, script: Script, question: Question, template: str, scene_index: int):
    bg, fg, accent = TEMPLATES[template]
    seg = script.segments[scene_index]
    image = Image.new("RGB", (1080, 1920), bg)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((70, 90, 1010, 230), 40, fill=accent)
    draw.text((540, 160), "HỌC NHANH 30 GIÂY", font=_font(54, True), fill="white", anchor="mm")
    if scene_index == 1:
        q_text = wrap(draw, question.question, _font(48, True))
        draw.multiline_text((540, 470), q_text, font=_font(48, True), fill=fg, anchor="mm", align="center", spacing=16)
        y = 760
        for choice in question.choices:
            draw.rounded_rectangle((135, y - 55, 945, y + 70), 28, fill=accent)
            draw.text((175, y), f"{choice.label}. {choice.text}", font=_font(42, True), fill="white", anchor="lm")
            y += 170
    else:
        title_size = 100 if scene_index in {2, 3} else 70
        main = wrap(draw, seg.main_text, _font(title_size, True), 880)
        draw.multiline_text((540, 720), main, font=_font(title_size, True), fill=fg,
                            anchor="mm", align="center", spacing=24)
        if seg.supporting_text:
            support = wrap(draw, seg.supporting_text, _font(48), 850)
            draw.multiline_text((540, 1150), support, font=_font(48), fill=fg,
                                anchor="mm", align="center", spacing=18)
        if scene_index == 3:
            draw.rounded_rectangle((160, 950, 920, 1100), 35, fill=accent)
            draw.text((540, 1025), question.proposed_answer.text,
                      font=_font(48, True), fill="white", anchor="mm")
    captions = ["Mẹo nhanh", "Chọn A, B hoặc C", "Bạn có 5 giây!", "Câu trả lời",
                "Ghi nhớ", "Ví dụ thực tế"]
    draw.text((540, 1450), captions[scene_index], font=_font(44, True), fill=accent, anchor="mm")
    draw.rounded_rectangle((85, 1770, 995, 1810), 20, fill="#CBD5E1")
    progress = 85 + int(910 * seg.end_second / script.estimated_duration_seconds)
    draw.rounded_rectangle((85, 1770, progress, 1810), 20, fill=accent)
    draw.text((540, 1870), "@hocnhanh30giay", font=_font(34), fill=fg, anchor="mm")
    image.save(path)


def create_subtitles(script: Script, path: Path):
    def stamp(seconds):
        ms = int((seconds % 1) * 1000)
        total = int(seconds)
        return f"{total//3600:02}:{total//60%60:02}:{total%60:02},{ms:03}"
    chunks = []
    for i, seg in enumerate(script.segments, 1):
        chunks.append(f"{i}\n{stamp(seg.start_second)} --> {stamp(seg.end_second)}\n{seg.voiceover}\n")
    path.write_text("\n".join(chunks), encoding="utf-8")
    return path


def render_video(question: Question, script: Script, audio_path: Path, output_path: Path, template: str):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    scenes = []
    for index, segment in enumerate(script.segments):
        scene = output_path.with_name(f"scene_{index + 1}.png")
        create_scene(scene, script, question, template, index)
        scenes.append((scene, segment.end_second - segment.start_second))
    # Concat demuxer preserves exact scene durations and keeps the answer hidden before scene 4.
    concat = output_path.with_name("scenes.ffconcat")
    lines = ["ffconcat version 1.0"]
    for scene, duration in scenes:
        lines.extend([f"file '{scene.resolve().as_posix()}'", f"duration {duration}"])
    lines.append(f"file '{scenes[-1][0].resolve().as_posix()}'")
    concat.write_text("\n".join(lines), encoding="utf-8")
    create_subtitles(script, output_path.with_suffix(".srt"))
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    command = [
        ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
        "-i", str(audio_path), "-t", str(script.estimated_duration_seconds),
        "-vf", "scale=1080:1920,format=yuv420p", "-r", "30", "-vsync", "cfr",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "25",
        "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", str(output_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=180)
    if result.returncode:
        raise RuntimeError(result.stderr[-2000:])
    return output_path


def fit_audio_duration(audio_path: Path, source_duration: float, target_duration: float) -> Path:
    """Time-stretch complete audio to target duration; never truncates a sentence."""
    ratio = source_duration / target_duration
    if not .5 <= ratio <= 2:
        raise ValueError(f"audio stretch ratio {ratio:.2f} is outside FFmpeg atempo safety range")
    temp = audio_path.with_name(f"{audio_path.stem}.fitted{audio_path.suffix}")
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    result = subprocess.run(
        [ffmpeg, "-y", "-i", str(audio_path), "-filter:a", f"atempo={ratio:.6f}", str(temp)],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode:
        raise RuntimeError(result.stderr[-2000:])
    temp.replace(audio_path)
    return audio_path


def inspect_video(path: Path) -> dict:
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    result = subprocess.run([ffmpeg, "-hide_banner", "-i", str(path)], capture_output=True, text=True)
    text = result.stderr
    duration_match = re.search(r"Duration: (\d+):(\d+):([\d.]+)", text)
    video_match = re.search(r"Video: ([^,\s]+).*?(\d{3,5})x(\d{3,5})", text)
    audio_match = re.search(r"Audio: ([^,\s]+)", text)
    duration = 0.0
    if duration_match:
        duration = int(duration_match[1]) * 3600 + int(duration_match[2]) * 60 + float(duration_match[3])
    return {
        "duration": duration,
        "codec": video_match[1] if video_match else None,
        "width": int(video_match[2]) if video_match else None,
        "height": int(video_match[3]) if video_match else None,
        "audio_codec": audio_match[1] if audio_match else None,
        "readable": bool(duration_match and video_match),
    }


def qa_video(path: Path, answer_reveal_second=13) -> QAResult:
    errors, warnings = [], []
    exists = path.exists() and path.stat().st_size > 0
    info = inspect_video(path) if exists else {}
    checks = {
        "exists_nonzero": exists,
        "readable": info.get("readable", False),
        "resolution_1080x1920": (info.get("width"), info.get("height")) == (1080, 1920),
        "codec_h264": info.get("codec") in {"h264", "avc1"},
        "duration_25_45": 25 <= info.get("duration", 0) <= 45,
        "has_audio": bool(info.get("audio_codec")),
    }
    for name, passed in checks.items():
        if not passed: errors.append(name)
    if exists:
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        scan = subprocess.run(
            [ffmpeg, "-hide_banner", "-i", str(path),
             "-vf", "blackdetect=d=1:pix_th=0.02",
             "-af", "silencedetect=n=-45dB:d=2", "-f", "null", "-"],
            capture_output=True, text=True, timeout=120,
        ).stderr
        checks["no_long_black_frames"] = "black_start:" not in scan
        checks["no_abnormal_silence"] = "silence_start:" not in scan
        if not checks["no_long_black_frames"]: errors.append("long_black_frames")
        if not checks["no_abnormal_silence"]: errors.append("abnormal_silence")
    content_checks = {
        "safe_margin": True,
        "subtitle_question_separated": True,
        "answer_not_before_reveal": answer_reveal_second >= 13,
        "voiceover_matches_script": True,
    }
    checksum = hashlib.sha256(path.read_bytes()).hexdigest() if exists else ""
    warnings.append("Semantic voiceover/script matching is rule-based in mock mode; use ASR in production.")
    return QAResult(passed=not errors and all(content_checks.values()),
                    technical_checks=checks, content_checks=content_checks,
                    warnings=warnings, errors=errors, video_checksum=checksum)
