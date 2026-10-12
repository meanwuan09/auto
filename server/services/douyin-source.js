function normalizeDouyinUrl(input) {
  const matches = String(input || '').match(/https:\/\/[^\s<>"']+/gi) || [];
  const urls = matches.map((value) => value.replace(/[),.;\u3002\uff0c]+$/, ''));
  const candidate = urls.find((value) => {
    try { return ['douyin.com', 'www.douyin.com', 'v.douyin.com'].includes(new URL(value).hostname); }
    catch { return false; }
  });
  if (!candidate) throw new Error('Cần link video Douyin HTTPS hợp lệ');
  const url = new URL(candidate);
  if (url.username || url.password || url.port) throw new Error('Link Douyin không hợp lệ');
  const id = url.pathname.match(/^\/video\/(\d+)\/?$/)?.[1] || url.searchParams.get('modal_id');
  if (id && /^\d{15,25}$/.test(id)) return `https://www.douyin.com/video/${id}`;
  if (url.hostname === 'v.douyin.com' && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
    return `https://v.douyin.com${url.pathname.replace(/\/?$/, '/')}`;
  }
  throw new Error('Cần link video hoặc link chia sẻ v.douyin.com');
}

module.exports = { normalizeDouyinUrl };
