const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const TOOLS_DIR = path.join(__dirname, 'tools');
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { 'User-Agent': 'auto-affiliate' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy();
        return downloadFile(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); res.resume(); return; }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    });
    req.on('error', (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
    file.on('error', (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
  });
}

(async () => {
  const zipPath = path.join(TOOLS_DIR, 'ffmpeg.zip');
  const destDir = path.join(TOOLS_DIR, 'ffmpeg');
  console.log('1. Downloading...');
  await downloadFile('https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip', zipPath);
  console.log('2. zip size:', fs.statSync(zipPath).size);
  const cmd = `powershell -NoProfile -Command "Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'"`;
  console.log('3. CMD:', cmd);
  try {
    execSync(cmd, { stdio: 'pipe' });
    console.log('4. Extract OK');
  } catch (e) {
    console.log('4. Extract ERR:', e.stderr && e.stderr.toString());
  }
  function walk(d, depth) {
    if (depth > 5) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      console.log('   ', '  '.repeat(depth) + e.name);
      if (e.isDirectory()) walk(full, depth + 1);
    }
  }
  walk(destDir, 0);
})();