import hashlib
import json
import os
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model


ROOT = Path(__file__).resolve().parents[1]


def separate_background(video, output):
    fingerprint = hashlib.sha256(video.read_bytes()).hexdigest()
    manifest = output.with_suffix('.json')
    if output.exists() and manifest.exists():
        cached = json.loads(manifest.read_text(encoding='utf-8'))
        if cached.get('source_sha256') == fingerprint:
            return cached
    os.environ['TORCH_HOME'] = str(ROOT / 'data' / 'models' / 'torch')
    torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
    model = get_model('htdemucs').cpu().eval()
    original = output.with_name(output.stem + '-original.wav')
    subprocess.run([
        str(ROOT / 'tools' / 'ffmpeg.exe'), '-hide_banner', '-loglevel', 'error', '-y',
        '-i', str(video), '-vn', '-ar', str(model.samplerate), '-ac', '2',
        '-c:a', 'pcm_f32le', str(original)
    ], check=True)
    samples, rate = sf.read(original, dtype='float32', always_2d=True)
    wav = torch.from_numpy(samples.T.copy())
    reference = wav.mean(0)
    mean, std = reference.mean(), reference.std()
    if std < 1e-8:
        raise ValueError('Source audio is silent')
    print('Separating original vocals from background (Demucs CPU)...', flush=True)
    with torch.no_grad():
        stems = apply_model(model, ((wav - mean) / std)[None], device='cpu',
                            shifts=1, split=True, overlap=0.25, progress=True)[0]
    stems = stems * std + mean
    vocals = stems[model.sources.index('vocals')]
    # Subtract the vocal estimate so the source residual stays in the background.
    background = wav - vocals
    sf.write(output, background.T.numpy(), rate, subtype='FLOAT')
    vocal_file = output.with_name(output.stem + '-vocals.wav')
    sf.write(vocal_file, vocals.T.numpy(), rate, subtype='FLOAT')
    info = {'source_sha256': fingerprint, 'model': 'htdemucs', 'sample_rate': rate,
            'background': str(output), 'vocals': str(vocal_file),
            'background_gain': 1.0,
            'reconstruction_max_error': float(torch.max(torch.abs(background + vocals - wav)))}
    manifest.write_text(json.dumps(info, indent=2), encoding='utf-8')
    return info
