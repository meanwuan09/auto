const { db, getSettings, setSetting } = require('../db');

const STATUSES = ['warming', 'active', 'paused'];
const BROWSERS = ['roxy'];
// An account is paused when its last few posts, each over a day old, all stayed under this many views.
const LOW_VIEWS = 30;
const LOW_VIEW_POSTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
// Older posts have no account_profile and were made from their topic's Roxy profile.
const OWNER = "COALESCE(NULLIF(j.account_profile, ''), t.roxy_profile_id)";

db.exec(`CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id),
  name TEXT NOT NULL DEFAULT '',
  browser TEXT NOT NULL DEFAULT 'roxy',
  profile_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  daily_limit INTEGER,
  pause_reason TEXT NOT NULL DEFAULT '',
  active_since TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
// Before accounts existed each topic posted from one Roxy profile; carry those over once.
if (getSettings().accounts_migrated !== '1') {
  db.exec("INSERT OR IGNORE INTO accounts (topic_id, name, profile_id, active_since) SELECT id, name, roxy_profile_id, '2000-01-01 00:00:00' FROM topics WHERE roxy_profile_id != ''");
  setSetting('accounts_migrated', '1');
}

const sqlTime = (date) => date.toISOString().replace('T', ' ').slice(0, 19);

function dayStart(now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return sqlTime(start);
}

// Scheduled TikTok posts made from a profile since the given SQLite UTC time, newest first.
function postsBy(profileId, since) {
  return db.prepare(`SELECT p.id, p.created_at FROM reup_publications p JOIN reup_jobs j ON j.id = p.job_id LEFT JOIN topics t ON t.id = j.topic_id
    WHERE ${OWNER} = ? AND p.platform = 'tiktok' AND p.mode = 'schedule' AND p.status IN ('running', 'done') AND p.created_at >= ?
    ORDER BY p.created_at DESC`).all(profileId, since);
}

function list(now = new Date()) {
  const since = dayStart(now);
  return db.prepare('SELECT a.*, t.name AS topic_name FROM accounts a JOIN topics t ON t.id = a.topic_id ORDER BY a.topic_id, a.id').all()
    .map((account) => {
      const today = postsBy(account.profile_id, since);
      const last = db.prepare(`SELECT MAX(p.created_at) AS at FROM reup_publications p JOIN reup_jobs j ON j.id = p.job_id LEFT JOIN topics t ON t.id = j.topic_id
        WHERE ${OWNER} = ? AND p.platform = 'tiktok' AND p.mode = 'schedule' AND p.status = 'done'`).get(account.profile_id).at;
      return { ...account, postedToday: today.length, lastPost: last };
    });
}

function active(topicId) {
  return db.prepare("SELECT * FROM accounts WHERE topic_id = ? AND status = 'active' ORDER BY id").all(topicId);
}

function activeTopics() {
  return db.prepare("SELECT * FROM topics WHERE id IN (SELECT topic_id FROM accounts WHERE status = 'active') ORDER BY id").all();
}

function save(body, id = null) {
  const current = id ? db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) : null;
  if (id && !current) throw new Error('Không có tài khoản này');
  const topicId = Number(body.topicId ?? current?.topic_id);
  if (!db.prepare('SELECT id FROM topics WHERE id = ?').get(topicId)) throw new Error('Chọn chủ đề cho tài khoản');
  const profileId = String(body.profileId ?? current?.profile_id ?? '').trim();
  if (!/^[A-Za-z0-9]{1,64}$/.test(profileId)) throw new Error('ID profile trình duyệt không hợp lệ');
  const taken = db.prepare('SELECT id FROM accounts WHERE profile_id = ? AND id != ?').get(profileId, id || 0);
  if (taken) throw new Error('Profile này đã gắn với một tài khoản khác');
  const name = String(body.name ?? current?.name ?? '').trim().slice(0, 80);
  const browser = String(body.browser ?? current?.browser ?? 'roxy');
  if (!BROWSERS.includes(browser)) throw new Error('Trình duyệt chưa hỗ trợ');
  const status = String(body.status ?? current?.status ?? 'warming');
  if (!STATUSES.includes(status)) throw new Error('Trạng thái không hợp lệ');
  const rawLimit = body.dailyLimit !== undefined ? body.dailyLimit : current?.daily_limit;
  const dailyLimit = rawLimit === null || rawLimit === '' || rawLimit === undefined ? null : Number(rawLimit);
  if (dailyLimit !== null && (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 6)) throw new Error('Số bài/ngày phải từ 1 đến 6');
  if (current && current.profile_id !== profileId && db.prepare("SELECT id FROM reup_publications WHERE status = 'running' LIMIT 1").get()) {
    throw new Error('Đang đăng bài — đổi profile sau khi lượt đăng xong');
  }
  // Views are judged only on posts made after the account was (re)activated.
  const activated = status === 'active' && current?.status !== 'active';
  if (current) {
    db.prepare(`UPDATE accounts SET topic_id = ?, name = ?, browser = ?, profile_id = ?, status = ?, daily_limit = ?,
      pause_reason = CASE WHEN ? = 'paused' THEN pause_reason ELSE '' END,
      active_since = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE active_since END WHERE id = ?`)
      .run(topicId, name, browser, profileId, status, dailyLimit, status, activated ? 1 : 0, id);
    return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  }
  const result = db.prepare('INSERT INTO accounts (topic_id, name, browser, profile_id, status, daily_limit) VALUES (?, ?, ?, ?, ?, ?)')
    .run(topicId, name, browser, profileId, status, dailyLimit);
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(result.lastInsertRowid));
}

function remove(id) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!account) throw new Error('Không có tài khoản này');
  // Videos waiting for this account go back to the topic's shared queue.
  db.prepare(`UPDATE reup_jobs SET account_profile = '' WHERE account_profile = ?
    AND NOT EXISTS (SELECT 1 FROM reup_publications p WHERE p.job_id = reup_jobs.id)`).run(account.profile_id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
}

// "Chạy trọn gói" can pick any Roxy profile; make sure it is known as an account of that topic.
function ensure(topicId, profileId) {
  db.prepare("INSERT OR IGNORE INTO accounts (topic_id, profile_id, status) VALUES (?, ?, 'active')").run(topicId, profileId);
}

// A stable offset (0..max-1 minutes) per account and day, so channels never post in lockstep.
function jitter(profileId, now, max) {
  let hash = 0;
  for (const char of `${profileId}:${now.toDateString()}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % max;
}

// Pause accounts whose recent posts get almost no views (likely restricted), so they stop burning videos.
function checkHealth(now = new Date()) {
  require('./stats'); // owns the post_stats table
  const dayAgo = sqlTime(new Date(now - DAY_MS));
  const paused = [];
  for (const account of db.prepare("SELECT * FROM accounts WHERE status = 'active'").all()) {
    const recent = db.prepare(`SELECT p.created_at,
        (SELECT s.views FROM post_stats s WHERE s.publication_id = p.id ORDER BY s.checked_at DESC LIMIT 1) AS views
      FROM reup_publications p JOIN reup_jobs j ON j.id = p.job_id LEFT JOIN topics t ON t.id = j.topic_id
      WHERE ${OWNER} = ? AND p.platform = 'tiktok' AND p.mode = 'schedule' AND p.status = 'done' AND p.post_url != '' AND p.created_at >= ?
      ORDER BY p.created_at DESC LIMIT ?`).all(account.profile_id, account.active_since, LOW_VIEW_POSTS);
    if (recent.length < LOW_VIEW_POSTS || !recent.every((post) => post.created_at <= dayAgo && post.views != null && post.views < LOW_VIEWS)) continue;
    const reason = `${LOW_VIEW_POSTS} bài gần nhất đều dưới ${LOW_VIEWS} view sau 24 giờ — kiểm tra Tình trạng tài khoản trong TikTok Studio`;
    db.prepare("UPDATE accounts SET status = 'paused', pause_reason = ? WHERE id = ?").run(reason, account.id);
    paused.push({ ...account, pause_reason: reason });
  }
  return paused;
}

module.exports = { list, active, activeTopics, save, remove, ensure, postsBy, dayStart, jitter, checkHealth, LOW_VIEWS };
