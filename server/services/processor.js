const fs = require('fs');
const path = require('path');
const https = require('https');
const { exec } = require('./adb');
const { getSettings } = require('../db');

const TOOLS_DIR = path.join(__dirname, '..', '..', 'tools');
if (!fs.existsSync(TOOLS_DIR)) fs.mkdirSync(TOOLS_DIR, { recursive: true });

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { 'User-Agent': 'auto-affiliate' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy();
        return downloadFile(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    });
    req.on('error', (e) => { fs.unlinkSync(dest); reject(e); });
    file.on('error', (e) => { fs.unlinkSync(dest); reject(e); });
  });
}

function findYtdlp() {
  const s = getSettings();
  if (s.ytdlp_path && fs.existsSync(s.ytdlp_path)) return s.ytdlp_path;
  const local = path.join(TOOLS_DIR, 'yt-dlp.exe');
  if (fs.existsSync(local)) return local;
  return null;
}

async function ensureYtdlp() {
  let p = findYtdlp();
  if (p) return p;
  const dest = path.join(TOOLS_DIR, 'yt-dlp.exe');
  await downloadFile('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', dest);
  return dest;
}

function findFfmpeg() {
  const s = getSettings();
  if (s.ffmpeg_path && fs.existsSync(s.ffmpeg_path)) return s.ffmpeg_path;
  const candidates = [
    path.join(TOOLS_DIR, 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function findFileRecursive(dir, name) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const f = findFileRecursive(full, name);
        if (f) return f;
      } else if (e.name.toLowerCase() === name.toLowerCase()) {
        return full;
      }
    }
  } catch { /* ignore */ }
  return null;
}

async function installFfmpeg() {
  const zipPath = path.join(TOOLS_DIR, 'ffmpeg.zip');
  const destDir = path.join(TOOLS_DIR, 'ffmpeg');
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  await downloadFile('https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip', zipPath);
  const { execSync } = require('child_process');
  execSync(`tar -xf "${zipPath}" -C "${destDir}"`, { stdio: 'pipe' });
  fs.unlinkSync(zipPath);
  const rootBin = path.join(TOOLS_DIR, 'ffmpeg.exe');
  if (!fs.existsSync(rootBin)) {
    const bin = findFileRecursive(destDir, 'ffmpeg.exe');
    if (!bin) throw new Error('Cài ffmpeg thất bại, không tìm thấy ffmpeg.exe');
    fs.copyFileSync(bin, rootBin);
  }
  return rootBin;
}

async function ensureFfmpeg() {
  let p = findFfmpeg();
  if (p) return p;
  return installFfmpeg();
}

async function downloadVideo(url, destPath) {
  const ytdlp = await ensureYtdlp();
  await exec(ytdlp, [
    '-f', 'bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', destPath,
    '--no-playlist',
    '--no-warnings',
    url
  ], 180000);
}

function buildFilter(inputW, inputH, s) {
  const cropPx = parseInt(s.watermark_crop_px || '160', 10);
  const parts = [];
  if (s.watermark_remove === '1') {
    parts.push(`crop=iw-${cropPx}:ih:0:0`);
  }
  parts.push('scale=' + inputW + ':' + inputH + ':force_original_aspect_ratio=decrease');
  parts.push(`pad=${inputW}:${inputH}:(ow-iw)/2:(oh-ih)/2`);
  parts.push('eq=brightness=0.02:saturation=1.05');
  parts.push('setsar=1');
  return parts.join(',');
}

async function processVideo(inputPath, outputPath) {
  const ffmpeg = await ensureFfmpeg();
  const s = getSettings();
  const probe = await exec(ffmpeg, ['-i', inputPath], 15000).catch(() => '');
  const m = probe.match(/(\d{2,5})x(\d{2,5})/);
  let W = 1080, H = 1920;
  if (m) {
    if (parseInt(m[2], 10) > parseInt(m[1], 10)) { W = parseInt(m[1], 10); H = parseInt(m[2], 10); }
  }
  const filter = buildFilter(W, H, s);
  await exec(ffmpeg, [
    '-y', '-i', inputPath,
    '-vf', filter,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    '-map_metadata', '-1',
    '-movflags', '+faststart',
    outputPath
  ], 300000);
}

function fileSizeMb(p) {
  try { return (fs.statSync(p).size / 1024 / 1024).toFixed(1); } catch { return '0'; }
}

module.exports = { downloadVideo, processVideo, findFfmpeg, findYtdlp, ensureYtdlp, ensureFfmpeg, installFfmpeg, fileSizeMb, TOOLS_DIR };