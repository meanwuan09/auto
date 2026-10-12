"""Read burned-in Chinese text from a source video.

Writes JOB-ocr.json (every text track with its box and time range, used by
dub_reviewed.py to blur the source text) and, unless it already exists,
JOB-reviewed-vi.draft.json: one cue per subtitle with the Chinese text in
"source", a speaker guessed from on-screen role labels, and an empty "text"
for the Vietnamese translation.
"""

import argparse
import json
import re
from pathlib import Path

import cv2
from rapidocr_onnxruntime import RapidOCR


CJK = re.compile(r"[㐀-鿿]")
FEMALE = "姐妹妈母女婆奶姑姨嫂娘她"
MALE = "哥弟爸父男爷叔伯舅公他"
VOICES = {"female": "vi-VN-HoaiMyNeural", "male": "vi-VN-NamMinhNeural"}
SCALE_WIDTH = 540
# Text on screen longer than this is a title or disclaimer, not a subtitle.
STATIC_SECONDS = 8


def normalise(text):
    return re.sub(r"[\s，。,.!！?？~～…:：\"'“”()（）#＃*＊]", "", text)


def overlap(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    if x2 <= x1 or y2 <= y1:
        return 0
    inter = (x2 - x1) * (y2 - y1)
    return inter / min(a[2] * a[3], b[2] * b[3])


def sample(video, fps):
    capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        raise RuntimeError(f"Cannot open {video}")
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frame_rate = capture.get(cv2.CAP_PROP_FPS)
    duration = capture.get(cv2.CAP_PROP_FRAME_COUNT) / frame_rate
    scale = SCALE_WIDTH / width
    engine = RapidOCR()
    detections = []
    step = 1 / fps
    t = step / 2
    index = -1
    while t < duration:
        # Decode sequentially; seeking an H.264 stream per sample is slow and can land on the wrong frame.
        target = int(t * frame_rate)
        while index < target:
            if not capture.grab():
                break
            index += 1
        if index < target:
            break
        ok, frame = capture.retrieve()
        if not ok:
            break
        small = cv2.resize(frame, (SCALE_WIDTH, round(height * scale)), interpolation=cv2.INTER_AREA)
        result, _ = engine(small)
        for box, text, score in result or []:
            xs, ys = [p[0] / scale for p in box], [p[1] / scale for p in box]
            detections.append({"t": round(t, 3), "text": text, "score": round(float(score), 3),
                               "box": [round(min(xs)), round(min(ys)), round(max(xs) - min(xs)), round(max(ys) - min(ys))]})
        print(f"OCR {t:6.2f}/{duration:.2f}s", flush=True)
        t += step
    capture.release()
    return width, height, duration, detections


def keep(detection, height):
    if detection["score"] < 0.6 or not CJK.search(detection["text"]):
        return False
    # Captions are at most ~7% of the frame tall; larger text is print on clothes or props,
    # except edited-in titles, which OCR reads with near certainty and run several characters.
    if detection["box"][3] > height * 0.08:
        return detection["score"] >= 0.95 and len(CJK.findall(detection["text"])) >= 4
    # Short low-confidence reads are mostly the same kind of background print.
    return len(CJK.findall(detection["text"])) > 2 or detection["score"] >= 0.9


def build_tracks(detections, fps, duration):
    step = 1 / fps
    tracks = []
    for item in sorted(detections, key=lambda d: d["t"]):
        key = normalise(item["text"])
        for track in reversed(tracks):
            # One missed sample is tolerated so a single OCR miss does not split a subtitle.
            if item["t"] - track["last"] > step * 2.5:
                continue
            if track["key"] == key and overlap(track["box"], item["box"]) > 0.3:
                track["last"] = item["t"]
                x, y, w, h = track["box"]
                bx, by, bw, bh = item["box"]
                x2, y2 = max(x + w, bx + bw), max(y + h, by + bh)
                track["box"] = [min(x, bx), min(y, by), x2 - min(x, bx), y2 - min(y, by)]
                track["samples"] += 1
                break
        else:
            tracks.append({"key": key, "text": item["text"], "first": item["t"], "last": item["t"],
                           "box": item["box"], "samples": 1})
    for track in tracks:
        track["start"] = round(max(0, track["first"] - step / 2), 2)
        track["end"] = round(min(duration, track["last"] + step / 2), 2)
    return tracks


def classify(tracks):
    """Mark long-lived text (titles, disclaimers) as static and recurring short text (姐姐, 弟弟 ...) as role labels."""
    counts = {}
    for track in tracks:
        if len(track["key"]) <= 4:
            counts[track["key"]] = counts.get(track["key"], 0) + 1
    labels = {key for key, count in counts.items() if count >= 3}
    for track in tracks:
        if track["key"] in labels:
            track["kind"] = "label"
        else:
            track["kind"] = "static" if track["end"] - track["start"] > STATIC_SECONDS else "text"
    statics = [t for t in tracks if t["kind"] == "static"]
    for track in tracks:
        # A partly hidden disclaimer is read as a prefix of itself; it is the same static text.
        if track["kind"] == "text" and any(track["key"] in s["key"] and overlap(track["box"], s["box"]) > 0.3 for s in statics):
            track["kind"] = "static"
    return labels


def static_notes(tracks):
    notes = []
    for track in sorted((t for t in tracks if t["kind"] == "static"), key=lambda t: -len(t["key"])):
        for note in notes:
            if track["key"] in note["key"] and overlap(track["box"], note["box"]) > 0.3:
                note["start"], note["end"] = min(note["start"], track["start"]), max(note["end"], track["end"])
                break
        else:
            notes.append(dict(track))
    return sorted(notes, key=lambda n: n["start"])


def build_cues(tracks):
    lines = sorted((t for t in tracks if t["kind"] == "text"), key=lambda t: (t["start"], t["box"][1]))
    cues = []
    for line in lines:
        for cue in cues:
            # Lines shown together and stacked closely belong to one subtitle.
            same_time = abs(cue["start"] - line["start"]) <= 0.5 and abs(cue["end"] - line["end"]) <= 0.75
            gap = line["box"][1] - (cue["bottom"])
            if same_time and -cue["line_height"] < gap < cue["line_height"] * 1.5:
                if normalise(line["text"]) not in map(normalise, cue["lines"]):
                    cue["lines"].append(line["text"])
                cue["bottom"] = line["box"][1] + line["box"][3]
                cue["start"], cue["end"] = min(cue["start"], line["start"]), max(cue["end"], line["end"])
                break
        else:
            cues.append({"start": line["start"], "end": line["end"], "lines": [line["text"]],
                         "top": line["box"][1], "bottom": line["box"][1] + line["box"][3], "line_height": line["box"][3]})
    return sorted(cues, key=lambda c: c["start"])


def gender(label):
    if any(ch in label for ch in FEMALE):
        return "female"
    if any(ch in label for ch in MALE):
        return "male"
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("output", type=Path, help="JOB-ocr.json")
    parser.add_argument("--fps", type=float, default=4)
    parser.add_argument("--draft", type=Path, help="Draft translation path (default: JOB-reviewed-vi.draft.json beside the output)")
    parser.add_argument("--reuse", action="store_true", help="Regroup the raw reads saved in the output instead of running OCR again")
    args = parser.parse_args()
    if args.reuse and args.output.exists():
        saved = json.loads(args.output.read_text(encoding="utf-8"))
        width, height, duration, detections = saved["width"], saved["height"], saved["duration"], saved["detections"]
        args.fps = saved["fps"]
    else:
        width, height, duration, detections = sample(args.video, args.fps)
    tracks = build_tracks([d for d in detections if keep(d, height)], args.fps, duration)
    labels = classify(tracks)
    notes = static_notes(tracks)
    cues = build_cues(tracks)
    label_tracks = [t for t in tracks if t["kind"] == "label"]
    for cue in cues:
        middle = (cue["start"] + cue["end"]) / 2
        active = [t for t in label_tracks if t["start"] <= middle <= t["end"]]
        cue["speaker"] = min(active, key=lambda t: t["box"][1])["key"] if active else None
    document = {
        "video": str(args.video), "width": width, "height": height, "duration": duration, "fps": args.fps,
        "speaker_labels": sorted(labels),
        "mask": [{"start": t["start"], "end": t["end"], "box": t["box"], "text": t["text"], "kind": t["kind"]} for t in tracks],
        "cues": [{"start": c["start"], "end": c["end"], "speaker": c["speaker"], "zh": "".join(c["lines"])} for c in cues],
        "static": [{"start": n["start"], "end": n["end"], "zh": n["text"]} for n in notes],
        "detections": detections,
    }
    args.output.write_text(json.dumps(document, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"OCR: {len(tracks)} text tracks, {len(cues)} cues, labels {sorted(labels)} -> {args.output}", flush=True)

    stem = args.output.name.removesuffix("-ocr.json")
    draft = args.draft or args.output.with_name(f"{stem}-reviewed-vi.draft.json")
    if draft.exists():
        print(f"Draft exists, left unchanged: {draft}")
        return
    speakers = sorted({c["speaker"] for c in cues if c["speaker"]})
    voices = {s: VOICES.get(gender(s), VOICES["female"]) for s in speakers}
    draft.write_text(json.dumps({
        "source_language": "zh", "target_language": "vi",
        "review_method": "Draft from on-screen OCR. Fill every \"text\", merge or split cues, and mark captions that should not be spoken with \"voiced\": false.",
        "voice": VOICES["female"], "voices": voices, "mask": args.output.name,
        "segments": sorted([
            *({"start": c["start"], "end": c["end"], **({"speaker": c["speaker"]} if c["speaker"] else {}),
               **({"voiced": False} if c["zh"][:1] in "#＃*" else {}), "source": c["zh"], "text": ""} for c in document["cues"]),
            *({"start": n["start"], "end": n["end"], "voiced": False, "source": n["zh"], "text": ""} for n in document["static"]),
        ], key=lambda segment: segment["start"]),
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Draft translation: {draft}")


if __name__ == "__main__":
    main()
