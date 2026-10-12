// Long-running work (product scans, link creation) runs here so it survives the popup closing.
importScripts('shopee-page.js');

const API = 'http://127.0.0.1:3210';
const OFFERS = 'https://affiliate.shopee.vn/offer/product_offer';
const CUSTOM_LINK = 'https://affiliate.shopee.vn/offer/custom_link';
const KEYWORDS_PER_TOPIC = 4;
let busy = false;

async function request(path, options = {}) {
  const response = await fetch(API + path, { ...options, headers: { 'Content-Type': 'application/json' } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function status(text) {
  return chrome.storage.local.set({ status: { text, busy, at: Date.now() } });
}

function loaded(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') { chrome.tabs.onUpdated.removeListener(listener); resolve(); } });
  });
}

// Reuses one background tab per Shopee page so scans do not steal focus from the user.
async function shopeeTab(url, exact = false) {
  const [tab] = await chrome.tabs.query({ url: `${url}*` });
  let target = tab;
  if (!target) target = await chrome.tabs.create({ url, active: false });
  else if (exact && target.url !== url) target = await chrome.tabs.update(target.id, { url });
  await loaded(target.id);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  return target;
}

async function run(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  if (result.result?.error) throw new Error(result.result.error);
  return result.result;
}

async function scanProducts() {
  const { topics = [] } = await request('/api/douyin/discovery');
  const tab = await shopeeTab(OFFERS, true);
  let total = 0;
  for (const topic of topics) {
    const keywords = String(topic.shopee_keywords || '').split(/[,\n]/).map((word) => word.trim()).filter(Boolean).slice(0, KEYWORDS_PER_TOPIC);
    for (const keyword of keywords) {
      await status(`Đang quét "${keyword}" (${topic.name})…`);
      const { items } = await run(tab.id, scrapeOffers, [keyword]);
      total += (await request('/api/shopee-products/scan', { method: 'POST', body: JSON.stringify({ topicId: topic.id, keyword, items }) })).saved;
    }
  }
  return `Đã quét ${total} sản phẩm. Mở dashboard để gắn sản phẩm vào video.`;
}

// For each video with a picked product: read the shopee.vn URL from the offer page, then create
// the Custom Link with Sub_id1=Reup, Sub_id2=Clip<ID> exactly like the manual flow.
async function linkProducts() {
  const { jobs } = await request('/api/reup');
  const pending = jobs.filter((job) => job.shopee_item_id && !job.shopee_affiliate_url);
  if (!pending.length) return 'Không có video nào đang chờ tạo link.';
  const done = [];
  for (const job of pending) {
    await status(`Video #${job.id}: đọc link sản phẩm…`);
    const offer = await shopeeTab(`${OFFERS}/${job.shopee_item_id}`, true);
    const { url } = await run(offer.id, readProductUrl);
    await request(`/api/reup/${job.id}/affiliate/product`, { method: 'PATCH', body: JSON.stringify({ url }) });
    await status(`Video #${job.id}: tạo Custom Link…`);
    const page = await shopeeTab(CUSTOM_LINK, true);
    await run(page.id, fillShopee, [url, `Clip${job.id}`]);
    const { link } = await run(page.id, requestShopeeLink);
    await request(`/api/reup/${job.id}/affiliate/link`, { method: 'PATCH', body: JSON.stringify({ url: link }) });
    done.push(`#${job.id} ${link}`);
  }
  return `Đã tạo link: ${done.join(', ')}`;
}

// Auto mode: the dashboard's autopilot picks products; this creates their links every few minutes.
const AUTO_ALARM = 'auto-link';
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create(AUTO_ALARM, { periodInMinutes: 2 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create(AUTO_ALARM, { periodInMinutes: 2 }));
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== AUTO_ALARM || busy) return;
  const { autoLink } = await chrome.storage.local.get('autoLink');
  if (!autoLink) return;
  let pending;
  try { pending = (await request('/api/reup')).jobs.some((job) => job.shopee_item_id && !job.shopee_affiliate_url); }
  catch { return; } // dashboard not running
  if (!pending) return;
  busy = true;
  try { await status(`Tự động: ${await linkProducts()}`); }
  catch (error) { await status(`Tự động lỗi: ${error.message}`); }
  finally { busy = false; }
});

// Douyin keyword search in the user's signed-in Chrome (the headless scanner gets a captcha).
async function scanDouyin() {
  const { sources = [] } = await request('/api/douyin/discovery');
  const keywords = sources.filter((source) => source.kind === 'keyword' && source.topic_id);
  if (!keywords.length) return 'Chưa có nguồn từ khóa gắn chủ đề trong dashboard.';
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  let total = 0;
  try {
    for (const source of keywords) {
      await status(`Quét Douyin "${source.value}" (${source.topic_name})…`);
      await chrome.tabs.update(tab.id, { url: `https://www.douyin.com/search/${encodeURIComponent(source.value)}?type=video` });
      await loaded(tab.id);
      await new Promise((resolve) => setTimeout(resolve, 6000));
      const result = await run(tab.id, scrapeDouyin);
      total += (await request(`/api/douyin/discovery/sources/${source.id}/items`, { method: 'POST', body: JSON.stringify({ items: result.items }) })).kept;
      await new Promise((resolve) => setTimeout(resolve, 4000 + Math.random() * 4000));
    }
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
  return `Đã quét Douyin: ${total} video mới/cập nhật từ ${keywords.length} từ khóa.`;
}

const DOUYIN_ALARM = 'douyin-scan';
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create(DOUYIN_ALARM, { periodInMinutes: 60 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create(DOUYIN_ALARM, { periodInMinutes: 60 }));
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== DOUYIN_ALARM || busy) return;
  const { autoDouyin } = await chrome.storage.local.get('autoDouyin');
  if (!autoDouyin) return;
  busy = true;
  try { await status(`Tự động: ${await scanDouyin()}`); }
  catch (error) { await status(`Quét Douyin lỗi: ${error.message}`); }
  finally { busy = false; }
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const task = { scanProducts, linkProducts, scanDouyin }[message?.type];
  if (!task) return false;
  if (busy) { reply({ error: 'Đang chạy một tác vụ khác.' }); return false; }
  busy = true;
  reply({ started: true });
  task().then((text) => { busy = false; return status(text); })
    .catch((error) => { busy = false; return status(`Lỗi: ${error.message}`); });
  return false;
});
