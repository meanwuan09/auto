const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');

const openApiUrl = () => process.env.SHOPEE_AFFILIATE_API || 'https://open-api.affiliate.shopee.vn/graphql';
const openApiFile = () => process.env.SHOPEE_OPENAPI_FILE || path.join(__dirname, '..', '..', 'data', 'shopee-openapi.json');

function shopeeUrl(value, label) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error(`${label} phải là URL Shopee hợp lệ`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['shopee.vn', 'www.shopee.vn', 's.shopee.vn', 'shope.ee'].includes(url.hostname)) {
    throw new Error(`${label} phải là URL HTTPS thuộc Shopee`);
  }
  return url.href;
}

function trackingIds(jobId) {
  return { subId1: 'Reup', subId2: `Clip${Number(jobId)}` };
}

function saveProduct(jobId, productUrl) {
  const url = shopeeUrl(productUrl, 'Link sản phẩm');
  const current = db.prepare('SELECT shopee_product_url FROM reup_jobs WHERE id = ?').get(jobId);
  if (!current) throw new Error('Không có video');
  db.prepare(`UPDATE reup_jobs SET shopee_product_url = ?,
    shopee_affiliate_url = CASE WHEN shopee_product_url = ? THEN shopee_affiliate_url ELSE '' END
    WHERE id = ?`).run(url, url, jobId);
  return { productUrl: url, ...trackingIds(jobId) };
}

function saveAffiliate(jobId, affiliateUrl) {
  const url = shopeeUrl(affiliateUrl, 'Link affiliate');
  if (!['s.shopee.vn', 'shope.ee'].includes(new URL(url).hostname)) {
    throw new Error('Dán link rút gọn Shopee trả về từ Custom Link');
  }
  const current = db.prepare('SELECT shopee_product_url FROM reup_jobs WHERE id = ?').get(jobId);
  if (!current) throw new Error('Không có video');
  if (!current.shopee_product_url) throw new Error('Cần lưu link sản phẩm trước');
  // The link only goes in a comment, never into the video, so the reviewed video stays approved.
  db.prepare('UPDATE reup_jobs SET shopee_affiliate_url = ? WHERE id = ?').run(url, jobId);
  return { affiliateUrl: url, ...trackingIds(jobId) };
}

function openApiCredentials() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(openApiFile(), 'utf8')); } catch {}
  const appId = String(process.env.SHOPEE_AFFILIATE_APP_ID || file.appId || '').trim();
  const secret = String(process.env.SHOPEE_AFFILIATE_SECRET || file.secret || '').trim();
  return appId && secret ? { appId, secret } : null;
}

// Shopee Affiliate Open API: Authorization is SHA256 over AppId + Timestamp + Payload + Secret.
function signedRequest({ appId, secret }, payload, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = crypto.createHash('sha256').update(`${appId}${timestamp}${payload}${secret}`).digest('hex');
  return { 'Content-Type': 'application/json', Authorization: `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}` };
}

async function generateAffiliate(jobId) {
  const current = db.prepare('SELECT shopee_product_url FROM reup_jobs WHERE id = ?').get(jobId);
  if (!current) throw new Error('Không có video');
  if (!current.shopee_product_url) throw new Error('Cần lưu link sản phẩm trước');
  const credentials = openApiCredentials();
  if (!credentials) throw new Error('Chưa cấu hình Shopee Open API (data/shopee-openapi.json). Dùng tiện ích Chrome để tạo link.');
  const { subId1, subId2 } = trackingIds(jobId);
  const payload = JSON.stringify({
    query: `mutation{generateShortLink(input:{originUrl:${JSON.stringify(current.shopee_product_url)},subIds:${JSON.stringify([subId1, subId2])}}){shortLink}}`
  });
  const response = await fetch(openApiUrl(), { method: 'POST', headers: signedRequest(credentials, payload), body: payload, signal: AbortSignal.timeout(20000) });
  const body = await response.json().catch(() => ({}));
  const shortLink = body?.data?.generateShortLink?.shortLink;
  if (!response.ok || !shortLink) {
    const error = body?.errors?.[0];
    throw new Error(`Shopee Open API: ${error?.extensions?.message || error?.message || `HTTP ${response.status}`}`);
  }
  return saveAffiliate(jobId, shortLink);
}

module.exports = { shopeeUrl, trackingIds, saveProduct, saveAffiliate, openApiCredentials, signedRequest, generateAffiliate };
