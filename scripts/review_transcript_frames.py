import argparse
import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('video', type=Path)
parser.add_argument('transcript', type=Path)
args = parser.parse_args()
segments = json.loads(args.transcript.read_text(encoding='utf-8'))['segments']
for group in range(0, len(segments), 10):
    with tempfile.TemporaryDirectory(prefix='review-', dir=args.transcript.parent) as temporary:
        folder = Path(temporary)
        for offset, segment in enumerate(segments[group:group + 10]):
            midpoint = segment['start'] + (segment['end'] - segment['start']) * 0.5
            subprocess.run([
                str(ROOT / 'tools' / 'ffmpeg.exe'), '-hide_banner', '-loglevel', 'error',
                '-ss', str(midpoint), '-i', str(args.video), '-frames:v', '1',
                '-vf', 'scale=640:360', str(folder / f'frame{offset + 1:03}.png')
            ], check=True)
        destination = args.transcript.with_name(f'{args.transcript.stem}-review-{group // 10 + 1}.jpg')
        subprocess.run([
            str(ROOT / 'tools' / 'ffmpeg.exe'), '-hide_banner', '-loglevel', 'error', '-y',
            '-start_number', '1', '-i', str(folder / 'frame%03d.png'),
            '-vf', 'tile=2x5', '-frames:v', '1', str(destination)
        ], check=True)
        print(destination, flush=True)
