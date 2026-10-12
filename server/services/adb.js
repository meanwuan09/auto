const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getSettings, setSetting } = require('../db');

let adbPath = null;
let adbChecked = false;

const COMMON_ADB_PATHS = [
  'C:\\LDPlayer\\LDPlayer9\\adb.exe',
  'C:\\LDPlayer\\adb.exe',
  'C:\\Program Files\\LDPlayer9\\adb.exe',
  'C:\\Program Files (x86)\\LDPlayer9\\adb.exe',
  'C:\\Program Files\\Netease\\MuMuPlayer-12.0\\shell\\adb.exe',
  'C:\\Program Files\\Netease\\MuMuPlayer-12.0.0\\shell\\adb.exe',
  'C:\\Program Files\\Netease\\MuMuPlayer-12.0.1\\shell\\adb.exe',
  'C:\\Program Files\\Netease\\MuMuPlayer-12.0.2\\shell\\adb.exe',
  'C:\\Program Files\\BlueStacks_nxt\\HD-Adb.exe',
  'C:\\Program Files\\BlueStacks_nxt\\Engine\\BlueStacks_nxt\\HD-Adb.exe',
  'C:\\Program Files\\Nox\\bin\\adb.exe',
  'C:\\Program Files (x86)\\Nox\\bin\\adb.exe',
  'C:\\Program Files\\Memu\\Hyper-V\\MEmuAdb.exe',
  'C:\\Program Files\\Microvirt\\MEmu\\adb.exe'
];

function exec(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || stdout || '').toString().trim();
        reject(new Error(msg || err.message));
      } else {
        resolve(stdout.toString());
      }
    });
  });
}

function scanDirForAdb(dir, depth = 0) {
  if (!dir || depth > 3) return null;
  let found = null;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const name = e.name.toLowerCase();
        if (name.includes('ld') || name.includes('mumu') || name.includes('bluestack') || name.includes('nox') || name.includes('memu')) {
          const f = scanDirForAdb(full, depth + 1);
          if (f) return f;
        }
      } else if (e.name.toLowerCase() === 'adb.exe' || e.name.toLowerCase() === 'hd-adb.exe') {
        return full;
      }
    }
  } catch { /* ignore */ }
  return found;
}

function detectAdbPath() {
  const s = getSettings();
  if (s.adb_path && fs.existsSync(s.adb_path)) return s.adb_path;
  for (const p of COMMON_ADB_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  const scanRoots = ['C:\\LDPlayer', 'C:\\Program Files', 'C:\\Program Files (x86)'];
  for (const root of scanRoots) {
    const found = scanDirForAdb(root);
    if (found) return found;
  }
  return null;
}

function getAdbPath() {
  if (!adbChecked) {
    adbPath = detectAdbPath();
    adbChecked = true;
    if (adbPath) setSetting('adb_path', adbPath);
  }
  return adbPath;
}

function resetAdbCache() {
  adbPath = null;
  adbChecked = false;
}

async function adb(serial, ...args) {
  const p = getAdbPath();
  if (!p) throw new Error('Không tìm thấy adb.exe. Cài giả lập (LDPlayer/MuMu) hoặc đặt đường dẫn adb trong Settings.');
  const full = serial ? ['-s', serial, ...args] : args;
  return exec(p, full);
}

async function listDevices() {
  const out = await adb(null, 'devices');
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*'))
    .map((l) => {
      const [serial, state] = l.split(/\s+/);
      return { serial, state };
    });
}

async function tap(serial, x, y) {
  await adb(serial, 'shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y)));
}

async function swipe(serial, x1, y1, x2, y2, ms = 400) {
  await adb(serial, 'shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(ms));
}

function escapeInputText(text) {
  return text
    .replace(/%/g, '\\%')
    .replace(/ /g, '%s')
    .replace(/([&|<>"';=()\\])/g, '\\$1');
}

async function inputText(serial, text) {
  const escaped = escapeInputText(text);
  if (!escaped) return;
  await adb(serial, 'shell', 'input', 'text', escaped);
}

async function openApp(serial, pkg) {
  await adb(serial, 'shell', 'am', 'start', '-n', `${pkg}/.main.MainActivity`);
}

async function isAppInstalled(serial, pkg) {
  const out = await adb(serial, 'shell', 'pm', 'list', 'packages');
  return out.includes(pkg);
}

async function screenshot(serial, destPath) {
  const buf = await exec(getAdbPath(), ['-s', serial, 'exec-out', 'screencap', '-p'], 20000);
  fs.writeFileSync(destPath, buf);
}

async function pushFile(serial, localPath, remotePath) {
  await adb(serial, 'push', localPath, remotePath);
}

async function getResolution(serial) {
  const out = await adb(serial, 'shell', 'wm', 'size');
  const m = out.match(/(\d+)x(\d+)/);
  return m ? `${m[1]}x${m[2]}` : '1080x1920';
}

async function home(serial) {
  await adb(serial, 'shell', 'input', 'keyevent', 'KEYCODE_HOME');
}

module.exports = {
  getAdbPath,
  resetAdbCache,
  listDevices,
  tap,
  swipe,
  inputText,
  openApp,
  isAppInstalled,
  screenshot,
  pushFile,
  getResolution,
  home,
  exec
};