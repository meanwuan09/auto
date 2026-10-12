const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { db, getSettings, setSetting } = require('../db');
const reup = require('./reup');
const shopeeProducts = require('./shopee-products');
const affiliateComment = require('./affiliate-comment');
const accounts = require('./accounts');

const ROOT = path.join(__dirname, '..', '..');
const MEDIA = process.env.REUP_MEDIA_DIR || path.join(ROOT, 'media', 'reup');
const PYTHON = process.env.DOUYIN_PYTHON || path.join(ROOT, 'third_party', 'luno-automation', 'backend', '.venv', 'Scripts', 'python.exe');
const LUNO_DIR = path.join(ROOT, 'third_party', 'luno-automation', 'backend');
const FIND_RETRY_MS = 5 * 60 * 1000;
const FIND_ATTEMPTS = 8;

const DEFAULTS = { enabled: '0', posts_per_day: '2', min_gap_hours: '4', start_hour: '7', end_hour: '23', comment_delay_min: '15', slots: '',
  refill: '0', refill_target: '3' };
// With posting slots set, a topic posts at most once per slot, within this many minutes after it.
const SLOT_WINDOW_MIN = 45;
// Each account posts at its own offset of the day: up to this many minutes into a slot, or past the minimum gap.
const SLOT_JITTER_MIN = 25;
const GAP_JITTER_MIN = 40;
let finding = null;
let luno = null;
const findTries = new Map();
const log = [];

function note(message) {
  log.unshift({ at: new Date().toISOString(), message });
  log.length = Math.min(log.length, 30);
  console.log(`[Tự động] ${message}`);
}

function config() {
  const settings = getSettings();
  const value = (key) => settings[`autopilot_${key}`] ?? DEFAULTS[key];
  return {
    enabled: value('enabled') === '1', postsPerDay: Number(value('posts_per_day')), minGapHours: Number(value('min_gap_hours')),
    startHour: Number(value('start_hour')), endHour: Number(value('end_hour')), commentDelayMin: Number(value('comment_delay_min')),
    slots: String(value('slots')).split(',').map((slot) => slot.trim()).filter(Boolean),
    refill: value('refill') === '1', refillTarget: Number(value('refill_target'))
  };
}

function parseSlots(input) {
  const slots = [...new Set(String(input || '').split(/[,\s]+/).filter(Boolean).map((slot) => {
    const match = slot.match(/^(\d{1,2})[:h](\d{2})?$/);
    if (!match || Number(match[1]) > 23 || Number(match[2] || 0) > 59) throw new Error(`Giờ "${slot}" không hợp lệ; dùng dạng 08:00`);
    return `${match[1].padStart(2, '0')}:${match[2] || '00'}`;
  }))].sort();
  if (slots.length > 12) throw new Error('Tối đa 12 khung giờ mỗi ngày');
  return slots;
}

// The slot (today) whose window contains now, or null.
function activeSlot(now, slots) {
  for (const slot of slots) {
    const [h, m] = slot.split(':').map(Number);
    const start = new Date(now); start.setHours(h, m, 0, 0);
    if (now >= start && now - start < SLOT_WINDOW_MIN * 60000) return start;
  }
  return null;
}

function saveConfig(body) {
  const ranges = { posts_per_day: [1, 6], min_gap_hours: [1, 24], start_hour: [0, 23], end_hour: [1, 24], comment_delay_min: [1, 240] };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const camel = key.replace(/_(\w)/g, (_, c) => c.toUpperCase());
    if (body[camel] === undefined) continue;
    const number = Number(body[camel]);
    if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Giá trị ${key} phải từ ${min} đến ${max}`);
    setSetting(`autopilot_${key}`, String(number));
  }
  if (typeof body.enabled === 'boolean') setSetting('autopilot_enabled', body.enabled ? '1' : '0');
  if (body.slots !== undefined) setSetting('autopilot_slots', parseSlots(body.slots).join(','));
  if (typeof body.refill === 'boolean') {
    // Refilling downloads Douyin videos without a per-video click, so it needs the user's rights confirmation.
    if (body.refill && body.rightsConfirmed !== true) throw new Error('Cần xác nhận quyền sử dụng video để bật tự lấy video');
    setSetting('autopilot_refill', body.refill ? '1' : '0');
  }
  if (body.refillTarget !== undefined) {
    const target = Number(body.refillTarget);
    if (!Number.isInteger(target) || target < 1 || target > 10) throw new Error('Số video giữ sẵn phải từ 1 đến 10');
    setSetting('autopilot_refill_target', String(target));
  }
  const current = config();
  if (current.startHour >= current.endHour) throw new Error('Giờ bắt đầu phải trước giờ kết thúc');
  return snapshot();
}

function snapshot() {
  return { ...config(), finding: finding ? finding.publicationId : null, lunoStarted: Boolean(luno), log,
    translator: require('./machine-translate').provider() };
}

// Posting a new video and opening TikTok Studio for an older one would fight over the same Roxy profile.
function browserBusy() {
  return Boolean(finding || affiliateComment.commentRunning() ||
    db.prepare("SELECT id FROM reup_publications WHERE status = 'running' LIMIT 1").get());
}

const PROFILE_OF_PUBLICATION = `SELECT COALESCE(NULLIF(j.account_profile, ''), t.roxy_profile_id, '') AS profile FROM reup_publications p
  JOIN reup_jobs j ON j.id = p.job_id LEFT JOIN topics t ON t.id = j.topic_id WHERE p.id = ?`;
const profileOf = (publicationId) => db.prepare(PROFILE_OF_PUBLICATION).get(publicationId)?.profile || '';

// Roxy profiles autopilot is using right now (posting, finding a post link, commenting a link).
// Other profiles stay free for the "Tương tác" tab, so accounts work side by side.
function busyProfiles() {
  const ids = db.prepare("SELECT id FROM reup_publications WHERE status = 'running'").all().map((row) => row.id);
  if (finding) ids.push(finding.publicationId);
  const comment = affiliateComment.commentRunning();
  if (comment) ids.push(comment.publicationId);
  return new Set(ids.map(profileOf).filter(Boolean));
}
const engageBusy = (profile) => Boolean(profile) && require('./engage').busyOn(profile);

// Douyin videos with burned-in subtitles have no caption of their own: start from the first
// translated line and the topic's trending hashtags. Never put links in the caption.
function autoCaption(job) {
  let first = '';
  try {
    const translation = JSON.parse(fs.readFileSync(path.join(MEDIA, `${job.id}-reviewed-vi.json`), 'utf8'));
    first = translation.segments.find((segment) => segment.text && segment.voiced !== false)?.text || '';
  } catch {}
  const topic = job.topic_id ? db.prepare('SELECT trend_tags FROM topics WHERE id = ?').get(job.topic_id) : null;
  return [first || job.title.replace(/#\S+/g, '').trim(), topic?.trend_tags || ''].filter(Boolean).join(' ').slice(0, 300);
}

// Ready videos get a written caption (hook + matching hashtags) before their slot, so it can be
// checked in "Xem trước"; autoCaption stays the fallback at posting time.
const captionFailed = new Set();
async function writeCaptions() {
  const mt = require('./machine-translate');
  if (mt.provider() !== 'deepseek') return;
  const jobs = db.prepare(`SELECT j.*, t.name AS topic_name, t.trend_tags FROM reup_jobs j JOIN topics t ON t.id = j.topic_id
    WHERE (j.approved = 1 OR j.auto_full > 0) AND j.caption = '' AND j.status = 'review'
    AND NOT EXISTS (SELECT 1 FROM reup_publications p WHERE p.job_id = j.id AND p.status IN ('running', 'done')) ORDER BY j.id LIMIT 3`).all();
  for (const job of jobs) {
    if (captionFailed.has(job.id)) continue;
    let lines = [];
    try {
      lines = JSON.parse(fs.readFileSync(path.join(MEDIA, `${job.id}-reviewed-vi.json`), 'utf8')).segments.map((segment) => segment.text).filter(Boolean);
    } catch { continue; }
    try {
      const caption = await mt.writeCaption({ lines, title: job.title, topic: job.topic_name, topicTags: job.trend_tags, ai: reup.isAiContent(job) });
      db.prepare("UPDATE reup_jobs SET caption = ? WHERE id = ? AND caption = ''").run(caption, job.id);
      note(`Video #${job.id}: viết caption — ${caption.slice(0, 80)}`);
    } catch (error) {
      captionFailed.add(job.id);
      note(`Video #${job.id}: chưa viết được caption (${error.message}), sẽ dùng caption tự ghép`);
    }
  }
}

function assignProducts() {
  // Prepared runs get their product (and so their link) before approval, so they are ready to post.
  const jobs = db.prepare("SELECT * FROM reup_jobs WHERE (approved = 1 OR auto_full > 0) AND topic_id IS NOT NULL AND shopee_item_id = ''").all();
  for (const job of jobs) {
    const product = shopeeProducts.pickFor(job.id);
    if (!product) continue;
    note(`Video #${job.id}: gắn sản phẩm "${product.name.slice(0, 50)}" — tiện ích Chrome sẽ tạo link`);
  }
}

// Downloaded topic videos get their speech extracted without waiting for a click; the
// translation step after that still needs the user's review.
function prepareDownloads() {
  const translation = require('./translation');
  const jobs = db.prepare("SELECT id FROM reup_jobs WHERE status = 'source_ready' AND topic_id IS NOT NULL AND source_path != '' AND error = '' ORDER BY id").all();
  for (const job of jobs) {
    if (fs.existsSync(path.join(MEDIA, `${job.id}-reviewed-vi.draft.json`)) || fs.existsSync(path.join(MEDIA, `${job.id}-reviewed-vi.json`))) continue;
    if (translation.transcribing() === job.id || translation.queued().includes(job.id)) continue;
    translation.enqueueExtract(job.id);
    note(`Video #${job.id}: tự lấy lời thoại`);
  }
}

// Keep every channel stocked: when a topic has fewer than the target number of videos on their way
// to posting, take its best new Douyin candidates through the unattended run-and-post flow.
// Posting slots in the next 24 hours, as Date objects in order.
function upcomingSlots(now = new Date()) {
  const { slots } = config();
  const result = [];
  for (const dayOffset of [0, 1]) {
    for (const slot of slots) {
      const [h, m] = slot.split(':').map(Number);
      const at = new Date(now); at.setDate(at.getDate() + dayOffset); at.setHours(h, m, 0, 0);
      if (at > now - SLOT_WINDOW_MIN * 60000 && at - now < 24 * 3600000) result.push(at);
    }
  }
  return result.sort((a, b) => a - b);
}

// Videos of a topic that will be posted next: ready ones first (approved and dubbed), then the ones
// still being prepared for unattended posting. Posted and failed videos are not counted.
function pipelineFor(topicId) {
  return db.prepare(`SELECT j.id, j.status, j.approved, j.dubbed_path, j.auto_full, j.error, j.account_profile FROM reup_jobs j
    WHERE j.topic_id = ? AND ((j.approved = 1 AND j.dubbed_path != '') OR (j.auto_full = 1 AND j.error = ''))
    AND NOT EXISTS (SELECT 1 FROM reup_publications p WHERE p.job_id = j.id AND p.platform = 'tiktok' AND p.mode = 'schedule' AND p.status IN ('running', 'done'))
    ORDER BY (j.approved = 1 AND j.status = 'review') DESC, j.id`).all(topicId);
}

// How many videos a topic needs on hand: for each of its active accounts, one per posting slot in the
// next 24 hours (capped by the account's daily limit) when a schedule is set, otherwise "keep N ready".
function channelNeed(topicId, now = new Date()) {
  const { slots, postsPerDay, refillTarget } = config();
  const list = accounts.active(topicId);
  if (!slots.length) return refillTarget * list.length;
  const upcoming = upcomingSlots(now);
  const today = upcoming.filter((at) => at.getDate() === now.getDate()).length;
  const tomorrow = upcoming.length - today;
  return list.reduce((total, account) => {
    const limit = account.daily_limit || postsPerDay;
    const done = accounts.postsBy(account.profile_id, accounts.dayStart(now)).length;
    return total + Math.max(0, Math.min(today, limit - done)) + Math.min(tomorrow, limit);
  }, 0);
}

// Prepare early: as soon as a channel has fewer videos on hand than its upcoming slots need, take its
// best new Douyin candidates through the unattended flow, so they are dubbed well before posting time.
function refillChannels(now = new Date()) {
  const { refill } = config();
  if (!refill) return;
  const discovery = require('./douyin-discovery');
  for (const topic of accounts.activeTopics()) {
    const need = channelNeed(topic.id, now) - pipelineFor(topic.id).length;
    if (need <= 0) continue;
    let jobs = [];
    try { jobs = discovery.quickTopic(topic.id, need, true); } catch { continue; } // no candidates yet; the next scan adds some
    // Left without an account: whichever account of the topic posts next takes it.
    for (const job of jobs) db.prepare('UPDATE reup_jobs SET auto_full = 1 WHERE id = ?').run(job.jobId);
    note(`${topic.name}: chuẩn bị sớm ${jobs.length} video cho lịch đăng (${jobs.map((job) => '#' + job.jobId).join(', ')})`);
  }
}

// Posting plan for the next 24 hours: each slot of each account with the video lined up for it.
function plan(now = new Date()) {
  const { postsPerDay } = config();
  const upcoming = upcomingSlots(now);
  const channels = [];
  for (const topic of accounts.activeTopics()) {
    const list = accounts.active(topic.id);
    const queue = pipelineFor(topic.id).map((job) => ({
      id: job.id, profile: job.account_profile, ready: Boolean(job.approved && job.status === 'review' && job.dubbed_path),
      step: job.approved ? 'Sẵn sàng' : job.status === 'dubbing' ? 'Đang lồng tiếng' : job.status === 'review' ? 'Chờ duyệt'
        : job.status === 'source_ready' ? 'Đang dịch/lấy lời thoại' : ['queued', 'downloading'].includes(job.status) ? 'Đang tải' : job.status
    }));
    const quota = new Map(list.map((account) => {
      const limit = account.daily_limit || postsPerDay;
      return [account.id, { today: Math.max(0, limit - accounts.postsBy(account.profile_id, accounts.dayStart(now)).length), tomorrow: limit, slots: [] }];
    }));
    for (const at of upcoming) {
      const isToday = at.getDate() === now.getDate();
      for (const account of list) {
        const left = quota.get(account.id);
        if ((isToday ? left.today : left.tomorrow) <= 0) { left.slots.push({ at: at.toISOString(), skipped: true }); continue; }
        if (isToday) left.today -= 1; else left.tomorrow -= 1;
        // A video picked for a specific account waits for it; the rest go to whichever account posts first.
        const own = queue.findIndex((job) => job.profile === account.profile_id);
        const index = own >= 0 ? own : queue.findIndex((job) => !job.profile);
        const job = index >= 0 ? queue.splice(index, 1)[0] : null;
        left.slots.push({ at: at.toISOString(), job: job && { id: job.id, ready: job.ready, step: job.step } });
      }
    }
    for (const account of list) {
      const assigned = quota.get(account.id).slots;
      channels.push({ topicId: topic.id, accountId: account.id, name: topic.name, account: account.name || `${account.profile_id.slice(0, 8)}…`,
        need: assigned.filter((slot) => !slot.skipped).length, onHand: assigned.filter((slot) => slot.job).length, assigned });
    }
  }
  return { slots: upcoming.map((at) => at.toISOString()), scheduled: config().slots.length > 0, channels };
}

// Steps that need no person for jobs started with "Chạy trọn gói".
async function advanceFullRuns() {
  const translation = require('./translation');
  // auto_full: 1 = run and post (auto-approve), 2 = prepare only (stop before approval).
  const jobs = db.prepare("SELECT * FROM reup_jobs WHERE auto_full > 0 AND error = '' ORDER BY id").all();
  for (const job of jobs) {
    const draft = fs.existsSync(path.join(MEDIA, `${job.id}-reviewed-vi.draft.json`));
    const reviewed = fs.existsSync(path.join(MEDIA, `${job.id}-reviewed-vi.json`));
    if (job.status === 'source_ready' && draft && !reviewed) {
      try {
        const result = await translation.autoTranslate(job.id);
        note(`Video #${job.id}: dịch máy (${result.provider}) ${result.cues} câu, ${result.voiced} câu đọc`);
      } catch (error) {
        db.prepare('UPDATE reup_jobs SET error = ? WHERE id = ?').run(`Dịch máy: ${error.message} — mở Dịch để làm tay`, job.id);
        note(`Video #${job.id}: dịch máy thất bại — ${error.message}`);
      }
      return; // one step per tick keeps the machine responsive
    }
    if (job.status === 'source_ready' && reviewed) {
      if (db.prepare("SELECT id FROM reup_jobs WHERE status = 'dubbing'").get()) return;
      db.prepare("UPDATE reup_jobs SET status = 'dubbing', approved = 0, error = '' WHERE id = ?").run(job.id);
      note(`Video #${job.id}: bắt đầu lồng tiếng`);
      reup.dubVietnamese(job.id).catch((error) => note(`Video #${job.id}: lồng tiếng lỗi — ${error.message}`));
      return;
    }
    if (job.status === 'review' && job.dubbed_path && !job.approved && job.auto_full === 1) {
      const problems = qualityProblems(job);
      if (problems.length) {
        db.prepare('UPDATE reup_jobs SET error = ? WHERE id = ?').run(`Cần xem lại trước khi đăng: ${problems.join('; ')}`, job.id);
        note(`Video #${job.id}: không tự duyệt — ${problems.join('; ')}`);
      } else {
        db.prepare('UPDATE reup_jobs SET approved = 1 WHERE id = ?').run(job.id);
        note(`Video #${job.id}: qua kiểm tra, tự duyệt`);
      }
    }
  }
}

function qualityProblems(job) {
  const problems = [];
  if (!fs.existsSync(job.dubbed_path)) return ['không có file video tiếng Việt'];
  let duration = null;
  try { duration = JSON.parse(fs.readFileSync(path.join(MEDIA, `${job.id}-source.download.json`), 'utf8')).duration; } catch {}
  if (duration && (duration < 10 || duration > 180)) problems.push(`độ dài ${Math.round(duration)}s ngoài 10–180s`);
  try {
    const segments = JSON.parse(fs.readFileSync(path.join(MEDIA, `${job.id}-reviewed-vi.json`), 'utf8')).segments;
    // Short music-driven clips (AI pets dancing, reactions) can have almost no speech and still work;
    // only a longer video with barely any narration suggests the speech step went wrong.
    if (segments.filter((segment) => segment.voiced !== false).length < 3 && (duration || 0) > 60) problems.push('video dài nhưng ít hơn 3 câu đọc');
    if (segments.some((segment) => !segment.text?.trim())) problems.push('còn câu chưa dịch');
  } catch { problems.push('thiếu bản dịch'); }
  return problems;
}

function publishNext(now) {
  const { postsPerDay, minGapHours, startHour, endHour, slots } = config();
  const hour = now.getHours();
  const slot = slots.length ? activeSlot(now, slots) : null;
  if (slots.length ? !slot : (hour < startHour || hour >= endHour)) return;
  if (browserBusy()) return;
  // Accounts that posted least today go first, so one busy topic never starves the others.
  const candidates = db.prepare("SELECT a.*, t.name AS topic_name FROM accounts a JOIN topics t ON t.id = a.topic_id WHERE a.status = 'active'").all()
    .map((account) => ({ ...account, recent: accounts.postsBy(account.profile_id, accounts.dayStart(now)) }))
    .sort((a, b) => a.recent.length - b.recent.length || a.id - b.id);
  for (const account of candidates) {
    const { recent } = account;
    if (recent.length >= (account.daily_limit || postsPerDay)) continue;
    if (engageBusy(account.profile_id)) continue; // that account is liking/commenting; it is free again within a minute
    // created_at is SQLite UTC text.
    const last = recent[0] && new Date(`${recent[0].created_at}Z`);
    if (slot ? (last && last >= slot) || now - slot < accounts.jitter(account.profile_id, now, SLOT_JITTER_MIN) * 60000
      : last && now - last < (minGapHours * 60 + accounts.jitter(account.profile_id, now, GAP_JITTER_MIN)) * 60000) continue;
    // Videos picked for this account first, then the topic's shared queue. Each video posts to one account only.
    const job = db.prepare(`SELECT * FROM reup_jobs j WHERE j.topic_id = ? AND j.approved = 1 AND j.status = 'review' AND j.dubbed_path != ''
      AND j.account_profile IN ('', ?)
      AND NOT EXISTS (SELECT 1 FROM reup_publications p WHERE p.job_id = j.id AND p.platform = 'tiktok' AND p.mode = 'schedule' AND p.status IN ('running', 'done'))
      ORDER BY j.account_profile = ? DESC, j.id LIMIT 1`).get(account.topic_id, account.profile_id, account.profile_id);
    if (!job || !fs.existsSync(job.dubbed_path)) continue;
    if (!job.caption?.trim()) {
      db.prepare('UPDATE reup_jobs SET caption = ? WHERE id = ?').run(autoCaption(job), job.id);
    }
    db.prepare('UPDATE reup_jobs SET account_profile = ? WHERE id = ?').run(account.profile_id, job.id);
    try {
      const id = reup.startPublication(job.id, 'tiktok', 'schedule');
      note(`Video #${job.id}: bắt đầu đăng lên TikTok (${account.topic_name} · ${account.name || account.profile_id.slice(0, 8)}, lượt #${id})`);
      return; // one post per tick; the browser is busy until it finishes
    } catch (error) {
      db.prepare('UPDATE reup_jobs SET account_profile = ? WHERE id = ?').run(job.account_profile, job.id);
      note(`Video #${job.id}: chưa đăng được — ${error.message}`);
    }
  }
}

function findPostUrl(now) {
  if (browserBusy()) return;
  const rows = db.prepare(`SELECT p.id, p.created_at, j.caption, COALESCE(NULLIF(j.account_profile, ''), t.roxy_profile_id) AS roxy_profile_id FROM reup_publications p
    JOIN reup_jobs j ON j.id = p.job_id LEFT JOIN topics t ON t.id = j.topic_id
    WHERE p.platform = 'tiktok' AND p.mode = 'schedule' AND p.status = 'done' AND p.post_url = '' AND j.topic_id IS NOT NULL ORDER BY p.id`).all();
  for (const row of rows) {
    if (engageBusy(row.roxy_profile_id)) continue;
    const tries = findTries.get(row.id) || { count: 0, last: 0 };
    if (tries.count >= FIND_ATTEMPTS || now - tries.last < FIND_RETRY_MS) continue;
    findTries.set(row.id, { count: tries.count + 1, last: now.getTime() });
    const excluded = db.prepare("SELECT post_url FROM reup_publications WHERE post_url != ''").all().map((item) => item.post_url);
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', ...(row.roxy_profile_id ? { ROXY_PROFILE_ID: row.roxy_profile_id } : {}) };
    const child = spawn(PYTHON, ['-X', 'utf8', path.join(ROOT, 'scripts', 'find_tiktok_post.py'), row.caption, '--exclude', JSON.stringify(excluded)],
      { cwd: ROOT, env, windowsHide: true });
    finding = { publicationId: row.id };
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    const timer = setTimeout(() => child.kill(), 180000);
    const done = (code) => {
      clearTimeout(timer);
      finding = null;
      const url = output.match(/POST_URL (\S+)/)?.[1];
      if (code === 0 && url) {
        affiliateComment.savePostUrl(row.id, url);
        note(`Lượt đăng #${row.id}: tìm thấy bài ${url}`);
      } else if (tries.count + 1 >= FIND_ATTEMPTS) {
        note(`Lượt đăng #${row.id}: không tìm thấy bài trong TikTok Studio sau ${FIND_ATTEMPTS} lần; dán link bài thủ công`);
      }
    };
    child.on('error', () => done(1));
    child.on('close', done);
    return;
  }
}

function attachAndComment(now) {
  const { commentDelayMin } = config();
  const ready = db.prepare(`SELECT p.id FROM reup_publications p JOIN reup_jobs j ON j.id = p.job_id
    WHERE p.platform = 'tiktok' AND p.mode = 'schedule' AND p.status = 'done' AND p.post_url != ''
    AND p.comment_url = '' AND j.shopee_affiliate_url != '' AND j.topic_id IS NOT NULL`).all();
  for (const row of ready) {
    try { affiliateComment.attachToPublication(row.id); note(`Lượt đăng #${row.id}: gắn link affiliate để bình luận`); }
    catch (error) { note(`Lượt đăng #${row.id}: ${error.message}`); }
  }
  if (browserBusy()) return;
  // Only posts made through topics: older manual posts went to other accounts.
  const pending = db.prepare(`SELECT p.id, p.created_at FROM reup_publications p JOIN reup_jobs j ON j.id = p.job_id
    WHERE p.platform = 'tiktok' AND p.mode = 'schedule' AND p.status = 'done' AND p.post_url != ''
    AND p.comment_status = 'pending' AND p.comment_error = '' AND j.topic_id IS NOT NULL ORDER BY p.id LIMIT 1`).get();
  if (!pending || now - new Date(`${pending.created_at}Z`) < commentDelayMin * 60000) return;
  if (engageBusy(profileOf(pending.id))) return;
  try { affiliateComment.runComment(pending.id); note(`Lượt đăng #${pending.id}: đang bình luận link affiliate`); }
  catch (error) { note(`Lượt đăng #${pending.id}: ${error.message}`); }
}

// Autopilot needs LUNO to post; start it from the bundled backend if it is not running.
async function ensureLuno() {
  if ((await reup.serviceStatus()).luno) return true;
  if (luno) return false;
  luno = spawn(path.join(LUNO_DIR, '.venv', 'Scripts', 'python.exe'), ['server.py'], { cwd: LUNO_DIR, env: process.env, windowsHide: true, stdio: 'ignore' });
  luno.on('close', () => { luno = null; });
  luno.on('error', (error) => { note(`Không khởi động được LUNO: ${error.message}`); luno = null; });
  note('Khởi động LUNO để đăng bài');
  return false;
}

// Plain-language reasons why nothing was posted, so "Chạy ngay" never looks silently broken.
function explain(now = new Date(), lunoUp = true) {
  const { enabled, postsPerDay, startHour, endHour } = config();
  const lines = [];
  if (!enabled) lines.push('Tự động đang tắt — tích "Bật tự động".');
  const { slots } = config();
  if (slots.length) {
    const next = slots.find((slot) => { const [h, m] = slot.split(':').map(Number); const t = new Date(now); t.setHours(h, m, 0, 0); return t > now; }) || `${slots[0]} ngày mai`;
    lines.push(activeSlot(now, slots) ? 'Đang trong khung giờ đăng.' : `Lịch đăng ${slots.join(', ')} — khung kế tiếp ${next}.`);
  } else if (now.getHours() < startHour || now.getHours() >= endHour) lines.push(`Ngoài khung giờ đăng (${startHour}h–${endHour}h).`);
  if (!lunoUp) lines.push('LUNO chưa chạy — đang khởi động, thử lại sau 1 phút.');
  for (const topic of db.prepare('SELECT * FROM topics ORDER BY id').all()) {
    const jobs = db.prepare(`SELECT j.*, EXISTS (SELECT 1 FROM reup_publications p WHERE p.job_id = j.id AND p.platform = 'tiktok'
      AND p.mode = 'schedule' AND p.status IN ('running', 'done')) AS posted FROM reup_jobs j WHERE j.topic_id = ?`).all(topic.id);
    const open = jobs.filter((job) => !job.posted);
    const ready = open.filter((job) => job.approved && job.status === 'review' && job.dubbed_path);
    const counts = {
      'chờ tải/lời thoại': open.filter((job) => ['queued', 'downloading'].includes(job.status) || (job.status === 'source_ready' && !fs.existsSync(path.join(MEDIA, `${job.id}-reviewed-vi.draft.json`)))).length,
      'chờ bạn soát bản dịch': open.filter((job) => job.status === 'source_ready' && fs.existsSync(path.join(MEDIA, `${job.id}-reviewed-vi.draft.json`)) && !fs.existsSync(path.join(MEDIA, `${job.id}-reviewed-vi.json`))).length,
      'chờ lồng tiếng': open.filter((job) => job.status === 'source_ready' && fs.existsSync(path.join(MEDIA, `${job.id}-reviewed-vi.json`))).length,
      'đang lồng tiếng': open.filter((job) => job.status === 'dubbing').length,
      'sẵn sàng, chờ bạn duyệt': open.filter((job) => job.status === 'review' && job.dubbed_path && !job.approved).length,
      'lỗi': open.filter((job) => job.status === 'failed').length
    };
    const all = db.prepare('SELECT * FROM accounts WHERE topic_id = ?').all(topic.id);
    const live = all.filter((account) => account.status === 'active');
    const full = live.filter((account) => accounts.postsBy(account.profile_id, accounts.dayStart(now)).length >= (account.daily_limit || postsPerDay));
    let line = `${topic.name}: ${ready.length} video sẵn sàng đăng`;
    const rest = Object.entries(counts).filter(([, n]) => n).map(([label, n]) => `${n} ${label}`);
    if (rest.length) line += ` · ${rest.join(' · ')}`;
    const warming = all.filter((account) => account.status === 'warming').length;
    const paused = all.filter((account) => account.status === 'paused').length;
    line += ` · ${live.length} tài khoản đang đăng${warming ? `, ${warming} đang nuôi` : ''}${paused ? `, ${paused} tạm dừng` : ''}`;
    if (live.length && full.length === live.length) line += ' · mọi tài khoản đã đủ bài hôm nay';
    lines.push(line);
  }
  return lines;
}

let ticking = false;
// Preparation (speech, translation, dubbing, products) always runs; posting and commenting
// only when "Tự động đăng" is on.
async function tick(now = new Date()) {
  if (ticking) return;
  ticking = true;
  try {
    if (config().enabled) refillChannels();
    prepareDownloads();
    await advanceFullRuns();
    assignProducts();
    await writeCaptions();
    if (!config().enabled) return;
    for (const account of accounts.checkHealth(now)) note(`Tạm dừng tài khoản ${account.name || account.profile_id}: ${account.pause_reason}`);
    attachAndComment(now);
    findPostUrl(now);
    if (await ensureLuno()) publishNext(now);
  } catch (error) {
    note(`Lỗi: ${error.message}`);
  } finally {
    ticking = false;
  }
}

function start() {
  setInterval(() => tick(), 60000).unref();
}

// "Chạy ngay": one tick, then report what happened and why nothing else could.
async function runNow() {
  const before = log[0];
  await tick();
  const actions = log.slice(0, before ? log.indexOf(before) : log.length).map((item) => item.message);
  return { ...snapshot(), actions, explanation: explain(new Date(), (await reup.serviceStatus()).luno) };
}

module.exports = { plan, upcomingSlots, channelNeed, refillChannels, qualityProblems, advanceFullRuns, config, saveConfig, snapshot, tick, start, runNow, explain, autoCaption, writeCaptions, publishNext, assignProducts, browserBusy, busyProfiles };
