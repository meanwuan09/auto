from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.providers.wikimedia import WikimediaCommonsVideoProvider
from app.rendering.video import inspect_video, qa_video
from app.sources.football import FootballControversyGate, FootballIncident


OUTPUT = ROOT / "output" / "real-football-controversy"
INCIDENT = FootballIncident(
    filename="Samsunspor-Manisa ma\u00e7\u0131 (05.09.22) VAR penalt\u0131.webm",
    incident_type="var",
    event_name="Samsunspor–Manisa FK",
    event_date="2022-09-05",
    factual_summary_vi=(
        "Phút 44, trọng tài Burak Pakkan cho Samsunspor hưởng phạt đền "
        "sau khi xem lại tình huống bằng VAR."
    ),
)


def slow_motion(source: Path, target: Path, seconds=5):
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    result = subprocess.run(
        [
            ffmpeg, "-y", "-i", str(source),
            "-filter_complex",
            f"[0:v]trim=duration={seconds},setpts=2.0*PTS[v];"
            f"[0:a]atrim=duration={seconds},asetpts=N/SR/TB,atempo=0.5[a]",
            "-map", "[v]", "-map", "[a]", "-r", "30",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
            "-c:a", "aac", "-b:a", "128k", str(target),
        ],
        capture_output=True, text=True, timeout=240,
    )
    if result.returncode:
        raise RuntimeError(result.stderr[-3000:])
    return target


def freeze_tail(source: Path, target: Path, seconds=7):
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    frame = target.with_suffix(".jpg")
    grab = subprocess.run(
        [ffmpeg, "-y", "-ss", "4", "-i", str(source), "-frames:v", "1", str(frame)],
        capture_output=True, text=True, timeout=60,
    )
    if grab.returncode:
        raise RuntimeError(grab.stderr[-2000:])
    still = subprocess.run(
        [
            ffmpeg, "-y", "-loop", "1", "-framerate", "30", "-i", str(frame),
            "-stream_loop", "-1", "-i", str(source),
            "-t", str(seconds), "-vf",
            "zoompan=z='min(zoom+0.0005,1.04)':d=1:s=1080x1920:fps=30,format=yuv420p",
            "-map", "0:v", "-map", "1:a",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
            "-c:a", "aac", "-b:a", "128k", "-shortest", str(target),
        ],
        capture_output=True, text=True, timeout=180,
    )
    if still.returncode:
        raise RuntimeError(still.stderr[-3000:])
    return target


def concatenate(parts: list[Path], target: Path):
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    concat = OUTPUT / "parts.ffconcat"
    concat.write_text(
        "ffconcat version 1.0\n" + "\n".join(
            f"file '{part.resolve().as_posix()}'" for part in parts
        ),
        encoding="utf-8",
    )
    result = subprocess.run(
        [
            ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(target),
        ],
        capture_output=True, text=True, timeout=300,
    )
    if result.returncode:
        raise RuntimeError(result.stderr[-3000:])
    return target


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    provider = WikimediaCommonsVideoProvider(allow_share_alike=True)
    asset = provider.resolve(INCIDENT.filename)
    gate = FootballControversyGate().validate(asset, INCIDENT)
    source = OUTPUT / "source.webm"
    if not source.exists():
        source = provider.download(asset, source)
    start, motion = provider.choose_high_motion_window(source, clip_seconds=10)
    normal = provider.cut_vertical(source, OUTPUT / "normal-10s.mp4", start, 10)
    replay = slow_motion(normal, OUTPUT / "slow-motion-10s.mp4", seconds=5)
    still = freeze_tail(normal, OUTPUT / "freeze-7s.mp4", seconds=7)
    final = concatenate([normal, replay, still], OUTPUT / "real_var_incident.mp4")
    qa = qa_video(final)
    manifest = {
        "real_people": True,
        "real_incident": True,
        "generated_visuals": False,
        "football_gate": gate,
        "incident": INCIDENT.model_dump(),
        "selected_start_second": start,
        "motion_score": motion,
        "source": asset.model_dump(mode="json"),
        "license_obligation": (
            "Derivative must retain attribution and be distributed under CC BY-SA 4.0."
            if asset.requires_share_alike else "Retain attribution."
        ),
        "video": str(final),
        "technical": inspect_video(final),
        "qa_passed": qa.passed,
        "qa_errors": qa.errors,
    }
    (OUTPUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (OUTPUT / "qa.json").write_text(qa.model_dump_json(indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
