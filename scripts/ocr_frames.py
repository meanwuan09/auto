"""Read on-screen text from still frames (used to understand a TikTok video before commenting).

Usage: ocr_frames.py <image> [<image> ...]
Prints one JSON object: {"<image path>": "text read top to bottom", ...}
RapidOCR's model is trained on Chinese and Latin script, so Vietnamese often loses its diacritics;
the text is still enough for the comment writer to tell what the video shows.
"""

import json
import sys

from rapidocr_onnxruntime import RapidOCR


def main():
    engine = RapidOCR()
    out = {}
    for image in sys.argv[1:]:
        try:
            result, _ = engine(image)
        except Exception as error:  # one unreadable frame must not stop the others
            out[image] = ""
            print(f"OCR failed for {image}: {error}", file=sys.stderr)
            continue
        lines = sorted((box[0][1], text) for box, text, score in (result or []) if float(score) >= 0.6 and len(text.strip()) >= 2)
        out[image] = " ".join(text.strip() for _, text in lines)[:400]
    print(json.dumps(out, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
