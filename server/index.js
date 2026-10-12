const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { db, getSettings, setSetting } = require('./db');
const adb = require('./services/adb');
const proc = require('./services/processor');
const poster = require('./services/poster');
const scheduler = require('./services/scheduler');
const reup = require('./services/reup');
const shopeeAffiliate = require('./services/shopee-affiliate');
const affiliateComment = require('./services/affiliate-comment');
const discovery = require('./services/douyin-discovery');
const tiktokAccount = require('./services/tiktok-account');
const shopeeProducts = require('./services/shopee-products');
const translation = require('./services/translation');
const autopilot = require('./services/autopilot');
const activity = require('./services/activity');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3210;
const RAW_DIR = path.join(__dirname, '..', 'media', 'raw');
const PROC_DIR = path.join(__dirname, '..', 'media', 'processed');
for (const d of [RAW_DIR, PROC_DIR]) fs.mkdirSync(d, { recursive: true });

const LOG_BUFFER = [];
const originalLog = console.log;
console.log = (...args) => {
  const msg = args.map(String).join(' ');
  LOG_BUFFER.push({ t: new Date().toISOString(), msg });
  if (LOG_BUFFER.length > 500) LOG_BUFFER.shift();
  io.emit('log', { t: LOG_BUFFER[LOG_BUFFER.length - 1].t, msg });
  originalLog(...args);
};
const originalError = console.error;
console.error = (...args) => {
  const msg = '[ERR] ' + args.map(String).join(' ');
  LOG_BUFFER.push({ t: new Date().toISOString(), msg });
  if (LOG_BUFFER.length > 500) LOG_BUFFER.shift();
  io.emit('log', { t: LOG_BUFFER[LOG_BUFFER.length - 1].t, msg });
  originalError(...args);
};

app.use(express.json({ limit: '10mb' }));
// Dashboard files change often; make browsers revalidate instead of running a stale app.js.
app.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
discovery.startScheduler();
autopilot.start();

app.get('/api/tiktok/account', async (req, res) => res.json(await tiktokAccount.status()));
app.post('/api/tiktok/login', async (req, res) => {
  try {
    if (db.prepare("SELECT id FROM reup_publications WHERE status = 'running' LIMIT 1").get()) return res.status(409).json({ error: 'Đợi lượt đăng hiện tại hoàn tất trước khi đăng nhập tài khoản khác' });
    const state = await tiktokAccount.status();
    if (!state.available) return res.status(503).json({ error: 'LUNO chưa sẵn sàng' });
    res.status(202).json(tiktokAccount.openLogin());
  } catch (error) { res.status(409).json({ error: error.message }); }
});
app.post('/api/tiktok/account/activate', async (req, res) => {
  if (db.prepare("SELECT id FROM reup_publications WHERE status = 'running' LIMIT 1").get()) return res.status(409).json({ error: 'Đợi lượt đăng hiện tại hoàn tất trước khi đổi tài khoản' });
  try { res.json(await tiktokAccount.activate(req.body?.id)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/douyin/discovery', (req, res) => res.json(discovery.snapshot()));
app.post('/api/douyin/discovery/sources', (req, res) => {
  try { res.json(discovery.addSource(req.body?.kind, req.body?.value, req.body?.rightsConfirmed, req.body?.topicId)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/api/douyin/discovery/sources/:id', (req, res) => {
  if (discovery.snapshot().scanning) return res.status(409).json({ error: 'Đợi quét xong trước khi xóa nguồn' });
  db.prepare('DELETE FROM douyin_candidates WHERE source_id = ?').run(req.params.id);
  db.prepare('DELETE FROM douyin_sources WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
app.patch('/api/douyin/discovery/config', (req, res) => res.json(discovery.saveConfig(req.body || {})));
app.post('/api/douyin/discovery/scan', (req, res) => {
  const state = discovery.snapshot();
  if (state.scanning || (state.loginOpen && !state.publicOnly) || !state.sources.some((s) => !state.publicOnly || discovery.PUBLIC_KINDS.includes(s.kind))) return res.status(409).json({ error: 'Cần nguồn phù hợp với chế độ quét; đóng phiên đăng nhập nếu dùng nguồn cần tài khoản' });
  discovery.scan().catch((error) => console.error(error.message));
  res.status(202).json({ status: 'scanning' });
});
// Everything the machine is doing right now, plus what is waiting, for the activity bar.
app.get('/api/activity', (req, res) => {
  const running = activity.list();
  const keys = new Set(running.map((item) => item.key));
  const add = (key, label, detail = '') => { if (!keys.has(key)) running.push({ key, label, detail, seconds: null }); };
  for (const job of db.prepare("SELECT id FROM reup_jobs WHERE status = 'downloading'").all()) add(`download-${job.id}`, `Tải video #${job.id}`, 'Đang lấy video từ Douyin…');
  for (const job of db.prepare("SELECT id FROM reup_jobs WHERE status = 'dubbing'").all()) add(`dub-${job.id}`, `Lồng tiếng video #${job.id}`);
  for (const p of db.prepare("SELECT id, job_id FROM reup_publications WHERE status = 'running'").all()) add(`publish-${p.id}`, `Đăng bài video #${p.job_id}`, 'Đang gửi sang LUNO…');
  if (translation.transcribing()) add(`extract-${translation.transcribing()}`, `Lấy lời thoại video #${translation.transcribing()}`);
  const comment = affiliateComment.commentRunning();
  if (comment) add(`comment-${comment.publicationId}`, `Bình luận link (lượt #${comment.publicationId})`, comment.verification ? 'TikTok yêu cầu xác minh — mở profile Roxy để kéo ghép hình' : 'Đang mở bài và gửi bình luận…');
  const pilot = autopilot.snapshot();
  if (pilot.finding) add(`find-${pilot.finding}`, `Tìm link bài (lượt #${pilot.finding})`, 'Đang đọc TikTok Studio…');
  if (discovery.snapshot().scanning) add('scan', 'Quét video Douyin', 'Đang đọc danh mục và bảng tin…');
  const waiting = [];
  const queued = db.prepare("SELECT count(*) n FROM reup_jobs WHERE status = 'queued'").get().n;
  if (queued) waiting.push(`${queued} video chờ tải`);
  if (translation.queued().length) waiting.push(`${translation.queued().length} video chờ lấy lời thoại`);
  const links = db.prepare("SELECT count(*) n FROM reup_jobs WHERE shopee_item_id != '' AND shopee_affiliate_url = ''").get().n;
  if (links) waiting.push(`${links} video chờ tiện ích tạo link`);
  const comments = db.prepare("SELECT count(*) n FROM reup_publications WHERE comment_status = 'pending' AND comment_error = ''").get().n;
  if (comments) waiting.push(`${comments} bài chờ bình luận`);
  res.json({ running, waiting, autopilot: pilot.enabled });
});
// Roxy profiles to post from, for the "Chạy trọn gói" account picker.
app.get('/api/roxy-profiles', async (req, res) => {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'roxy-browser.json'), 'utf8')); } catch {}
  const token = process.env.ROXY_API_TOKEN || config.api_token;
  if (!token || !config.workspace_id) return res.json({ profiles: [], error: 'Chưa cấu hình Roxy API (ROXY_API_TOKEN, workspace_id)' });
  try {
    const response = await fetch(`http://127.0.0.1:${config.api_port || 50000}/browser/list_v3?workspaceId=${encodeURIComponent(config.workspace_id)}&page_index=1&page_size=100`,
      { headers: { token }, signal: AbortSignal.timeout(5000) });
    const rows = (await response.json()).data?.rows || [];
    const topics = db.prepare('SELECT name, roxy_profile_id FROM topics').all();
    res.json({ profiles: rows.map((row) => ({ id: row.dirId, name: row.windowName, topic: topics.find((t) => t.roxy_profile_id === row.dirId)?.name || '' })) });
  } catch (error) { res.json({ profiles: [], error: `RoxyBrowser chưa mở hoặc API tắt (${error.message})` }); }
});
// One click from topic + account to posted video: pick the best Douyin videos (scanning first if
// the topic has none), then download, transcribe, machine-translate, dub, auto-approve and post.
app.post('/api/full-run', async (req, res) => {
  const { topicId, accountProfile, count, rightsConfirmed, mode = 'post' } = req.body || {};
  try {
    if (!/^[A-Za-z0-9]{1,64}$/.test(String(accountProfile || ''))) throw new Error('Chọn tài khoản (profile Roxy)');
    if (rightsConfirmed !== true) throw new Error('Cần xác nhận quyền sử dụng video');
    const hasCandidates = () => db.prepare("SELECT id FROM douyin_candidates WHERE topic_id = ? AND status = 'new' LIMIT 1").get(topicId);
    if (!hasCandidates() && !discovery.snapshot().scanning) await discovery.scan().catch(() => {});
    const jobs = discovery.quickTopic(topicId, count, true);
    if (!['prepare', 'post'].includes(mode)) throw new Error('Chế độ không hợp lệ');
    // prepare: stop before approval so the user posts; post: auto-approve and let the schedule post.
    for (const job of jobs) db.prepare('UPDATE reup_jobs SET auto_full = ?, account_profile = ? WHERE id = ?').run(mode === 'post' ? 1 : 2, accountProfile, job.jobId);
    if (mode === 'post') autopilot.saveConfig({ enabled: true });
    res.status(202).json({ jobs, translator: require('./services/machine-translate').provider() });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/autopilot', (req, res) => res.json(autopilot.snapshot()));
app.patch('/api/autopilot', (req, res) => {
  try { res.json(autopilot.saveConfig(req.body || {})); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/autopilot/run', async (req, res) => res.json(await autopilot.runNow()));
app.get('/api/shopee-products', (req, res) => res.json({ products: shopeeProducts.list() }));
// Called by the Chrome extension after it reads Shopee Affiliate's product offer page.
app.post('/api/shopee-products/scan', (req, res) => {
  try { res.json(shopeeProducts.saveScan(req.body?.topicId, req.body?.keyword, req.body?.items)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/shopee-products/:id/dismiss', (req, res) => {
  shopeeProducts.dismiss(req.params.id);
  res.json({ ok: true });
});
app.post('/api/reup/:id/shopee-product', (req, res) => {
  try { res.json(shopeeProducts.assign(req.params.id, req.body?.productId)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.patch('/api/topics/:id', (req, res) => {
  try { res.json(discovery.saveTopic(req.params.id, req.body || {})); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/douyin/cookie', (req, res) => res.json(discovery.cookieStatus()));
app.post('/api/douyin/cookie', async (req, res) => {
  try { discovery.saveCookie(req.body?.cookie); res.json(await discovery.checkLogin()); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/douyin/cookie/check', async (req, res) => {
  try { res.json(await discovery.checkLogin()); }
  catch (error) { res.status(409).json({ error: error.message }); }
});
app.delete('/api/douyin/cookie', (req, res) => res.json(discovery.clearCookie()));
app.post('/api/douyin/discovery/login', (req, res) => {
  try { res.json(discovery.openLogin()); }
  catch (error) { res.status(409).json({ error: error.message }); }
});
app.post('/api/douyin/discovery/candidates/:id/queue', (req, res) => {
  try { res.status(202).json(discovery.queueCandidate(req.params.id, req.body?.rightsConfirmed)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/douyin/discovery/sources/:id/items', (req, res) => {
  try { res.json(discovery.importItems(req.params.id, req.body?.items)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/douyin/discovery/candidates/:id/quick', (req, res) => {
  try { res.status(202).json(discovery.quickCandidate(req.params.id, req.body?.rightsConfirmed)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/douyin/discovery/quick', (req, res) => {
  try { res.status(202).json({ jobs: discovery.quickTopic(req.body?.topicId, req.body?.count, req.body?.rightsConfirmed) }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/douyin/discovery/candidates/:id/dismiss', (req, res) => {
  db.prepare("UPDATE douyin_candidates SET status = 'dismissed' WHERE id = ? AND status = 'new'").run(req.params.id);
  res.json({ ok: true });
});

db.prepare("UPDATE reup_jobs SET status = 'queued', error = '' WHERE status = 'downloading'").run();
db.prepare("UPDATE reup_jobs SET status = 'failed', error = 'Máy chủ khởi động lại; hãy thử lại bước này' WHERE status = 'dubbing'").run();
setImmediate(reup.drainDownloads);
db.prepare("UPDATE reup_publications SET status = 'failed', error = 'Máy chủ khởi động lại; kiểm tra trên nền tảng trước khi đăng lại' WHERE status = 'running'").run();

app.get('/api/reup', async (req, res) => {
  const jobs = db.prepare('SELECT * FROM reup_jobs ORDER BY id DESC').all().map((job) => ({ ...job, translation: translation.state(job.id) }));
  const publications = db.prepare('SELECT * FROM reup_publications ORDER BY id DESC').all();
  const services = await reup.serviceStatus();
  res.json({ jobs, publications, services, commenting: affiliateComment.commentRunning(),
    shopeeOpenApi: Boolean(shopeeAffiliate.openApiCredentials()) });
});

app.post('/api/reup/import', (req, res) => {
  if (req.body?.rightsConfirmed !== true) {
    return res.status(400).json({ error: 'Xác nhận quyền sử dụng video trước khi nhập' });
  }
  try {
    const topicId = req.body?.topicId ? Number(req.body.topicId) : null;
    if (topicId && !db.prepare('SELECT id FROM topics WHERE id = ?').get(topicId)) throw new Error('Không có chủ đề này');
    const result = reup.enqueueImports(req.body?.urls || [req.body?.url], req.body?.title || '', topicId);
    res.status(202).json({ ...result, id: result.ids[0] || result.skipped[0] });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.patch('/api/reup/:id/topic', (req, res) => {
  const topicId = req.body?.topicId ? Number(req.body.topicId) : null;
  if (topicId && !db.prepare('SELECT id FROM topics WHERE id = ?').get(topicId)) return res.status(400).json({ error: 'Không có chủ đề này' });
  if (db.prepare("SELECT id FROM reup_publications WHERE job_id = ? AND status = 'running'").get(req.params.id)) return res.status(409).json({ error: 'Video đang được đăng' });
  if (!db.prepare('UPDATE reup_jobs SET topic_id = ? WHERE id = ?').run(topicId, req.params.id).changes) return res.status(404).json({ error: 'Không có video' });
  res.json(reup.job(req.params.id));
});

app.post('/api/reup/:id/transcribe', (req, res) => {
  const current = reup.job(req.params.id);
  if (!current) return res.status(404).json({ error: 'Không có video' });
  if (['queued', 'downloading', 'dubbing'].includes(current.status)) return res.status(409).json({ error: 'Đợi bước hiện tại xong' });
  if (translation.transcribing()) return res.status(409).json({ error: `Đang lấy lời thoại cho video #${translation.transcribing()}` });
  db.prepare("UPDATE reup_jobs SET error = '' WHERE id = ?").run(current.id);
  translation.extract(current.id)
    .then(({ cues }) => console.log(`[Lời thoại #${current.id}] ${cues} câu`))
    .catch((error) => db.prepare('UPDATE reup_jobs SET error = ? WHERE id = ?').run(`Lấy lời thoại: ${error.message.slice(-400)}`, current.id));
  res.status(202).json({ started: true });
});
app.get('/api/reup/:id/translation', (req, res) => {
  try { res.json(translation.load(req.params.id)); }
  catch (error) { res.status(404).json({ error: error.message }); }
});
app.put('/api/reup/:id/translation', (req, res) => {
  const current = reup.job(req.params.id);
  if (!current) return res.status(404).json({ error: 'Không có video' });
  if (current.status === 'dubbing') return res.status(409).json({ error: 'Đang lồng tiếng; đợi xong rồi sửa' });
  try { res.json(translation.save(current.id, req.body?.segments, req.body?.voice)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/reup/:id/retry-import', (req, res) => {
  const current = reup.job(req.params.id);
  if (!current) return res.status(404).json({ error: 'Không có video' });
  if (current.status !== 'failed') return res.status(409).json({ error: 'Chỉ thử lại video lỗi' });
  db.prepare("UPDATE reup_jobs SET status = 'queued', error = '' WHERE id = ?").run(current.id);
  setImmediate(reup.drainDownloads);
  res.status(202).json({ id: current.id, status: 'queued' });
});

app.post('/api/reup/:id/dub', (req, res) => {
  const current = reup.job(req.params.id);
  if (!current) return res.status(404).json({ error: 'Không có video' });
  if (!['source_ready', 'review', 'failed'].includes(current.status) || !current.source_path || !fs.existsSync(current.source_path)) {
    return res.status(409).json({ error: 'Chưa có video nguồn để lồng tiếng' });
  }
  if (db.prepare("SELECT id FROM reup_jobs WHERE status = 'dubbing' LIMIT 1").get()) {
    return res.status(409).json({ error: 'VideoLingo đang xử lý video khác' });
  }
  db.prepare("UPDATE reup_jobs SET status = 'dubbing', approved = 0, error = '' WHERE id = ?").run(current.id);
  setImmediate(() => reup.dubVietnamese(current.id).catch((error) => {
    db.prepare("UPDATE reup_jobs SET status = 'failed', error = ? WHERE id = ?").run(error.message, current.id);
    console.error(`[reup #${current.id}] ${error.message}`);
  }));
  res.status(202).json({ id: current.id, status: 'dubbing' });
});

app.patch('/api/reup/:id', (req, res) => {
  const current = reup.job(req.params.id);
  if (!current) return res.status(404).json({ error: 'Không có video' });
  if (!['source_ready', 'review', 'failed'].includes(current.status)) return res.status(409).json({ error: 'Đợi xử lý xong trước khi sửa' });
  const fields = ['title', 'caption', 'tiktok_product_id', 'shopee_product_query', 'shopee_product_id'];
  const values = fields.map((key) => String(req.body?.[key] || '').trim().slice(0, key === 'caption' ? 2000 : 250));
  values[1] = reup.withRequiredTags(values[1]);
  if ((values[2] && !/^\d+$/.test(values[2])) || (values[4] && !/^\d+$/.test(values[4]))) {
    return res.status(400).json({ error: 'ID sản phẩm phải gồm chữ số' });
  }
  try { affiliateComment.validateCaption(values[1]); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  db.prepare(`UPDATE reup_jobs SET ${fields.map((key) => `${key} = ?`).join(', ')}, approved = 0 WHERE id = ?`).run(...values, current.id);
  res.json({ ok: true });
});

app.post('/api/reup/:id/approve', (req, res) => {
  const current = reup.job(req.params.id);
  if (!current) return res.status(404).json({ error: 'Không có video' });
  if (current.status !== 'review' || !current.dubbed_path || !fs.existsSync(current.dubbed_path)) {
    return res.status(409).json({ error: 'Chưa có bản lồng tiếng để duyệt' });
  }
  if (!current.caption?.trim()) {
    return res.status(400).json({ error: 'Cần caption trước khi duyệt video' });
  }
  db.prepare('UPDATE reup_jobs SET approved = 1 WHERE id = ?').run(current.id);
  res.json({ ok: true });
});

app.patch('/api/reup/:id/affiliate/product', (req, res) => {
  try { res.json(shopeeAffiliate.saveProduct(req.params.id, req.body?.url)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.patch('/api/reup/:id/affiliate/link', (req, res) => {
  try { res.json(shopeeAffiliate.saveAffiliate(req.params.id, req.body?.url)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/reup/:id/affiliate/generate', async (req, res) => {
  try { res.json(await shopeeAffiliate.generateAffiliate(req.params.id)); }
  catch (error) { res.status(409).json({ error: error.message }); }
});

app.patch('/api/reup/publications/:id/post-url', (req, res) => {
  try { res.json(affiliateComment.savePostUrl(req.params.id, req.body?.url)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/reup/publications/:id/comment/run', (req, res) => {
  try { res.json(affiliateComment.runComment(req.params.id, { browser: req.body?.browser || '' })); }
  catch (error) { res.status(409).json({ error: error.message }); }
});

app.get('/api/reup/publications/:id/comment', (req, res) => {
  try { res.json(affiliateComment.commentForPublication(req.params.id)); }
  catch (error) { res.status(409).json({ error: error.message }); }
});

app.post('/api/reup/publications/:id/affiliate', (req, res) => {
  try { res.json(affiliateComment.attachToPublication(req.params.id)); }
  catch (error) { res.status(409).json({ error: error.message }); }
});

app.post('/api/reup/publications/:id/comment-posted', (req, res) => {
  try { res.json(affiliateComment.markCommentPosted(req.params.id)); }
  catch (error) { res.status(409).json({ error: error.message }); }
});

app.get('/api/reup/:id/video', (req, res) => {
  const current = reup.job(req.params.id);
  if (!current) return res.status(404).end();
  const file = req.query.kind === 'source' ? current.source_path : current.dubbed_path;
  if (!file || !fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

app.delete('/api/reup/:id', (req, res) => {
  const current = reup.job(req.params.id);
  if (!current) return res.status(404).json({ error: 'Không có video' });
  if (['queued', 'downloading', 'dubbing'].includes(current.status) ||
      db.prepare("SELECT id FROM reup_publications WHERE job_id = ? AND status = 'running' LIMIT 1").get(current.id)) {
    return res.status(409).json({ error: 'Đợi xử lý xong trước khi xóa' });
  }
  const mediaRoot = path.resolve(__dirname, '..', 'media', 'reup') + path.sep;
  for (const file of [current.source_path, current.dubbed_path]) {
    if (file && path.resolve(file).startsWith(mediaRoot)) fs.rmSync(file, { force: true });
  }
  db.prepare('DELETE FROM reup_publications WHERE job_id = ?').run(current.id);
  db.prepare('DELETE FROM reup_jobs WHERE id = ?').run(current.id);
  res.json({ ok: true });
});

app.post('/api/reup/:id/publish', async (req, res) => {
  try {
    if (req.body?.platform === 'tiktok') {
      const account = await tiktokAccount.status();
      // In Roxy mode each profile holds its own TikTok session; LUNO's saved-account list is unused.
      const ready = account.browserMode === 'roxy' ? account.available : account.available && !account.loginOpen && account.activeId && (account.hasSession || account.hasCookie);
      if (!ready) return res.status(409).json({ error: account.browserMode === 'roxy' ? 'LUNO chưa chạy' : 'Cần đăng nhập và lưu phiên TikTok trước khi đăng' });
    }
    const publicationId = reup.startPublication(req.params.id, req.body?.platform, req.body?.mode);
    res.status(202).json({ publicationId, status: 'running' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

function cleanDevice(d) {
  return { ...d, coords: d.coords || '{}' };
}

// ---------- Devices ----------
app.get('/api/devices', async (req, res) => {
  try {
    const live = await adb.listDevices();
    const known = db.prepare('SELECT * FROM devices').all().map(cleanDevice);
    for (const l of live) {
      if (l.state !== 'device') continue;
      if (!known.some((k) => k.serial === l.serial)) {
        db.prepare('INSERT INTO devices (serial, name, status) VALUES (?, ?, ?)').run(l.serial, l.serial, 'online');
        known.push(cleanDevice(db.prepare('SELECT * FROM devices WHERE serial = ?').get(l.serial)));
      } else {
        const row = known.find((k) => k.serial === l.serial);
        if (row.status !== 'busy') row.status = 'online';
      }
    }
    for (const k of known) {
      if (!live.some((l) => l.serial === k.serial)) k.status = 'offline';
    }
    res.json({ devices: known, live, adbError: null });
  } catch (e) {
    res.json({ devices: db.prepare('SELECT * FROM devices').all().map(cleanDevice), live: [], adbError: e.message });
  }
});

app.post('/api/devices/rescan', async (req, res) => {
  try {
    adb.resetAdbCache();
    const live = await adb.listDevices();
    for (const l of live) {
      if (l.state !== 'device') continue;
      db.prepare('INSERT OR IGNORE INTO devices (serial, name, status) VALUES (?, ?, ?)').run(l.serial, l.serial, 'online');
    }
    res.json({ ok: true, adb: adb.getAdbPath(), devices: live });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/devices/:serial/update', (req, res) => {
  const { name, resolution, coords, note } = req.body;
  db.prepare('UPDATE devices SET name = ?, resolution = ?, coords = ?, note = ? WHERE serial = ?')
    .run(name || '', resolution || '1080x1920', JSON.stringify(coords || {}), note || '', req.params.serial);
  res.json({ ok: true });
});

app.delete('/api/devices/:serial', (req, res) => {
  db.prepare('DELETE FROM devices WHERE serial = ?').run(req.params.serial);
  res.json({ ok: true });
});

app.post('/api/devices/:serial/open', async (req, res) => {
  try {
    await adb.openApp(req.params.serial, getSettings().tiktok_package);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/devices/:serial/screenshot.png', async (req, res) => {
  try {
    const tmp = path.join(RAW_DIR, `scr_${req.params.serial.replace(/\W/g, '')}.png`);
    await adb.screenshot(req.params.serial, tmp);
    res.sendFile(tmp);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/devices/:serial/tap', async (req, res) => {
  try {
    await adb.tap(req.params.serial, req.body.x, req.body.y);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/devices/:serial/comment', async (req, res) => {
  try {
    const device = db.prepare('SELECT * FROM devices WHERE serial = ?').get(req.params.serial);
    const link = await poster.commentOnVideo(device);
    res.json({ ok: true, link: link ? link.content : null });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/devices/:serial/post', async (req, res) => {
  try {
    const device = db.prepare('SELECT * FROM devices WHERE serial = ?').get(req.params.serial);
    if (!device) return res.status(404).json({ error: 'Thiết bị không tồn tại' });
    let video;
    if (req.body.videoId) {
      video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.body.videoId);
    } else {
      video = db.prepare("SELECT * FROM videos WHERE status = 'ready' AND device_serial = '' ORDER BY id ASC LIMIT 1").get();
    }
    if (!video) return res.status(400).json({ error: 'Không có video sẵn sàng. Tải + xử lý video trước.' });
    db.prepare("UPDATE videos SET status = 'posting', device_serial = ? WHERE id = ?").run(device.serial, video.id);
    db.prepare("UPDATE devices SET status = 'busy' WHERE serial = ?").run(device.serial);
    res.json({ ok: true, message: `Bắt đầu đăng video #${video.id} lên ${device.serial}. Xem log để theo dõi.` });
    setTimeout(async () => {
      try {
        await poster.postVideo(device, video);
      } catch (e) {
        console.error(`Lỗi đăng video #${video.id}: ${e.message}`);
        db.prepare("UPDATE videos SET status = 'failed', error = ?, device_serial = '' WHERE id = ?").run(e.message, video.id);
        db.prepare("UPDATE devices SET status = 'online' WHERE serial = ?").run(device.serial);
      }
    }, 500);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Videos ----------
app.get('/api/videos', (req, res) => {
  const videos = db.prepare('SELECT * FROM videos ORDER BY id DESC').all();
  res.json({ videos: videos.map((v) => ({
    ...v,
    raw_size: v.raw_path ? proc.fileSizeMb(v.raw_path) : '0',
    processed_size: v.processed_path ? proc.fileSizeMb(v.processed_path) : '0'
  })) });
});

app.post('/api/videos/download', async (req, res) => {
  const { url, title } = req.body;
  if (!url) return res.status(400).json({ error: 'Thiếu URL video' });
  const id = db.prepare('INSERT INTO videos (source_url, title, status) VALUES (?, ?, ?)').run(url, title || url.split('/').pop(), 'downloading').lastInsertRowid;
  const rawPath = path.join(RAW_DIR, `${id}.mp4`);
  db.prepare('UPDATE videos SET raw_path = ? WHERE id = ?').run(rawPath, id);
  res.json({ ok: true, message: `Đang tải video #${id}...` });
  setTimeout(async () => {
    try {
      await proc.downloadVideo(url, rawPath);
      db.prepare("UPDATE videos SET status = 'processing' WHERE id = ?").run(id);
      const procPath = path.join(PROC_DIR, `${id}.mp4`);
      await proc.processVideo(rawPath, procPath);
      db.prepare("UPDATE videos SET processed_path = ?, status = ?, error = '' WHERE id = ?").run(procPath, 'ready', id);
      console.log(`Video #${id} tải + xử lý xong, sẵn sàng đăng.`);
    } catch (e) {
      console.error(`Lỗi xử lý video #${id}: ${e.message}`);
      db.prepare("UPDATE videos SET status = 'failed', error = ? WHERE id = ?").run(e.message, id);
    }
  }, 500);
});

app.post('/api/videos/:id/process', async (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Không tìm thấy video' });
  if (!v.raw_path || !fs.existsSync(v.raw_path)) return res.status(400).json({ error: 'Chưa có file raw. Tải lại.' });
  res.json({ ok: true, message: `Đang xử lý video #${v.id}...` });
  setTimeout(async () => {
    try {
      db.prepare("UPDATE videos SET status = 'processing' WHERE id = ?").run(v.id);
      const procPath = path.join(PROC_DIR, `${v.id}.mp4`);
      await proc.processVideo(v.raw_path, procPath);
      db.prepare("UPDATE videos SET processed_path = ?, status = ?, error = '' WHERE id = ?").run(procPath, 'ready', v.id);
      console.log(`Video #${v.id} xử lý xong.`);
    } catch (e) {
      console.error(`Lỗi xử lý video #${v.id}: ${e.message}`);
      db.prepare("UPDATE videos SET status = 'failed', error = ? WHERE id = ?").run(e.message, v.id);
    }
  }, 500);
});

app.post('/api/videos/:id/post', async (req, res) => {
  try {
    const device = db.prepare('SELECT * FROM devices WHERE serial = ?').get(req.body.serial);
    if (!device) return res.status(400).json({ error: 'Chưa có thiết bị' });
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video không tồn tại' });
    db.prepare("UPDATE videos SET status = 'posting', device_serial = ? WHERE id = ?").run(device.serial, video.id);
    db.prepare("UPDATE devices SET status = 'busy' WHERE serial = ?").run(device.serial);
    res.json({ ok: true, message: `Đang đăng video #${video.id} lên ${device.serial}...` });
    setTimeout(async () => {
      try {
        await poster.postVideo(device, video);
      } catch (e) {
        console.error(`Lỗi đăng video #${video.id}: ${e.message}`);
        db.prepare("UPDATE videos SET status = 'failed', error = ?, device_serial = '' WHERE id = ?").run(e.message, video.id);
        db.prepare("UPDATE devices SET status = 'online' WHERE serial = ?").run(device.serial);
      }
    }, 500);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/videos/:id', (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (v) {
    for (const p of [v.raw_path, v.processed_path]) {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    }
    db.prepare('DELETE FROM videos WHERE id = ?').run(req.params.id);
  }
  res.json({ ok: true });
});

// ---------- Links ----------
app.get('/api/links', (req, res) => {
  res.json({ links: db.prepare('SELECT * FROM links ORDER BY id DESC').all() });
});

app.post('/api/links', (req, res) => {
  const { content, contents } = req.body;
  const list = contents || [content];
  const ins = db.prepare('INSERT INTO links (content) VALUES (?)');
  let added = 0;
  for (const c of list) {
    if (c && c.trim()) { ins.run(c.trim()); added++; }
  }
  res.json({ ok: true, added });
});

app.delete('/api/links/:id', (req, res) => {
  db.prepare('DELETE FROM links WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Settings ----------
app.get('/api/settings', (req, res) => {
  res.json({ settings: getSettings() });
});

app.post('/api/settings', (req, res) => {
  const body = req.body;
  if (body && typeof body === 'object' && body.key !== undefined) {
    setSetting(body.key, body.value);
  } else if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body)) setSetting(k, v);
  }
  res.json({ settings: getSettings() });
});

app.get('/api/tools/status', (req, res) => {
  res.json({
    adb: adb.getAdbPath(),
    ffmpeg: proc.findFfmpeg(),
    ytdlp: proc.findYtdlp() || 'chưa có (bấm Cài yt-dlp)'
  });
});

app.post('/api/tools/install-ytdlp', async (req, res) => {
  try {
    const p = await proc.ensureYtdlp();
    res.json({ ok: true, path: p });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/tools/install-ffmpeg', async (req, res) => {
  try {
    const p = await proc.installFfmpeg();
    console.log('Đã cài ffmpeg tại ' + p);
    res.json({ ok: true, path: p });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Scheduler ----------
app.get('/api/scheduler', (req, res) => {
  res.json({ enabled: getSettings().scheduler_enabled === '1' });
});

app.post('/api/scheduler/toggle', (req, res) => {
  const enabled = getSettings().scheduler_enabled === '1' ? '0' : '1';
  setSetting('scheduler_enabled', enabled);
  if (enabled === '1') scheduler.start();
  else scheduler.stop();
  res.json({ enabled: enabled === '1' });
});

app.get('/api/logs', (req, res) => {
  res.json({ logs: LOG_BUFFER.slice(-200) });
});

io.on('connection', (socket) => {
  socket.emit('logs', LOG_BUFFER.slice(-200));
});

if (getSettings().scheduler_enabled === '1') scheduler.start();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Auto Affiliate đang chạy tại http://localhost:${PORT}`);
  console.log('ADB: ' + (adb.getAdbPath() || 'KHÔNG TÌM THẤY - cài giả lập hoặc đặt đường dẫn adb.exe trong Settings'));
  console.log('ffmpeg: ' + (proc.findFfmpeg() || 'chưa có - cài ffmpeg hoặc đặt đường dẫn trong Settings'));
  console.log('yt-dlp: ' + (proc.findYtdlp() || 'chưa có - vào trang web bấm "Cài yt-dlp"'));
});
