const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');

function server(handler) {
  const instance = http.createServer(handler);
  return new Promise((resolve) => instance.listen(0, '127.0.0.1', () => resolve(instance)));
}

function json(res, body) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

test('Douyin import, Vietnamese dubbing, approval and Shopee draft', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-reup-test-'));
  process.env.APP_DB_PATH = path.join(temp, 'test.db');
  process.env.REUP_MEDIA_DIR = path.join(temp, 'media');
  process.env.DOUYIN_DOWNLOAD_MODE = 'api';

  const dtk = await server((req, res) => {
    const route = req.url;
    if (route === '/api/v1/parse') return json(res, { success: true, data: { task_id: 'parse-1' } });
    if (route === '/api/v1/tasks/parse-1') return json(res, { success: true, data: { state: 'done', data: { platform: 'douyin', content_id: '1234567890123456789' } } });
    if (route === '/api/v1/downloads' && req.method === 'POST') return json(res, { success: true, data: { download_id: 'download-1' } });
    if (route === '/api/v1/downloads/download-1') return json(res, { success: true, data: { state: 'done', files: [{ kind: 'video', name: 'video.mp4' }] } });
    if (route === '/api/v1/downloads/download-1/files/video.mp4') return res.end('source mp4');
    res.writeHead(404).end();
  });
  let vlState = 'idle';
  const vl = await server((req, res) => {
    if (req.url === '/status') return json(res, { state: vlState, active: false, files: vlState === 'completed' ? ['output_dub.mp4'] : [] });
    if (req.url === '/input') { vlState = 'completed'; res.statusCode = 202; return json(res, { accepted: true }); }
    if (req.url === '/run') { vlState = 'completed'; res.statusCode = 202; return json(res, { accepted: true }); }
    if (req.url === '/files/output_dub.mp4') return res.end('dubbed mp4');
    res.writeHead(404).end();
  });
  let publishBody;
  const luno = await server((req, res) => {
    if (req.url === '/shopee/batch/run' || req.url === '/batch/run') {
      let text = '';
      req.on('data', (chunk) => { text += chunk; });
      req.on('end', () => { publishBody = JSON.parse(text); json(res, { batch_id: 'batch-1' }); });
      return;
    }
    res.writeHead(404).end();
  });
  const ws = new WebSocketServer({ server: luno, path: '/ws/batch/batch-1' });
  ws.on('connection', (socket) => setTimeout(() => socket.send(JSON.stringify({ type: 'video_done', status: 'success' })), 10));
  t.after(async () => {
    await new Promise((resolve) => ws.close(resolve));
    await Promise.all([dtk, vl, luno].map((item) => new Promise((resolve) => item.close(resolve))));
    fs.rmSync(temp, { recursive: true, force: true });
  });

  process.env.DTK_BASE_URL = `http://127.0.0.1:${dtk.address().port}`;
  process.env.VIDEOLINGO_BASE_URL = `http://127.0.0.1:${vl.address().port}`;
  process.env.LUNO_BASE_URL = `http://127.0.0.1:${luno.address().port}`;
  const { db } = require('../server/db');
  const reup = require('../server/services/reup');
  const id = Number(db.prepare("INSERT INTO reup_jobs (source_url, rights_confirmed, status) VALUES (?, 1, 'downloading')").run('https://www.douyin.com/video/1234567890123456789').lastInsertRowid);

  await reup.importDouyin(id);
  assert.equal(reup.job(id).status, 'source_ready');
  assert.equal(fs.readFileSync(reup.job(id).source_path, 'utf8'), 'source mp4');

  await reup.dubVietnamese(id);
  assert.equal(reup.job(id).status, 'review');
  assert.equal(fs.readFileSync(reup.job(id).dubbed_path, 'utf8'), 'dubbed mp4');

  assert.throws(() => reup.startPublication(id, 'shopee', 'draft'), /duyệt/);
  db.prepare("UPDATE reup_jobs SET approved = 1 WHERE id = ?").run(id);
  assert.throws(() => reup.startPublication(id, 'shopee', 'draft'), /caption/);
  db.prepare("UPDATE reup_jobs SET caption = 'Đã kiểm tra' WHERE id = ?").run(id);
  assert.throws(() => reup.startPublication(id, 'shopee', 'draft'), /Thiếu/);
  db.prepare("UPDATE reup_jobs SET caption = 'Đã kiểm tra', shopee_product_query = 'Sản phẩm A', shopee_product_id = '123', approved = 1 WHERE id = ?").run(id);
  const publicationId = reup.startPublication(id, 'shopee', 'draft');
  for (let i = 0; i < 30; i++) {
    if (db.prepare('SELECT status FROM reup_publications WHERE id = ?').get(publicationId).status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(db.prepare('SELECT status FROM reup_publications WHERE id = ?').get(publicationId).status, 'done');
  assert.equal(db.prepare('SELECT comment_status FROM reup_publications WHERE id = ?').get(publicationId).comment_status, 'none');
  assert.equal(publishBody.jobs[0].product_id, '123');
  assert.equal(publishBody.mode, 'draft');
  const { normalizeDouyinUrl } = require('../server/services/douyin-source');
  assert.equal(normalizeDouyinUrl('Chia sẻ https://www.douyin.com/jingxuan?modal_id=1234567890123456789'), 'https://www.douyin.com/video/1234567890123456789');
  assert.equal(normalizeDouyinUrl('https://v.douyin.com/AbCd/'), 'https://v.douyin.com/AbCd/');
  assert.throws(() => normalizeDouyinUrl('https://douyin.com.evil.test/video/1234567890123456789'));
  assert.throws(() => normalizeDouyinUrl('https://www.douyin.com/user/someone'));
  const count = db.prepare('SELECT COUNT(*) AS n FROM reup_jobs').get().n;
  assert.throws(() => reup.enqueueImports(['https://www.douyin.com/video/1234567890123456790', 'invalid']));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reup_jobs').get().n, count);
  const batch = reup.enqueueImports([
    'https://www.douyin.com/jingxuan?modal_id=1234567890123456789',
    'https://www.douyin.com/video/1234567890123456790',
    'https://www.douyin.com/video/1234567890123456790'
  ]);
  assert.deepEqual(batch.skipped, [id]);
  assert.equal(batch.ids.length, 1);
  await reup.drainDownloads();
  assert.equal(reup.job(batch.ids[0]).status, 'source_ready');
  const affiliate = require('../server/services/shopee-affiliate');
  assert.throws(() => affiliate.saveProduct(id, 'https://shopee.vn.evil.test/item'), /Shopee/);
  assert.throws(() => affiliate.saveAffiliate(id, 'https://s.shopee.vn/abc'), /sản phẩm/);
  assert.deepEqual(affiliate.saveProduct(id, 'https://shopee.vn/product/123/456'), {
    productUrl: 'https://shopee.vn/product/123/456', subId1: 'Reup', subId2: `Clip${id}`
  });
  assert.throws(() => affiliate.saveAffiliate(id, 'https://shopee.vn/product/123/456'), /rút gọn/);
  affiliate.saveAffiliate(id, 'https://s.shopee.vn/abc');
  assert.equal(reup.job(id).shopee_affiliate_url, 'https://s.shopee.vn/abc');
  db.prepare('UPDATE reup_jobs SET approved = 1 WHERE id = ?').run(id);
  const comments = require('../server/services/affiliate-comment');
  assert.throws(() => comments.validateCaption('Xem https://s.shopee.vn/abc'), /bình luận/);
  assert.throws(() => comments.commentForPublication(publicationId), /chưa được đăng thật/);
  db.prepare("UPDATE reup_jobs SET caption = 'Mua tại https://s.shopee.vn/abc' WHERE id = ?").run(id);
  assert.throws(() => reup.startPublication(id, 'shopee', 'schedule'), /bình luận/);
  db.prepare("UPDATE reup_jobs SET caption = 'Đã kiểm tra' WHERE id = ?").run(id);
  const liveId = reup.startPublication(id, 'shopee', 'schedule');
  for (let i = 0; i < 30; i++) {
    if (db.prepare('SELECT status FROM reup_publications WHERE id = ?').get(liveId).status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(db.prepare('SELECT status FROM reup_publications WHERE id = ?').get(liveId).status, 'done');
  assert.equal(db.prepare('SELECT comment_status FROM reup_publications WHERE id = ?').get(liveId).comment_status, 'pending');
  assert.equal(publishBody.jobs[0].caption, 'Đã kiểm tra');
  assert.equal(JSON.stringify(publishBody).includes('s.shopee.vn'), false);
  affiliate.saveProduct(id, 'https://shopee.vn/product/123/789');
  assert.equal(reup.job(id).shopee_affiliate_url, '');
  assert.equal(comments.commentForPublication(liveId).comment, 'https://s.shopee.vn/abc');
  assert.equal(comments.markCommentPosted(liveId).status, 'posted');
  const postedAt = db.prepare('SELECT comment_posted_at FROM reup_publications WHERE id = ?').get(liveId).comment_posted_at;
  assert.ok(postedAt);
  comments.markCommentPosted(liveId);
  assert.equal(db.prepare('SELECT comment_posted_at FROM reup_publications WHERE id = ?').get(liveId).comment_posted_at, postedAt);
  assert.equal(reup.job(id).shopee_affiliate_url, '');
  const discovery = require('../server/services/douyin-discovery');
  assert.throws(() => comments.attachToPublication(liveId), /Custom Link/);
  affiliate.saveAffiliate(id, 'https://s.shopee.vn/new');
  assert.throws(() => comments.attachToPublication(liveId), /đã có link/);
  const laterPost = Number(db.prepare(`INSERT INTO reup_publications
    (job_id, platform, mode, status, comment_url, comment_status)
    VALUES (?, 'tiktok', 'schedule', 'done', '', 'none')`).run(id).lastInsertRowid);
  assert.equal(comments.attachToPublication(laterPost).comment, 'https://s.shopee.vn/new');
  assert.throws(() => comments.attachToPublication(laterPost), /đã có link/);
  assert.throws(() => comments.savePostUrl(laterPost, 'https://www.tiktok.com.evil.test/@a/video/1'), /Link bài TikTok/);
  assert.equal(comments.savePostUrl(laterPost, 'https://www.tiktok.com/@wuan0409/video/7695207790079511815/?lang=vi').postUrl,
    'https://www.tiktok.com/@wuan0409/video/7695207790079511815');
  assert.throws(() => comments.savePostUrl(publicationId, 'https://www.tiktok.com/@a/video/1'), /đã đăng thật/);
  assert.equal(comments.commentRunning(), null);

  process.env.SHOPEE_OPENAPI_FILE = path.join(temp, 'missing-openapi.json');
  await assert.rejects(affiliate.generateAffiliate(id), /Open API/);
  const expected = require('crypto').createHash('sha256').update('app11700000000{"q":1}secret').digest('hex');
  assert.equal(affiliate.signedRequest({ appId: 'app1', secret: 'secret' }, '{"q":1}', 1700000000).Authorization,
    `SHA256 Credential=app1, Timestamp=1700000000, Signature=${expected}`);
  let openApiRequest;
  const openApi = await server((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { openApiRequest = { headers: req.headers, body }; json(res, { data: { generateShortLink: { shortLink: 'https://s.shopee.vn/api1' } } }); });
  });
  t.after(() => openApi.close());
  process.env.SHOPEE_AFFILIATE_API = `http://127.0.0.1:${openApi.address().port}/graphql`;
  process.env.SHOPEE_AFFILIATE_APP_ID = 'app1';
  process.env.SHOPEE_AFFILIATE_SECRET = 'secret';
  assert.equal((await affiliate.generateAffiliate(id)).affiliateUrl, 'https://s.shopee.vn/api1');
  assert.match(JSON.parse(openApiRequest.body).query, /originUrl:"https:\/\/shopee.vn\/product\/123\/789",subIds:\["Reup","Clip\d+"\]/);
  assert.match(openApiRequest.headers.authorization, /^SHA256 Credential=app1, Timestamp=\d+, Signature=[0-9a-f]{64}$/);
  delete process.env.SHOPEE_AFFILIATE_APP_ID;
  delete process.env.SHOPEE_AFFILIATE_SECRET;
  db.prepare("UPDATE reup_jobs SET approved = 1, tiktok_product_id = '' WHERE id = ?").run(id);
  const tiktokId = reup.startPublication(id, 'tiktok', 'dry_run');
  for (let i = 0; i < 30; i++) {
    if (db.prepare('SELECT status FROM reup_publications WHERE id = ?').get(tiktokId).status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(db.prepare('SELECT status FROM reup_publications WHERE id = ?').get(tiktokId).status, 'done');
  assert.equal(publishBody.mode, 'dry_run');
  assert.equal('product_id' in publishBody.jobs[0], false);
  assert.equal(publishBody.jobs[0].add_music, false);
  assert.equal(publishBody.jobs[0].caption, 'Đã kiểm tra #viral #xuhuong');
  assert.equal(reup.withRequiredTags('A #viral B #xuhuong'), 'A #viral B #xuhuong');
  assert.equal(JSON.stringify(publishBody).includes('s.shopee.vn'), false);
  const now = Date.now();
  const createdAt = Math.floor(now / 1000) - 86400;
  assert.equal(discovery.rank({ title: 'No stats' }, null, now).score, 0);
  // No publish date (search-page results): scored as if about a week old, below a fresh video.
  assert.ok(discovery.rank({ likes: 1000 }, null, now).score > 0);
  assert.ok(discovery.rank({ likes: 1000 }, null, now).score < discovery.rank({ likes: 1000, created_at: Math.floor(now / 1000) - 3600 }, null, now).score);
  assert.ok(discovery.rank({ likes: 1000, created_at: createdAt }, null, now).score > 15);
  assert.equal(discovery.rank({ likes: 200, created_at: createdAt }, { likes: 100, shares: 0, comments: 0, observed_at: new Date(now - 3600000).toISOString() }, now).growth, 100);
  assert.equal(discovery.rank({ likes: 200, created_at: createdAt }, { likes: 100, observed_at: new Date(now - 60000).toISOString() }, now).growth, null);
  assert.throws(() => discovery.addSource('channel', 'https://www.douyin.com.evil.test/user/abc', true));
  discovery.addSource('keyword', 'Test keyword', true);
  const keyword = discovery.snapshot().sources.find((s) => s.value === 'Test keyword');
  assert.equal(keyword.rights_confirmed, 0);
  discovery.storeCandidate(keyword, { url: reup.job(id).source_url, title: 'Existing' }, now);
  assert.equal(discovery.snapshot().candidates.find((c) => c.source_url === reup.job(id).source_url).status, 'queued');
  const candidateUrl = 'https://www.douyin.com/video/1234567890123456791';
  discovery.storeCandidate(keyword, { url: candidateUrl, title: 'New candidate', likes: 1000, created_at: createdAt, duration: 45 }, now);
  discovery.storeCandidate(keyword, { url: candidateUrl, title: 'Updated candidate', likes: 2000, created_at: createdAt, duration: 45 }, now + 3600000);
  assert.equal(discovery.snapshot().candidates.filter((c) => c.source_url === candidateUrl).length, 1);
  const candidate = discovery.snapshot().candidates.find((c) => c.source_url === candidateUrl);
  assert.throws(() => discovery.queueCandidate(candidate.id), /quyền/);
  discovery.queueCandidate(candidate.id, true);
  await reup.drainDownloads();
  assert.equal(discovery.snapshot().candidates.find((c) => c.id === candidate.id).status, 'queued');
  db.exec('DELETE FROM douyin_candidates; DELETE FROM douyin_sources');
  discovery.addSource('channel', 'https://www.douyin.com/user/authorized', true);
  discovery.saveConfig({ autoQueue: true, enabled: false, publicOnly: false });
  await discovery.scan(async () => [
    { url: 'https://www.douyin.com/video/1234567890123456792', title: 'Eligible', likes: 5000, created_at: createdAt, duration: 60 },
    { url: 'https://www.douyin.com/video/1234567890123456793', title: 'Missing metrics', duration: 60 },
    { url: 'https://www.douyin.com/video/1234567890123456794', title: 'Old', likes: 500000, created_at: createdAt - 60 * 86400, duration: 60 }
  ]);
  await reup.drainDownloads();
  assert.equal(discovery.snapshot().candidates.find((c) => c.title === 'Eligible').status, 'queued');
  assert.equal(discovery.snapshot().candidates.find((c) => c.title === 'Missing metrics').status, 'new');
  assert.equal(discovery.snapshot().candidates.find((c) => c.title === 'Old').status, 'new');
  await discovery.scan(async () => { throw new Error('Login required'); });
  assert.equal(discovery.snapshot().scanning, false);
  assert.equal(discovery.snapshot().sources[0].error, 'Login required');
  discovery.addSource('feed', '', true);
  discovery.addSource('keyword', 'Requires login', false);
  discovery.saveConfig({ autoQueue: true, enabled: false, publicOnly: true });
  const publicKinds = [];
  await discovery.scan(async (source) => {
    publicKinds.push(source.kind);
    return [{ url: 'https://www.douyin.com/video/1234567890123456795', title: 'Public feed', likes: 5000, created_at: createdAt, duration: 60 }];
  });
  assert.deepEqual(publicKinds, ['feed']);
  assert.equal(discovery.snapshot().candidates.find((c) => c.title === 'Public feed').status, 'new');
  assert.equal(discovery.snapshot().sources.find((s) => s.kind === 'feed').rights_confirmed, 0);

  const pets = discovery.snapshot().topics.find((t) => t.name === 'Thú cưng hài');
  assert.ok(pets.roxy_profile_id);
  assert.throws(() => discovery.addSource('category', '30020', false, pets.id), /6 chữ số/);
  assert.throws(() => discovery.addSource('category', '300201', false, 9999), /chủ đề/);
  discovery.addSource('category', '300201', false, pets.id);
  const category = discovery.snapshot().sources.find((s) => s.kind === 'category');
  assert.equal(category.value, 'https://www.douyin.com/channel/300201');
  assert.equal(category.topic_name, 'Thú cưng hài');
  db.exec("DELETE FROM douyin_candidates; DELETE FROM douyin_sources WHERE kind != 'category'");
  const scanned = [];
  await discovery.scan(async (source) => {
    scanned.push(source.kind);
    return [
      { url: 'https://www.douyin.com/video/1234567890123456796', title: '我家猫咪太搞笑了', likes: 9000, created_at: createdAt, duration: 30 },
      { url: 'https://www.douyin.com/video/1234567890123456797', title: '剁椒鱼头', likes: 9000, created_at: createdAt, duration: 30 }
    ];
  });
  assert.deepEqual(scanned, ['category']);
  const cat = discovery.snapshot().candidates.find((c) => c.title === '我家猫咪太搞笑了');
  assert.equal(cat.topic_name, 'Thú cưng hài');
  assert.equal(discovery.snapshot().candidates.some((c) => c.title === '剁椒鱼头'), false);
  discovery.queueCandidate(cat.id, true);
  const petJob = db.prepare('SELECT * FROM reup_jobs WHERE id = ?').get(discovery.snapshot().candidates.find((c) => c.id === cat.id).job_id);
  assert.equal(petJob.topic_id, pets.id);
  db.prepare("UPDATE reup_jobs SET topic_id = ?, approved = 1 WHERE id = ?").run(pets.id, id);
  const petPost = reup.startPublication(id, 'tiktok', 'dry_run');
  for (let i = 0; i < 30; i++) {
    if (db.prepare('SELECT status FROM reup_publications WHERE id = ?').get(petPost).status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(publishBody.roxy_profile_id, pets.roxy_profile_id);
  assert.throws(() => discovery.saveTopic(pets.id, { roxyProfileId: '../x' }), /Roxy/);
  assert.equal(discovery.saveTopic(pets.id, { keywords: '猫' }).topics.find((t) => t.id === pets.id).keywords, '猫');

  const products = require('../server/services/shopee-products');
  assert.ok(pets.shopee_keywords.includes('mèo'));
  assert.equal(products.parseSold('1tr+ lượt bán'), 1000000);
  assert.equal(products.parseSold('5,2k lượt bán'), 5200);
  assert.equal(products.parseCommission('Tỉ lệ hoa hồng 21,5%'), 21.5);
  assert.throws(() => products.saveScan(9999, 'x', []), /chủ đề/);
  assert.equal(products.saveScan(pets.id, 'đồ chơi cho mèo', [
    { itemId: '55913200112', name: 'Cần câu mèo', price: '₫98.560', sold: '20k+ lượt bán', commission: 'Tỉ lệ hoa hồng 10,5%' },
    { itemId: '49717854106', name: 'Bóng mèo', price: '₫9.000', sold: '1 lượt bán', commission: 'Tỉ lệ hoa hồng 3%' },
    { itemId: 'not-an-id', name: 'Bad' }
  ]).saved, 2);
  const ranked = products.list();
  assert.equal(ranked[0].name, 'Cần câu mèo');
  assert.equal(ranked[0].topic_name, 'Thú cưng hài');
  affiliate.saveProduct(id, 'https://shopee.vn/product/1/2');
  affiliate.saveAffiliate(id, 'https://s.shopee.vn/old');
  const linked = products.assign(id, ranked[0].id);
  assert.equal(linked.shopee_item_id, '55913200112');
  assert.equal(linked.shopee_product_url, '');
  assert.equal(linked.shopee_affiliate_url, '');
  products.dismiss(ranked[1].id);
  assert.equal(products.list().length, 1);

  const translation = require('../server/services/translation');
  assert.throws(() => translation.load(id), /Lấy lời thoại/);
  fs.writeFileSync(path.join(process.env.REUP_MEDIA_DIR, `${id}-reviewed-vi.draft.json`), JSON.stringify({
    voice: 'vi-VN-HoaiMyNeural', voices: { a: 'vi-VN-NamMinhNeural' },
    segments: [{ start: 0, end: 2, speaker: 'a', source: '小猫', text: '' }, { start: 2, end: 4, source: '#抖音', text: '' }, { start: 4, end: 6, source: '喵', text: '' }]
  }));
  assert.equal(translation.load(id).segments.length, 3);
  assert.throws(() => translation.save(id, [{}]), /không khớp/);
  const partial = translation.save(id, [{ text: 'Mèo con' }, { remove: true }, { text: '' }]);
  assert.equal(partial.missing, 1);
  assert.equal(partial.hasReviewed, false);
  assert.equal(translation.load(id).segments.length, 2);
  const complete = translation.save(id, [{ text: 'Mèo con' }, { text: 'Meo', voiced: false }], 'vi-VN-NamMinhNeural');
  assert.equal(complete.hasReviewed, true);
  const reviewed = JSON.parse(fs.readFileSync(path.join(process.env.REUP_MEDIA_DIR, `${id}-reviewed-vi.json`), 'utf8'));
  assert.equal(reviewed.voice, 'vi-VN-NamMinhNeural');
  assert.equal(reviewed.voices, undefined);
  assert.equal(reviewed.segments[1].voiced, false);
  assert.throws(() => translation.save(id, [{ text: 'a' }, { text: 'b' }], 'en-US-Fake'), /Giọng/);

  const autopilot = require('../server/services/autopilot');
  assert.throws(() => autopilot.saveConfig({ postsPerDay: 50 }), /posts_per_day/);
  assert.equal(autopilot.saveConfig({ postsPerDay: 1, minGapHours: 4 }).postsPerDay, 1);
  assert.equal(reup.job(id).approved, 0, 'a new translation changes the video, so it needs review again');
  db.prepare('UPDATE reup_jobs SET approved = 1 WHERE id = ?').run(id);
  affiliate.saveProduct(id, 'https://shopee.vn/product/1/55913200112');
  affiliate.saveAffiliate(id, 'https://s.shopee.vn/auto');
  assert.equal(reup.job(id).approved, 1, 'saving a comment link keeps the video approved');
  assert.match(autopilot.autoCaption({ ...reup.job(id), topic_id: pets.id }), /^Mèo con #cat/);
  const fresh = Number(db.prepare("INSERT INTO reup_jobs (source_url, rights_confirmed, title, status, approved, topic_id, dubbed_path) VALUES ('https://www.douyin.com/video/1234567890123456799', 1, 'Mèo #猫', 'review', 1, ?, ?)").run(pets.id, reup.job(id).dubbed_path).lastInsertRowid);
  autopilot.assignProducts();
  assert.notEqual(reup.job(fresh).shopee_item_id, '');
  db.exec("DELETE FROM reup_publications");
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  autopilot.publishNext(noon);
  for (let i = 0; i < 30 && db.prepare("SELECT id FROM reup_publications WHERE status = 'running'").get(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  const posted = db.prepare("SELECT * FROM reup_publications WHERE mode = 'schedule'").all();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].job_id, id);
  assert.equal(publishBody.roxy_profile_id, pets.roxy_profile_id);
  assert.equal(posted[0].comment_url, 'https://s.shopee.vn/auto');
  autopilot.publishNext(noon);
  assert.equal(db.prepare("SELECT count(*) n FROM reup_publications WHERE mode = 'schedule'").get().n, 1, 'daily limit of 1 is respected');
  const night = new Date(noon); night.setHours(3);
  autopilot.saveConfig({ postsPerDay: 6 });
  autopilot.publishNext(night);
  assert.equal(db.prepare("SELECT count(*) n FROM reup_publications WHERE mode = 'schedule'").get().n, 1, 'no posting outside allowed hours');
  autopilot.publishNext(noon);
  assert.equal(db.prepare("SELECT count(*) n FROM reup_publications WHERE mode = 'schedule'").get().n, 1, 'minimum gap between posts is respected');

  assert.throws(() => discovery.quickTopic(9999), /chủ đề/);
  const quickUrl = 'https://www.douyin.com/video/1234567890123456800';
  discovery.storeCandidate(category, { url: quickUrl, title: '猫咪 quick', likes: 9000, created_at: createdAt, duration: 30 }, now);
  products.saveScan(pets.id, 'pate cho mèo', [{ itemId: '77777777777', name: 'Pate mèo', price: '₫15.000', sold: '3k+ lượt bán', commission: 'Tỉ lệ hoa hồng 6%' }]);
  assert.throws(() => discovery.quickTopic(pets.id, 3), /quyền/);
  const [quick] = discovery.quickTopic(pets.id, 1, true);
  const quickJob = reup.job(quick.jobId);
  assert.equal(quickJob.auto_prepare, 1);
  assert.equal(quickJob.topic_id, pets.id);
  assert.equal(quickJob.shopee_item_id, '77777777777', 'picks an unused product of the topic');
  const machine = require('../server/services/machine-translate');
  machine.translate = async (lines) => ({ provider: 'test', lines: lines.map((line) => line === '长' ? 'một câu dịch rất dài không thể nào đọc kịp trong nửa giây được đâu' : `Câu ${line}`) });
  assert.equal(machine.syllables('Mèo con dễ thương!'), 4);
  const draftFile = path.join(process.env.REUP_MEDIA_DIR, `${quick.jobId}-reviewed-vi.draft.json`);
  fs.writeFileSync(draftFile, JSON.stringify({ voice: 'vi-VN-HoaiMyNeural', voices: { x: 'vi-VN-NamMinhNeural' }, segments: [
    { start: 0, end: 2, source: '我真没空陪你闹了', speaker: 'x', text: '' },
    { start: 0.2, end: 1.5, source: '我眞没空陪你闹', text: '' },
    { start: 2, end: 2.2, source: '闪', text: '' },
    { start: 3, end: 4, source: 'PRO 18g', text: '' },
    ...[5, 6, 7].map((t) => ({ start: t, end: t + 0.9, source: '小轻松冻干猫草棒', text: '' })),
    { start: 9, end: 9.6, source: '长', text: '' },
    { start: 10, end: 12, source: '你好小猫', text: '' }, { start: 12, end: 14, source: '再见小猫', text: '' }
  ] }));
  const machineResult = await translation.autoTranslate(quick.jobId);
  const machineDoc = JSON.parse(fs.readFileSync(path.join(process.env.REUP_MEDIA_DIR, `${quick.jobId}-reviewed-vi.json`), 'utf8'));
  assert.deepEqual(machineDoc.segments.map((s) => s.source), ['我真没空陪你闹了', '长', '你好小猫', '再见小猫'], 'drops duplicate reads, flicker, non-Chinese and repeated packaging text');
  assert.equal(machineDoc.segments.find((s) => s.source === '长').voiced, false, 'a line too long to speak in time becomes subtitle-only');
  assert.equal(machineDoc.voices, undefined);
  assert.equal(machineResult.voiced, 3);
  assert.deepEqual(autopilot.qualityProblems({ ...reup.job(quick.jobId), dubbed_path: path.join(process.env.REUP_MEDIA_DIR, 'missing.mp4') }), ['không có file video tiếng Việt']);

  discovery.addSource('keyword', '出租屋改造', false, pets.id);
  const searchSource = discovery.snapshot().sources.find((s) => s.value === '出租屋改造');
  const imported = discovery.importItems(searchSource.id, [
    { url: 'https://www.douyin.com/video/1234567890123456810', title: 'Room makeover (machine-translated title)', likes: 52000, duration: 40, createdAt: Math.floor(Date.now() / 1000) - 86400 },
    { url: 'not a douyin link', title: 'bad' }
  ]);
  assert.deepEqual(imported, { received: 2, kept: 1 }, 'keyword-search results skip the topic word filter; bad links are ignored');
  assert.ok(discovery.snapshot().candidates.find((c) => c.title.startsWith('Room makeover')).score > 0);
  assert.throws(() => autopilot.saveConfig({ refill: true }), /quyền/);
  assert.equal(autopilot.saveConfig({ refill: true, rightsConfirmed: true, refillTarget: 2 }).refillTarget, 2);
  autopilot.saveConfig({ refill: false });
  assert.equal(reup.isAiContent({ title: '#AI萌宠 小猫' }), true);
  assert.equal(reup.isAiContent({ title: '小猫太淘气了' }), false);

  const stats = require('../server/services/stats');
  const statPost = Number(db.prepare("INSERT INTO reup_publications (job_id, platform, mode, status, post_url) VALUES (?, 'tiktok', 'schedule', 'done', 'https://www.tiktok.com/@demo.cat/video/7000000000000000001')").run(id).lastInsertRowid);
  const day = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toISOString();
  db.prepare('INSERT INTO post_stats (publication_id, checked_at, views, likes, comments, shares, saves) VALUES (?, ?, ?, ?, ?, ?, ?)').run(statPost, day(30), 100, 5, 0, 0, 0);
  db.prepare('INSERT INTO post_stats (publication_id, checked_at, views, likes, comments, shares, saves) VALUES (?, ?, ?, ?, ?, ?, ?)').run(statPost, day(1), 900, 40, 3, 2, 1);
  db.prepare('INSERT INTO channel_stats (handle, checked_at, followers, likes, videos) VALUES (?, ?, ?, ?, ?)').run('demo.cat', day(30), 60, 100, 9);
  db.prepare('INSERT INTO channel_stats (handle, checked_at, followers, likes, videos) VALUES (?, ?, ?, ?, ?)').run('demo.cat', day(1), 85, 150, 10);
  const summary = stats.summary();
  const statVideo = summary.videos.find((v) => v.publicationId === statPost);
  assert.equal(statVideo.views, 900);
  assert.equal(statVideo.viewsChange, 800, '24h change compares with the reading from a day earlier');
  const statChannel = summary.channels.find((c) => c.handle === 'demo.cat');
  assert.equal(statChannel.followers, 85);
  assert.equal(statChannel.followersChange, 25);
  assert.equal(statChannel.views, 900);

  // Early preparation follows the schedule: one video per posting slot in the next 24 hours.
  const at = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
  db.exec('DELETE FROM post_stats; DELETE FROM reup_publications'); // earlier steps posted for this topic today
  autopilot.saveConfig({ slots: '08:00, 12:00, 20:00', postsPerDay: 3 });
  assert.deepEqual(autopilot.upcomingSlots(at(10)).map((d) => `${d.getHours()}:${d.getDate() === at(10).getDate() ? 'today' : 'tomorrow'}`), ['12:today', '20:today', '8:tomorrow']);
  assert.equal(autopilot.channelNeed(pets.id, at(10)), 3, 'two slots left today plus tomorrow morning');
  const petPlan = autopilot.plan(at(10)).channels.find((c) => c.topicId === pets.id);
  assert.equal(petPlan.assigned.length, 3);
  autopilot.saveConfig({ slots: '' });

  // Several accounts per topic: each video goes to one account, the least-used account posts first.
  db.prepare('UPDATE reup_jobs SET auto_prepare = 0').run(); // waiting for posts below must not start real OCR on the mock download
  const accounts = require('../server/services/accounts');
  assert.ok(accounts.list().some((a) => a.profile_id === pets.roxy_profile_id && a.status === 'active'), 'topic profiles become accounts');
  const second = accounts.save({ topicId: pets.id, name: 'Mèo 2', profileId: 'petsTwo', status: 'active' });
  assert.throws(() => accounts.save({ topicId: pets.id, profileId: 'petsTwo' }), /đã gắn/);
  assert.throws(() => accounts.save({ dailyLimit: 9 }, second.id), /1 đến 6/);
  db.exec("DELETE FROM reup_publications; UPDATE reup_jobs SET approved = 0");
  const dubbed = reup.job(id).dubbed_path;
  const readyJob = (n) => Number(db.prepare(`INSERT INTO reup_jobs (source_url, rights_confirmed, title, caption, status, approved, topic_id, dubbed_path)
    VALUES (?, 1, 'Mèo', 'Mèo con #cat', 'review', 1, ?, ?)`).run(`https://www.douyin.com/video/12345678901234569${n}`, pets.id, dubbed).lastInsertRowid);
  const [firstReady, secondReady] = [readyJob(50), readyJob(51)];
  const waitPost = async () => { for (let i = 0; i < 40 && db.prepare("SELECT id FROM reup_publications WHERE status = 'running'").get(); i++) await new Promise((resolve) => setTimeout(resolve, 50)); };
  autopilot.publishNext(noon);
  await waitPost();
  assert.equal(publishBody.roxy_profile_id, pets.roxy_profile_id);
  autopilot.publishNext(noon);
  await waitPost();
  assert.equal(publishBody.roxy_profile_id, 'petsTwo', 'the account with no post today takes the next video');
  assert.deepEqual(db.prepare("SELECT j.id, j.account_profile FROM reup_publications p JOIN reup_jobs j ON j.id = p.job_id ORDER BY p.id").all().map((r) => [r.id, r.account_profile]),
    [[firstReady, pets.roxy_profile_id], [secondReady, 'petsTwo']], 'each video posts once, to the account recorded on it');
  autopilot.saveConfig({ slots: '08:00, 12:00, 20:00', postsPerDay: 3 });
  assert.equal(autopilot.plan(at(10)).channels.filter((c) => c.topicId === pets.id).length, 2, 'the plan shows one row per account');
  autopilot.saveConfig({ slots: '' });

  db.prepare("UPDATE accounts SET active_since = datetime('now', '-3 days') WHERE id = ?").run(second.id);
  const lowJob = readyJob(52);
  db.prepare("UPDATE reup_jobs SET account_profile = 'petsTwo' WHERE id = ?").run(lowJob);
  for (let i = 0; i < 3; i++) {
    const pub = Number(db.prepare(`INSERT INTO reup_publications (job_id, platform, mode, status, post_url, created_at)
      VALUES (?, 'tiktok', 'schedule', 'done', 'https://www.tiktok.com/@two/video/1', datetime('now', '-2 days'))`).run(lowJob).lastInsertRowid);
    db.prepare('INSERT INTO post_stats (publication_id, checked_at, views) VALUES (?, ?, 5)').run(pub, new Date().toISOString());
  }
  assert.deepEqual(accounts.checkHealth().map((a) => a.profile_id), ['petsTwo'], 'an account whose last posts get almost no views is paused');
  accounts.save({ status: 'active' }, second.id);
  assert.deepEqual(accounts.checkHealth(), [], 'reactivating judges only posts made after it');
  const pinned = readyJob(53);
  db.prepare("UPDATE reup_jobs SET account_profile = 'petsTwo' WHERE id = ?").run(pinned);
  accounts.remove(second.id);
  assert.equal(reup.job(pinned).account_profile, '', 'videos waiting for a removed account return to the topic queue');

  const cleanup = require('../server/services/cleanup');
  const mediaDir = process.env.REUP_MEDIA_DIR;
  const oldJob = Number(db.prepare("INSERT INTO reup_jobs (source_url, rights_confirmed, title, status, approved, dubbed_path) VALUES ('https://www.douyin.com/video/1234567890123456901', 1, 'old', 'review', 1, 'x')").run().lastInsertRowid);
  const newJob = Number(db.prepare("INSERT INTO reup_jobs (source_url, rights_confirmed, title, status, approved, dubbed_path) VALUES ('https://www.douyin.com/video/1234567890123456902', 1, 'new', 'review', 1, 'x')").run().lastInsertRowid);
  for (const [job, name] of [[oldJob, 'source.mp4'], [oldJob, 'vi.mp4'], [oldJob, 'reviewed-vi.json'], [newJob, 'vi.mp4'], [newJob, 'vi-background-vocals.wav']]) {
    fs.writeFileSync(path.join(mediaDir, `${job}-${name}`), 'x'.repeat(1000));
  }
  db.prepare("INSERT INTO reup_publications (job_id, platform, mode, status, created_at) VALUES (?, 'tiktok', 'schedule', 'done', datetime('now', '-5 days'))").run(oldJob);
  db.prepare("INSERT INTO reup_publications (job_id, platform, mode, status, created_at) VALUES (?, 'tiktok', 'schedule', 'done', datetime('now', '-1 hours'))").run(newJob);
  const cleaned = cleanup.run();
  assert.ok(cleaned.last.jobs.includes(oldJob), 'a video posted 5 days ago is cleaned');
  assert.equal(fs.existsSync(path.join(mediaDir, `${oldJob}-vi.mp4`)), false);
  assert.equal(fs.existsSync(path.join(mediaDir, `${oldJob}-reviewed-vi.json`)), true, 'translations are kept');
  assert.equal(fs.existsSync(path.join(mediaDir, `${newJob}-vi.mp4`)), true, 'a video posted an hour ago is kept');
  assert.equal(fs.existsSync(path.join(mediaDir, `${newJob}-vi-background-vocals.wav`)), false, 'separation intermediates go right away');
  assert.throws(() => cleanup.saveConfig({ keepAfterPostDays: 0 }), /1 đến 90/);
  assert.ok(cleanup.items().posted.some((p) => p.id === newJob));
  fs.writeFileSync(path.join(mediaDir, `${newJob}-reviewed-vi.json`), '{}');
  assert.equal(cleanup.removeMedia([newJob]).jobs, 1);
  assert.equal(fs.existsSync(path.join(mediaDir, `${newJob}-vi.mp4`)), false, 'Xóa file removes the video');
  assert.ok(reup.job(newJob), 'Xóa file keeps the record');
  cleanup.removeRecords([newJob]);
  assert.equal(reup.job(newJob), undefined, 'Xóa hẳn removes the record');
  assert.equal(fs.existsSync(path.join(mediaDir, `${newJob}-reviewed-vi.json`)), false);
  assert.equal(db.prepare('SELECT count(*) n FROM reup_publications WHERE job_id = ?').get(newJob).n, 0);
  const busyJob = Number(db.prepare("INSERT INTO reup_jobs (source_url, rights_confirmed, status) VALUES ('https://www.douyin.com/video/1234567890123456903', 1, 'dubbing')").run().lastInsertRowid);
  assert.throws(() => cleanup.removeRecords([busyJob]), /đang xử lý/);

  // The mock download is not a real video; stop it from starting real OCR before the test ends.
  db.prepare('UPDATE reup_jobs SET auto_prepare = 0').run();
  await reup.drainDownloads();
  db.close();
});
