const fs = require('fs');
const path = require('path');
const { db, getSettings, setSetting } = require('../db');

const ROOT = path.join(__dirname, '..', '..');
const MEDIA = process.env.REUP_MEDIA_DIR || path.join(ROOT, 'media', 'reup');
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULTS = { keep_after_post_days: '3', stale_days: '7', candidate_days: '14' };

const reupColumns = new Set(db.prepare('PRAGMA table_info(reup_jobs)').all().map((column) => column.name));
if (!reupColumns.has('media_cleaned_at')) db.exec("ALTER TABLE reup_jobs ADD COLUMN media_cleaned_at TEXT NOT NULL DEFAULT ''");

let lastResult = null;

function config() {
  const settings = getSettings();
  const value = (key) => Number(settings[`cleanup_${key}`] ?? DEFAULTS[key]);
  return { keepAfterPostDays: value('keep_after_post_days'), staleDays: value('stale_days'), candidateDays: value('candidate_days') };
}

function saveConfig(body) {
  for (const [key, field] of [['keep_after_post_days', 'keepAfterPostDays'], ['stale_days', 'staleDays'], ['candidate_days', 'candidateDays']]) {
    if (body[field] === undefined) continue;
    const days = Number(body[field]);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('Số ngày phải từ 1 đến 90');
    setSetting(`cleanup_${key}`, String(days));
  }
  return status();
}

function sizeOf(target) {
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return stat.size;
    return fs.readdirSync(target).reduce((total, name) => total + sizeOf(path.join(target, name)), 0);
  } catch { return 0; }
}

function remove(target) {
  const size = sizeOf(target);
  if (!size) return 0;
  fs.rmSync(target, { recursive: true, force: true });
  return size;
}

// Media of one job. Translations and OCR (small JSON) are kept so a post can still be traced.
function heavyFiles(id) {
  const names = fs.existsSync(MEDIA) ? fs.readdirSync(MEDIA) : [];
  return names.filter((name) => name.startsWith(`${id}-`) && !name.endsWith('.json') && !name.endsWith('.srt') && !name.endsWith('.ass'))
    .map((name) => path.join(MEDIA, name));
}

function run(now = Date.now()) {
  const { keepAfterPostDays, staleDays, candidateDays } = config();
  let freed = 0;
  const cleaned = [];
  // Never touch a job that is being processed or posted right now.
  const busy = new Set(db.prepare("SELECT id FROM reup_jobs WHERE status IN ('queued', 'downloading', 'dubbing')").all().map((row) => row.id)
    .concat(db.prepare("SELECT job_id AS id FROM reup_publications WHERE status = 'running'").all().map((row) => row.id)));

  // 1. Vocal-separation intermediates are never read again once the dubbed video exists.
  for (const job of db.prepare("SELECT id FROM reup_jobs WHERE dubbed_path != ''").all()) {
    if (busy.has(job.id)) continue;
    for (const suffix of ['-vi-background-original.wav', '-vi-background-vocals.wav']) freed += remove(path.join(MEDIA, `${job.id}${suffix}`));
  }

  // 2. Posted videos live on TikTok; after the grace period their local media can go.
  const posted = db.prepare(`SELECT j.id, MAX(p.created_at) AS posted_at FROM reup_jobs j JOIN reup_publications p ON p.job_id = j.id
    WHERE p.platform = 'tiktok' AND p.mode = 'schedule' AND p.status = 'done' AND j.media_cleaned_at = '' GROUP BY j.id`).all();
  for (const job of posted) {
    if (busy.has(job.id) || now - Date.parse(`${job.posted_at}Z`) < keepAfterPostDays * DAY_MS) continue;
    const size = heavyFiles(job.id).reduce((total, file) => total + remove(file), 0);
    db.prepare('UPDATE reup_jobs SET media_cleaned_at = ? WHERE id = ?').run(new Date(now).toISOString(), job.id);
    freed += size;
    cleaned.push(job.id);
  }

  // 3. Failed or never-approved videos left untouched for too long.
  const stale = db.prepare(`SELECT j.id, j.created_at FROM reup_jobs j WHERE j.media_cleaned_at = '' AND j.approved = 0
    AND j.status IN ('failed', 'source_ready', 'review')
    AND NOT EXISTS (SELECT 1 FROM reup_publications p WHERE p.job_id = j.id AND p.status IN ('running', 'done'))`).all();
  for (const job of stale) {
    if (busy.has(job.id) || now - Date.parse(`${job.created_at}Z`) < staleDays * DAY_MS) continue;
    const size = heavyFiles(job.id).reduce((total, file) => total + remove(file), 0);
    db.prepare("UPDATE reup_jobs SET media_cleaned_at = ?, error = CASE WHEN error = '' THEN 'Đã dọn video lâu không dùng' ELSE error END WHERE id = ?")
      .run(new Date(now).toISOString(), job.id);
    freed += size;
    cleaned.push(job.id);
  }

  // 4. Old Douyin suggestions nobody picked.
  const cutoff = new Date(now - candidateDays * DAY_MS).toISOString();
  const candidates = db.prepare("DELETE FROM douyin_candidates WHERE status IN ('new', 'dismissed') AND observed_at < ?").run(cutoff).changes;

  lastResult = { at: new Date(now).toISOString(), freedBytes: freed, jobs: cleaned, candidates };
  setSetting('cleanup_last_result', JSON.stringify(lastResult));
  if (freed || candidates) console.log(`[Dọn dẹp] giải phóng ${(freed / 1048576).toFixed(0)} MB, ${cleaned.length} video, ${candidates} đề xuất cũ`);
  return status();
}

function busyJobs() {
  return new Set(db.prepare("SELECT id FROM reup_jobs WHERE status IN ('queued', 'downloading', 'dubbing')").all().map((row) => row.id)
    .concat(db.prepare("SELECT job_id AS id FROM reup_publications WHERE status = 'running'").all().map((row) => row.id)));
}

function allFiles(id) {
  const names = fs.existsSync(MEDIA) ? fs.readdirSync(MEDIA) : [];
  return names.filter((name) => name.startsWith(`${id}-`)).map((name) => path.join(MEDIA, name));
}

// Everything the "Dọn dẹp" tab lists: posted videos, failed/abandoned ones, and database totals.
function items() {
  const latestViews = db.prepare(`SELECT s.views FROM post_stats s WHERE s.publication_id = ? ORDER BY s.checked_at DESC LIMIT 1`);
  const posted = db.prepare(`SELECT j.id, j.title, j.caption, j.media_cleaned_at, t.name AS topic, MAX(p.created_at) AS posted_at,
      MAX(p.post_url) AS post_url, MAX(p.id) AS publication_id
    FROM reup_jobs j JOIN reup_publications p ON p.job_id = j.id LEFT JOIN topics t ON t.id = j.topic_id
    WHERE p.platform = 'tiktok' AND p.mode = 'schedule' AND p.status = 'done' GROUP BY j.id ORDER BY posted_at DESC`).all()
    .map((job) => ({ ...job, title: (job.caption || job.title || '').replace(/\s+#\S+/g, '').slice(0, 100),
      bytes: heavyFiles(job.id).reduce((total, file) => total + sizeOf(file), 0),
      views: latestViews.get(job.publication_id)?.views ?? null, handle: String(job.post_url || '').match(/@([\w.]+)/)?.[1] || '' }));
  const abandoned = db.prepare(`SELECT j.id, j.title, j.status, j.error, j.created_at, t.name AS topic FROM reup_jobs j LEFT JOIN topics t ON t.id = j.topic_id
    WHERE (j.status = 'failed' OR j.media_cleaned_at != '' OR (j.approved = 0 AND j.created_at < datetime('now', '-3 days')))
    AND NOT EXISTS (SELECT 1 FROM reup_publications p WHERE p.job_id = j.id AND p.status IN ('running', 'done'))
    ORDER BY j.id DESC`).all()
    .map((job) => ({ ...job, title: (job.title || '').slice(0, 100), bytes: heavyFiles(job.id).reduce((total, file) => total + sizeOf(file), 0) }));
  const count = (sql) => db.prepare(sql).get().n;
  return {
    ...status(), posted, abandoned,
    database: {
      jobs: count('SELECT count(*) n FROM reup_jobs'), publications: count('SELECT count(*) n FROM reup_publications'),
      candidates: count('SELECT count(*) n FROM douyin_candidates'), oldCandidates: count(`SELECT count(*) n FROM douyin_candidates WHERE status IN ('new', 'dismissed') AND observed_at < '${new Date(Date.now() - config().candidateDays * DAY_MS).toISOString()}'`),
      products: count('SELECT count(*) n FROM shopee_products'), statRows: count('SELECT count(*) n FROM post_stats')
    }
  };
}

function checkIds(jobIds) {
  if (!Array.isArray(jobIds) || !jobIds.length || jobIds.length > 500) throw new Error('Chọn ít nhất một video');
  const busy = busyJobs();
  const ids = [...new Set(jobIds.map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  const blocked = ids.filter((id) => busy.has(id));
  if (blocked.length) throw new Error(`Video đang xử lý hoặc đang đăng, chưa dọn được: ${blocked.map((id) => '#' + id).join(', ')}`);
  return ids;
}

// Remove the heavy media of chosen videos; the record, translation and statistics stay.
function removeMedia(jobIds) {
  const ids = checkIds(jobIds);
  let freed = 0;
  for (const id of ids) {
    freed += heavyFiles(id).reduce((total, file) => total + remove(file), 0);
    db.prepare('UPDATE reup_jobs SET media_cleaned_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }
  return { freedBytes: freed, jobs: ids.length };
}

// Remove chosen videos entirely: every file and their rows (job, publications, statistics).
// The Douyin suggestion they came from is dismissed so it is not picked again.
function removeRecords(jobIds) {
  const ids = checkIds(jobIds);
  let freed = 0;
  db.exec('BEGIN');
  try {
    for (const id of ids) {
      freed += allFiles(id).reduce((total, file) => total + remove(file), 0);
      db.prepare('DELETE FROM post_stats WHERE publication_id IN (SELECT id FROM reup_publications WHERE job_id = ?)').run(id);
      db.prepare('DELETE FROM reup_publications WHERE job_id = ?').run(id);
      db.prepare("UPDATE douyin_candidates SET status = 'dismissed', job_id = NULL WHERE job_id = ?").run(id);
      db.prepare('DELETE FROM reup_jobs WHERE id = ?').run(id);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { freedBytes: freed, jobs: ids.length };
}

function removeOldCandidates() {
  const cutoff = new Date(Date.now() - config().candidateDays * DAY_MS).toISOString();
  return { candidates: db.prepare("DELETE FROM douyin_candidates WHERE status IN ('new', 'dismissed') AND observed_at < ?").run(cutoff).changes };
}

function status() {
  if (!lastResult) { try { lastResult = JSON.parse(getSettings().cleanup_last_result || 'null'); } catch {} }
  return { ...config(), mediaBytes: sizeOf(MEDIA), last: lastResult };
}

function start() {
  setTimeout(() => { try { run(); } catch (error) { console.error(`[Dọn dẹp] ${error.message}`); } }, 60000).unref();
  setInterval(() => { try { run(); } catch (error) { console.error(`[Dọn dẹp] ${error.message}`); } }, 6 * 60 * 60 * 1000).unref();
}

module.exports = { config, saveConfig, run, status, start, heavyFiles, items, removeMedia, removeRecords, removeOldCandidates };
