const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const reup = require('./reup');

const ROOT = path.join(__dirname, '..', '..');
let loginProcess = null;

function readLogin() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tiktok-login-status.json'), 'utf8')); }
  catch { return { state: 'idle' }; }
}

function browserConfig() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'roxy-browser.json'), 'utf8'));
    if (value.mode === 'roxy') return { browserMode: 'roxy', browserConfigured: Boolean(value.profile_id) };
  } catch {}
  return { browserMode: 'chrome', browserConfigured: false };
}

function loginOpen(login) {
  if (loginProcess) return true;
  if (!['opening', 'login_required', 'rate_limited'].includes(login.state) || !Number.isInteger(login.pid) || login.pid <= 0) return false;
  try { process.kill(login.pid, 0); return true; } catch { return false; }
}

async function request(route, body) {
  const response = await fetch(reup.base('luno') + route, {
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`LUNO HTTP ${response.status}`);
  return response.json();
}

async function status() {
  const login = readLogin();
  const browser = browserConfig();
  try {
    const [registry, session] = await Promise.all([request('/accounts'), request('/session/status')]);
    return { ...browser, available: true, loginOpen: loginOpen(login), login, activeId: registry.active_id,
      accounts: registry.accounts.map((a) => ({ id: a.id, label: a.label })),
      hasSession: Boolean(session.has_session), hasCookie: Boolean(session.has_cookie) };
  } catch (error) { return { ...browser, available: false, loginOpen: loginOpen(login), login, accounts: [], error: error.message }; }
}

function openLogin() {
  if (loginOpen(readLogin())) throw new Error('Cửa sổ đăng nhập TikTok đang mở');
  const python = process.env.DOUYIN_PYTHON || path.join(ROOT, 'third_party', 'luno-automation', 'backend', '.venv', 'Scripts', 'python.exe');
  loginProcess = spawn(python, [path.join(ROOT, 'scripts', 'open_tiktok_login.py'), reup.base('luno')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
  loginProcess.on('error', (error) => { console.error(`[TikTok login] ${error.message}`); loginProcess = null; });
  loginProcess.on('close', () => { loginProcess = null; });
  return { opened: true };
}

async function activate(id) {
  const state = await status();
  if (!state.accounts.some((a) => a.id === id)) throw new Error('Không có tài khoản TikTok này');
  await request('/accounts/activate', { id });
  return status();
}

module.exports = { status, openLogin, activate };
