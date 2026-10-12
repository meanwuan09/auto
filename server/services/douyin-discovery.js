const path = require('path');
const { spawn } = require('child_process');
const { db, getSettings, setSetting } = require('../db');
const { normalizeDouyinUrl } = require('./douyin-source');
const reup = require('./reup');

const ROOT = path.join(__dirname, '..', '..');
const PYTHON = process.env.DOUYIN_PYTHON || path.join(ROOT, 'third_party', 'luno-automation', 'backend', '.venv', 'Scripts', 'python.exe');
let scanning = false;
let loginProcess = null;
let lastRun = 0;

if (getSettings().discovery_seeded !== '1') {
  for (const value of ['厨房好物', '家居好物', '实用小工具']) {
    db.prepare('INSERT OR IGNORE INTO douyin_sources (kind, value) VALUES (?, ?)').run('keyword', value);
  }
  setSetting('discovery_seeded', '1');
}
if (getSettings().discovery_public_seeded !== '1') {
  db.prepare('INSERT OR IGNORE INTO douyin_sources (kind, value) VALUES (?, ?)').run('feed', 'https://www.douyin.com/jingxuan');
  setSetting('discovery_public_seeded', '1');
}

function config() {
  const settings = getSettings();
  return { enabled: settings.discovery_enabled === '1', autoQueue: settings.discovery_auto_queue === '1', publicOnly: settings.discovery_public_only !== '0' };
}

// Feed and category pages load without a Douyin account; keyword and creator pages need login.
const PUBLIC_KINDS = ['feed', 'category'];

function topics() {
  return db.prepare('SELECT * FROM topics ORDER BY id').all();
}

function topicKeywords(topic) {
  return String(topic?.keywords || '').split(/[,，\n]/).map((word) => word.trim().toLowerCase()).filter(Boolean);
}

function matchesTopic(topic, title) {
  const words = topicKeywords(topic);
  const text = String(title || '').toLowerCase();
  return !words.length || words.some((word) => text.includes(word));
}

function saveTopic(id, body) {
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(id);
  if (!topic) throw new Error('Không có chủ đề này');
  const profile = String(body.roxyProfileId ?? topic.roxy_profile_id).trim();
  if (profile && !/^[A-Za-z0-9]{1,64}$/.test(profile)) throw new Error('ID profile Roxy không hợp lệ');
  const keywords = String(body.keywords ?? topic.keywords).slice(0, 1000);
  const trendTags = String(body.trendTags ?? topic.trend_tags).slice(0, 1000);
  const shopeeKeywords = String(body.shopeeKeywords ?? topic.shopee_keywords).slice(0, 1000);
  db.prepare('UPDATE topics SET roxy_profile_id = ?, keywords = ?, trend_tags = ?, shopee_keywords = ? WHERE id = ?').run(profile, keywords, trendTags, shopeeKeywords, id);
  return snapshot();
}

function snapshot() {
  return { ...config(), scanning, loginOpen: Boolean(loginProcess), topics: topics(),
    sources: db.prepare('SELECT s.*, t.name AS topic_name FROM douyin_sources s LEFT JOIN topics t ON t.id = s.topic_id ORDER BY s.id').all(),
    // Top 100 per topic (and for untagged sources) so a busy feed cannot push topic videos off the list.
    candidates: db.prepare(`SELECT * FROM (SELECT c.*, s.kind, s.value AS source_name, s.rights_confirmed, t.name AS topic_name,
      ROW_NUMBER() OVER (PARTITION BY c.topic_id ORDER BY c.score DESC, c.id DESC) AS topic_rank
      FROM douyin_candidates c JOIN douyin_sources s ON s.id = c.source_id LEFT JOIN topics t ON t.id = c.topic_id
      WHERE c.status != 'dismissed') WHERE topic_rank <= 100 ORDER BY score DESC, id DESC`).all() };
}

function addSource(kind, input, rightsConfirmed, topicId = null) {
  let value = String(input || '').trim();
  if (kind === 'feed') value = 'https://www.douyin.com/jingxuan';
  if (kind === 'category') {
    const id = value.match(/^(?:https:\/\/www\.douyin\.com\/channel\/)?(\d{6})\/?$/)?.[1];
    if (!id) throw new Error('Cần mã danh mục Douyin 6 chữ số, ví dụ 300201');
    value = `https://www.douyin.com/channel/${id}`;
  }
  const topic = topicId == null || topicId === '' ? null : db.prepare('SELECT id FROM topics WHERE id = ?').get(topicId);
  if (topicId != null && topicId !== '' && !topic) throw new Error('Không có chủ đề này');
  if (!['keyword', 'channel', 'feed', 'category'].includes(kind) || !value || value.length > 250) throw new Error('Nguồn hoặc từ khóa không hợp lệ');
  if (kind === 'channel') {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['douyin.com', 'www.douyin.com'].includes(url.hostname) || url.username || url.password || url.port || !/^\/user\/[\w-]+\/?$/.test(url.pathname)) throw new Error('Cần URL kênh Douyin dạng https://www.douyin.com/user/...');
    value = `https://www.douyin.com${url.pathname.replace(/\/$/, '')}`;
  }
  // A keyword includes many creators; it cannot carry blanket reuse permission.
  const rights = kind === 'channel' && rightsConfirmed === true ? 1 : 0;
  db.prepare('INSERT INTO douyin_sources (kind, value, rights_confirmed, topic_id) VALUES (?, ?, ?, ?) ON CONFLICT(kind, value) DO UPDATE SET rights_confirmed = excluded.rights_confirmed, topic_id = excluded.topic_id').run(kind, value, rights, topic?.id ?? null);
  return snapshot();
}

function saveConfig(body) {
  setSetting('discovery_enabled', body.enabled === true ? '1' : '0');
  setSetting('discovery_auto_queue', body.autoQueue === true ? '1' : '0');
  if (typeof body.publicOnly === 'boolean') setSetting('discovery_public_only', body.publicOnly ? '1' : '0');
  return snapshot();
}

function readSource(source) {
  return new Promise((resolve, reject) => {
    const args = [path.join(ROOT, 'scripts', 'discover_douyin.py'), source.kind, source.value];
    if (PUBLIC_KINDS.includes(source.kind) || config().publicOnly) args.push('--anonymous');
    const child = spawn(PYTHON, args, { cwd: ROOT, windowsHide: true });
    let output = '', detail = '';
    const timer = setTimeout(() => child.kill(), 90000);
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { detail = (detail + chunk.toString()).slice(-2000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(detail || 'Quét Douyin quá thời gian'));
      try {
        const result = JSON.parse(output);
        if (!Array.isArray(result.items)) throw new Error('Douyin không trả danh sách video');
        resolve(result.items.slice(0, 50));
      } catch (error) { reject(error); }
    });
  });
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function rank(item, previous, now = Date.now()) {
  const likes = number(item.likes), shares = number(item.shares), comments = number(item.comments);
  const total = likes === null ? null : likes + (shares || 0) * 5 + (comments || 0) * 2;
  const elapsed = previous ? (now - Date.parse(previous.observed_at)) / 3600000 : 0;
  const oldTotal = previous?.likes == null ? null : previous.likes + (previous.shares || 0) * 5 + (previous.comments || 0) * 2;
  const growth = total !== null && oldTotal !== null && elapsed >= 0.25 ? Math.max(0, total - oldTotal) / elapsed : null;
  const published = number(item.created_at);
  // Search pages scraped in the user's Chrome carry no publish date; treat those as about a week old.
  const age = published && published * 1000 <= now ? (now / 1000 - published) / 86400 : published ? null : 7;
  const score = total === null || age === null ? 0 : Math.log10(1 + total) * 10 / (1 + age / 7) + (growth === null ? 0 : Math.min(15, Math.log10(1 + growth) * 3));
  return { score: Math.round(score * 100) / 100, growth };
}

function storeCandidate(source, item, now = Date.now(), { trustSource = false } = {}) {
  const topic = source.topic_id ? db.prepare('SELECT * FROM topics WHERE id = ?').get(source.topic_id) : null;
  // A keyword search already targets the topic (and its titles may arrive machine-translated).
  if (topic && !trustSource && !matchesTopic(topic, item.title)) return false;
  const url = normalizeDouyinUrl(item.url);
  const previous = db.prepare('SELECT * FROM douyin_candidates WHERE source_url = ?').get(url);
  const { score, growth } = rank(item, previous, now);
  const job = db.prepare('SELECT id, source_url FROM reup_jobs').all().find((entry) => {
    try { return normalizeDouyinUrl(entry.source_url) === url; } catch { return false; }
  });
  const sourceId = previous && previous.source_id !== source.id && !source.rights_confirmed ? previous.source_id : source.id;
  const topicId = previous && previous.source_id === sourceId && previous.source_id !== source.id ? previous.topic_id : (topic?.id ?? previous?.topic_id ?? null);
  db.prepare(`INSERT INTO douyin_candidates (source_id, source_url, title, author, likes, comments, shares, views, published_at, duration, score, growth, observed_at, status, job_id, topic_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_url) DO UPDATE SET source_id = excluded.source_id, title = excluded.title, topic_id = excluded.topic_id,
    author = excluded.author, likes = excluded.likes, comments = excluded.comments, shares = excluded.shares,
    views = excluded.views, published_at = excluded.published_at, duration = excluded.duration,
    score = excluded.score, growth = excluded.growth, observed_at = excluded.observed_at,
    status = CASE WHEN excluded.job_id IS NOT NULL THEN 'queued' ELSE douyin_candidates.status END,
    job_id = COALESCE(excluded.job_id, douyin_candidates.job_id)`)
    .run(sourceId, url, String(item.title || '').slice(0, 250), String(item.author || '').slice(0, 150),
      number(item.likes), number(item.comments), number(item.shares), number(item.views), number(item.created_at), number(item.duration),
      score, growth, new Date(now).toISOString(), job ? 'queued' : 'new', job?.id || null, topicId);
  return true;
}

function queueCandidate(id, rightsConfirmed = false) {
  const item = db.prepare('SELECT c.*, s.rights_confirmed FROM douyin_candidates c JOIN douyin_sources s ON s.id = c.source_id WHERE c.id = ?').get(id);
  if (!item || item.status !== 'new') throw new Error('Video không còn trong danh sách đề xuất');
  if (!item.rights_confirmed && rightsConfirmed !== true) throw new Error('Cần xác nhận quyền sử dụng video');
  const result = reup.enqueueImports([item.source_url], item.title, item.topic_id);
  const jobId = result.ids[0] || result.skipped[0];
  db.prepare("UPDATE douyin_candidates SET status = 'queued', job_id = ? WHERE id = ?").run(jobId, id);
  return { jobId };
}

// Results scraped by the Chrome extension from Douyin search, where the user's real browser is
// signed in and is not shown the captcha that the headless scanner gets.
function importItems(sourceId, items) {
  const source = db.prepare('SELECT * FROM douyin_sources WHERE id = ?').get(sourceId);
  if (!source) throw new Error('Không có nguồn này');
  if (!Array.isArray(items) || items.length > 100) throw new Error('Danh sách video không hợp lệ');
  let kept = 0;
  for (const item of items) {
    try {
      // Results of an AI keyword (AI萌宠, 即梦…) are AI clips even when the translated title hides it;
      // mark them so posting adds TikTok's AI-generated label.
      const aiSource = /(^|[^a-z])ai|aigc|即梦|可灵/i.test(source.value) && !/(^|[^a-z])ai(?![a-z])|aigc|即梦|可灵/i.test(item.title || '');
      if (storeCandidate(source, { url: item.url, title: aiSource ? `${item.title || ''} #AI` : item.title, likes: number(Number(item.likes)), duration: number(Number(item.duration)),
        created_at: number(Number(item.createdAt)) }, Date.now(), { trustSource: source.kind === 'keyword' })) kept += 1;
    } catch {}
  }
  db.prepare("UPDATE douyin_sources SET last_scan = ?, error = ? WHERE id = ?").run(new Date().toISOString(), items.length ? '' : 'Tiện ích không đọc được video nào', source.id);
  return { received: items.length, kept };
}

// Quick button: download, then transcribe and pick a product without further clicks.
function quickCandidate(id, rightsConfirmed = false) {
  const { jobId } = queueCandidate(id, rightsConfirmed);
  db.prepare('UPDATE reup_jobs SET auto_prepare = 1 WHERE id = ?').run(jobId);
  const product = require('./shopee-products').pickFor(jobId);
  return { jobId, product: product?.name || null };
}

function quickTopic(topicId, count = 3, rightsConfirmed = false) {
  const topic = db.prepare('SELECT id FROM topics WHERE id = ?').get(topicId);
  if (!topic) throw new Error('Chọn một chủ đề trước');
  const limit = Math.max(1, Math.min(10, Number(count) || 3));
  const picks = db.prepare(`SELECT id FROM douyin_candidates WHERE topic_id = ? AND status = 'new'
    AND (duration IS NULL OR duration BETWEEN 10 AND 180) ORDER BY score DESC, id DESC LIMIT ?`).all(topic.id, limit);
  if (!picks.length) throw new Error('Chủ đề này chưa có video đề xuất; bấm Quét ngay trước');
  return picks.map((pick) => quickCandidate(pick.id, rightsConfirmed));
}

async function scan(reader = readSource) {
  if (scanning || (loginProcess && !config().publicOnly)) throw new Error('Đang quét hoặc mở phiên đăng nhập; đóng Chrome Douyin trước khi quét');
  const sources = db.prepare(`SELECT * FROM douyin_sources ${config().publicOnly ? `WHERE kind IN (${PUBLIC_KINDS.map((kind) => `'${kind}'`).join(', ')})` : ''} ORDER BY last_scan, id LIMIT 3`).all();
  if (!sources.length) throw new Error('Thêm từ khóa hoặc kênh trước khi quét');
  scanning = true;
  lastRun = Date.now();
  try {
    for (const source of sources) {
      try {
        const items = await reader(source);
        for (const item of items) storeCandidate(source, item);
        db.prepare("UPDATE douyin_sources SET last_scan = ?, error = '' WHERE id = ?").run(new Date().toISOString(), source.id);
      } catch (error) {
        db.prepare('UPDATE douyin_sources SET last_scan = ?, error = ? WHERE id = ?').run(new Date().toISOString(), error.message.slice(0, 1500), source.id);
        console.error(`[Douyin discovery #${source.id}] ${error.message}`);
      }
    }
    if (config().autoQueue) {
      const candidates = db.prepare(`SELECT c.id FROM douyin_candidates c JOIN douyin_sources s ON s.id = c.source_id
        WHERE c.status = 'new' AND s.rights_confirmed = 1 AND s.error = '' AND c.score >= 15
        AND c.duration BETWEEN 10 AND 180 AND c.published_at >= ? AND c.observed_at >= ? ORDER BY c.score DESC LIMIT 3`)
        .all(Math.floor(Date.now() / 1000) - 30 * 86400, new Date(lastRun).toISOString());
      for (const item of candidates) queueCandidate(item.id);
    }
    return snapshot();
  } finally { scanning = false; }
}

// ---------- Douyin login by cookie ----------
const fs = require('fs');
const COOKIE_FILE = path.join(ROOT, 'data', 'douyin-cookie.json');

// Accepts the Cookie header copied from DevTools ("a=b; c=d") or a Cookie-Editor JSON export.
function parseCookies(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('Dán cookie Douyin vào ô');
  let cookies;
  if (text.startsWith('[')) {
    let list;
    try { list = JSON.parse(text); } catch { throw new Error('JSON cookie không hợp lệ'); }
    cookies = list.filter((c) => c?.name && c.value !== undefined && /douyin\.com$/.test(String(c.domain || '.douyin.com').replace(/^\./, ''))).map((c) => ({
      name: String(c.name), value: String(c.value), domain: c.domain || '.douyin.com', path: c.path || '/',
      secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly),
      ...(c.expirationDate || c.expires > 0 ? { expires: Math.floor(c.expirationDate || c.expires) } : {}),
      ...(['Strict', 'Lax', 'None'].includes(c.sameSite) ? { sameSite: c.sameSite } : {})
    }));
  } else {
    cookies = text.replace(/^cookie:\s*/i, '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
      const at = part.indexOf('=');
      return at > 0 ? { name: part.slice(0, at).trim(), value: part.slice(at + 1).trim(), domain: '.douyin.com', path: '/', secure: true } : null;
    }).filter(Boolean);
  }
  if (!cookies.some((c) => ['sessionid', 'sessionid_ss', 'sid_tt'].includes(c.name))) {
    throw new Error('Cookie thiếu sessionid — hãy copy cookie khi đang đăng nhập douyin.com');
  }
  return cookies;
}

function saveCookie(input) {
  const cookies = parseCookies(input);
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies), 'utf8');
  setSetting('douyin_cookie_saved_at', new Date().toISOString());
  return cookieStatus();
}

function clearCookie() {
  fs.rmSync(COOKIE_FILE, { force: true });
  setSetting('douyin_cookie_saved_at', '');
  return cookieStatus();
}

function cookieStatus() {
  const settings = getSettings();
  return { saved: fs.existsSync(COOKIE_FILE), savedAt: settings.douyin_cookie_saved_at || '',
    loggedIn: settings.douyin_login_state === '1', name: settings.douyin_login_name || '', checkedAt: settings.douyin_login_checked_at || '' };
}

// Opens douyin.com with the saved cookie and asks Douyin who is signed in.
function checkLogin() {
  if (scanning || loginProcess) return Promise.reject(new Error('Đang quét hoặc đang mở phiên đăng nhập'));
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [path.join(ROOT, 'scripts', 'discover_douyin.py'), 'check', 'x'], { cwd: ROOT, windowsHide: true });
    let output = '';
    const timer = setTimeout(() => child.kill(), 90000);
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', () => {
      clearTimeout(timer);
      let result = { loggedIn: false };
      try { result = JSON.parse(output.trim().split(/\r?\n/).pop()); } catch {}
      setSetting('douyin_login_state', result.loggedIn ? '1' : '0');
      setSetting('douyin_login_name', result.name || '');
      setSetting('douyin_login_checked_at', new Date().toISOString());
      resolve(cookieStatus());
    });
  });
}

function openLogin() {
  if (scanning || loginProcess) throw new Error('Đang quét hoặc đã mở phiên đăng nhập');
  loginProcess = spawn(PYTHON, [path.join(ROOT, 'scripts', 'discover_douyin.py'), 'keyword', 'login', '--login'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  loginProcess.stderr.on('data', (chunk) => console.error(`[Douyin login] ${chunk.toString().slice(-1000)}`));
  loginProcess.on('error', (error) => { console.error(error.message); loginProcess = null; });
  loginProcess.on('close', () => { loginProcess = null; });
  return { opened: true };
}

function startScheduler() {
  const timer = setInterval(() => {
    if (config().enabled && !scanning && (!loginProcess || config().publicOnly) && Date.now() - lastRun >= 3600000 && db.prepare('SELECT id FROM douyin_sources LIMIT 1').get()) {
      scan().catch((error) => console.error(`[Douyin discovery] ${error.message}`));
    }
  }, 60000);
  timer.unref();
}

module.exports = { importItems, saveCookie, clearCookie, cookieStatus, checkLogin, parseCookies, quickCandidate, quickTopic, PUBLIC_KINDS, snapshot, addSource, saveConfig, saveTopic, matchesTopic, scan, queueCandidate, openLogin, startScheduler, rank, storeCandidate };
