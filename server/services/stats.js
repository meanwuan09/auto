const path = require('path');
const { spawn } = require('child_process');
const { db } = require('../db');
const activity = require('./activity');

const ROOT = path.join(__dirname, '..', '..');
const PYTHON = process.env.DOUYIN_PYTHON || path.join(ROOT, 'third_party', 'luno-automation', 'backend', '.venv', 'Scripts', 'python.exe');
const REFRESH_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

db.exec(`
CREATE TABLE IF NOT EXISTS post_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER NOT NULL REFERENCES reup_publications(id),
  checked_at TEXT NOT NULL,
  views INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, saves INTEGER
);
CREATE INDEX IF NOT EXISTS post_stats_publication ON post_stats (publication_id, checked_at);
CREATE TABLE IF NOT EXISTS channel_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  followers INTEGER, likes INTEGER, videos INTEGER
);
CREATE INDEX IF NOT EXISTS channel_stats_handle ON channel_stats (handle, checked_at);
`);

let running = false;
let lastRun = null;
let lastError = '';

const handleOf = (url) => String(url).match(/tiktok\.com\/@([\w.]+)\//)?.[1] || null;

function posts() {
  return db.prepare(`SELECT p.id, p.job_id, p.post_url, p.created_at, j.title, j.caption, j.topic_id, t.name AS topic_name,
      COALESCE(NULLIF(j.account_profile, ''), t.roxy_profile_id, '') AS profile
    FROM reup_publications p JOIN reup_jobs j ON j.id = p.job_id LEFT JOIN topics t ON t.id = j.topic_id
    WHERE p.platform = 'tiktok' AND p.post_url != '' ORDER BY p.id DESC`).all();
}

function readScript(profileId, request) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', ...(profileId ? { ROXY_PROFILE_ID: profileId } : {}) };
    const child = spawn(PYTHON, ['-X', 'utf8', path.join(ROOT, 'scripts', 'tiktok_stats.py'), JSON.stringify(request)], { cwd: ROOT, env, windowsHide: true });
    const rows = [];
    let buffer = '';
    let detail = '';
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) { try { rows.push(JSON.parse(line)); } catch {} }
      activity.set('stats', 'Cập nhật thống kê TikTok', `${rows.length} mục đã đọc`);
    });
    child.stderr.on('data', (chunk) => { detail = (detail + chunk.toString()).slice(-600); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 || rows.length ? resolve(rows) : reject(new Error(detail || `exit ${code}`)); });
  });
}

// TikTok serves post and profile pages with their numbers embedded (__UNIVERSAL_DATA_FOR_REHYDRATION__),
// so a plain request reads them without opening a browser or tying up a Roxy profile.
const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0 Safari/537.36',
  'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8'
};
const asNumber = (value) => (value == null || value === '' ? null : Number(value));

async function pageScope(url) {
  const response = await fetch(url, { headers: PAGE_HEADERS, signal: AbortSignal.timeout(20000) });
  const html = await response.text();
  const match = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error(`TikTok HTTP ${response.status} không có dữ liệu trang`);
  return JSON.parse(match[1]).__DEFAULT_SCOPE__ || {};
}

async function readHttp(request) {
  const rows = [];
  for (const url of request.videos) {
    try {
      const item = (await pageScope(url))['webapp.video-detail']?.itemInfo?.itemStruct;
      const stats = item?.statsV2 || item?.stats;
      if (!stats) throw new Error('không có số liệu');
      rows.push({ type: 'video', url, views: asNumber(stats.playCount), likes: asNumber(stats.diggCount), comments: asNumber(stats.commentCount),
        shares: asNumber(stats.shareCount), saves: asNumber(stats.collectCount) });
    } catch (error) { rows.push({ type: 'video', url, error: error.message }); }
    activity.set('stats', 'Cập nhật thống kê TikTok', `${rows.length}/${request.videos.length + request.profiles.length} mục`);
    await new Promise((resolve) => setTimeout(resolve, 800 + Math.random() * 700));
  }
  for (const handle of request.profiles) {
    try {
      const info = (await pageScope(`https://www.tiktok.com/@${handle}`))['webapp.user-detail']?.userInfo;
      const stats = info?.statsV2 || info?.stats;
      if (!stats) throw new Error('không có số liệu');
      rows.push({ type: 'profile', handle, followers: asNumber(stats.followerCount), likes: asNumber(stats.heartCount ?? stats.heart), videos: asNumber(stats.videoCount) });
    } catch (error) { rows.push({ type: 'profile', handle, error: error.message }); }
    await new Promise((resolve) => setTimeout(resolve, 800 + Math.random() * 700));
  }
  return rows;
}

// Browsing TikTok shares the Roxy profiles with posting and commenting, so wait for those to finish.
function browserBusy() {
  const autopilot = require('./autopilot');
  const comment = require('./affiliate-comment').commentRunning();
  return Boolean(comment || autopilot.snapshot().finding ||
    db.prepare("SELECT id FROM reup_publications WHERE status = 'running' LIMIT 1").get());
}

async function refresh() {
  if (running) throw new Error('Đang cập nhật thống kê');
  running = true;
  lastError = '';
  activity.set('stats', 'Cập nhật thống kê TikTok', 'Mở trang video và kênh…');
  try {
    const list = posts();
    // Each channel is read from its own Roxy profile; posts from older setups use the first configured one.
    const fallback = db.prepare("SELECT roxy_profile_id FROM topics WHERE roxy_profile_id != '' ORDER BY id LIMIT 1").get()?.roxy_profile_id || '';
    const groups = new Map();
    for (const post of list) {
      const key = post.profile || fallback;
      if (!groups.has(key)) groups.set(key, { videos: [], profiles: new Set() });
      groups.get(key).videos.push(post.post_url);
      if (handleOf(post.post_url)) groups.get(key).profiles.add(handleOf(post.post_url));
    }
    const now = new Date().toISOString();
    const byUrl = new Map(list.map((post) => [post.post_url, post]));
    let read = 0;
    for (const [profile, group] of groups) {
      const request = { videos: group.videos, profiles: [...group.profiles] };
      let rows = await readHttp(request);
      // Fall back to the channel's Roxy browser only if TikTok refused the plain requests.
      if (rows.length && rows.every((row) => row.error) && !browserBusy()) rows = await readScript(profile, request);
      for (const row of rows) {
        if (row.error) continue;
        if (row.type === 'video' && byUrl.has(row.url)) {
          db.prepare('INSERT INTO post_stats (publication_id, checked_at, views, likes, comments, shares, saves) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(byUrl.get(row.url).id, now, row.views, row.likes, row.comments, row.shares, row.saves);
          read += 1;
        } else if (row.type === 'profile') {
          db.prepare('INSERT INTO channel_stats (handle, checked_at, followers, likes, videos) VALUES (?, ?, ?, ?, ?)')
            .run(row.handle, now, row.followers, row.likes, row.videos);
        }
      }
    }
    lastRun = now;
    return { read, posts: list.length };
  } catch (error) {
    lastError = error.message.slice(0, 300);
    throw error;
  } finally {
    running = false;
    activity.clear('stats');
  }
}

// Latest numbers plus the change against the reading closest to 24 hours earlier.
function latestWithChange(table, keyColumn, key) {
  const latest = db.prepare(`SELECT * FROM ${table} WHERE ${keyColumn} = ? ORDER BY checked_at DESC LIMIT 1`).get(key);
  if (!latest) return null;
  const since = new Date(Date.parse(latest.checked_at) - DAY_MS).toISOString();
  const base = db.prepare(`SELECT * FROM ${table} WHERE ${keyColumn} = ? AND checked_at <= ? ORDER BY checked_at DESC LIMIT 1`).get(key, since)
    || db.prepare(`SELECT * FROM ${table} WHERE ${keyColumn} = ? ORDER BY checked_at ASC LIMIT 1`).get(key);
  return { latest, base };
}

function summary() {
  const videos = posts().map((post) => {
    const found = latestWithChange('post_stats', 'publication_id', post.id);
    const latest = found?.latest || {};
    const change = (field) => found && latest[field] != null && found.base[field] != null ? latest[field] - found.base[field] : null;
    return {
      publicationId: post.id, jobId: post.job_id, url: post.post_url, handle: handleOf(post.post_url), topic: post.topic_name || '',
      title: (post.caption || post.title || '').replace(/\s+#\S+/g, '').slice(0, 120), postedAt: post.created_at,
      views: latest.views ?? null, likes: latest.likes ?? null, comments: latest.comments ?? null, shares: latest.shares ?? null, saves: latest.saves ?? null,
      viewsChange: change('views'), checkedAt: latest.checked_at || null
    };
  });
  const handles = [...new Set(videos.map((video) => video.handle).filter(Boolean))];
  const topicOf = (handle) => videos.find((video) => video.handle === handle && video.topic)?.topic || '';
  const channels = handles.map((handle) => {
    const found = latestWithChange('channel_stats', 'handle', handle);
    const own = videos.filter((video) => video.handle === handle);
    const views = own.reduce((total, video) => total + (video.views || 0), 0);
    return {
      handle, topic: topicOf(handle), followers: found?.latest.followers ?? null,
      followersChange: found && found.latest.followers != null && found.base.followers != null ? found.latest.followers - found.base.followers : null,
      totalLikes: found?.latest.likes ?? null, tiktokVideos: found?.latest.videos ?? null,
      posts: own.length, views, avgViews: own.length ? Math.round(views / own.length) : 0
    };
  });
  return { running, lastRun, lastError, channels, videos };
}

function start() {
  const timer = setInterval(() => {
    if (!running && (!lastRun || Date.now() - Date.parse(lastRun) >= REFRESH_MS) && posts().length) {
      refresh().catch((error) => console.error(`[Thống kê] ${error.message}`));
    }
  }, 5 * 60 * 1000);
  timer.unref();
}

module.exports = { refresh, summary, start, running: () => running };
