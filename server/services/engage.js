// "Tương tác" tab: find videos in each channel's niche, draft a comment for each, and carry out the
// likes, comments and reposts the owner approves, one at a time and at a human pace per account.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { db, getSettings, setSetting } = require('../db');
const activity = require('./activity');

const ROOT = path.join(__dirname, '..', '..');
const PYTHON = process.env.DOUYIN_PYTHON || path.join(ROOT, 'third_party', 'luno-automation', 'backend', '.venv', 'Scripts', 'python.exe');
const OCR_PYTHON = process.env.DUB_PYTHON || path.join(ROOT, 'data', 'dub-venv', 'Scripts', 'python.exe');
const FRAME_DIR = path.join(ROOT, 'media', 'engage');
const HOUR_MS = 60 * 60 * 1000;
const DEFAULTS = { enabled: '0', likes_per_hour: '12', comments_per_hour: '12', reposts_per_day: '3', start_hour: '8', end_hour: '23', gap_minutes: '5' };

db.exec(`
CREATE TABLE IF NOT EXISTS engage_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL,
  profile TEXT NOT NULL,
  url TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  views TEXT NOT NULL DEFAULT '',
  do_like INTEGER NOT NULL DEFAULT 1,
  do_repost INTEGER NOT NULL DEFAULT 0,
  comment TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  result TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS engage_tasks_url ON engage_tasks (profile, url);
`);
if (!db.prepare('PRAGMA table_info(engage_tasks)').all().some((column) => column.name === 'screen_text')) {
  db.exec("ALTER TABLE engage_tasks ADD COLUMN screen_text TEXT NOT NULL DEFAULT ''");
}

const finding = new Map(); // profile -> topic being searched
const running = new Map(); // profile -> task being carried out
const nextAt = new Map(); // profile -> earliest time for its next action
const pausedUntil = new Map(); // profile -> time after a verification page

function config() {
  const settings = getSettings();
  const value = (key) => settings[`engage_${key}`] ?? DEFAULTS[key];
  return {
    enabled: value('enabled') === '1', likesPerHour: Number(value('likes_per_hour')), commentsPerHour: Number(value('comments_per_hour')),
    repostsPerDay: Number(value('reposts_per_day')), startHour: Number(value('start_hour')), endHour: Number(value('end_hour')),
    gapMinutes: Number(value('gap_minutes'))
  };
}

function saveConfig(body) {
  if (body.enabled !== undefined) setSetting('engage_enabled', body.enabled ? '1' : '0');
  const limits = { likesPerHour: ['likes_per_hour', 0, 30], commentsPerHour: ['comments_per_hour', 0, 20], repostsPerDay: ['reposts_per_day', 0, 10], startHour: ['start_hour', 0, 23], endHour: ['end_hour', 1, 24], gapMinutes: ['gap_minutes', 2, 60] };
  for (const [field, [key, min, max]] of Object.entries(limits)) {
    if (body[field] === undefined) continue;
    const number = Number(body[field]);
    if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Giá trị ${field} phải từ ${min} đến ${max}`);
    setSetting(`engage_${key}`, String(number));
  }
  return snapshot();
}

function runScript(profile, request, onRow) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', ROXY_PROFILE_ID: profile };
    const child = spawn(PYTHON, ['-X', 'utf8', path.join(ROOT, 'scripts', 'tiktok_engage.py'), JSON.stringify(request)], { cwd: ROOT, env, windowsHide: true });
    const rows = [];
    let buffer = '';
    let detail = '';
    const timer = setTimeout(() => child.kill(), 6 * 60 * 1000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) { try { const row = JSON.parse(line); rows.push(row); onRow?.(row); } catch {} }
    });
    child.stderr.on('data', (chunk) => { detail = (detail + chunk.toString()).slice(-600); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 || rows.length ? resolve(rows) : reject(new Error(detail.trim().split('\n').pop() || `exit ${code}`)); });
  });
}

// Each account has its own Roxy profile, so accounts work in parallel; one profile only does one
// thing at a time (posting, finding a post link and commenting a Shopee link come first).
function busyOn(profile) {
  return finding.has(profile) || running.has(profile) || require('./autopilot').busyProfiles().has(profile);
}

function ownHandles() {
  return db.prepare("SELECT DISTINCT post_url FROM reup_publications WHERE post_url != ''").all()
    .map((row) => String(row.post_url).match(/@([\w.]+)/)?.[1]).filter(Boolean);
}

// Text shown in the frames (titles, captions burned into the video), read locally for free.
function readFrames(frames) {
  if (!frames.length) return Promise.resolve({});
  return new Promise((resolve) => {
    execFile(OCR_PYTHON, ['-X', 'utf8', path.join(ROOT, 'scripts', 'ocr_frames.py'), ...frames],
      { cwd: ROOT, windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      (error, stdout) => {
        if (error) console.error(`[Tương tác] OCR lỗi: ${error.message.split('\n')[0]}`);
        try { resolve(JSON.parse(String(stdout).trim().split(/\r?\n/).pop())); } catch { resolve({}); }
      });
  });
}

function screenText(video, ocr) {
  const seen = new Set();
  return (video.frames || []).map((frame) => ocr[frame] || '').join(' ').split(/\s+/)
    .filter((word) => !seen.has(word.toLowerCase()) && seen.add(word.toLowerCase())).join(' ').slice(0, 300);
}

async function draftComments(topicName, videos) {
  const mt = require('./machine-translate');
  return mt.writeComments(topicName, videos.map((video) => ({ caption: video.desc, screen: video.screen, comments: video.comments || [] })));
}

// Search the niche with the channel's own profile, then draft one comment per video for review.
async function discover(topicId, query) {
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId);
  if (!topic) throw new Error('Không tìm thấy kênh');
  if (!topic.roxy_profile_id) throw new Error('Kênh chưa gắn profile Roxy');
  if (busyOn(topic.roxy_profile_id)) throw new Error('Acc này đang bận (đăng bài hoặc đang tương tác), thử lại sau ít phút');
  const tags = String(topic.trend_tags || '').split(/\s+/).map((tag) => tag.replace(/^#/, '')).filter(Boolean);
  const queries = query ? [String(query).replace(/^#/, '').trim()] : tags.sort(() => Math.random() - 0.5).slice(0, 2);
  if (!queries.length) throw new Error('Nhập từ khóa hoặc thêm hashtag cho kênh');
  const skip = db.prepare('SELECT url FROM engage_tasks WHERE profile = ?').all(topic.roxy_profile_id).map((row) => row.url);
  const key = `engage-${topic.roxy_profile_id}`;
  finding.set(topic.roxy_profile_id, topic.id);
  activity.set(key, `Tương tác: tìm video cho ${topic.name}`, queries.join(', '));
  try {
    let seen = 0;
    const rows = await runScript(topic.roxy_profile_id, { mode: 'discover', queries, limit: 10, skip, skipHandles: ownHandles(), frameDir: FRAME_DIR },
      (row) => row.type === 'video' && activity.set(key, `Tương tác: xem video cho ${topic.name}`, `${++seen}/10 · ${row.desc.slice(0, 60)}`));
    const failure = rows.find((row) => row.type === 'error');
    if (failure) throw new Error(failure.error);
    const videos = rows.filter((row) => row.type === 'video');
    if (!videos.length) throw new Error('Không tìm thấy video mới cho từ khóa này');
    activity.set(key, `Tương tác: đọc chữ trên video cho ${topic.name}`, `${videos.length} video`);
    const frames = videos.flatMap((video) => video.frames || []);
    const ocr = await readFrames(frames);
    for (const video of videos) video.screen = screenText(video, ocr);
    for (const frame of frames) fs.rm(frame, { force: true }, () => {});
    activity.set(key, `Tương tác: soạn bình luận cho ${topic.name}`, `${videos.length} video`);
    let comments = [];
    try { comments = await draftComments(topic.name, videos); } catch (error) { console.error(`[Tương tác] soạn bình luận lỗi: ${error.message}`); }
    const insert = db.prepare(`INSERT OR IGNORE INTO engage_tasks (topic_id, profile, url, author, description, views, comment, screen_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    videos.forEach((video, index) => insert.run(topic.id, topic.roxy_profile_id, video.url, video.author, video.desc, video.views, comments[index] || '', video.screen || ''));
    return { found: videos.length };
  } finally {
    finding.delete(topic.roxy_profile_id);
    activity.clear(key);
  }
}

function list() {
  return db.prepare(`SELECT e.*, t.name AS topic_name FROM engage_tasks e LEFT JOIN topics t ON t.id = e.topic_id
    WHERE e.status IN ('draft', 'approved', 'running') OR e.done_at > datetime('now', '-2 days')
    ORDER BY CASE e.status WHEN 'running' THEN 0 WHEN 'approved' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, e.id DESC LIMIT 300`).all();
}

function update(id, body) {
  const task = db.prepare('SELECT * FROM engage_tasks WHERE id = ?').get(id);
  if (!task) throw new Error('Không tìm thấy việc');
  if (!['draft', 'approved'].includes(task.status)) throw new Error('Việc này đã chạy rồi');
  const comment = body.comment !== undefined ? String(body.comment).replace(/https?:\/\/\S+/g, '').trim().slice(0, 150) : task.comment;
  db.prepare('UPDATE engage_tasks SET comment = ?, do_like = ?, do_repost = ? WHERE id = ?')
    .run(comment, body.like !== undefined ? (body.like ? 1 : 0) : task.do_like, body.repost !== undefined ? (body.repost ? 1 : 0) : task.do_repost, id);
  return db.prepare('SELECT * FROM engage_tasks WHERE id = ?').get(id);
}

function setStatus(ids, status) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('Chọn ít nhất một việc');
  const from = status === 'approved' ? "('draft')" : "('draft', 'approved')";
  const statement = db.prepare(`UPDATE engage_tasks SET status = ? WHERE id = ? AND status IN ${from}`);
  return { changed: ids.reduce((total, id) => total + statement.run(status, Number(id)).changes, 0) };
}

function clearDone() {
  return { removed: db.prepare("DELETE FROM engage_tasks WHERE status IN ('done', 'failed', 'skipped')").run().changes };
}

// Actions an account did recently, so each one stays under the hourly and daily limits.
function usage(profile) {
  const since = (ms) => new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);
  const count = (field, ms) => db.prepare(`SELECT count(*) n FROM engage_tasks WHERE profile = ? AND status = 'done' AND done_at > ? AND result LIKE ?`)
    .get(profile, since(ms), `%"${field}":"done"%`).n;
  return { likes: count('like', HOUR_MS), comments: count('comment', HOUR_MS), reposts: count('repost', 24 * HOUR_MS) };
}

async function runOne(task) {
  const limits = config();
  const used = usage(task.profile);
  const request = {
    mode: 'act', url: task.url,
    like: Boolean(task.do_like) && used.likes < limits.likesPerHour,
    comment: task.comment && used.comments < limits.commentsPerHour ? task.comment : '',
    repost: Boolean(task.do_repost) && used.reposts < limits.repostsPerDay
  };
  // A task waits until every action it asks for is allowed again, so an approved comment is never dropped.
  if ((task.do_like && !request.like) || (task.comment && !request.comment) || (task.do_repost && !request.repost)) return false;
  const key = `engage-${task.profile}`;
  running.set(task.profile, task.id);
  db.prepare("UPDATE engage_tasks SET status = 'running' WHERE id = ?").run(task.id);
  activity.set(key, `Tương tác #${task.id} (${task.topic_name})`, `${request.like ? 'tym ' : ''}${request.comment ? 'bình luận ' : ''}${request.repost ? 'đăng lại' : ''}`);
  try {
    const rows = await runScript(task.profile, request);
    const failure = rows.find((row) => row.type === 'error');
    const result = rows.find((row) => row.type === 'result') || {};
    if (failure?.verification) pausedUntil.set(task.profile, Date.now() + 6 * HOUR_MS);
    const ok = !failure && ['like', 'comment', 'repost'].some((key) => ['done', 'already'].includes(result[key]));
    db.prepare("UPDATE engage_tasks SET status = ?, result = ?, done_at = datetime('now') WHERE id = ?")
      .run(ok ? 'done' : 'failed', JSON.stringify(failure ? { error: failure.error } : result), task.id);
  } catch (error) {
    db.prepare("UPDATE engage_tasks SET status = 'failed', result = ?, done_at = datetime('now') WHERE id = ?").run(JSON.stringify({ error: error.message.slice(0, 200) }), task.id);
  } finally {
    running.delete(task.profile);
    activity.clear(key);
    // The chosen gap, give or take 20%, before the same account acts again.
    nextAt.set(task.profile, Date.now() + config().gapMinutes * 60000 * (0.8 + Math.random() * 0.4));
  }
  return true;
}

// Every free account starts its next approved task; accounts run side by side, not one after another.
function tick() {
  const limits = config();
  const hour = new Date().getHours();
  if (!limits.enabled || hour < limits.startHour || hour >= limits.endHour) return;
  const tasks = db.prepare(`SELECT e.*, t.name AS topic_name FROM engage_tasks e LEFT JOIN topics t ON t.id = e.topic_id
    WHERE e.status = 'approved' ORDER BY e.id`).all();
  const started = new Set();
  for (const task of tasks) {
    if (started.has(task.profile) || busyOn(task.profile)) continue;
    if ((nextAt.get(task.profile) || 0) > Date.now() || (pausedUntil.get(task.profile) || 0) > Date.now()) continue;
    started.add(task.profile);
    runOne(task).then((ran) => { if (!ran) nextAt.set(task.profile, Date.now() + 60000); })
      .catch((error) => console.error(`[Tương tác] ${error.message}`));
  }
}

function snapshot() {
  const accounts = db.prepare("SELECT id, name, roxy_profile_id FROM topics WHERE roxy_profile_id != '' ORDER BY id").all().map((topic) => ({
    topicId: topic.id, name: topic.name, usage: usage(topic.roxy_profile_id),
    finding: finding.has(topic.roxy_profile_id), running: running.get(topic.roxy_profile_id) || null,
    pausedUntil: (pausedUntil.get(topic.roxy_profile_id) || 0) > Date.now() ? new Date(pausedUntil.get(topic.roxy_profile_id)).toISOString() : null,
    nextAt: (nextAt.get(topic.roxy_profile_id) || 0) > Date.now() ? new Date(nextAt.get(topic.roxy_profile_id)).toISOString() : null
  }));
  return { ...config(), finding: [...finding.values()], running: [...running.values()], accounts, tasks: list() };
}

function start() {
  db.prepare("UPDATE engage_tasks SET status = 'approved' WHERE status = 'running'").run(); // interrupted by a restart
  setInterval(() => { try { tick(); } catch (error) { console.error(`[Tương tác] ${error.message}`); } }, 30000).unref();
}

module.exports = { config, saveConfig, discover, list, update, setStatus, clearDone, snapshot, start, tick, busyOn };
