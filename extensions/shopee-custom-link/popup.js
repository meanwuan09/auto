const API = 'http://127.0.0.1:3210';
const PAGE = 'https://affiliate.shopee.vn/offer/custom_link';
const $ = (id) => document.getElementById(id);
let jobs = [];

function selected() {
  return jobs.find((item) => String(item.id) === $('job').value);
}

function message(text) { $('message').textContent = text; }

async function request(path, options = {}) {
  const response = await fetch(API + path, { ...options, headers: { 'Content-Type': 'application/json' } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function refresh() {
  const data = await request('/api/reup');
  jobs = data.jobs.filter((item) => item.shopee_product_url);
  $('job').replaceChildren(...jobs.map((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `#${item.id} ${item.title || 'Video Douyin'}`;
    return option;
  }));
  $('job').disabled = jobs.length === 0;
  for (const id of ['auto', 'fill', 'read', 'save']) $(id).disabled = jobs.length === 0;
  updateDetails();
  if (!jobs.length) message('Lưu URL sản phẩm trong dashboard trước khi tạo link.');
}

function updateDetails() {
  const item = selected();
  $('details').textContent = item ? `${item.shopee_product_url}\nSub_id1: Reup · Sub_id2: Clip${item.id}` : '';
  $('affiliate').value = item?.shopee_affiliate_url || '';
}

async function pageTab(create = false) {
  const [tab] = await chrome.tabs.query({ url: `${PAGE}*` });
  if (tab) return tab;
  if (create) return chrome.tabs.create({ url: PAGE });
  throw new Error('Mở trang Custom Link trong Chrome này rồi thử lại.');
}

$('auto').addEventListener('click', async () => {
  try {
    const item = selected();
    const tab = await pageTab();
    message('Đang điền thông tin…');
    const [filled] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fillShopee, args: [item.shopee_product_url, `Clip${item.id}`] });
    if (filled.result?.error) throw new Error(filled.result.error);
    message('Đang chờ Shopee tạo link…');
    const [created] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: requestShopeeLink });
    if (created.result?.error) throw new Error(created.result.error);
    $('affiliate').value = created.result.link;
    await request(`/api/reup/${item.id}/affiliate/link`, { method: 'PATCH', body: JSON.stringify({ url: created.result.link }) });
    item.shopee_affiliate_url = created.result.link;
    message(`Đã tạo và lưu ${created.result.link} cho clip #${item.id}.`);
  } catch (error) { message(error.message); }
});

$('job').addEventListener('change', updateDetails);
$('open').addEventListener('click', async () => {
  try { await pageTab(true); message('Trang Shopee đã mở trong Chrome hiện tại.'); }
  catch (error) { message(error.message); }
});
$('fill').addEventListener('click', async () => {
  try {
    const item = selected();
    const tab = await pageTab();
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fillShopee, args: [item.shopee_product_url, `Clip${item.id}`] });
    if (result.result?.error) throw new Error(result.result.error);
    message('Đã điền URL và Sub_id. Bấm Lấy link trên trang Shopee.');
  } catch (error) { message(error.message); }
});
$('read').addEventListener('click', async () => {
  try {
    const tab = await pageTab();
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readShopeeLinks });
    const links = result.result || [];
    if (links.length !== 1) throw new Error(links.length ? `Trang có ${links.length} link; chọn đúng link và dán vào ô bên dưới.` : 'Chưa thấy link rút gọn trên trang Shopee.');
    $('affiliate').value = links[0];
    message('Đã đọc link. Kiểm tra rồi bấm Lưu vào clip.');
  } catch (error) { message(error.message); }
});
$('save').addEventListener('click', async () => {
  try {
    const item = selected();
    await request(`/api/reup/${item.id}/affiliate/link`, { method: 'PATCH', body: JSON.stringify({ url: $('affiliate').value.trim() }) });
    message(`Đã lưu link cho clip #${item.id}.`);
  } catch (error) { message(error.message); }
});

function showTask({ status } = {}) {
  if (!status) return;
  $('task-status').textContent = status.text;
  for (const id of ['scan-products', 'link-products', 'scan-douyin']) $(id).disabled = status.busy;
}

for (const [id, type] of [['scan-products', 'scanProducts'], ['link-products', 'linkProducts'], ['scan-douyin', 'scanDouyin']]) {
  $(id).addEventListener('click', async () => {
    const reply = await chrome.runtime.sendMessage({ type });
    $('task-status').textContent = reply?.error || 'Đang chạy… có thể đóng popup, tác vụ vẫn chạy nền.';
  });
}
chrome.storage.local.get(['status', 'autoLink', 'autoDouyin']).then((saved) => {
  showTask(saved);
  $('auto-link').checked = Boolean(saved.autoLink);
  $('auto-douyin').checked = Boolean(saved.autoDouyin);
});
$('auto-link').addEventListener('change', () => chrome.storage.local.set({ autoLink: $('auto-link').checked }));
$('auto-douyin').addEventListener('change', () => chrome.storage.local.set({ autoDouyin: $('auto-douyin').checked }));
chrome.storage.onChanged.addListener((changes) => { if (changes.status) showTask({ status: changes.status.newValue }); });

refresh().catch((error) => message(`Không kết nối dashboard: ${error.message}`));
