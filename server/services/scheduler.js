const { getSettings, db } = require('../db');
const adb = require('./adb');
const { postVideo } = require('./poster');

let timer = null;
let running = false;

function postsToday(serial) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM videos WHERE device_serial = ? AND posted_at >= ? AND status = 'posted'"
  ).get(serial, start.toISOString());
  return row.c;
}

async function schedulerTick() {
  const s = getSettings();
  if (s.scheduler_enabled !== '1') return;
  if (running) return;
  running = true;
  try {
    const devices = db.prepare('SELECT * FROM devices').all();
    const live = await adb.listDevices().catch(() => []);
    const liveSerials = new Set(live.filter((d) => d.state === 'device').map((d) => d.serial));

    for (const device of devices) {
      if (!liveSerials.has(device.serial)) continue;
      if (device.status === 'busy') continue;
      const maxPerDay = parseInt(s.scheduler_max_posts_per_day, 10) || 20;
      if (postsToday(device.serial) >= maxPerDay) continue;
      const cooldown = parseInt(s.post_cooldown_min, 10) || 5;
      if (device.last_post && (Date.now() - new Date(device.last_post).getTime()) < cooldown * 60000) continue;

      const video = db.prepare("SELECT * FROM videos WHERE status = 'ready' AND device_serial = '' ORDER BY id ASC LIMIT 1").get();
      if (!video) break;

      db.prepare("UPDATE videos SET status = 'posting', device_serial = ? WHERE id = ?").run(device.serial, video.id);
      db.prepare("UPDATE devices SET status = 'busy' WHERE serial = ?").run(device.serial);
      console.log(`[scheduler] Đang đăng video #${video.id} lên ${device.serial}...`);
      try {
        await postVideo(device, video);
      } catch (e) {
        console.error(`[scheduler] Lỗi đăng #${video.id}: ${e.message}`);
        db.prepare("UPDATE videos SET status = 'ready', device_serial = '' WHERE id = ?").run(video.id);
        db.prepare("UPDATE devices SET status = 'online' WHERE serial = ?").run(device.serial);
      }
    }
  } catch (e) {
    console.error('[scheduler] Lỗi tick: ' + e.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(schedulerTick, 60000);
  console.log('[scheduler] Đã bật (check mỗi 60s)');
  schedulerTick();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[scheduler] Đã tắt');
  }
}

module.exports = { start, stop, schedulerTick, postsToday };