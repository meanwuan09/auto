import argparse
import asyncio
import json
import re
import shutil
import subprocess
import wave
from pathlib import Path

import cv2
import edge_tts
import numpy as np
from separate_background import separate_background


ROOT = Path(__file__).resolve().parents[1]
FFMPEG = ROOT / "tools" / "ffmpeg.exe"
# The ffmpeg installer has unpacked into different tools/ subfolders over time; use whichever ffprobe exists.
FFPROBE = next((path for path in [ROOT / "tools" / "ffprobe.exe", *sorted((ROOT / "tools").glob("*/ffmpeg-*/bin/ffprobe.exe"))]
                if path.is_file()), Path(shutil.which("ffprobe") or "ffprobe"))
RATE = 24000
TTS_RATE = "+5%"
# Above this, Edge TTS sounds rushed. A translation may raise it with "max_speed".
DEFAULT_MAX_SPEED = 1.35
# TikTok plays back at about -14 LUFS; louder uploads are turned down, quieter ones sound weak.
LOUDNORM = "loudnorm=I=-14:TP=-1.5:LRA=11"
EDGE_SILENCE = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03"


def run(args, cwd=None):
    subprocess.run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", *args], check=True, cwd=cwd)


def probe(file):
    return json.loads(subprocess.check_output([
        str(FFPROBE), "-v", "error", "-show_format", "-show_streams", "-of", "json", str(file)
    ], text=True))


def timestamp(seconds):
    milliseconds = round(seconds * 1000)
    hours, milliseconds = divmod(milliseconds, 3600000)
    minutes, milliseconds = divmod(milliseconds, 60000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"


def ass_time(seconds):
    centiseconds = round(seconds * 100)
    hours, centiseconds = divmod(centiseconds, 360000)
    minutes, centiseconds = divmod(centiseconds, 6000)
    seconds, centiseconds = divmod(centiseconds, 100)
    return f"{hours}:{minutes:02}:{seconds:02}.{centiseconds:02}"


def ass_text(text):
    return re.sub(r"[{}]", "", text).replace("\n", r"\N")


async def synthesize(text, voice, output):
    # Edge TTS throttles bursts (NoAudioReceived); back off up to about a minute.
    for attempt in range(6):
        try:
            await edge_tts.Communicate(text, voice, rate=TTS_RATE).save(str(output))
            if output.stat().st_size:
                return
            raise RuntimeError("Edge TTS returned an empty file")
        except Exception:
            if attempt == 5:
                raise
            print(f"TTS retry {attempt + 1}", flush=True)
            await asyncio.sleep(min(60, 5 * 2 ** attempt))


def voice_for(document, segment, index):
    speaker = segment.get("speaker")
    if speaker is None:
        return document["voice"]
    voices = document.get("voices", {})
    if speaker not in voices:
        raise ValueError(f"Cue {index}: speaker '{speaker}' has no entry in \"voices\"")
    return voices[speaker]


def cover_bands(document):
    bands = document.get("cover", [])
    for band in bands:
        if not (0 <= band["y"] < 1 and 0 < band["height"] <= 1 - band["y"]):
            raise ValueError(f"Invalid cover band {band}; y and height are fractions of the frame height")
    return bands


def write_ass(path, width, height, events, bands, bottom=None):
    # Landscape videos are shown small on a phone, so their subtitles need a larger share of the height.
    size = round(height * (0.055 if width > height else 0.036))
    outline = max(2, round(height * 0.0026))
    side = round(width * 0.06)
    # Sit on the lowest covered band, or clear of TikTok's caption and buttons.
    if bottom or bands:
        lowest = bottom or max(band["y"] + band["height"] for band in bands)
        margin = round(height * (1 - lowest) + height * 0.012)
    else:
        margin = round(height * 0.28)
    lines = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {width}", f"PlayResY: {height}",
        "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
        "MarginL, MarginR, MarginV, Encoding",
        f"Style: Dialogue,Arial,{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,"
        f"{outline},1,2,{side},{side},{margin},1",
        f"Style: Note,Arial,{round(size * 0.85)},&H0000E6FF,&H0000E6FF,&H00000000,&H64000000,-1,-1,0,0,100,100,0,0,1,"
        f"{outline},1,8,{side},{side},{round(height * 0.12)},1",
        "", "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    pad = round(height * 0.012)
    for start, end, style, text, *place in events:
        override = ""
        if place and place[0]:
            # Replace the source subtitle in place: a translucent plate hides the blurred
            # Chinese lines (all of them, for a two-line subtitle) and the text sits on top.
            x, y, (left, top, right, bottom) = place[0]
            w, h = right - left + 2 * pad, bottom - top + 2 * pad
            plate = f"{{\\an7\\pos({left - pad},{top - pad})\\bord0\\shad0\\1c&H000000&\\1a&H50&\\p1}}m 0 0 l {w} 0 {w} {h} 0 {h}{{\\p0}}"
            lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},{style},,0,0,0,,{plate}")
            # Keep a cue placed near the frame edge fully on screen (Arial is about 0.5 em per character).
            half = min(width * 0.47, len(text) * size * (0.85 if style == "Note" else 1) * 0.26)
            x = round(min(max(x, half + side * 0.3), width - half - side * 0.3))
            override = f"{{\\an5\\pos({x},{y})}}"
        lines.append(f"Dialogue: 1,{ass_time(start)},{ass_time(end)},{style},,0,0,0,,{override}{ass_text(text)}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def video_filter(bands, subtitle_name):
    if not bands:
        return f"[0:v]subtitles=filename={subtitle_name}[vout]"
    parts = [f"[0:v]split={len(bands) + 1}[v0]" + "".join(f"[b{i}]" for i in range(len(bands)))]
    for i, band in enumerate(bands):
        y, h = band["y"], band["height"]
        parts.append(f"[b{i}]crop=w=iw:h=ih*{h}:x=0:y=ih*{y},gblur=sigma=45:steps=4,eq=brightness=-0.12[blur{i}]")
        parts.append(f"[v{i}][blur{i}]overlay=x=0:y=main_h*{y}[v{i + 1}]")
    parts.append(f"[v{len(bands)}]subtitles=filename={subtitle_name}[vout]")
    return ";".join(parts)


def load_mask(document, translation):
    """Time-ranged text boxes from ocr_subtitles.py, padded for its sampling interval."""
    if not document.get("mask"):
        return []
    ocr = json.loads((translation.parent / document["mask"]).read_text(encoding="utf-8"))
    margin = 0.6 / ocr["fps"]
    return [(item["start"] - margin, item["end"] + margin, item["box"]) for item in ocr["mask"]]


def subtitle_bottom(document, translation):
    """Where the source subtitles sat (upper-quartile bottom edge, as a fraction of the frame), so ours replace them in place."""
    if not document.get("mask"):
        return None
    ocr = json.loads((translation.parent / document["mask"]).read_text(encoding="utf-8"))
    bottoms = sorted((m["box"][1] + m["box"][3]) / ocr["height"] for m in ocr["mask"] if m["kind"] == "text")
    # Keep clear of TikTok's caption and buttons in the bottom fifth.
    return min(bottoms[len(bottoms) * 3 // 4], 0.78) if bottoms else None


def subtitle_boxes(document, translation):
    """Burned-in subtitle boxes from ocr_subtitles.py as (start, end, (x, y, w, h))."""
    if not document.get("mask"):
        return []
    ocr = json.loads((translation.parent / document["mask"]).read_text(encoding="utf-8"))
    return [(item["start"], item["end"], item["box"], item.get("text", "")) for item in ocr["mask"] if item["kind"] == "text"]


def shared_chars(a, b):
    a, b = set(re.sub(r"\s+", "", a or "")), set(re.sub(r"\s+", "", b or ""))
    return len(a & b) / max(1, min(len(a), len(b)))


def source_position(boxes, start, end, source=""):
    """Centre of the source subtitle shown during a cue; a two-line subtitle is merged into one box.
    When several texts are on screen, the box whose words match the cue's source wins, so a
    speech bubble and the narration subtitle shown together each keep their own place."""
    timed = [(min(end, b_end) - max(start, b_start), box, text) for b_start, b_end, box, text in boxes]
    timed = [item for item in timed if item[0] > 0]
    if not timed:
        return None
    best, anchor, _ = max(timed, key=lambda item: (shared_chars(item[2], source) if source else 0, item[0]))
    group = [box for overlap, box, text in timed if (shared_chars(text, source) >= 0.5 if source else overlap >= best * 0.5)
             and abs(box[1] - anchor[1]) <= 4 * anchor[3]] or [anchor]
    left, top = min(box[0] for box in group), min(box[1] for box in group)
    right, bottom = max(box[0] + box[2] for box in group), max(box[1] + box[3] for box in group)
    return round((left + right) / 2), round((top + bottom) / 2), (left, top, right, bottom)


def blur_text(frame, box):
    x, y, w, h = box
    pad = max(8, round(h * 0.4))
    x0, y0 = max(0, x - pad), max(0, y - pad)
    x1, y1 = min(frame.shape[1], x + w + pad), min(frame.shape[0], y + h + pad)
    region = frame[y0:y1, x0:x1].astype(np.float32)
    blurred = cv2.GaussianBlur(region, (0, 0), max(6, h * 0.45)) * 0.85
    # Feather the edge so the blur does not read as a hard rectangle.
    alpha = np.zeros(region.shape[:2], np.float32)
    alpha[pad // 2:alpha.shape[0] - pad // 2, pad // 2:alpha.shape[1] - pad // 2] = 1
    alpha = cv2.GaussianBlur(alpha, (0, 0), pad / 3)[..., None]
    frame[y0:y1, x0:x1] = (region * (1 - alpha) + blurred * alpha).astype(np.uint8)


def render_masked(video, frame_rate, mask, ffmpeg_args, cwd):
    """Blur each OCR box only while its text is on screen, then hand the frames to ffmpeg."""
    capture = cv2.VideoCapture(str(video))
    width, height = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    process = subprocess.Popen([
        str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{height}", "-framerate", frame_rate, "-i", "-",
        *ffmpeg_args], stdin=subprocess.PIPE, cwd=cwd)
    index = 0
    numerator, denominator = (int(part) for part in frame_rate.split("/"))
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            t = index * denominator / numerator
            for start, end, box in mask:
                if start <= t <= end:
                    blur_text(frame, box)
            process.stdin.write(frame.tobytes())
            index += 1
    finally:
        capture.release()
        process.stdin.close()
    if process.wait():
        raise RuntimeError(f"ffmpeg failed while rendering masked video ({process.returncode})")


def integrated_loudness(file):
    result = subprocess.run([str(FFMPEG), "-hide_banner", "-nostats", "-i", str(file), "-vn", "-af", "ebur128", "-f", "null", "-"],
                            capture_output=True, text=True, encoding="utf-8", errors="replace")
    values = re.findall(r"I:\s+(-?[\d.]+) LUFS", result.stderr)
    return float(values[-1]) if values else None


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("video", type=Path)
    parser.add_argument("translation", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--reuse-audio", action="store_true", help="Reuse cached cues only when the translation and voice are unchanged")
    args = parser.parse_args()
    document = json.loads(args.translation.read_text(encoding="utf-8"))
    max_speed = float(document.get("max_speed", DEFAULT_MAX_SPEED))
    burn = document.get("burn_subtitles", True)
    bands = cover_bands(document)
    mask = load_mask(document, args.translation)
    source_info = probe(args.video)
    duration = float(source_info["format"]["duration"])
    video_stream = next(stream for stream in source_info['streams'] if stream['codec_type'] == 'video')
    width, height = int(video_stream["width"]), int(video_stream["height"])
    segments = document["segments"]
    voiced = [segment.get("voiced", True) for segment in segments]
    for index, segment in enumerate(segments, 1):
        if segment["end"] <= segment["start"] or segment["start"] < 0 or segment["end"] > duration:
            raise ValueError(f"Invalid cue {index}: {segment['start']}-{segment['end']}")
        if not segment.get("text", "").strip():
            raise ValueError(f"Cue {index} has no Vietnamese text yet (source: {segment.get('source', '')}); translate or delete it")
        voice_for(document, segment, index)

    background_file = args.output.with_name(f"{args.output.stem}-background.wav")
    separation = separate_background(args.video, background_file)
    folder = args.output.parent / f"{args.output.stem}-audio"
    folder.mkdir(parents=True, exist_ok=True)
    audio = bytearray(round(duration * RATE) * 2)
    report = []
    subtitles = []
    events = []
    previous_end = 0
    generated = {}
    spoken = [i for i, flag in enumerate(voiced) if flag]

    for position, i in enumerate(spoken):
        index, segment = i + 1, segments[i]
        start, end = segment["start"], segment["end"]
        if start < previous_end:
            raise ValueError(f"Cue {index} overlaps the previous spoken cue")
        # Speech may run on into the silence before the next spoken cue.
        limit = segments[spoken[position + 1]]["start"] if position + 1 < len(spoken) else duration
        voice = voice_for(document, segment, index)
        mp3, wav = folder / f"{index:03}.mp3", folder / f"{index:03}.wav"
        cache_file = folder / f"{index:03}.json"
        cache_key = {"text": segment["text"], "voice": voice, "rate": TTS_RATE}
        try:
            cached = json.loads(cache_file.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            cached = None
        if not args.reuse_audio or cached != cache_key or not mp3.exists() or mp3.stat().st_size == 0:
            if (segment["text"], voice) in generated:
                shutil.copyfile(generated[(segment["text"], voice)], mp3)
            else:
                try:
                    await synthesize(segment["text"], voice, mp3)
                except Exception as error:
                    if document.get("too_fast") != "subtitle":
                        raise
                    # Unattended runs keep going: a line TTS will not speak is shown as a subtitle.
                    voiced[i] = False
                    mp3.unlink(missing_ok=True)
                    print(f"TTS cue {index}/{len(segments)}: no audio ({type(error).__name__}), shown as subtitle only", flush=True)
                    continue
                await asyncio.sleep(2)
            cache_file.write_text(json.dumps(cache_key, ensure_ascii=False), encoding='utf-8')
        generated[(segment["text"], voice)] = mp3
        # Edge TTS pads each clip with up to ~1.4 s of silence; time the speech itself.
        trimmed = folder / f"{index:03}-trimmed.wav"
        run(["-i", str(mp3), "-af", f"{EDGE_SILENCE},areverse,{EDGE_SILENCE},areverse", "-ar", str(RATE), "-ac", "1", "-c:a", "pcm_s16le", str(trimmed)])
        spoken_duration = float(probe(trimmed)["format"]["duration"])
        speed = max(1, spoken_duration / (limit - start - 0.05))
        if speed > max_speed and document.get("too_fast") == "subtitle":
            # Machine translations cannot be shortened by hand; show such a line as a subtitle only.
            voiced[i] = False
            print(f"TTS cue {index}/{len(segments)}: needs {speed:.2f}x, shown as subtitle only", flush=True)
            continue
        if speed > max_speed:
            raise ValueError(f"Cue {index} needs {speed:.2f}x speed (limit {max_speed}x); shorten its translation or widen its timing")
        run(["-i", str(trimmed), "-af", f"atempo={speed:.6f}", "-ar", str(RATE), "-ac", "1", "-c:a", "pcm_s16le", str(wav)])
        with wave.open(str(wav), "rb") as track:
            frames = track.readframes(track.getnframes())
        offset = round(start * RATE) * 2
        if offset + len(frames) > round(limit * RATE) * 2:
            raise ValueError(f"Cue {index} exceeds its timeline")
        audio[offset:offset + len(frames)] = frames
        speech_end = start + len(frames) / (RATE * 2)
        previous_end = max(end, speech_end)
        report.append({"cue": index, "start": start, "end": end, "speaker": segment.get("speaker"), "voice": voice,
                       "spoken_duration": len(frames) / (RATE * 2), "speed": speed})
        print(f"TTS cue {index}/{len(segments)}: {len(frames) / (RATE * 2):.2f}s, speed {speed:.2f}x, {voice}", flush=True)

    boxes = subtitle_boxes(document, args.translation)
    for index, segment in enumerate(segments, 1):
        start, end = segment["start"], segment["end"]
        if voiced[index - 1]:
            cue = next(item for item in report if item["cue"] == index)
            end = max(end, start + cue["spoken_duration"])
        subtitles.append(f"{len(subtitles) + 1}\n{timestamp(start)} --> {timestamp(end)}\n{segment['text']}\n")
        events.append((start, end, "Dialogue" if voiced[index - 1] else "Note", segment["text"],
                       source_position(boxes, segment["start"], segment["end"], segment.get("source", ""))))

    voice_file = args.output.with_suffix(".wav")
    with wave.open(str(voice_file), "wb") as track:
        track.setnchannels(1)
        track.setsampwidth(2)
        track.setframerate(RATE)
        track.writeframes(audio)
    subtitle_file = args.output.with_suffix(".srt")
    subtitle_file.write_text("\n".join(subtitles), encoding="utf-8")
    temporary_output = args.output.with_name(f"{args.output.stem}-rendering.mp4")
    audio_filter = f"[1:a][2:a]amix=inputs=2:duration=first:normalize=0,{LOUDNORM},aresample=48000[mix]"
    # Uploads go through a remote CDP browser, which refuses files over 50 MB; cap the video bitrate so
    # the whole file stays near 40 MB (TikTok re-encodes uploads to a far lower rate anyway).
    video_kbps = max(1500, min(8000, int(40 * 8192 / max(duration, 1)) - 160))
    encode = ["-c:v", "libx264", "-crf", "20", "-maxrate", f"{video_kbps}k", "-bufsize", f"{video_kbps * 2}k",
              "-preset", "medium", "-pix_fmt", "yuv420p", "-profile:v", "high"]
    if burn:
        ass_file = args.output.with_suffix(".ass")
        write_ass(ass_file, width, height, events, [] if mask else bands, subtitle_bottom(document, args.translation))
        # libass paths are awkward to escape on Windows, so render from the output folder.
        video_args = ["-filter_complex", f"{video_filter([] if mask else bands, ass_file.name)};{audio_filter}", "-map", "[vout]", *encode]
    elif mask:
        video_args = ["-filter_complex", audio_filter, "-map", "0:v:0", *encode]
    else:
        video_args = ["-filter_complex", audio_filter, "-map", "0:v:0", "-c:v", "copy",
                      *(["-tag:v", "hvc1"] if video_stream['codec_name'] == 'hevc' else [])]
    inputs = ["-i", str(background_file.resolve()), "-i", str(voice_file.resolve())]
    tail = [*video_args, "-map", "[mix]", "-c:a", "aac", "-b:a", "192k", "-t", str(duration),
            "-movflags", "+faststart", "-map_metadata", "-1", str(temporary_output.resolve())]
    if mask:
        print(f"Blurring {len(mask)} OCR text boxes frame by frame...", flush=True)
        render_masked(args.video, video_stream["r_frame_rate"], mask, [*inputs, *tail], args.output.parent)
    else:
        run(["-i", str(args.video.resolve()), *inputs, *tail], cwd=args.output.parent)
    output_info = probe(temporary_output)
    output_duration = float(output_info["format"]["duration"])
    if abs(output_duration - duration) > 0.1 or not any(stream["codec_type"] == "audio" for stream in output_info["streams"]):
        raise RuntimeError("Rendered video failed duration/audio check")
    loudness = integrated_loudness(temporary_output)
    temporary_output.replace(args.output)
    speeds = [cue["speed"] for cue in report]
    args.output.with_suffix(".qa.json").write_text(json.dumps({
        "voice": document["voice"], "voices": document.get("voices", {}),
        "source_duration": duration, "output_duration": output_duration,
        "integrated_loudness_lufs": loudness, "max_speed": max(speeds, default=1), "speed_limit": max_speed,
        "render": output_info, "cues": report, "separation": separation,
        "video_stream_copied": not burn and not mask, "subtitles_burned": burn, "covered_bands": [] if mask else bands,
        "ocr_mask_boxes": len(mask),
        "notes": "Original vocals removed with Demucs; background residual mixed at unity gain with Vietnamese speech, "
                 "then loudness-normalised to -14 LUFS. Separation may leave artifacts. "
                 + ("Vietnamese subtitles burned in; listed bands blurred to hide the source subtitles."
                    if burn else "Original video stream copied without added subtitles.")
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Rendered: {args.output} ({loudness} LUFS, max speed {max(speeds, default=1):.2f}x)", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
