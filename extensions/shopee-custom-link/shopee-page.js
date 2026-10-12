// Functions injected into Shopee Affiliate tabs with chrome.scripting; each must be self-contained.
// Loaded by popup.html and by background.js (importScripts).

function fillShopee(productUrl, subId) {
  const textarea = document.querySelector('textarea');
  if (!textarea) return { error: 'Không thấy ô nhập URL. Kiểm tra tài khoản đã đăng nhập và trang Custom Link đã tải xong.' };
  const setValue = (element, value) => {
    const setter = Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  setValue(textarea, productUrl);
  const inputs = [...document.querySelectorAll('input:not([type=hidden])')];
  for (const [index, value] of [[1, 'Reup'], [2, subId]]) {
    const label = [...document.querySelectorAll('label, div, span')].find((element) => element.children.length === 0 && element.textContent.trim().toLowerCase() === `sub_id${index}`);
    let input = label?.closest('label')?.querySelector('input') || label?.parentElement?.querySelector('input') || label?.nextElementSibling?.querySelector('input');
    if (!input) input = inputs.find((candidate) => candidate.placeholder?.toLowerCase().includes(index === 1 ? 'sportshoes' : 'instagramfeed'));
    if (!input) return { error: `Đã điền URL nhưng không tìm thấy ô Sub_id${index}.` };
    setValue(input, value);
  }
  return { ok: true };
}

function readShopeeLinks() {
  const matches = new Set();
  const pattern = /https:\/\/(?:s\.shopee\.vn|shope\.ee)\/[A-Za-z0-9_?=&%./-]+/g;
  for (const element of document.querySelectorAll('a[href], input, textarea')) {
    for (const value of [element.href, element.value, element.textContent]) {
      if (!value) continue;
      for (const match of value.match(pattern) || []) matches.add(match.replace(/[.,;)]$/, ''));
    }
  }
  for (const match of document.body.innerText.match(pattern) || []) matches.add(match.replace(/[.,;)]$/, ''));
  return [...matches];
}

// Runs in the Shopee tab after fillShopee: presses "Lấy link" and waits for the short link in the result dialog.
async function requestShopeeLink() {
  const pattern = /https:\/\/(?:s\.shopee\.vn|shope\.ee)\/[A-Za-z0-9]+/;
  const dialogLink = () => {
    for (const dialog of document.querySelectorAll('[role=dialog], .shopee-modal, [class*=modal]')) {
      if (!dialog.offsetParent && getComputedStyle(dialog).position !== 'fixed') continue;
      for (const element of dialog.querySelectorAll('textarea, input, a[href]')) {
        const match = (element.value || element.href || '').match(pattern);
        if (match) return { link: match[0], element };
      }
      const match = dialog.innerText.match(pattern);
      if (match) return { link: match[0] };
    }
    return null;
  };
  const before = dialogLink()?.link;
  const button = [...document.querySelectorAll('button')].find((element) => element.textContent.trim().toLowerCase() === 'lấy link');
  if (!button) return { error: 'Không thấy nút Lấy link trên trang Shopee.' };
  button.click();
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const found = dialogLink();
    if (found && found.link !== before) return { link: found.link };
  }
  return { error: 'Shopee chưa trả link sau 20 giây. Kiểm tra trang (có thể cần xác minh) rồi bấm Đọc link vừa tạo.' };
}

// Product offer list: type the keyword into Shopee's own search box and read the first page of results.
async function scrapeOffers(keyword) {
  const input = document.querySelector('input.ant-input-lg') || document.querySelector('input[placeholder*="Tìm kiếm"]');
  if (!input) return { error: 'Không thấy ô tìm kiếm sản phẩm. Kiểm tra đã đăng nhập Shopee Affiliate.' };
  const firstName = () => document.querySelector('.ItemCard__name')?.textContent || '';
  const before = firstName();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, keyword);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  for (const type of ['keydown', 'keypress', 'keyup']) {
    input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  }
  for (let i = 0; i < 30 && firstName() === before; i += 1) await new Promise((resolve) => setTimeout(resolve, 500));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const items = [...document.querySelectorAll('.ItemCard__contentSection')].map((card) => ({
    itemId: card.closest('a[href*="/offer/product_offer/"]')?.getAttribute('href').match(/product_offer\/(\d+)/)?.[1],
    name: card.querySelector('.ItemCard__name')?.textContent.trim(),
    price: card.querySelector('.ItemCardPrice__wrap .price')?.textContent,
    sold: card.querySelector('.ItemCardSold__wrap')?.textContent,
    commission: card.querySelector('.commRate')?.textContent
  })).filter((item) => item.itemId && item.name);
  return items.length ? { items } : { error: `Không đọc được sản phẩm cho "${keyword}".` };
}

// Product offer detail page links to the real shopee.vn product, which Custom Link needs.
async function readProductUrl() {
  for (let i = 0; i < 30; i += 1) {
    const link = [...document.querySelectorAll('a[href]')].map((a) => a.href).find((href) => /^https:\/\/shopee\.vn\/product\/\d+\/\d+/.test(href));
    if (link) return { url: link.split('?')[0] };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { error: 'Không thấy link sản phẩm Shopee trên trang chi tiết.' };
}

// Douyin search results (video tab): each card reads "duration, likes, title, @author, age".
// Works whether or not Chrome auto-translates the page.
async function scrapeDouyin() {
  for (let i = 0; i < 3; i += 1) {
    window.scrollBy(0, 1600);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (/验证码|captcha/i.test(document.title)) return { error: 'Douyin yêu cầu xác minh (captcha) — mở douyin.com trong Chrome để xác minh.' };
  const count = (text) => {
    const match = String(text).replace(/,/g, '').match(/^([\d.]+)\s*(万|w|k|m)?$/i);
    if (!match) return null;
    const unit = { '万': 1e4, w: 1e4, k: 1e3, m: 1e6 }[(match[2] || '').toLowerCase()] || 1;
    return Math.round(Number(match[1]) * unit);
  };
  const age = (text) => {
    const match = String(text).match(/(\d+)\s*(分钟|小时|天|周|月|年|minute|hour|day|week|month|year)/i);
    if (!match) return null;
    const unit = { 分钟: 60, minute: 60, 小时: 3600, hour: 3600, 天: 86400, day: 86400, 周: 604800, week: 604800, 月: 2592000, month: 2592000, 年: 31536000, year: 31536000 }[match[2].toLowerCase()];
    return Math.floor(Date.now() / 1000) - Number(match[1]) * unit;
  };
  const items = new Map();
  for (const link of document.querySelectorAll('a[href*="/video/"]')) {
    const id = link.getAttribute('href').match(/\/video\/(\d{15,25})/)?.[1];
    if (!id || items.has(id)) continue;
    const lines = link.innerText.split('\n').map((line) => line.trim()).filter(Boolean);
    const durationLine = lines.find((line) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(line));
    const duration = durationLine ? durationLine.split(':').reduce((total, part) => total * 60 + Number(part), 0) : null;
    const likes = lines.map(count).find((value) => value !== null) ?? null;
    const title = lines.filter((line) => line !== durationLine && count(line) === null && !line.startsWith('@') && !age(line) && !/^(合集|Collection)$/i.test(line))
      .sort((a, b) => b.length - a.length)[0] || '';
    // Image posts and the unrelated suggestions Douyin appends lower down carry no video length.
    if (!duration) continue;
    items.set(id, { url: `https://www.douyin.com/video/${id}`, title: title.slice(0, 250), likes, duration, createdAt: lines.map(age).find(Boolean) || null });
  }
  return { items: [...items.values()].slice(0, 60) };
}
