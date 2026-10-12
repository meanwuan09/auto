import argparse
import json
from pathlib import Path

from faster_whisper import WhisperModel


ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("video", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--no-vad", action="store_true")
    parser.add_argument("--language")
    args = parser.parse_args()
    model = WhisperModel("small", device="cpu", compute_type="int8", download_root=str(ROOT / "data" / "models"))
    segments, info = model.transcribe(
        str(args.video), beam_size=5, vad_filter=not args.no_vad,
        language=args.language, condition_on_previous_text=False,
    )
    result = {
        "language": info.language,
        "language_probability": info.language_probability,
        "segments": [{"start": segment.start, "end": segment.end, "text": segment.text.strip()} for segment in segments],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"language": result["language"], "segments": len(result["segments"]), "output": str(args.output)}, ensure_ascii=True))


if __name__ == "__main__":
    main()
