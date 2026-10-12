from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.providers.wikimedia import WikimediaCommonsVideoProvider
from app.rendering.video import inspect_video


def main():
    output = ROOT / "output" / "real-clip-test"
    output.mkdir(parents=True, exist_ok=True)
    provider = WikimediaCommonsVideoProvider()
    result = provider.fetch_best_clip("Footvolley.webm", output, clip_seconds=10)
    report = {
        "real_people": True,
        "real_situation": "Footvolley at Ipanema during the 2014 Brazil Tour",
        "semantic_match_to_var_story": False,
        "selected_start_second": result.start_second,
        "motion_score": result.motion_score,
        "license": result.source.license_name,
        "author": result.source.author,
        "source_page": result.source.source_page,
        "clip": str(result.clip_path),
        "technical": inspect_video(result.clip_path),
    }
    (output / "test-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
