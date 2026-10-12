const { db } = require('../db');

// Shopee Affiliate's product offer page shows "20k+ lượt bán" / "1tr+ lượt bán"; keep the lower bound.
function parseSold(text) {
  const match = String(text || '').replace(/\./g, '').replace(',', '.').match(/([\d.]+)\s*(k|tr)?/i);
  if (!match) return null;
  const unit = { k: 1e3, tr: 1e6 }[match[2]?.toLowerCase()] || 1;
  return Math.round(Number(match[1]) * unit);
}

function parsePrice(text) {
  const digits = String(text || '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

function parseCommission(text) {
  const match = String(text || '').match(/([\d.,]+)\s*%/);
  return match ? Number(match[1].replace(',', '.')) : null;
}

// Commission per sale weighted by proven demand; products nobody buys rank last. TikTok viewers
// buy cheap items on impulse, so commission above 15.000đ/order stops adding to the score.
function score(product) {
  if (!product.commission || !product.price) return 0;
  const perOrder = Math.min(15000, product.price * product.commission / 100);
  return Math.round(perOrder * Math.log10(1 + (product.sold || 0)) ** 2);
}

function saveScan(topicId, keyword, items, now = new Date()) {
  const topic = db.prepare('SELECT id FROM topics WHERE id = ?').get(topicId);
  if (!topic) throw new Error('Không có chủ đề này');
  if (!Array.isArray(items) || items.length > 100) throw new Error('Danh sách sản phẩm không hợp lệ');
  let saved = 0;
  for (const item of items) {
    const itemId = String(item.itemId || '');
    if (!/^\d{5,20}$/.test(itemId)) continue;
    db.prepare(`INSERT INTO shopee_products (item_id, topic_id, keyword, name, price, sold, commission, scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET topic_id = excluded.topic_id, keyword = excluded.keyword, name = excluded.name,
      price = excluded.price, sold = excluded.sold, commission = excluded.commission, scanned_at = excluded.scanned_at`)
      .run(itemId, topic.id, String(keyword || '').slice(0, 100), String(item.name || '').slice(0, 300),
        parsePrice(item.price), parseSold(item.sold), parseCommission(item.commission), now.toISOString());
    saved += 1;
  }
  return { saved };
}

function list() {
  return db.prepare(`SELECT p.*, t.name AS topic_name FROM shopee_products p LEFT JOIN topics t ON t.id = p.topic_id
    WHERE p.status = 'new'`).all().map((product) => ({ ...product, score: score(product) }))
    .sort((a, b) => b.score - a.score).slice(0, 200);
}

function dismiss(id) {
  db.prepare("UPDATE shopee_products SET status = 'dismissed' WHERE id = ?").run(id);
}

// Picking a different product drops the old product URL and link so the extension regenerates both.
function assign(jobId, productId) {
  const job = db.prepare('SELECT id, shopee_item_id FROM reup_jobs WHERE id = ?').get(jobId);
  if (!job) throw new Error('Không có video');
  const product = db.prepare('SELECT * FROM shopee_products WHERE id = ?').get(productId);
  if (!product) throw new Error('Không có sản phẩm này');
  if (job.shopee_item_id !== product.item_id) {
    db.prepare(`UPDATE reup_jobs SET shopee_item_id = ?, shopee_product_url = '', shopee_affiliate_url = '',
      shopee_product_query = ? WHERE id = ?`).run(product.item_id, product.name.slice(0, 200), jobId);
  }
  return db.prepare('SELECT * FROM reup_jobs WHERE id = ?').get(jobId);
}

// Best-scoring product of the job's topic, preferring one no other video promotes yet.
function pickFor(jobId) {
  const job = db.prepare('SELECT id, topic_id, shopee_item_id FROM reup_jobs WHERE id = ?').get(jobId);
  if (!job?.topic_id || job.shopee_item_id) return null;
  const used = new Set(db.prepare("SELECT shopee_item_id FROM reup_jobs WHERE shopee_item_id != ''").all().map((row) => row.shopee_item_id));
  const candidates = list().filter((product) => product.topic_id === job.topic_id && product.score > 0);
  const product = candidates.find((item) => !used.has(item.item_id)) || candidates[0];
  if (!product) return null;
  assign(job.id, product.id);
  return product;
}

module.exports = { parseSold, parsePrice, parseCommission, score, saveScan, list, dismiss, assign, pickFor };
