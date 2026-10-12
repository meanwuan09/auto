const { getSettings, db } = require('../db');
const adb = require('./adb');
const path = require('path');
const { validateCaption } = require('./affiliate-comment');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

const DEFAULT_COORDS_FRACTION = {
  create_btn: [0.5, 0.94],
  gallery_tab: [0.5, 0.93],
  first_video: [0.17, 0.18],
  next_btn: [0.85, 0.05],
  caption_box: [0.5, 0.2],
  post_btn: [0.88, 0.05],
  profile_tab: [0.08, 0.95],
  first_video_profile: [0.5, 0.55],
  comment_box: [0.5, 0.93],
  comment_input: [0.5, 0.97],
  send_btn: [0.9, 0.97]
};

function parseResolution(device) {
  const [w, h] = (device.resolution || '1080x1920').toLowerCase().split('x').map(Number);
  return { w: w || 1080, h: h || 1920 };
}

function getCoords(device, step) {
  const { w, h } = parseResolution(device);
  let overrides = {};
  try { overrides = JSON.parse(device.coords || '{}'); } catch { overrides = {}; }
  if (overrides[step]) {
    if (typeof overrides[step] === 'number') {
      throw new Error(`Tọa độ step ${step} phải là [x,y]`);
    }
    return overrides[step];
  }
  const f = DEFAULT_COORDS_FRACTION[step];
  if (!f) throw new Error(`Không có tọa độ cho step ${step}`);
  return [Math.round(f[0] * w), Math.round(f[1] * h)];
}

function pickLink() {
  const rows = db.prepare('SELECT * FROM links ORDER BY used_count ASC, RANDOM() LIMIT 5').all();
  if (!rows.length) return null;
  rows.sort((a, b) => a.used_count - b.used_count);
  return rows[0];
}

async function waitAndTap(device, step, s) {
  const delay = parseInt(s.tap_delay_ms, 10) || 1200;
  const jitter = parseInt(s.tap_delay_jitter_ms, 10) || 800;
  await sleep(rand(delay, delay + jitter));
  const [x, y] = getCoords(device, step);
  await adb.tap(device.serial, x, y);
}

async function postVideo(device, video) {
  const s = getSettings();
  const caption = video.caption || s.caption_template || '';
  validateCaption(caption);
  const serial = device.serial;
  const pkg = s.tiktok_package;
  const log = (m) => console.log(`[${device.name || serial}] ${m}`);

  const installed = await adb.isAppInstalled(serial, pkg);
  if (!installed) throw new Error(`TikTok (${pkg}) chưa cài trên ${serial}. Cài thủ công trước.`);

  const base = path.basename(video.processed_path || video.raw_path || '');
  const remote = `/sdcard/DCIM/Camera/${Date.now()}_${base}`;
  log('Mở TikTok...');
  await adb.openApp(serial, pkg);
  await waitAndTap(device, 'create_btn', s);

  log('Chọn gallery...');
  await waitAndTap(device, 'gallery_tab', s);

  log(`Push video ${base} lên máy...`);
  await adb.pushFile(serial, video.processed_path || video.raw_path, remote);
  await adb.adb(serial, 'shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${remote}`).catch(() => {});
  await sleep(rand(2500, 4000));

  await waitAndTap(device, 'first_video', s);
  await waitAndTap(device, 'next_btn', s);

  if (caption) {
    log('Nhập mô tả...');
    await waitAndTap(device, 'caption_box', s);
    await sleep(rand(500, 1200));
    await adb.inputText(serial, caption);
  }

  log('Đăng video...');
  await waitAndTap(device, 'post_btn', s);
  await sleep(rand(4000, 7000));

  log('Vào profile lấy video vừa đăng...');
  await adb.home(serial);
  await sleep(rand(1200, 2000));
  await adb.openApp(serial, pkg);
  await waitAndTap(device, 'profile_tab', s);
  await waitAndTap(device, 'first_video_profile', s);

  const link = pickLink();
  if (link) {
    await commentOnVideo(device, link);
    log(`Đã cmt link: ${link.content}`);
  } else {
    log('Không có link affiliate trong pool, bỏ qua cmt.');
  }

  db.prepare('UPDATE videos SET status = ?, posted_at = ? WHERE id = ?').run('posted', new Date().toISOString(), video.id);
  db.prepare('UPDATE devices SET status = ?, last_post = ? WHERE serial = ?').run('online', new Date().toISOString(), serial);
  log('HOÀN TẤT đăng video + cmt.');
  return { ok: true, link: link ? link.content : null };
}

async function commentOnVideo(device, selectedLink = null) {
  const s = getSettings();
  const serial = device.serial;
  const link = selectedLink || pickLink();
  if (!link) return null;
  await waitAndTap(device, 'comment_box', s);
  await waitAndTap(device, 'comment_input', s);
  await sleep(rand(800, 1500));
  await adb.inputText(serial, link.content);
  await sleep(rand(500, 1000));
  await waitAndTap(device, 'send_btn', s);
  db.prepare('UPDATE links SET used_count = used_count + 1 WHERE id = ?').run(link.id);
  return link;
}

module.exports = { postVideo, commentOnVideo, getCoords, DEFAULT_COORDS_FRACTION, pickLink, sleep, rand };
