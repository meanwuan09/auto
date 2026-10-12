const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');
const { db } = require('../db');
const { normalizeDouyinUrl } = require('./douyin-source');
const { validateCaption } = require('./affiliate-comment');
const activity = require('./activity');

const ROOT = path.join(__dirname, '..', '..');
const MEDIA = process.env.REUP_MEDIA_DIR || path.join(ROOT, 'media', 'reup');
fs.mkdirSync(MEDIA, { recursive: true });

const endpoints = {
  dtk: process.env.DTK_BASE_URL || 'http://127.0.0.1:8080',
  videoLingo: process.env.VIDEOLINGO_BASE_URL || 'http://127.0.0.1:8000',
  luno: process.env.LUNO_BASE_URL || 'http://127.0.0.1:8756'
};
const active = new Set();
const REQUIRED_TAGS = ['#viral', '#xuhuong'];

// Douyin titles of AI-made clips carry tags like #AI萌宠, #AIGC, #即梦AI or 可灵; TikTok requires
// such videos to carry its "AI-generated content" label.
const AI_CONTENT = /(^|[^a-z])ai(?![a-z])|aigc|即梦|可灵|人工智能|ai生成|ai创作/i;
function isAiContent(job) {
  return AI_CONTENT.test(`${job.title || ''} ${job.source_title || ''}`);
}

function withRequiredTags(caption) {
  const text = String(caption || '').trim();
  const missing = REQUIRED_TAGS.filter((tag) => !new RegExp(`(^|\\s)${tag}(?=\\s|$)`, 'i').test(text));
  return [text, ...missing].filter(Boolean).join(' ');
}
let dubbing = false;
let downloading = false;
const DOWNLOAD_PYTHON = process.env.DOUYIN_PYTHON || path.join(ROOT, 'third_party', 'luno-automation', 'backend', '.venv', 'Scripts', 'python.exe');

function localDownloaderReady() {
  return [DOWNLOAD_PYTHON, path.join(ROOT, 'tools', 'yt-dlp.exe'), path.join(ROOT, 'tools', 'ffmpeg.exe')].every((file) => fs.existsSync(file));
}

function enqueueImports(inputs, title = '', topicId = null) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 50) throw new Error('Nhập từ 1 đến 50 link video');
  const urls = [...new Set(inputs.map(normalizeDouyinUrl))];
  const ids = [], skipped = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const known = new Map();
    for (const item of db.prepare('SELECT id, source_url FROM reup_jobs ORDER BY id').all()) {
      try { known.set(normalizeDouyinUrl(item.source_url), item.id); } catch {}
    }
    for (const url of urls) {
      if (known.has(url)) { skipped.push(known.get(url)); continue; }
      ids.push(Number(db.prepare("INSERT INTO reup_jobs (source_url, rights_confirmed, title, status, topic_id) VALUES (?, 1, ?, 'queued', ?)").run(url, String(title).trim().slice(0, 200), topicId ?? null).lastInsertRowid));
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  setImmediate(drainDownloads);
  return { ids, skipped, status: 'queued' };
}

async function drainDownloads() {
  if (downloading) return;
  downloading = true;
  try {
    let next;
    while ((next = db.prepare("SELECT id FROM reup_jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get())) {
      db.prepare("UPDATE reup_jobs SET status = 'downloading', error = '' WHERE id = ?").run(next.id);
      await importDouyin(next.id);
      const done = job(next.id);
      if (done?.auto_prepare && done.status === 'source_ready') require('./translation').enqueueExtract(done.id);
    }
  } finally { downloading = false; }
}

function downloadLocal(current, destination) {
  return new Promise((resolve, reject) => {
    const child = spawn(DOWNLOAD_PYTHON, [path.join(ROOT, 'scripts', 'download_douyin.py'), current.source_url, destination], { cwd: ROOT, windowsHide: true });
    let detail = '';
    const timeout = setTimeout(() => { child.kill(); }, 10 * 60 * 1000);
    child.stdout.on('data', (chunk) => {
      console.log(`[Douyin #${current.id}] ${chunk.toString().trim()}`);
      activity.set(`download-${current.id}`, `Tải video #${current.id}`, activity.progressLine(chunk));
    });
    child.stderr.on('data', (chunk) => { detail = (detail + chunk.toString()).slice(-1500); });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`Tải Douyin thất bại: ${detail || 'quá thời gian hoặc tiến trình bị dừng'}`));
      try {
        const metadata = JSON.parse(fs.readFileSync(destination.replace(/\.mp4$/i, '.download.json'), 'utf8'));
        if (!fs.existsSync(destination) || !fs.statSync(destination).size) throw new Error('Không có file video');
        resolve(metadata);
      } catch (error) { reject(error); }
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const job = (id) => db.prepare('SELECT * FROM reup_jobs WHERE id = ?').get(id);

function base(name) {
  const url = new URL(endpoints[name]);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(`${name} phải chạy trên localhost`);
  }
  return url.origin;
}

async function serviceStatus() {
  const checks = [
    ['dtk', '/readyz'], ['videoLingo', '/status'], ['luno', '/health']
  ];
  const status = Object.fromEntries(await Promise.all(checks.map(async ([name, route]) => {
    try {
      const response = await fetch(base(name) + route, { signal: AbortSignal.timeout(1500) });
      return [name, response.ok];
    } catch {
      return [name, false];
    }
  })));
  status.douyinLocal = localDownloaderReady();
  return status;
}

async function request(name, route, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
  if (name === 'dtk' && process.env.DTK_API_KEY) headers['X-API-Key'] = process.env.DTK_API_KEY;
  const labels = { dtk: 'Douyin API', videoLingo: 'VideoLingo', luno: 'LUNO' };
  let response;
  try {
    response = await fetch(base(name) + route, {
      ...options,
      headers: { ...headers, ...options.headers },
      signal: AbortSignal.timeout(20000)
    });
  } catch (error) {
    // Node reports a refused connection as a bare "fetch failed"; name the service that is down.
    throw new Error(`${labels[name] || name} chưa chạy hoặc không kết nối được (${base(name)})`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${name} HTTP ${response.status}: ${detail.slice(0, 250)}`);
  }
  const data = await response.json();
  if (name === 'dtk' && data.success === false) {
    throw new Error(`Douyin API: ${data.error?.message || data.error?.code || 'thất bại'}`);
  }
  return name === 'dtk' ? data.data : data;
}

async function saveFile(name, route, dest) {
  const headers = name === 'dtk' && process.env.DTK_API_KEY ? { 'X-API-Key': process.env.DTK_API_KEY } : {};
  const response = await fetch(base(name) + route, { headers, signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw new Error(`${name} không trả file (${response.status})`);
  const temp = dest + '.part';
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temp));
    if (fs.statSync(temp).size === 0) throw new Error('File tải về rỗng');
    fs.renameSync(temp, dest);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

async function poll(name, route, isDone, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await request(name, route);
    const result = isDone(state);
    if (result === true) return state;
    if (typeof result === 'string') throw new Error(result);
    await sleep(2000);
  }
  throw new Error(`${name} quá thời gian chờ; kiểm tra dịch vụ trước khi thử lại`);
}

async function importDouyin(id) {
  if (active.has(id)) throw new Error('Video đang được xử lý');
  active.add(id);
  try {
    const current = job(id);
    if (!current || !current.rights_confirmed) throw new Error('Chưa có video hoặc quyền sử dụng');
    const mode = process.env.DOUYIN_DOWNLOAD_MODE || 'auto';
    let useApi = mode === 'api';
    if (mode === 'auto') {
      try { useApi = (await fetch(base('dtk') + '/readyz', { signal: AbortSignal.timeout(1500) })).ok; }
      catch { useApi = false; }
    }
    if (!useApi) {
      if (!localDownloaderReady()) throw new Error('Chưa cài bộ tải Douyin local');
      const destination = path.join(MEDIA, `${id}-source.mp4`);
      const metadata = await downloadLocal(current, destination);
      db.prepare("UPDATE reup_jobs SET source_path = ?, title = CASE WHEN title = '' THEN ? ELSE title END, status = 'source_ready', error = '' WHERE id = ?").run(destination, metadata.title || '', id);
      return;
    }
    const parsed = await request('dtk', '/api/v1/parse', {
      method: 'POST', body: JSON.stringify({ url: current.source_url })
    });
    const task = await poll('dtk', `/api/v1/tasks/${encodeURIComponent(parsed.task_id)}`,
      (item) => item.state === 'done' ? true : item.state === 'failed' ? (item.error?.message || 'Không phân tích được link') : false,
      120000);
    const post = task.data?.result || task.data;
    if (post?.platform !== 'douyin' || !post?.content_id) throw new Error('Link không dẫn tới một video Douyin');
    const started = await request('dtk', '/api/v1/downloads', {
      method: 'POST', body: JSON.stringify({ platform: 'douyin', content_id: String(post.content_id), skip_existing: true })
    });
    const download = await poll('dtk', `/api/v1/downloads/${encodeURIComponent(started.download_id)}`,
      (item) => item.state === 'done' ? true : ['failed', 'cancelled', 'partial'].includes(item.state) ? (item.error || `Tải video: ${item.state}`) : false,
      300000);
    const video = download.files?.find((file) => file.kind === 'video' && file.name?.toLowerCase().endsWith('.mp4'));
    if (!video) throw new Error('Douyin API không trả video MP4');
    const dest = path.join(MEDIA, `${id}-source.mp4`);
    await saveFile('dtk', `/api/v1/downloads/${encodeURIComponent(started.download_id)}/files/${encodeURIComponent(video.name)}`, dest);
    db.prepare("UPDATE reup_jobs SET source_path = ?, status = 'source_ready', error = '' WHERE id = ?").run(dest, id);
  } catch (error) {
    db.prepare("UPDATE reup_jobs SET status = 'failed', error = ? WHERE id = ?").run(error.message, id);
    console.error(`[reup #${id}] ${error.message}`);
  } finally {
    active.delete(id);
    activity.clear(`download-${id}`);
  }
}

async function dubVietnamese(id) {
  if (dubbing || active.has(id)) throw new Error('VideoLingo đang xử lý video khác');
  const current = job(id);
  if (!current?.source_path || !fs.existsSync(current.source_path)) throw new Error('Chưa có video nguồn');
  dubbing = true;
  active.add(id);
  db.prepare("UPDATE reup_jobs SET status = 'dubbing', error = '' WHERE id = ?").run(id);
  try {
    const translation = path.join(MEDIA, `${id}-reviewed-vi.json`);
    const python = path.join(ROOT, 'data', 'dub-venv', 'Scripts', 'python.exe');
    if (fs.existsSync(translation) && fs.existsSync(python)) {
      const dest = path.join(MEDIA, `${id}-vi.mp4`);
      activity.set(`dub-${id}`, `Lồng tiếng video #${id}`, 'Tách giọng gốc…');
      await renderReviewed(python, current.source_path, translation, dest, (line) => activity.set(`dub-${id}`, `Lồng tiếng video #${id}`, line));
      db.prepare("UPDATE reup_jobs SET dubbed_path = ?, status = 'review', approved = 0, error = '' WHERE id = ?").run(dest, id);
      return;
    }
    const existing = await request('videoLingo', '/status').catch((error) => {
      throw new Error(`Chưa có bản dịch đã duyệt (${id}-reviewed-vi.json) và ${error.message}`);
    });
    if (existing.active || existing.state === 'paused') throw new Error('VideoLingo đang bận');
    await request('videoLingo', '/input', {
      method: 'POST', body: JSON.stringify({ source: current.source_path.replace(/\\/g, '/'), existing: 'archive' })
    });
    await poll('videoLingo', '/status', (state) => state.active ? false : state.state === 'completed' ? true : state.state === 'error' ? (state.error || 'Lỗi nhập video') : false, 180000);
    await request('videoLingo', '/run', {
      method: 'POST', body: JSON.stringify({ stage: 'all', source_language: 'zh', target_language: 'Tiếng Việt', dubbing: true })
    });
    const result = await poll('videoLingo', '/status', (state) => state.active ? false : state.state === 'completed' ? true : ['error', 'paused', 'stopped'].includes(state.state) ? (state.error || state.pause_message || `VideoLingo: ${state.state}`) : false, 1800000);
    if (!result.files?.includes('output_dub.mp4')) throw new Error('VideoLingo chưa tạo output_dub.mp4');
    const dest = path.join(MEDIA, `${id}-vi.mp4`);
    await saveFile('videoLingo', '/files/output_dub.mp4', dest);
    db.prepare("UPDATE reup_jobs SET dubbed_path = ?, status = 'review', approved = 0, error = '' WHERE id = ?").run(dest, id);
  } catch (error) {
    db.prepare("UPDATE reup_jobs SET status = 'failed', error = ? WHERE id = ?").run(error.message, id);
    console.error(`[reup #${id}] ${error.message}`);
  } finally {
    active.delete(id);
    dubbing = false;
    activity.clear(`dub-${id}`);
  }
}

function renderReviewed(python, source, translation, destination, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(ROOT, 'scripts', 'dub_reviewed.py'), source, translation, destination, '--reuse-audio'], {
      cwd: ROOT, windowsHide: true
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      console.log(`[Vietnamese TTS] ${chunk.toString().trim()}`);
      onProgress(activity.progressLine(chunk));
    });
    child.stderr.on('data', (chunk) => { output = (output + chunk.toString()).slice(-2000); });
    child.on('error', reject);
    // stderr ends with progress bars; report the actual Python error line when there is one.
    const reason = () => output.split(/\r?\n/).reverse().find((line) => /^[A-Za-z_][\w.]*(Error|Exception|Received|Timeout)\b.*: /.test(line.trim()))?.trim() || output.slice(-300);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Lồng tiếng lỗi: ${reason()}`)));
  });
}

function watchBatch(publicationId, batchId) {
  return new Promise((resolve, reject) => {
    const endpoint = base('luno').replace(/^http/, 'ws') + `/ws/batch/${encodeURIComponent(batchId)}`;
    const ws = new WebSocket(endpoint);
    let completed = false;
    const timer = setTimeout(() => { ws.close(); reject(new Error('LUNO quá thời gian chờ')); }, 1200000);
    ws.addEventListener('message', (message) => {
      let event;
      try { event = JSON.parse(message.data); } catch { return; }
      const steps = { upload: 'Đã tải video lên', caption: 'Đã điền caption', hashtags: 'Đã thêm hashtag', cover: 'Đã chọn ảnh bìa', product_link: 'Đã gắn sản phẩm', schedule: 'Chuẩn bị đăng', music: 'Đã thêm nhạc' };
      if (event.type === 'video_start') activity.set(`publish-${publicationId}`, `Đăng bài (lượt #${publicationId})`, 'Mở TikTok Studio, tải video…');
      if (event.type === 'step') activity.set(`publish-${publicationId}`, `Đăng bài (lượt #${publicationId})`, steps[event.step] || event.step);
      if (event.type === 'fatal' || (event.type === 'video_done' && event.status === 'failed')) {
        completed = true;
        clearTimeout(timer);
        ws.close();
        reject(new Error(event.error || event.message || 'LUNO đăng thất bại'));
      } else if (event.type === 'video_done' && event.status === 'success') {
        completed = true;
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
    ws.addEventListener('error', () => { if (!completed) { clearTimeout(timer); reject(new Error('Mất kết nối LUNO')); } });
    ws.addEventListener('close', () => { if (!completed) { clearTimeout(timer); reject(new Error('LUNO đóng kết nối trước khi trả kết quả')); } });
  });
}

// LUNO hands the file to a Roxy browser over CDP, which cannot transfer files above 50 MB.
const UPLOAD_LIMIT = 45 * 1024 * 1024;
function uploadableVideo(file) {
  if (fs.statSync(file).size <= UPLOAD_LIMIT) return Promise.resolve(file);
  const target = file.replace(/\.mp4$/i, '-upload.mp4');
  if (fs.existsSync(target) && fs.statSync(target).mtimeMs >= fs.statSync(file).mtimeMs && fs.statSync(target).size <= UPLOAD_LIMIT) return Promise.resolve(target);
  return new Promise((resolve, reject) => {
    const ffmpeg = path.join(ROOT, 'tools', 'ffmpeg.exe');
    const probe = spawn(ffmpeg, ['-i', file], { windowsHide: true });
    let info = '';
    probe.stderr.on('data', (chunk) => { info += chunk.toString(); });
    probe.on('close', () => {
      const [, h, m, sec] = info.match(/Duration: (\d+):(\d+):([\d.]+)/) || [0, 0, 0, 60];
      const duration = Number(h) * 3600 + Number(m) * 60 + Number(sec);
      const kbps = Math.max(1200, Math.floor(40 * 8192 / Math.max(duration, 1)) - 160);
      const child = spawn(ffmpeg, ['-y', '-i', file, '-c:v', 'libx264', '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
        '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', target], { windowsHide: true });
      child.on('error', reject);
      child.on('close', (code) => code === 0 && fs.statSync(target).size <= UPLOAD_LIMIT ? resolve(target) : reject(new Error('Không nén được video xuống dưới 45 MB để tải lên')));
    });
  });
}

async function publish(publicationId) {
  const row = db.prepare(`SELECT p.*, j.title, j.dubbed_path, j.caption, j.tiktok_product_id, j.shopee_product_query, j.shopee_product_id,
    COALESCE(NULLIF(j.account_profile, ''), t.roxy_profile_id) AS roxy_profile_id
    FROM reup_publications p JOIN reup_jobs j ON j.id = p.job_id LEFT JOIN topics t ON t.id = j.topic_id WHERE p.id = ?`).get(publicationId);
  try {
    const isTikTok = row.platform === 'tiktok';
    activity.set(`publish-${publicationId}`, `Đăng bài (lượt #${publicationId})`, 'Kiểm tra dung lượng video…');
    row.dubbed_path = await uploadableVideo(row.dubbed_path);
    const route = isTikTok ? '/batch/run' : '/shopee/batch/run';
    const videoJob = isTikTok
      ? { video_path: row.dubbed_path, caption: withRequiredTags(row.caption), ...(row.tiktok_product_id ? { product_id: row.tiktok_product_id } : {}), add_music: false, ai_generated: isAiContent(row) }
      : { video_path: row.dubbed_path, caption: row.caption, product_query: row.shopee_product_query, product_id: row.shopee_product_id };
    // Each topic posts from its own Roxy profile; jobs without a topic use the configured default.
    const account = isTikTok && row.roxy_profile_id ? { roxy_profile_id: row.roxy_profile_id } : {};
    const result = await request('luno', route, { method: 'POST', body: JSON.stringify({ mode: row.mode, jobs: [videoJob], ...account }) });
    db.prepare('UPDATE reup_publications SET batch_id = ? WHERE id = ?').run(result.batch_id, publicationId);
    await watchBatch(publicationId, result.batch_id);
    db.prepare("UPDATE reup_publications SET status = 'done', comment_status = CASE WHEN mode = 'schedule' AND comment_url != '' THEN 'pending' ELSE 'none' END, error = '' WHERE id = ?").run(publicationId);
  } catch (error) {
    db.prepare("UPDATE reup_publications SET status = 'failed', error = ? WHERE id = ?").run(error.message, publicationId);
    console.error(`[reup publish #${publicationId}] ${error.message}`);
  } finally {
    activity.clear(`publish-${publicationId}`);
  }
}

function startPublication(id, platform, mode) {
  const current = job(id);
  if (!current || !current.approved || current.status !== 'review' || !current.dubbed_path || !fs.existsSync(current.dubbed_path)) {
    throw new Error('Cần duyệt video lồng tiếng trước khi đăng');
  }
  if (!['tiktok', 'shopee'].includes(platform) || !['dry_run', 'draft', 'schedule'].includes(mode)) throw new Error('Nền tảng hoặc chế độ không hợp lệ');
  validateCaption(current.caption);
  if (!current.caption?.trim()) throw new Error('Cần caption trước khi đăng');
  if (platform === 'shopee' && (!current.shopee_product_query || !current.shopee_product_id)) throw new Error('Thiếu tên hoặc ID sản phẩm Shopee');
  const running = db.prepare("SELECT id FROM reup_publications WHERE status = 'running' LIMIT 1").get();
  if (running) throw new Error('LUNO đang xử lý lượt đăng khác');
  const result = db.prepare('INSERT INTO reup_publications (job_id, platform, mode, comment_url) VALUES (?, ?, ?, ?)').run(id, platform, mode, current.shopee_affiliate_url || '');
  const publicationId = Number(result.lastInsertRowid);
  setImmediate(() => publish(publicationId));
  return publicationId;
}

module.exports = { isAiContent, endpoints, base, job, importDouyin, enqueueImports, drainDownloads, dubVietnamese, startPublication, serviceStatus, withRequiredTags };
