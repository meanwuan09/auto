const path = require('path');
const { spawn } = require('child_process');
const { db } = require('../db');

const ROOT = path.join(__dirname, '..', '..');
const PYTHON = process.env.DOUYIN_PYTHON || path.join(ROOT, 'third_party', 'luno-automation', 'backend', '.venv', 'Scripts', 'python.exe');

const URL_PATTERN = /(?:https?:\/\/|www\.|s\.shopee\.vn\/|shope\.ee\/|shopee\.vn\/)[^\s]*/i;

function validateCaption(caption) {
  if (URL_PATTERN.test(String(caption || ''))) {
    throw new Error('Link chỉ được đặt trong bình luận, không đặt trong caption');
  }
}

function commentForPublication(publicationId) {
  const row = db.prepare(`SELECT id, mode, status, comment_status, comment_url
    FROM reup_publications WHERE id = ?`).get(publicationId);
  if (!row) throw new Error('Không có lượt đăng');
  if (row.mode !== 'schedule' || row.status !== 'done') throw new Error('Video chưa được đăng thật');
  if (!row.comment_url) throw new Error('Lượt đăng chưa có link affiliate');
  if (!['pending', 'posted'].includes(row.comment_status)) throw new Error('Bình luận chưa sẵn sàng');
  return { publicationId: row.id, comment: row.comment_url, status: row.comment_status };
}

function markCommentPosted(publicationId) {
  const item = commentForPublication(publicationId);
  if (item.status === 'posted') return item;
  db.prepare(`UPDATE reup_publications SET comment_status = 'posted',
    comment_posted_at = CURRENT_TIMESTAMP WHERE id = ?`).run(publicationId);
  return { ...item, status: 'posted' };
}

function attachToPublication(publicationId) {
  const row = db.prepare(`SELECT p.id, p.mode, p.status, p.comment_url,
    j.shopee_product_url, j.shopee_affiliate_url
    FROM reup_publications p JOIN reup_jobs j ON j.id = p.job_id
    WHERE p.id = ?`).get(publicationId);
  if (!row || row.mode !== 'schedule' || row.status !== 'done') {
    throw new Error('Cần một bài đã đăng thật');
  }
  if (!row.shopee_product_url || !row.shopee_affiliate_url) {
    throw new Error('Cần lưu sản phẩm phù hợp và Custom Link trước');
  }
  if (row.comment_url) throw new Error('Bài đăng đã có link bình luận');
  db.prepare(`UPDATE reup_publications SET comment_url = ?, comment_status = 'pending'
    WHERE id = ? AND comment_url = ''`).run(row.shopee_affiliate_url, publicationId);
  return commentForPublication(publicationId);
}

function tiktokPostUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('Link bài TikTok không hợp lệ'); }
  const match = url.pathname.match(/^\/@[\w.]+\/video\/\d+\/?$/);
  if (url.protocol !== 'https:' || !['www.tiktok.com', 'tiktok.com'].includes(url.hostname) || !match) {
    throw new Error('Link bài TikTok phải có dạng https://www.tiktok.com/@tai_khoan/video/ID');
  }
  return `https://www.tiktok.com${url.pathname.replace(/\/$/, '')}`;
}

function savePostUrl(publicationId, value) {
  const row = db.prepare('SELECT platform, mode, status FROM reup_publications WHERE id = ?').get(publicationId);
  if (!row) throw new Error('Không có lượt đăng');
  if (row.platform !== 'tiktok' || row.mode !== 'schedule' || row.status !== 'done') throw new Error('Chỉ lưu link cho bài TikTok đã đăng thật');
  const url = tiktokPostUrl(value);
  db.prepare('UPDATE reup_publications SET post_url = ? WHERE id = ?').run(url, publicationId);
  return { publicationId: Number(publicationId), postUrl: url };
}

let running = null;

function commentRunning() {
  return running ? { publicationId: running.publicationId, verification: running.verification } : null;
}

// Runs scripts/open_tiktok_comment.py, which sends at most once, reloads to confirm the comment
// is visible and only then marks the publication posted.
function runComment(publicationId, { browser } = {}) {
  if (running) throw new Error(`Đang bình luận cho lượt đăng #${running.publicationId}`);
  if (db.prepare("SELECT id FROM reup_publications WHERE status = 'running' LIMIT 1").get()) {
    throw new Error('Đợi lượt đăng hiện tại hoàn tất trước khi bình luận');
  }
  const item = commentForPublication(publicationId);
  if (item.status !== 'pending') throw new Error('Bình luận đã được xác nhận');
  const row = db.prepare(`SELECT p.platform, p.post_url, COALESCE(NULLIF(j.account_profile, ''), t.roxy_profile_id) AS roxy_profile_id FROM reup_publications p
    JOIN reup_jobs j ON j.id = p.job_id LEFT JOIN topics t ON t.id = j.topic_id WHERE p.id = ?`).get(publicationId);
  if (row.platform !== 'tiktok') throw new Error('Tự bình luận hiện chỉ hỗ trợ TikTok');
  if (!row.post_url) throw new Error('Lưu link bài TikTok trước khi bình luận');
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  // Comment from the same Roxy profile (TikTok account) that posted the topic's video.
  if (row.roxy_profile_id) env.ROXY_PROFILE_ID = row.roxy_profile_id;
  if (browser) {
    if (!['chrome', 'roxy'].includes(browser)) throw new Error('Trình duyệt phải là chrome hoặc roxy');
    env.TIKTOK_BROWSER = browser;
  }
  db.prepare("UPDATE reup_publications SET comment_error = '' WHERE id = ?").run(publicationId);
  const child = spawn(PYTHON, ['-X', 'utf8', path.join(ROOT, 'scripts', 'open_tiktok_comment.py'), String(item.publicationId), row.post_url, '--wait-for-verification'],
    { cwd: ROOT, env, windowsHide: true });
  running = { publicationId: item.publicationId, verification: false };
  const output = [];
  const collect = (chunk) => {
    const text = chunk.toString();
    output.push(text);
    if (text.includes('MANUAL_VERIFICATION_REQUIRED') && running) running.verification = true;
    if (text.includes('MANUAL_VERIFICATION_CLEARED') && running) running.verification = false;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const finish = (code, error) => {
    running = null;
    if (code === 0) return;
    const lines = output.join('').trim().split(/\r?\n/);
    const reason = error?.message || lines.reverse().find((line) => line.includes('COMMENT_NOT_CONFIRMED')) || lines[0] || `exit ${code}`;
    db.prepare('UPDATE reup_publications SET comment_error = ? WHERE id = ?').run(reason.replace('COMMENT_NOT_CONFIRMED: ', '').slice(0, 500), item.publicationId);
  };
  child.on('error', (error) => finish(1, error));
  child.on('close', (code) => finish(code));
  return { publicationId: item.publicationId, started: true };
}

module.exports = { validateCaption, commentForPublication, markCommentPosted, attachToPublication, tiktokPostUrl, savePostUrl, runComment, commentRunning };
