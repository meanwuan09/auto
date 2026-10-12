const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(process.env.APP_DB_PATH || path.join(DATA_DIR, 'app.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  serial TEXT PRIMARY KEY,
  name TEXT,
  resolution TEXT DEFAULT '1080x1920',
  coords TEXT DEFAULT '{}',
  status TEXT DEFAULT 'offline',
  last_post TEXT DEFAULT '',
  note TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_url TEXT DEFAULT '',
  title TEXT DEFAULT '',
  status TEXT DEFAULT 'raw',
  raw_path TEXT DEFAULT '',
  processed_path TEXT DEFAULT '',
  caption TEXT DEFAULT '',
  device_serial TEXT DEFAULT '',
  posted_at TEXT DEFAULT '',
  error TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  used_count INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS reup_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_url TEXT NOT NULL,
  rights_confirmed INTEGER NOT NULL DEFAULT 0,
  title TEXT DEFAULT '',
  caption TEXT DEFAULT '',
  source_path TEXT DEFAULT '',
  dubbed_path TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'downloading',
  approved INTEGER NOT NULL DEFAULT 0,
  tiktok_product_id TEXT DEFAULT '',
  shopee_product_query TEXT DEFAULT '',
  shopee_product_id TEXT DEFAULT '',
  error TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reup_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES reup_jobs(id),
  platform TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  batch_id TEXT DEFAULT '',
  error TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS douyin_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  rights_confirmed INTEGER NOT NULL DEFAULT 0,
  last_scan TEXT DEFAULT '',
  error TEXT DEFAULT '',
  UNIQUE(kind, value)
);
CREATE TABLE IF NOT EXISTS douyin_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES douyin_sources(id),
  source_url TEXT NOT NULL UNIQUE,
  title TEXT DEFAULT '',
  author TEXT DEFAULT '',
  likes INTEGER, comments INTEGER, shares INTEGER, views INTEGER,
  published_at INTEGER, duration REAL,
  score REAL NOT NULL DEFAULT 0,
  growth REAL,
  observed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  job_id INTEGER
);
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  roxy_profile_id TEXT DEFAULT '',
  keywords TEXT DEFAULT '',
  trend_tags TEXT DEFAULT ''
);
`);

for (const table of ['douyin_sources', 'douyin_candidates', 'reup_jobs']) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  if (!columns.has('topic_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN topic_id INTEGER REFERENCES topics(id)`);
}
db.exec(`CREATE TABLE IF NOT EXISTS shopee_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL UNIQUE,
  topic_id INTEGER REFERENCES topics(id),
  keyword TEXT DEFAULT '',
  name TEXT DEFAULT '',
  price INTEGER,
  sold INTEGER,
  commission REAL,
  scanned_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'
)`);
if (!new Set(db.prepare('PRAGMA table_info(topics)').all().map((column) => column.name)).has('shopee_keywords')) {
  db.exec("ALTER TABLE topics ADD COLUMN shopee_keywords TEXT DEFAULT ''");
}
// Chủ đề theo xu hướng TikTok VN (Creative Center, 10/2026); mỗi chủ đề đăng bằng một profile Roxy.
if (!db.prepare('SELECT id FROM topics LIMIT 1').get()) {
  const seed = db.prepare('INSERT INTO topics (name, roxy_profile_id, keywords, trend_tags) VALUES (?, ?, ?, ?)');
  seed.run('Thú cưng hài', '40e6292d2016949e03e8d81afddfd80a', '猫咪, 猫猫, 小猫, 狗狗, 小狗, 萌宠, 宠物, 喵, 柯基, 柴犬, 金毛, 布偶, 橘猫, 铲屎官', '#cat #funnycat #pets #thúcưng');
  seed.run('Mẹo nhà sạch & gia dụng', '580a7ecfb1e06522b9cca49a277d5091', '好物, 收纳, 清洁, 除垢, 家务, 家居, 小工具, 厨房神器, 家用神器, 懒人神器', '#chamsocgiadinh #taycancanxi #chinhhangsaledam');
  seed.run('Decor phòng trọ & góc làm việc', '7acd3110ce751aa1cf73ae75608dc51c', '改造, 出租屋, 房间, 桌面, 布置, 装修, 卧室, 软装', '#decorbanlamviec #phongtro #nhahiendai');
}
const SHOPEE_KEYWORDS = {
  'Thú cưng hài': 'đồ chơi cho mèo, cát vệ sinh mèo, pate cho mèo, đồ chơi cho chó',
  'Mẹo nhà sạch & gia dụng': 'tẩy cặn canxi, dụng cụ vệ sinh nhà cửa, hộp đựng đồ, đồ gia dụng thông minh',
  'Decor phòng trọ & góc làm việc': 'đèn led trang trí phòng, kệ để bàn làm việc, decor phòng ngủ, giá treo đồ'
};
for (const [name, keywords] of Object.entries(SHOPEE_KEYWORDS)) {
  db.prepare("UPDATE topics SET shopee_keywords = ? WHERE name = ? AND shopee_keywords = ''").run(keywords, name);
}

const reupColumns = new Set(db.prepare('PRAGMA table_info(reup_jobs)').all().map((column) => column.name));
for (const column of ['shopee_product_url', 'shopee_affiliate_url', 'shopee_item_id']) {
  if (!reupColumns.has(column)) db.exec(`ALTER TABLE reup_jobs ADD COLUMN ${column} TEXT DEFAULT ''`);
}
// Set by the quick button: transcribe and pick a product as soon as the download finishes.
if (!reupColumns.has('auto_prepare')) db.exec('ALTER TABLE reup_jobs ADD COLUMN auto_prepare INTEGER NOT NULL DEFAULT 0');
// "Chạy trọn gói": translate, dub and approve without a reviewer, and post from this Roxy profile.
if (!reupColumns.has('auto_full')) db.exec('ALTER TABLE reup_jobs ADD COLUMN auto_full INTEGER NOT NULL DEFAULT 0');
if (!reupColumns.has('account_profile')) db.exec("ALTER TABLE reup_jobs ADD COLUMN account_profile TEXT NOT NULL DEFAULT ''");
const publicationColumns = new Set(db.prepare('PRAGMA table_info(reup_publications)').all().map((column) => column.name));
if (!publicationColumns.has('comment_status')) db.exec("ALTER TABLE reup_publications ADD COLUMN comment_status TEXT DEFAULT 'none'");
if (!publicationColumns.has('comment_posted_at')) db.exec("ALTER TABLE reup_publications ADD COLUMN comment_posted_at TEXT DEFAULT ''");
if (!publicationColumns.has('comment_url')) db.exec("ALTER TABLE reup_publications ADD COLUMN comment_url TEXT DEFAULT ''");
if (!publicationColumns.has('post_url')) db.exec("ALTER TABLE reup_publications ADD COLUMN post_url TEXT DEFAULT ''");
if (!publicationColumns.has('comment_error')) db.exec("ALTER TABLE reup_publications ADD COLUMN comment_error TEXT DEFAULT ''");

const DEFAULT_SETTINGS = {
  adb_path: '',
  ffmpeg_path: '',
  ytdlp_path: '',
  tiktok_package: 'com.ss.android.ugc.aweme',
  scheduler_enabled: '0',
  scheduler_interval_min: '30',
  scheduler_max_posts_per_day: '20',
  tap_delay_ms: '1200',
  tap_delay_jitter_ms: '800',
  post_cooldown_min: '5',
  caption_template: 'Sản phẩm tuyệt vời! Link ở comment nhé',
  watermark_remove: '1',
  watermark_crop_px: '160'
};

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(String(key), String(value));
}

module.exports = { db, getSettings, setSetting };
