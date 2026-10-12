const $ = (id) => document.getElementById(id);
const socket = io();

let state = { devices: [], videos: [], links: [], reup: [], publications: [], services: {}, discovery: {}, tiktok: {}, settings: {}, currentSerial: null, picked: {} };

async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderTikTokAccount() {
  const t = state.tiktok;
  $('tiktok-account-status').textContent = !t.available ? 'LUNO chưa sẵn sàng' : t.browserMode === 'roxy' ? (t.login?.state === 'error' ? t.login.error : t.loginOpen ? 'Đang mở TikTok trong RoxyBrowser' : t.browserConfigured ? 'RoxyBrowser đã cấu hình' : 'Cần cấu hình profile RoxyBrowser') : t.login?.state === 'rate_limited' && !t.activeId ? 'TikTok đang giới hạn đăng nhập · chờ thử lại' : t.loginOpen ? 'Đang chờ đăng nhập trong Chrome' : t.activeId && (t.hasSession || t.hasCookie) ? 'Đã lưu phiên TikTok' : t.login?.state === 'error' ? t.login.error : 'Chưa có phiên TikTok';
  $('tiktok-account-select').innerHTML = (t.accounts || []).length ? t.accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === t.activeId ? 'selected' : ''}>${esc(a.label)}</option>`).join('') : '<option value="">Chưa có tài khoản</option>';
  $('tiktok-account-select').disabled = t.browserMode === 'roxy' || !t.available || !(t.accounts || []).length || state.publications.some((p) => p.status === 'running');
  $('tiktok-login').disabled = !t.available || t.loginOpen || state.publications.some((p) => p.status === 'running');
}
$('tiktok-login').onclick = async () => {
  try { await api('/api/tiktok/login', 'POST', {}); await refresh(); }
  catch (error) { alert(error.message); }
};
$('tiktok-account-select').onchange = async () => {
  try { await api('/api/tiktok/account/activate', 'POST', { id: $('tiktok-account-select').value }); await refresh(); }
  catch (error) { alert(error.message); }
};

const PUBLIC_SOURCE_KINDS = ['feed', 'category'];
const SOURCE_KIND_LABELS = { channel: 'Kênh', feed: 'Công khai', category: 'Danh mục', keyword: 'Từ khóa' };

function topicOptions(selected, emptyLabel) {
  return `<option value="">${esc(emptyLabel)}</option>` + (state.discovery.topics || [])
    .map((t) => `<option value="${t.id}" ${Number(selected) === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
}

function renderTopics() {
  const topics = state.discovery.topics || [];
  for (const id of ['discovery-source-topic', 'reup-topic']) {
    const select = $(id);
    if (document.activeElement !== select) select.innerHTML = topicOptions(select.value, 'Không gắn chủ đề');
  }
  if ($('topic-list').contains(document.activeElement)) return;
  $('topic-list').innerHTML = topics.map((t) => `<div class="topic-card">
    <strong>${esc(t.name)}</strong>
    <label>Profile Roxy<input id="topic-profile-${t.id}" value="${esc(t.roxy_profile_id)}" maxlength="64"></label>
    <label>Từ khóa lọc Douyin<input id="topic-keywords-${t.id}" value="${esc(t.keywords)}" maxlength="1000"></label>
    <label>Hashtag xu hướng TikTok<input id="topic-tags-${t.id}" value="${esc(t.trend_tags)}" maxlength="1000"></label>
    <label>Từ khóa sản phẩm Shopee<input id="topic-shopee-${t.id}" value="${esc(t.shopee_keywords)}" maxlength="1000"></label>
    <button class="btn small" onclick="saveTopic(${t.id})">Lưu</button>
  </div>`).join('');
}

async function saveTopic(id) {
  try {
    await api(`/api/topics/${id}`, 'PATCH', { roxyProfileId: $(`topic-profile-${id}`).value, keywords: $(`topic-keywords-${id}`).value, trendTags: $(`topic-tags-${id}`).value, shopeeKeywords: $(`topic-shopee-${id}`).value });
    document.activeElement?.blur();
    await refresh();
  } catch (error) { alert(error.message); }
}

function renderProducts() {
  const select = $('products-topic');
  if (document.activeElement !== select) select.innerHTML = topicOptions(select.value, 'Tất cả chủ đề');
  const topicId = Number(select.value) || null;
  const products = (state.products || []).filter((p) => !topicId || p.topic_id === topicId);
  const num = (n) => n == null ? '—' : Number(n).toLocaleString('vi-VN');
  $('products-status').textContent = `${(state.products || []).length} sản phẩm`;
  $('products-body').innerHTML = products.map((p) => {
    const jobs = state.reup.filter((j) => !p.topic_id || !j.topic_id || j.topic_id === p.topic_id);
    const assigned = state.reup.filter((j) => j.shopee_item_id === p.item_id).map((j) => `#${j.id}${j.shopee_affiliate_url ? ' · có link' : ' · chờ tạo link'}`);
    return `<tr>
      <td><a href="https://affiliate.shopee.vn/offer/product_offer/${esc(p.item_id)}" target="_blank" rel="noopener noreferrer">${esc(p.name)}</a><small>${esc(p.topic_name || '')} · từ khóa: ${esc(p.keyword)}</small></td>
      <td><small>₫${num(p.price)}</small><small>${num(p.sold)}+ đã bán</small></td>
      <td>${p.commission == null ? '—' : `${String(p.commission).replace('.', ',')}%`}<small>≈ ₫${num(Math.round((p.price || 0) * (p.commission || 0) / 100))}/đơn</small></td>
      <td>${assigned.length ? `<small class="approved-line">Đã gắn ${esc(assigned.join(', '))}</small>` : ''}<div class="td-actions">
        <select id="product-job-${p.id}" aria-label="Video để gắn sản phẩm">${jobs.map((j) => `<option value="${j.id}">#${j.id} ${esc((j.title || 'Video Douyin').slice(0, 30))}</option>`).join('')}</select>
        <button class="btn small" onclick="assignProduct(${p.id})" ${jobs.length ? '' : 'disabled'}>Gắn</button>
        <button class="btn small" onclick="dismissProduct(${p.id})">Bỏ qua</button>
      </div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="empty-row">Chưa có sản phẩm. Bấm Quét sản phẩm trong tiện ích Chrome.</td></tr>';
}
$('products-topic').onchange = renderProducts;

async function assignProduct(id) {
  try { await api(`/api/reup/${$(`product-job-${id}`).value}/shopee-product`, 'POST', { productId: id }); await refresh(); }
  catch (error) { alert(error.message); }
}

async function dismissProduct(id) {
  try { await api(`/api/shopee-products/${id}/dismiss`, 'POST', {}); await refresh(); }
  catch (error) { alert(error.message); }
}

// Re-rendering would restart videos that are playing, so only redraw when the shown data changes.
let previewSignature = '';
function renderPreview(force = false) {
  const select = $('preview-topic');
  if (document.activeElement !== select) select.innerHTML = topicOptions(select.value, 'Tất cả chủ đề');
  const topicId = Number(select.value) || null;
  const statusFilter = $('preview-status').value;
  const ready = state.reup.filter((j) => j.dubbed_path && j.status === 'review');
  const shown = ready.filter((j) => (!topicId || j.topic_id === topicId) &&
    (!statusFilter || (statusFilter === 'approved' ? j.approved : !j.approved)));
  $('preview-count').textContent = `${ready.length} video đã lồng tiếng · ${ready.filter((j) => !j.approved).length} chờ duyệt`;
  const signature = JSON.stringify([topicId, statusFilter, (state.discovery.topics || []).length,
    shown.map((j) => [j.id, j.approved, j.topic_id, j.caption, j.shopee_item_id, j.shopee_affiliate_url, j.dubbed_path])]);
  if (!force && signature === previewSignature) return;
  previewSignature = signature;
  $('preview-grid').innerHTML = shown.map((j) => `<article class="preview-card">
    <video controls preload="metadata" src="/api/reup/${j.id}/video" id="preview-video-${j.id}"></video>
    <div class="preview-card-body">
      <div class="preview-card-head"><strong>#${j.id} ${esc(j.title || 'Video Douyin')}</strong>${j.approved ? '<span class="badge done">Đã duyệt</span>' : '<span class="badge review">Chờ duyệt</span>'}</div>
      <select class="topic-select" aria-label="Chủ đề video #${j.id}" onchange="setReupTopic(${j.id}, this.value)">${topicOptions(j.topic_id, 'Chưa gắn chủ đề')}</select>
      <small>${j.caption ? esc(j.caption) : '<em>Chưa có caption</em>'}</small>
      <small>Sản phẩm: ${j.shopee_product_query ? esc(j.shopee_product_query.slice(0, 60)) : 'chưa gắn'} · Link: ${j.shopee_affiliate_url ? esc(j.shopee_affiliate_url) : 'chưa có'}</small>
      <div class="td-actions">
        <button class="btn small" onclick="togglePreviewSource(${j.id}, this)">Xem bản gốc</button>
        <button class="btn small" onclick="openReup(${j.id})">Sửa caption · Đăng</button>
        ${j.approved ? '' : `<button class="btn small primary" onclick="approveFromPreview(${j.id})">Duyệt</button>`}
      </div>
    </div>
  </article>`).join('') || '<p class="empty-row">Chưa có video đã lồng tiếng phù hợp bộ lọc.</p>';
}
$('preview-status').onchange = () => renderPreview(true);
$('preview-topic').onchange = () => renderPreview(true);

function togglePreviewSource(id, button) {
  const video = $(`preview-video-${id}`);
  const source = video.src.includes('kind=source');
  video.src = source ? `/api/reup/${id}/video` : `/api/reup/${id}/video?kind=source`;
  button.textContent = source ? 'Xem bản gốc' : 'Xem bản tiếng Việt';
}

async function approveFromPreview(id) {
  try { await api(`/api/reup/${id}/approve`, 'POST', {}); await refresh(); }
  catch (error) { alert(error.message); }
}

function renderAutopilot() {
  const a = state.autopilot || {};
  const schedule = a.slots?.length ? `lịch ${a.slots.join(', ')}` : `${a.startHour}h–${a.endHour}h, cách ${a.minGapHours} giờ`;
  const engine = !a.enabled ? '' : !state.services.luno ? (a.lunoStarted ? ' · đang khởi động LUNO…' : ' · LUNO chưa chạy') : a.finding ? ` · đang tìm link bài #${a.finding}` : '';
  $('autopilot-status').textContent = a.enabled
    ? `Tự động đăng: BẬT · ${a.postsPerDay} bài/ngày mỗi kênh · ${schedule} · bình luận sau ${a.commentDelayMin} phút${a.refill ? ` · tự lấy video (giữ ${a.refillTarget}/kênh)` : ''}${engine}`
    : 'Tự động đăng: TẮT — video chuẩn bị xong sẽ chờ bạn đăng';
  $('autopilot-log').innerHTML = (a.log || []).slice(0, 8).map((item) => `<li><small>${esc(new Date(item.at).toLocaleTimeString('vi-VN'))}</small> ${esc(item.message)}</li>`).join('');
}

function openAutopilotSettings() {
  const a = state.autopilot || {};
  $('modal-title').textContent = 'Lịch đăng tự động';
  $('modal-body').innerHTML = `
    <div class="settings-form">
      <label class="check-line"><input id="ap-enabled" type="checkbox" ${a.enabled ? 'checked' : ''}> Bật tự động đăng và bình luận link</label>
      <fieldset><legend>Tự lấy video mới cho cả 3 kênh</legend>
        <label class="check-line"><input id="ap-refill" type="checkbox" ${a.refill ? 'checked' : ''}> Tự chọn video Douyin tốt nhất mỗi kênh, dịch, lồng tiếng, tự duyệt nếu qua kiểm tra rồi đăng</label>
        <label>Giữ sẵn số video mỗi kênh<input id="ap-refill-target" type="number" min="1" max="10" value="${a.refillTarget ?? 3}"></label>
        <label class="check-line"><input id="ap-rights" type="checkbox" ${a.refill ? 'checked' : ''}> Tôi có quyền sử dụng và đăng lại các video Douyin được tự chọn</label>
      </fieldset>
      <label>Khung giờ đăng trong ngày<input id="ap-slots" value="${esc((a.slots || []).join(', '))}" placeholder="VD: 08:00, 12:00, 19:30">
        <small>Mỗi kênh đăng tối đa 1 bài trong 45 phút sau mỗi mốc. Để trống để dùng khoảng giờ bên dưới.</small></label>
      <div class="settings-presets">${['07:30, 12:00, 20:00', '11:30, 19:00', '09:00, 13:00, 18:00, 21:30'].map((p) => `<button class="btn small" type="button" onclick="$('ap-slots').value='${p}'">${p}</button>`).join('')}</div>
      <label>Tối đa bài/ngày mỗi kênh<input id="ap-posts" type="number" min="1" max="6" value="${a.postsPerDay ?? 2}"></label>
      <fieldset><legend>Khi không đặt khung giờ</legend>
        <label>Từ giờ<input id="ap-start" type="number" min="0" max="23" value="${a.startHour ?? 7}"></label>
        <label>Đến giờ<input id="ap-end" type="number" min="1" max="24" value="${a.endHour ?? 23}"></label>
        <label>Cách nhau (giờ)<input id="ap-gap" type="number" min="1" max="24" value="${a.minGapHours ?? 4}"></label>
      </fieldset>
      <label>Bình luận link sau khi đăng (phút)<input id="ap-delay" type="number" min="1" max="240" value="${a.commentDelayMin ?? 15}"></label>
      <div class="row command-row"><button class="btn primary" onclick="saveAutopilotSettings()">Lưu</button></div>
    </div>`;
  $('modal').classList.remove('hidden');
}

async function saveAutopilotSettings() {
  try {
    await api('/api/autopilot', 'PATCH', { refill: $('ap-refill').checked, refillTarget: Number($('ap-refill-target').value), rightsConfirmed: $('ap-rights').checked,
      enabled: $('ap-enabled').checked, slots: $('ap-slots').value, postsPerDay: Number($('ap-posts').value),
      startHour: Number($('ap-start').value), endHour: Number($('ap-end').value), minGapHours: Number($('ap-gap').value), commentDelayMin: Number($('ap-delay').value) });
    closeModal();
    await refresh();
  } catch (error) { alert(error.message); }
}
$('autopilot-settings').onclick = openAutopilotSettings;
$('autopilot-run').onclick = async () => {
  $('autopilot-run').disabled = true;
  $('autopilot-run').textContent = 'Đang chạy…';
  try {
    const result = await api('/api/autopilot/run', 'POST', {});
    await refresh();
    const bullets = (items) => items.map((item) => `• ${item}`).join('\n');
    const done = result.actions.length ? `Vừa làm:\n${bullets(result.actions)}\n\n` : 'Lượt này không có việc nào để làm.\n\n';
    alert(`${done}Tình trạng:\n${bullets(result.explanation)}`);
  } catch (error) { alert(error.message); }
  finally { $('autopilot-run').disabled = false; $('autopilot-run').textContent = 'Chạy ngay'; }
};

// ---------- ACTIVITY ----------
const fmtSeconds = (s) => s == null ? '' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}p${String(s % 60).padStart(2, '0')}`;
async function pollActivity() {
  let data;
  try { data = await api('/api/activity'); } catch { $('activity-text').textContent = 'Mất kết nối dashboard'; $('activity-bar').className = 'activity-bar error'; return; }
  const busy = data.running.length > 0;
  $('activity-bar').className = `activity-bar ${busy ? 'busy' : 'idle'}`;
  $('activity-text').textContent = busy ? `Đang chạy ${data.running.length} việc` : (data.autopilot ? 'Tự động đang bật · chờ việc tiếp theo' : 'Đang rảnh');
  $('activity-list').innerHTML = data.running.map((item) => `<div class="activity-item"><span class="spinner"></span><strong>${esc(item.label)}</strong>${item.detail ? `<span class="activity-detail">${esc(item.detail)}</span>` : ''}${item.seconds != null ? `<small>${fmtSeconds(item.seconds)}</small>` : ''}</div>`).join('') +
    (data.waiting.length ? `<div class="activity-item waiting">⏳ ${esc(data.waiting.join(' · '))}</div>` : '');
  // A task just finished: refresh the tables so the new state shows without waiting 15 s.
  const signature = data.running.map((item) => item.key).join();
  if (pollActivity.last !== undefined && signature !== pollActivity.last) refresh();
  pollActivity.last = signature;
}
setInterval(pollActivity, 3000);
pollActivity();

function jobSteps(j, publications) {
  const posts = publications.filter((p) => p.platform === 'tiktok' && p.mode === 'schedule');
  const t = j.translation || {};
  const steps = [
    ['Tải', j.source_path ? 'done' : ['queued', 'downloading'].includes(j.status) ? 'active' : ''],
    ['Lời thoại', t.hasDraft || t.hasReviewed || j.dubbed_path ? 'done' : t.transcribing ? 'active' : ''],
    ['Dịch', t.hasReviewed || j.dubbed_path ? 'done' : t.hasDraft ? 'todo' : ''],
    ['Lồng tiếng', j.status === 'dubbing' ? 'active' : j.dubbed_path ? 'done' : ''],
    ['Duyệt', j.approved ? 'done' : j.dubbed_path ? 'todo' : ''],
    ['Link', j.shopee_affiliate_url ? 'done' : j.shopee_item_id ? 'active' : ''],
    ['Đăng', posts.some((p) => p.status === 'done') ? 'done' : posts.some((p) => p.status === 'running') ? 'active' : ''],
    ['Bình luận', posts.some((p) => p.comment_status === 'posted') ? 'done' : posts.some((p) => p.comment_status === 'pending') ? 'active' : '']
  ];
  if (j.status === 'failed') {
    const index = steps.findIndex(([, state]) => state !== 'done');
    if (index >= 0) steps[index][1] = 'error';
  }
  return `<div class="job-steps">${steps.map(([label, state]) => `<span class="step ${state}" title="${label}">${label}</span>`).join('')}</div>`;
}

// ---------- FULL RUN ----------
let roxyProfiles = null;
async function renderFullRun() {
  const topicSelect = $('full-run-topic');
  const topics = state.discovery.topics || [];
  if (document.activeElement !== topicSelect && !topicSelect.options.length) {
    topicSelect.innerHTML = topics.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    topicSelect.onchange = () => selectTopicAccount();
    $('full-run-account').onchange = () => selectAccountTopic();
  }
  $('full-run-translator').textContent = state.autopilot?.translator === 'deepseek' ? 'DeepSeek' : 'Microsoft (miễn phí, có thể sai tiếng lóng)';
  if (!roxyProfiles) {
    roxyProfiles = [];
    const data = await api('/api/roxy-profiles').catch(() => ({ profiles: [], error: 'Không đọc được danh sách profile' }));
    roxyProfiles = data.profiles;
    $('full-run-account').innerHTML = roxyProfiles.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.topic ? ` · ${esc(p.topic)}` : ''}</option>`).join('')
      || topics.filter((t) => t.roxy_profile_id).map((t) => `<option value="${esc(t.roxy_profile_id)}">${esc(t.roxy_profile_id.slice(0, 8))}… · ${esc(t.name)}</option>`).join('');
    if (data.error) $('full-run-status').textContent = data.error;
    selectTopicAccount();
  }
}
// Picking a channel preselects the content type that channel is set up for, and vice versa.
function selectAccountTopic() {
  const topic = (state.discovery.topics || []).find((t) => t.roxy_profile_id === $('full-run-account').value);
  if (topic) $('full-run-topic').value = topic.id;
}
function selectTopicAccount() {
  const topic = (state.discovery.topics || []).find((t) => t.id === Number($('full-run-topic').value));
  if (topic?.roxy_profile_id && [...$('full-run-account').options].some((o) => o.value === topic.roxy_profile_id)) $('full-run-account').value = topic.roxy_profile_id;
}
async function startFullRun(mode) {
  const count = Number($('full-run-count').value) || 2;
  const topic = $('full-run-topic').selectedOptions[0]?.textContent;
  const account = $('full-run-account').selectedOptions[0]?.textContent;
  if (!topic || !account) return alert('Chọn kênh đăng và loại content.');
  const what = mode === 'prepare'
    ? `Chuẩn bị ${count} video "${topic}" cho kênh "${account}" (dừng trước khi đăng để bạn duyệt).`
    : `Chạy ${count} video "${topic}" và TỰ ĐĂNG lên kênh "${account}" theo lịch đăng.`;
  if (!confirm(`${what}

Bạn có quyền sử dụng và đăng lại các video Douyin được chọn?`)) return;
  const button = $(mode === 'prepare' ? 'full-run-prepare' : 'full-run-start');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Đang chọn video…';
  try {
    const result = await api('/api/full-run', 'POST', { topicId: Number($('full-run-topic').value), accountProfile: $('full-run-account').value, count, rightsConfirmed: true, mode });
    $('full-run-status').textContent = `${mode === 'prepare' ? 'Đang chuẩn bị' : 'Đang chạy'} ${result.jobs.map((j) => '#' + j.jobId).join(', ')} · theo dõi ở thanh "Đang chạy"`;
    await refresh();
  } catch (error) { alert(error.message); }
  finally { button.disabled = false; button.textContent = label; }
}
$('full-run-prepare').onclick = () => startFullRun('prepare');
$('full-run-start').onclick = () => startFullRun('post');

// ---------- DOUYIN COOKIE LOGIN ----------
async function renderDouyinLogin() {
  const status = await api('/api/douyin/cookie').catch(() => null);
  const pill = $('douyin-login-status');
  if (!status) { pill.textContent = ''; return; }
  pill.className = `login-pill ${status.loggedIn ? 'ok' : status.saved ? 'warn' : ''}`;
  pill.textContent = status.loggedIn ? `Đã đăng nhập Douyin${status.name ? ' · ' + status.name : ''}` : status.saved ? 'Cookie đã lưu nhưng chưa đăng nhập được' : 'Chưa đăng nhập Douyin · chỉ quét nguồn công khai';
}

function openDouyinCookie() {
  $('modal-title').textContent = 'Đăng nhập Douyin bằng cookie';
  $('modal-body').innerHTML = `
    <div class="settings-form">
      <p class="hint">Đăng nhập Douyin giúp quét theo <strong>từ khóa</strong> (家居好物, 收纳神器…) cho mọi chủ đề. Cookie có giá trị như mật khẩu: chỉ dán ở đây, cookie được lưu trên máy (data/douyin-cookie.json), không gửi đi đâu khác.</p>
      <ol class="hint steps">
        <li>Mở <strong>www.douyin.com</strong> trong Chrome và đăng nhập (quét QR bằng app Douyin).</li>
        <li><strong>Cách A:</strong> bấm F12 → tab <em>Network</em> → tải lại trang → bấm một yêu cầu tới douyin.com → mục <em>Request Headers</em> → copy giá trị dòng <code>cookie:</code>.</li>
        <li><strong>Cách B:</strong> dùng tiện ích <em>Cookie-Editor</em> → Export → JSON.</li>
      </ol>
      <label>Cookie Douyin<textarea id="douyin-cookie-input" rows="6" placeholder="sessionid=...; ttwid=...; ... hoặc [ { &quot;name&quot;: &quot;sessionid&quot;, ... } ]"></textarea></label>
      <p id="douyin-cookie-result" role="status"></p>
      <div class="actions">
        <button class="btn primary" id="douyin-cookie-save">Lưu và kiểm tra</button>
        <button class="btn" id="douyin-cookie-check">Kiểm tra lại</button>
        <button class="btn danger" id="douyin-cookie-clear">Xóa cookie</button>
      </div>
    </div>`;
  $('modal').classList.remove('hidden');
  const result = (text) => { $('douyin-cookie-result').textContent = text; };
  const after = async (status) => {
    $('douyin-cookie-input').value = '';
    if (status.loggedIn) {
      result(`Đã đăng nhập Douyin${status.name ? ': ' + status.name : ''}. Đã tắt "Chỉ nguồn công khai" để quét theo từ khóa.`);
      await api('/api/douyin/discovery/config', 'PATCH', { enabled: $('discovery-enabled').checked, autoQueue: $('discovery-auto-queue').checked, publicOnly: false });
    } else {
      result('Douyin chưa nhận cookie này (có thể hết hạn hoặc thiếu dòng). Hãy copy lại khi đang đăng nhập.');
    }
    await refresh(); renderDouyinLogin();
  };
  $('douyin-cookie-save').onclick = async () => {
    result('Đang kiểm tra với Douyin… (khoảng 15 giây)');
    try { await after(await api('/api/douyin/cookie', 'POST', { cookie: $('douyin-cookie-input').value })); }
    catch (error) { result(error.message); }
  };
  $('douyin-cookie-check').onclick = async () => {
    result('Đang kiểm tra…');
    try { await after(await api('/api/douyin/cookie/check', 'POST', {})); } catch (error) { result(error.message); }
  };
  $('douyin-cookie-clear').onclick = async () => {
    if (!confirm('Xóa cookie Douyin đã lưu?')) return;
    await api('/api/douyin/cookie', 'DELETE'); result('Đã xóa cookie.'); renderDouyinLogin();
  };
}
$('discovery-cookie').onclick = openDouyinCookie;
renderDouyinLogin();

async function setReupTopic(id, topicId) {
  try { await api(`/api/reup/${id}/topic`, 'PATCH', { topicId: topicId || null }); await refresh(); }
  catch (error) { alert(error.message); await refresh(); }
}

function renderDiscovery() {
  const d = state.discovery;
  renderTopics();
  $('discovery-enabled').checked = Boolean(d.enabled);
  $('discovery-auto-queue').checked = Boolean(d.autoQueue);
  $('discovery-public-only').checked = Boolean(d.publicOnly);
  $('discovery-status').textContent = d.scanning ? 'Đang quét' : d.loginOpen && !d.publicOnly ? 'Đang mở đăng nhập; đóng Chrome Douyin khi xong' : d.publicOnly ? 'Chế độ công khai' : '';
  $('discovery-scan').disabled = Boolean(d.scanning || (d.loginOpen && !d.publicOnly));
  $('discovery-login').disabled = Boolean(d.scanning || d.loginOpen);
  const labels = { '厨房好物': 'Đồ bếp', '家居好物': 'Đồ gia dụng', '实用小工具': 'Dụng cụ tiện ích', 'https://www.douyin.com/jingxuan': 'Douyin精选' };
  $('discovery-sources').innerHTML = (d.sources || []).filter((s) => !d.publicOnly || PUBLIC_SOURCE_KINDS.includes(s.kind)).map((s) => `<div class="discovery-source"><div><strong>${esc(labels[s.value] || s.value)}</strong> · ${SOURCE_KIND_LABELS[s.kind] || esc(s.kind)}${s.topic_name ? ` · Chủ đề: ${esc(s.topic_name)}` : ''}${s.rights_confirmed ? ' · Đã xác nhận quyền' : ''}${s.last_scan ? `<small>Quét: ${esc(new Date(s.last_scan).toLocaleString('vi-VN'))}</small>` : ''}${s.error ? `<small class="error-line">${esc(s.error)}</small>` : ''}</div><button class="btn small danger" title="Xóa nguồn" onclick="removeDiscoverySource(${s.id})" ${d.scanning ? 'disabled' : ''}>Xóa</button></div>`).join('');
  const num = (n) => n == null ? '—' : Number(n).toLocaleString('vi-VN');
  const filter = $('discovery-topic-filter');
  if (document.activeElement !== filter) {
    const current = filter.value || 'topics';
    filter.innerHTML = `<option value="topics">Video theo chủ đề</option>` +
      (d.topics || []).map((t) => `<option value="${t.id}">Chủ đề: ${esc(t.name)}</option>`).join('') +
      `<option value="none">Không chủ đề (bảng tin chung)</option><option value="all">Tất cả</option>`;
    filter.value = current;
  }
  const wanted = (c) => filter.value === 'all' || (filter.value === 'topics' ? Boolean(c.topic_id) : filter.value === 'none' ? !c.topic_id : c.topic_id === Number(filter.value));
  $('discovery-candidates').innerHTML = (d.candidates || []).filter((c) => c.status !== 'dismissed' && wanted(c)).map((c) => `<tr>
    <td><a href="${esc(c.source_url)}" target="_blank" rel="noopener noreferrer">${esc(c.title || 'Video Douyin')}</a><small>${esc(c.author)} · ${esc(labels[c.source_name] || c.source_name)}${c.topic_name ? ` · ${esc(c.topic_name)}` : ''}</small></td>
    <td><small>Thích: ${num(c.likes)} · Chia sẻ: ${num(c.shares)}</small><small>Bình luận: ${num(c.comments)}</small>${c.growth == null ? '' : `<small>Tăng: ${num(Math.round(c.growth))}/giờ</small>`}</td>
    <td>${num(c.score)}${c.score === 0 ? '<small>Chưa đủ số liệu</small>' : ''}</td>
    <td>${c.status === 'queued' ? `Đã chọn · #${c.job_id}` : 'Đề xuất'}</td>
    <td><div class="td-actions"><button class="btn small" onclick="previewCandidate(${c.id})">Xem thử</button>${c.status === 'new' && c.topic_id ? `<button class="btn small primary" onclick="quickCandidate(${c.id}, ${c.rights_confirmed})" title="Tải, lấy lời thoại và gắn sản phẩm Shopee tự động">⚡ Nhanh</button>` : ''}${c.status === 'new' ? `<button class="btn small" onclick="queueDiscoveryCandidate(${c.id}, ${c.rights_confirmed})">Tải video</button><button class="btn small" onclick="dismissDiscoveryCandidate(${c.id})">Bỏ qua</button>` : ''}</div></td>
  </tr>`).join('') || `<tr><td colspan="5" class="empty-row">${filter.value === 'topics' ? 'Chưa có video theo chủ đề. Thêm nguồn Danh mục gắn chủ đề rồi bấm Quét ngay.' : 'Chưa có video đề xuất.'}</td></tr>`;
}

$('discovery-topic-filter').onchange = renderDiscovery;
$('discovery-quick').onclick = quickTopic;
$('discovery-source-kind').onchange = () => {
  $('discovery-source-rights').disabled = $('discovery-source-kind').value !== 'channel';
  $('discovery-source-rights').checked = false;
  const feed = $('discovery-source-kind').value === 'feed';
  $('discovery-source-value').placeholder = $('discovery-source-kind').value === 'category' ? 'Mã danh mục, ví dụ 300201' : 'Từ khóa tiếng Trung hoặc URL kênh';
  $('discovery-source-value').disabled = feed;
  $('discovery-source-value').required = !feed;
};
$('discovery-source-form').onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api('/api/douyin/discovery/sources', 'POST', { kind: $('discovery-source-kind').value, value: $('discovery-source-value').value, rightsConfirmed: $('discovery-source-rights').checked, topicId: $('discovery-source-topic').value || null });
    $('discovery-source-form').reset(); $('discovery-source-rights').disabled = true; $('discovery-source-value').disabled = false; $('discovery-source-value').required = true;
    await refresh();
  } catch (error) { alert(error.message); }
};
async function updateDiscoveryConfig() {
  try { await api('/api/douyin/discovery/config', 'PATCH', { enabled: $('discovery-enabled').checked, autoQueue: $('discovery-auto-queue').checked, publicOnly: $('discovery-public-only').checked }); await refresh(); }
  catch (error) { alert(error.message); }
}
$('discovery-enabled').onchange = updateDiscoveryConfig;
$('discovery-auto-queue').onchange = updateDiscoveryConfig;
$('discovery-public-only').onchange = updateDiscoveryConfig;
$('discovery-scan').onclick = async () => {
  try { await api('/api/douyin/discovery/scan', 'POST', {}); await refresh(); }
  catch (error) { alert(error.message); }
};
$('discovery-login').onclick = async () => {
  try { await api('/api/douyin/discovery/login', 'POST', {}); await refresh(); }
  catch (error) { alert(error.message); }
};
async function removeDiscoverySource(id) {
  if (!confirm('Xóa nguồn và danh sách đề xuất của nguồn này?')) return;
  try { await api(`/api/douyin/discovery/sources/${id}`, 'DELETE'); await refresh(); }
  catch (error) { alert(error.message); }
}
async function queueDiscoveryCandidate(id, rights) {
  if (!rights && !confirm('Bạn có quyền sử dụng và đăng lại video này?')) return;
  try { await api(`/api/douyin/discovery/candidates/${id}/queue`, 'POST', { rightsConfirmed: true }); await refresh(); }
  catch (error) { alert(error.message); }
}
// Douyin's official embed player streams the video for review without downloading it.
function previewCandidate(id) {
  const c = (state.discovery.candidates || []).find((item) => item.id === id);
  const videoId = c?.source_url.match(/\/video\/(\d{15,25})/)?.[1];
  if (!videoId) return;
  const num = (n) => n == null ? '—' : Number(n).toLocaleString('vi-VN');
  $('modal-title').textContent = c.title ? c.title.slice(0, 80) : 'Video Douyin';
  $('modal-body').innerHTML = `
    <div class="candidate-preview">
      <iframe src="https://open.douyin.com/player/video?vid=${videoId}&autoplay=0" allow="autoplay; fullscreen" allowfullscreen referrerpolicy="unsafe-url" title="Xem thử video Douyin"></iframe>
      <div class="candidate-preview-meta">
        <p>${esc(c.title)}</p>
        <small>${esc(c.author)}${c.topic_name ? ` · Chủ đề: ${esc(c.topic_name)}` : ''}</small>
        <small>Thích: ${num(c.likes)} · Chia sẻ: ${num(c.shares)} · Bình luận: ${num(c.comments)}</small>
        <small>Thời lượng: ${c.duration ? Math.round(c.duration) + ' giây' : '—'} · Điểm: ${num(c.score)}</small>
        <a href="${esc(c.source_url)}" target="_blank" rel="noopener noreferrer">Mở trên Douyin</a>
        ${c.status === 'new' ? `<div class="td-actions"><button class="btn small primary" onclick="closeModal(); queueDiscoveryCandidate(${c.id}, ${c.rights_confirmed})">Tải video</button><button class="btn small" onclick="closeModal(); dismissDiscoveryCandidate(${c.id})">Bỏ qua</button></div>` : `<small>Đã chọn · #${c.job_id}</small>`}
      </div>
    </div>`;
  $('modal').classList.remove('hidden');
  if (j.source_path) loadTranslation(id);
}

const fmtTime = (seconds) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;

async function loadTranslation(id) {
  const j = state.reup.find((item) => item.id === id);
  const box = $(`translation-editor-${id}`);
  const status = $(`translation-status-${id}`);
  if (!box) return;
  if (j?.translation?.transcribing) { status.textContent = 'Đang lấy lời thoại…'; box.innerHTML = ''; return; }
  let data;
  try { data = await api(`/api/reup/${id}/translation`); }
  catch { status.textContent = 'Chưa có lời thoại'; box.innerHTML = ''; return; }
  const missing = data.segments.filter((s) => !s.text).length;
  status.textContent = data.hasReviewed ? 'Đã dịch đủ · sẵn sàng lồng tiếng' : `${data.segments.length} câu · còn ${missing} câu chưa dịch`;
  box.innerHTML = `
    <label class="voice-line">Giọng đọc
      <select id="translation-voice-${id}">
        <option value="">Theo vai (tự đoán)</option>
        <option value="vi-VN-HoaiMyNeural" ${data.voice === 'vi-VN-HoaiMyNeural' && !data.segments.some((s) => s.speaker) ? 'selected' : ''}>Nữ · HoaiMy</option>
        <option value="vi-VN-NamMinhNeural" ${data.voice === 'vi-VN-NamMinhNeural' ? 'selected' : ''}>Nam · NamMinh</option>
      </select>
    </label>
    <div class="table-scroll"><table class="translation-table"><thead><tr><th>Thời gian</th><th>Câu gốc</th><th>Tiếng Việt</th><th>Đọc</th><th>Bỏ</th></tr></thead><tbody>
    ${data.segments.map((s, i) => `<tr>
      <td><small>${fmtTime(s.start)}–${fmtTime(s.end)}</small></td>
      <td><span class="zh-line">${esc(s.source || '')}</span></td>
      <td><textarea rows="2" id="tr-text-${id}-${i}" placeholder="Nhập câu tiếng Việt">${esc(s.text || '')}</textarea></td>
      <td><input type="checkbox" id="tr-voiced-${id}-${i}" ${s.voiced === false ? '' : 'checked'} title="Đọc thành tiếng (bỏ chọn: chỉ hiện phụ đề)"></td>
      <td><input type="checkbox" id="tr-remove-${id}-${i}" title="Bỏ câu này (chữ trang trí, tên kênh…)"></td>
    </tr>`).join('')}
    </tbody></table></div>
    <div class="row command-row">
      <button class="btn primary" onclick="saveTranslation(${id}, ${data.segments.length})">Lưu bản dịch</button>
      <button class="btn" onclick="saveTranslation(${id}, ${data.segments.length}, true)">Lưu và lồng tiếng</button>
    </div>`;
}

async function extractSpeech(id) {
  try { await api(`/api/reup/${id}/transcribe`, 'POST', {}); await refresh(); openReup(id); watchTranscribe(id); }
  catch (error) { alert(error.message); }
}

async function watchTranscribe(id) {
  for (let i = 0; i < 400; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await refresh();
    const j = state.reup.find((item) => item.id === id);
    if (!j?.translation?.transcribing) {
      if (!$('modal').classList.contains('hidden') && $(`translation-editor-${id}`)) openReup(id);
      if (j?.error) alert(j.error);
      return;
    }
  }
}

async function saveTranslation(id, count, dub = false) {
  const segments = Array.from({ length: count }, (_, i) => ({
    text: $(`tr-text-${id}-${i}`).value, voiced: $(`tr-voiced-${id}-${i}`).checked, remove: $(`tr-remove-${id}-${i}`).checked
  }));
  try {
    const result = await api(`/api/reup/${id}/translation`, 'PUT', { segments, voice: $(`translation-voice-${id}`).value || undefined });
    if (result.missing) { alert(`Đã lưu nháp. Còn ${result.missing} câu chưa dịch — dịch hoặc đánh dấu Bỏ trước khi lồng tiếng.`); await loadTranslation(id); return; }
    if (dub) return startDub(id);
    await refresh(); openReup(id);
  } catch (error) { alert(error.message); }
}

async function quickCandidate(id, rights) {
  if (!rights && !confirm('Bạn có quyền sử dụng và đăng lại video này?')) return;
  try {
    const result = await api(`/api/douyin/discovery/candidates/${id}/quick`, 'POST', { rightsConfirmed: true });
    await refresh();
    const product = result.product ? `Sản phẩm: ${result.product}` : 'Chưa có sản phẩm Shopee cho chủ đề này — quét sản phẩm trong tiện ích.';
    alert(`Đã đưa vào video #${result.jobId}: đang tải, sau đó tự lấy lời thoại.\n${product}`);
  } catch (error) { alert(error.message); }
}

async function quickTopic() {
  const topicId = Number($('discovery-topic-filter').value);
  if (!topicId) return alert('Chọn một chủ đề cụ thể trong ô lọc trước.');
  if (!confirm('Lấy nhanh 3 video điểm cao nhất của chủ đề này. Bạn có quyền sử dụng và đăng lại các video này?')) return;
  try {
    const { jobs } = await api('/api/douyin/discovery/quick', 'POST', { topicId, count: 3, rightsConfirmed: true });
    await refresh();
    alert(`Đã đưa ${jobs.length} video vào hàng đợi: ${jobs.map((j) => `#${j.jobId}`).join(', ')}. Máy sẽ tự tải, lấy lời thoại và gắn sản phẩm; khi xong bấm Dịch để soát.`);
  } catch (error) { alert(error.message); }
}

async function dismissDiscoveryCandidate(id) {
  try { await api(`/api/douyin/discovery/candidates/${id}/dismiss`, 'POST', {}); await refresh(); }
  catch (error) { alert(error.message); }
}

function renderPublication(p, affiliateReady = false) {
  const result = `<small id="publication-comment-result-${p.id}" role="status">${p.comment_error ? `Lỗi: ${esc(p.comment_error)}` : ''}</small>`;
  const running = state.commenting?.publicationId === p.id;
  const auto = p.platform === 'tiktok'
    ? `<div class="row"><input id="publication-post-url-${p.id}" type="url" value="${esc(p.post_url || '')}" placeholder="https://www.tiktok.com/@.../video/..." aria-label="Link bài TikTok"><button class="btn small" onclick="savePublicationPostUrl(${p.id}, ${p.job_id})">Lưu link bài</button></div>
      <div class="row"><select id="publication-browser-${p.id}" aria-label="Trình duyệt bình luận"><option value="">Trình duyệt mặc định</option><option value="chrome">Chrome</option><option value="roxy">RoxyBrowser</option></select><button class="btn small primary" onclick="runPublicationComment(${p.id}, ${p.job_id})" ${p.post_url && !state.commenting ? '' : 'disabled'}>Tự bình luận</button></div>
      ${running ? `<small>${state.commenting.verification ? 'TikTok yêu cầu xác minh: hãy giải trong cửa sổ trình duyệt vừa mở.' : 'Đang bình luận và kiểm tra lại…'}</small>` : ''}`
    : '';
  const comment = p.comment_status === 'pending'
    ? `<div class="publication-comment"><span>Chờ bình luận affiliate: ${esc(p.comment_url)}</span>${auto}<div class="row"><button class="btn small" onclick="copyPublicationComment(${p.id})">Sao chép link</button><button class="btn small" onclick="markPublicationCommentPosted(${p.id}, ${p.job_id})">Đã bình luận tay</button></div>${result}</div>`
    : p.comment_status === 'posted' ? '<span class="comment-posted">Đã xác nhận bình luận</span>'
      : affiliateReady && p.mode === 'schedule' && p.status === 'done'
        ? `<div class="publication-comment"><button class="btn small" onclick="attachPublicationAffiliate(${p.id}, ${p.job_id})">Gắn link vào bài này</button>${result}</div>` : '';
  return `<div class="publication-item"><span>#${p.id} ${esc(p.platform)} · ${esc(p.mode)} · ${esc(p.status)}${p.error ? ` · ${esc(p.error)}` : ''}</span>${comment}</div>`;
}

async function savePublicationPostUrl(publicationId, jobId) {
  try {
    await api(`/api/reup/publications/${publicationId}/post-url`, 'PATCH', { url: $(`publication-post-url-${publicationId}`).value.trim() });
    await refresh(); openReup(jobId);
  } catch (error) { $(`publication-comment-result-${publicationId}`).textContent = error.message; }
}

async function runPublicationComment(publicationId, jobId) {
  if (!confirm('Mở trình duyệt TikTok và đăng link affiliate vào bình luận của bài này?')) return;
  try {
    await api(`/api/reup/publications/${publicationId}/comment/run`, 'POST', { browser: $(`publication-browser-${publicationId}`).value });
    await refresh(); openReup(jobId);
    watchComment(jobId);
  } catch (error) { $(`publication-comment-result-${publicationId}`).textContent = error.message; }
}

async function watchComment(jobId) {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await refresh();
    if (!$('modal').classList.contains('hidden')) openReup(jobId);
    if (!state.commenting) return;
  }
}

// ---------- TABS ----------
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('tab-' + t.dataset.tab).classList.add('active');
  });
});

// ---------- DEVICES ----------
const REUP_STATUS = {
  queued: 'Chờ tải',
  downloading: 'Đang tải Douyin', source_ready: 'Có video nguồn', dubbing: 'Đang lồng tiếng',
  review: 'Chờ duyệt', failed: 'Lỗi'
};

function renderReup() {
  $('reup-count').textContent = `${state.reup.length} video`;
  $('reup-services').innerHTML = [['douyinLocal', 'Bộ tải Douyin'], ['dtk', 'Douyin API'], ['videoLingo', 'VideoLingo'], ['luno', 'LUNO']]
    .map(([key, label]) => `<div class="service-line"><span class="service-dot ${state.services[key] ? 'up' : ''}"></span>${label}<strong>${state.services[key] ? 'API chạy' : 'Chưa chạy'}</strong></div>`).join('');
  $('reup-body').innerHTML = state.reup.map((j) => {
    const publications = state.publications.filter((p) => p.job_id === j.id);
    const latest = publications.slice(0, 2).map((p) => `<div>${esc(p.platform)} · ${esc(p.mode)} · <span class="badge ${p.status}">${esc(p.status)}</span>${p.error ? `<small class="error-line">${esc(p.error)}</small>` : ''}</div>`).join('');
    return `<tr>
      <td><strong>#${j.id} ${esc(j.title || 'Video Douyin')}</strong><small class="source-url">${esc(j.source_url)}</small>${jobSteps(j, publications)}<select class="topic-select" aria-label="Chủ đề video #${j.id}" onchange="setReupTopic(${j.id}, this.value)" ${publications.some((p) => p.status === 'running') ? 'disabled' : ''}>${topicOptions(j.topic_id, 'Chưa gắn chủ đề · đăng bằng profile mặc định')}</select>${j.error ? `<small class="error-line">${esc(j.error)}</small>` : ''}</td>
      <td><span class="badge ${j.status}">${REUP_STATUS[j.status] || esc(j.status)}</span>${j.approved ? '<small class="approved-line">Đã duyệt</small>' : ''}</td>
      <td><small>TikTok: ${esc(j.tiktok_product_id || '-')}</small><small>Shopee: ${esc(j.shopee_product_query || '-')}</small><small>Custom Link: ${j.shopee_affiliate_url ? 'Đã lưu' : 'Chưa có'}</small></td>
      <td>${latest || '<small>Chưa đăng</small>'}</td>
      <td><div class="td-actions">
        <button class="btn small" onclick="openReup(${j.id})">Kiểm tra</button>
        ${j.status === 'source_ready' || (j.status === 'failed' && j.source_path) ? (j.translation?.hasReviewed
          ? `<button class="btn small" onclick="startDub(${j.id})">Lồng tiếng</button>`
          : `<button class="btn small primary" onclick="openReup(${j.id})">${j.translation?.transcribing ? 'Đang lấy lời thoại…' : 'Dịch'}</button>`) : ''}
        ${j.status === 'failed' && !j.source_path ? `<button class="btn small" onclick="retryImport(${j.id})">Tải lại</button>` : ''}
        ${!['queued', 'downloading', 'dubbing'].includes(j.status) && !publications.some((p) => p.status === 'running') ? `<button class="btn small danger" onclick="removeReup(${j.id})">Xóa</button>` : ''}
      </div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="empty-row">Chưa có video Douyin.</td></tr>';
}

function openReup(id) {
  const j = state.reup.find((item) => item.id === id);
  if (!j) return;
  $('modal-title').textContent = `Video #${j.id} · ${REUP_STATUS[j.status] || j.status}`;
  const publications = state.publications.filter((p) => p.job_id === id);
  $('modal-body').innerHTML = `
    <div class="preview-grid">
      ${j.source_path ? `<div><h4>Bản gốc</h4><video controls preload="metadata" src="/api/reup/${id}/video?kind=source"></video></div>` : ''}
      ${j.dubbed_path ? `<div><h4>Bản tiếng Việt</h4><video controls preload="metadata" src="/api/reup/${id}/video"></video></div>` : ''}
    </div>
    ${j.source_path ? `<div class="translation-workflow">
      <div class="workflow-list-head"><h4>Lời thoại &amp; bản dịch</h4><span id="translation-status-${id}" role="status"></span></div>
      <div class="row command-row">
        <button class="btn" onclick="extractSpeech(${id})" ${j.translation?.transcribing || j.status === 'dubbing' ? 'disabled' : ''}>${j.translation?.hasDraft ? 'Lấy lại lời thoại' : 'Lấy lời thoại'}</button>
        <small>Đọc chữ Trung trên video (OCR); nếu không có phụ đề thì nghe lời nói (Whisper). Mất vài phút.</small>
      </div>
      <div id="translation-editor-${id}"></div>
    </div>` : ''}
    <div class="edit-grid">
      <label>Tiêu đề nội bộ<input id="reup-edit-title" value="${esc(j.title)}"></label>
      <label>ID sản phẩm TikTok (tùy chọn)<input id="reup-edit-tiktok" value="${esc(j.tiktok_product_id)}" placeholder="ID trong TikTok Shop"></label>
      <label>Tên tìm sản phẩm Shopee<input id="reup-edit-shopee-query" value="${esc(j.shopee_product_query)}" placeholder="Tên sản phẩm chính xác"></label>
      <label>ID sản phẩm Shopee<input id="reup-edit-shopee-id" value="${esc(j.shopee_product_id)}" placeholder="ID sản phẩm để đối chiếu"></label>
      <label class="wide">Caption tiếng Việt<textarea id="reup-edit-caption" rows="3">${esc(j.caption)}</textarea></label>
    </div>
    <div class="affiliate-workflow">
      <h4>Shopee Custom Link</h4>
      <label>URL sản phẩm Shopee<input id="reup-product-url" type="url" value="${esc(j.shopee_product_url)}" placeholder="https://shopee.vn/..."></label>
      <div class="row command-row">
        <button class="btn" onclick="saveAffiliateProduct(${id})">Lưu sản phẩm</button>
        <button class="btn primary" onclick="generateAffiliateLink(${id})" ${j.shopee_product_url && state.shopeeOpenApi ? '' : 'disabled'} title="${state.shopeeOpenApi ? 'Tạo qua Shopee Open API' : 'Cần cấu hình data/shopee-openapi.json'}">Tạo link tự động</button>
        <button class="btn" onclick="openCustomLink(${id})" ${j.shopee_product_url ? '' : 'disabled'}>Mở Custom Link</button>
      </div>
      <div class="affiliate-tracking">Sub_id1: <strong>Reup</strong> · Sub_id2: <strong>Clip${id}</strong></div>
      <label>Link affiliate Shopee trả về<input id="reup-affiliate-url" type="url" value="${esc(j.shopee_affiliate_url)}" placeholder="https://s.shopee.vn/..."></label>
      <div class="row command-row"><button class="btn" onclick="saveAffiliateLink(${id})">Lưu link affiliate</button></div>
      ${j.shopee_affiliate_url ? `<a href="${esc(j.shopee_affiliate_url)}" target="_blank" rel="noopener noreferrer">Kiểm tra link đã lưu</a>` : ''}
      <p id="reup-affiliate-result" role="status"></p>
    </div>
    <div class="row command-row">
      <button class="btn" onclick="saveReup(${id})">Lưu thông tin</button>
      ${j.status === 'review' ? `<button class="btn primary" onclick="approveReup(${id})" ${j.approved ? 'disabled' : ''}>${j.approved ? 'Đã duyệt' : 'Duyệt video'}</button>` : ''}
      ${j.source_path && j.status !== 'dubbing' ? `<button class="btn" onclick="startDub(${id})">Lồng tiếng lại</button>` : ''}
    </div>
    <div class="publish-controls">
      <h4>Đăng qua LUNO</h4>
      <div class="row">
        <select id="reup-platform" aria-label="Nền tảng"><option value="tiktok">TikTok</option><option value="shopee">Shopee Video</option></select>
        <select id="reup-mode" aria-label="Chế độ đăng"><option value="dry_run">Kiểm tra trước</option><option value="draft">Lưu nháp</option><option value="schedule">Đăng ngay</option></select>
        <button class="btn primary" onclick="publishReup(${id})" ${j.approved ? '' : 'disabled'}>Thực hiện</button>
      </div>
    </div>
    ${publications.length ? `<div class="publication-history"><h4>Lịch sử đăng</h4>${publications.map((p) => renderPublication(p, Boolean(j.shopee_affiliate_url && j.shopee_product_url))).join('')}</div>` : ''}`;
  $('modal').classList.remove('hidden');
}

async function copyPublicationComment(publicationId) {
  const result = $(`publication-comment-result-${publicationId}`);
  try {
    const data = await api(`/api/reup/publications/${publicationId}/comment`);
    await navigator.clipboard.writeText(data.comment);
    result.textContent = 'Đã sao chép. Hãy bình luận vào đúng bài đăng.';
  } catch (error) { result.textContent = error.message; }
}

async function attachPublicationAffiliate(publicationId, jobId) {
  const result = $(`publication-comment-result-${publicationId}`);
  try {
    await api(`/api/reup/publications/${publicationId}/affiliate`, 'POST', {});
    await refresh(); openReup(jobId);
  } catch (error) { result.textContent = error.message; }
}

async function markPublicationCommentPosted(publicationId, jobId) {
  const result = $(`publication-comment-result-${publicationId}`);
  if (!confirm('Bạn đã đăng và kiểm tra bình luận trên đúng bài video này?')) return;
  try {
    await api(`/api/reup/publications/${publicationId}/comment-posted`, 'POST', {});
    await refresh(); openReup(jobId);
  } catch (error) { result.textContent = error.message; }
}

async function saveAffiliateProduct(id) {
  try {
    await api(`/api/reup/${id}/affiliate/product`, 'PATCH', { url: $('reup-product-url').value.trim() });
    await refresh(); openReup(id);
    $('reup-affiliate-result').textContent = 'Đã lưu sản phẩm.';
  } catch (error) { $('reup-affiliate-result').textContent = error.message; }
}

async function openCustomLink(id) {
  const j = state.reup.find((item) => item.id === id);
  if (!j?.shopee_product_url) return;
  window.open('https://affiliate.shopee.vn/offer/custom_link', '_blank', 'noopener,noreferrer');
  try {
    await navigator.clipboard.writeText(j.shopee_product_url);
    $('reup-affiliate-result').textContent = 'Đã sao chép URL sản phẩm. Dùng Sub_id1 Reup và Sub_id2 Clip' + id + '.';
  } catch {
    $('reup-affiliate-result').textContent = 'Sao chép URL sản phẩm trong ô trên và nhập vào trang Shopee.';
  }
}

async function generateAffiliateLink(id) {
  $('reup-affiliate-result').textContent = 'Đang tạo link…';
  try {
    await api(`/api/reup/${id}/affiliate/generate`, 'POST', {});
    await refresh(); openReup(id);
    $('reup-affiliate-result').textContent = 'Đã tạo và lưu link affiliate.';
  } catch (error) { $('reup-affiliate-result').textContent = error.message; }
}

async function saveAffiliateLink(id) {
  try {
    await api(`/api/reup/${id}/affiliate/link`, 'PATCH', { url: $('reup-affiliate-url').value.trim() });
    await refresh(); openReup(id);
    $('reup-affiliate-result').textContent = 'Đã lưu Custom Link. Chọn bài đăng để chuẩn bị bình luận.';
  } catch (error) { $('reup-affiliate-result').textContent = error.message; }
}

async function saveReup(id) {
  try {
    await api(`/api/reup/${id}`, 'PATCH', {
      title: $('reup-edit-title').value, caption: $('reup-edit-caption').value,
      tiktok_product_id: $('reup-edit-tiktok').value,
      shopee_product_query: $('reup-edit-shopee-query').value,
      shopee_product_id: $('reup-edit-shopee-id').value
    });
    await refresh(); openReup(id);
  } catch (e) { alert(e.message); }
}

async function approveReup(id) {
  try { await api(`/api/reup/${id}/approve`, 'POST', {}); await refresh(); openReup(id); }
  catch (e) { alert(e.message); }
}

async function startDub(id) {
  try { await api(`/api/reup/${id}/dub`, 'POST', {}); closeModal(); await refresh(); }
  catch (e) { alert(e.message); }
}

async function retryImport(id) {
  try { await api(`/api/reup/${id}/retry-import`, 'POST', {}); await refresh(); }
  catch (e) { alert(e.message); }
}

async function removeReup(id) {
  if (!confirm(`Xóa video #${id} và hai file đã tải/lồng tiếng?`)) return;
  try { await api(`/api/reup/${id}`, 'DELETE'); await refresh(); }
  catch (e) { alert(e.message); }
}

async function publishReup(id) {
  const platform = $('reup-platform').value;
  const mode = $('reup-mode').value;
  if (platform === 'tiktok' && (state.tiktok.browserMode === 'roxy' ? !state.tiktok.browserConfigured : !state.tiktok.activeId || !(state.tiktok.hasSession || state.tiktok.hasCookie))) {
    alert('Đăng nhập TikTok trước khi đăng video.'); return;
  }
  if (mode === 'schedule' && !confirm(`Đăng video #${id} ngay lên ${platform}?`)) return;
  try {
    await api(`/api/reup/${id}/publish`, 'POST', { platform, mode });
    closeModal(); await refresh();
  } catch (e) { alert(e.message); }
}

$('reup-import-form').onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const result = await api('/api/reup/import', 'POST', {
      urls: $('reup-url').value.trim().split(/\r?\n/).filter((line) => line.trim()), title: $('reup-title').value.trim(), topicId: $('reup-topic').value || null, rightsConfirmed: $('reup-rights').checked
    });
    $('reup-import-result').textContent = `${result.ids.length} video vào hàng đợi · ${result.skipped.length} video đã có`;
    $('reup-import-form').reset();
    await refresh();
  } catch (e) { $('reup-import-result').textContent = e.message; }
  finally { button.disabled = false; }
};

// ---------- DEVICES ----------
async function renderDevices() {
  const body = $('devices-body');
  if (!state.devices.length) { body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#8b93a7">Chưa có thiết bị. Bấm "Quét thiết bị" sau khi mở giả lập.</td></tr>'; return; }
  body.innerHTML = state.devices.map((d) => `
    <tr>
      <td>${esc(d.serial)}</td>
      <td><input value="${esc(d.name)}" data-field="name" data-serial="${esc(d.serial)}" style="min-width:120px" onchange="updateDevice(this)"></td>
      <td><span class="badge ${d.status}">${d.status}</span></td>
      <td>${esc(d.resolution)}</td>
      <td>${d.last_post ? new Date(d.last_post).toLocaleString('vi-VN') : '-'}</td>
      <td>
        <div class="td-actions">
          <button class="btn small" onclick="openTikTok('${esc(d.serial)}')">Mở TikTok</button>
          <button class="btn small" onclick="openScreenshot('${esc(d.serial)}')">Ảnh màn hình</button>
          <button class="btn small" onclick="editCoords('${esc(d.serial)}')">Tọa độ</button>
          <button class="btn small primary" onclick="postVideo('${esc(d.serial)}')">Đăng video</button>
          <button class="btn small" onclick="doComment('${esc(d.serial)}')">Cmt link</button>
          <button class="btn small danger" onclick="removeDevice('${esc(d.serial)}')">Xóa</button>
        </div>
      </td>
    </tr>`).join('');
}

async function updateDevice(el) {
  await api(`/api/devices/${el.dataset.serial}/update`, 'POST', { [el.dataset.field]: el.value });
}
async function removeDevice(serial) {
  if (!confirm('Xóa thiết bị ' + serial + '?')) return;
  await api('/api/devices/' + encodeURIComponent(serial), 'DELETE');
  await refresh();
}
async function openTikTok(serial) {
  try { await api('/api/devices/' + encodeURIComponent(serial) + '/open', 'POST'); }
  catch (e) { alert(e.message); }
}
async function postVideo(serial) {
  try { await api('/api/devices/' + encodeURIComponent(serial) + '/post', 'POST', {}); }
  catch (e) { alert(e.message); }
}
async function doComment(serial) {
  try {
    const r = await api('/api/devices/' + encodeURIComponent(serial) + '/comment', 'POST');
    alert(r.link ? 'Đã cmt: ' + r.link : 'Không có link trong pool');
  } catch (e) { alert(e.message); }
}

// ---------- SCREENSHOT CALIBRATION ----------
async function openScreenshot(serial) {
  state.currentSerial = serial;
  state.picked = {};
  const d = state.devices.find((x) => x.serial === serial);
  $('modal-title').textContent = 'Hiệu chỉnh tọa độ - ' + (d ? d.name : serial);
  $('modal-body').innerHTML = `
    <p class="hint">Click vào vị trí nút trên ảnh để chọn tọa độ, rồi bấm nút tương ứng để gán. Bấm "Xem ảnh mới" để chụp lại màn hình.</p>
    <div class="screenshot-wrap">
      <img id="shot-img" src="/api/devices/${encodeURIComponent(serial)}/screenshot.png?t=${Date.now()}" onload="imgLoaded()">
      <div id="shot-tag" class="coord-tag" style="display:none"></div>
    </div>
    <p class="hint">Tọa độ vừa chọn: <b id="picked-coord">-</b></p>
    <div class="steps-grid" id="steps-grid"></div>
    <div class="row" style="margin-top:12px">
      <button class="btn" onclick="refreshShot()">Xem ảnh mới</button>
      <button class="btn primary" onclick="savePicked()">Lưu tọa độ đã gán</button>
    </div>`;
  const img = $('shot-img');
  img.onclick = (e) => {
    const r = img.getBoundingClientRect();
    const x = Math.round((e.clientX - r.left) * img.naturalWidth / r.width);
    const y = Math.round((e.clientY - r.top) * img.naturalHeight / r.height);
    state.picked = { x, y };
    $('picked-coord').textContent = `${x}, ${y}`;
    const tag = $('shot-tag');
    tag.style.display = 'block';
    tag.style.left = (e.clientX - r.left) + 'px';
    tag.style.top = (e.clientY - r.top) + 'px';
    tag.textContent = `${x},${y}`;
    renderStepsGrid();
  };
  $('modal').classList.remove('hidden');
  refreshShot();
}
function imgLoaded() {
  if (!state.currentSerial) return;
  const d = state.devices.find((x) => x.serial === state.currentSerial);
  if (!d) return;
  let coords = {};
  try { coords = JSON.parse(d.coords || '{}'); } catch {}
  $('steps-grid').innerHTML = '';
}
function refreshShot() {
  const img = $('shot-img');
  if (img) img.src = '/api/devices/' + encodeURIComponent(state.currentSerial) + '/screenshot.png?t=' + Date.now();
}
function renderStepsGrid() {
  const steps = ['create_btn', 'gallery_tab', 'first_video', 'next_btn', 'caption_box', 'post_btn', 'profile_tab', 'first_video_profile', 'comment_box', 'comment_input', 'send_btn'];
  const grid = $('steps-grid');
  grid.innerHTML = steps.map((s) => `<button class="btn small" onclick="assignStep('${s}')">${s}</button>`).join('') +
    '<div style="width:100%;color:#8b93a7;font-size:11px">Chọn tọa độ trên ảnh trước, rồi bấm nút để gán.</div>';
}
function assignStep(step) {
  if (!state.picked.x) { alert('Hãy click chọn vị trí trên ảnh trước.'); return; }
  state.picked = { ...state.picked, step };
  renderStepsGrid();
}
async function savePicked() {
  if (!state.picked.step) { alert('Chưa gán step nào.'); return; }
  const d = state.devices.find((x) => x.serial === state.currentSerial);
  let coords = {};
  try { coords = JSON.parse(d.coords || '{}'); } catch {}
  coords[state.picked.step] = [state.picked.x, state.picked.y];
  await api('/api/devices/' + encodeURIComponent(state.currentSerial) + '/update', 'POST', { coords });
  alert('Đã lưu tọa độ cho ' + state.picked.step);
  closeModal();
  await refresh();
}

// ---------- COORDS JSON EDITOR ----------
async function editCoords(serial) {
  const d = state.devices.find((x) => x.serial === serial);
  $('modal-title').textContent = 'Tọa độ - ' + d.name;
  $('modal-body').innerHTML = `
    <p class="hint">Định dạng: {"step": [x, y], ...}. Step hợp lệ: create_btn, gallery_tab, first_video, next_btn, caption_box, post_btn, profile_tab, first_video_profile, comment_box, comment_input, send_btn.</p>
    <textarea id="coords-json" rows="14">${esc(d.coords || '{}')}</textarea>
    <div class="row" style="margin-top:10px"><button class="btn primary" onclick="saveCoordsJson('${esc(serial)}')">Lưu</button></div>`;
  $('modal').classList.remove('hidden');
}
async function saveCoordsJson(serial) {
  try {
    JSON.parse($('coords-json').value);
  } catch {
    alert('JSON không hợp lệ');
    return;
  }
  await api('/api/devices/' + encodeURIComponent(serial) + '/update', 'POST', { coords: JSON.parse($('coords-json').value) });
  closeModal();
  await refresh();
}

function closeModal() { $('modal').classList.add('hidden'); }
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });

// ---------- VIDEOS ----------
function renderVideos() {
  const body = $('videos-body');
  if (!state.videos.length) { body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#8b93a7">Chưa có video.</td></tr>'; return; }
  body.innerHTML = state.videos.map((v) => `
    <tr>
      <td>#${v.id}</td>
      <td>${esc(v.title)}<br><small style="color:#8b93a7">${esc(v.source_url)}</small>${v.error ? `<br><small style="color:#f87171">${esc(v.error)}</small>` : ''}</td>
      <td><span class="badge ${v.status}">${v.status}</span></td>
      <td>raw ${v.raw_size}MB / proc ${v.processed_size}MB</td>
      <td>
        <div class="td-actions">
          ${v.status === 'raw' || v.status === 'failed' ? `<button class="btn small" onclick="processVideo(${v.id})">Xử lý</button>` : ''}
          ${v.status === 'ready' ? `<button class="btn small primary" onclick="postReady(${v.id})">Đăng</button>` : ''}
          <button class="btn small danger" onclick="removeVideo(${v.id})">Xóa</button>
        </div>
      </td>
    </tr>`).join('');
}
async function processVideo(id) {
  try { await api('/api/videos/' + id + '/process', 'POST', {}); }
  catch (e) { alert(e.message); }
}
async function postReady(id) {
  const serial = prompt('Nhập serial thiết bị (vd emulator-5554):');
  if (!serial) return;
  try { await api('/api/videos/' + id + '/post', 'POST', { serial }); }
  catch (e) { alert(e.message); }
}
async function removeVideo(id) {
  if (!confirm('Xóa video #' + id + '?')) return;
  await api('/api/videos/' + id, 'DELETE');
  await refresh();
}

// ---------- LINKS ----------
function renderLinks() {
  const body = $('links-body');
  body.innerHTML = state.links.map((l) => `
    <tr><td>${l.id}</td><td>${esc(l.content)}</td><td>${l.used_count}</td>
    <td><button class="btn small danger" onclick="removeLink(${l.id})">Xóa</button></td></tr>`).join('') ||
    '<tr><td colspan="4" style="text-align:center;color:#8b93a7">Chưa có link.</td></tr>';
}
async function removeLink(id) {
  await api('/api/links/' + id, 'DELETE');
  await refresh();
}

// ---------- SETTINGS ----------
const SETTING_FIELDS = [
  ['adb_path', 'Đường dẫn adb.exe (để trống = tự dò)'],
  ['ffmpeg_path', 'Đường dẫn ffmpeg.exe (để trống = tự dò)'],
  ['ytdlp_path', 'Đường dẫn yt-dlp.exe (để trống = tự dò)'],
  ['tiktok_package', 'Package TikTok'],
  ['caption_template', 'Caption mặc định khi đăng'],
  ['tap_delay_ms', 'Delay giữa các thao tác (ms)'],
  ['tap_delay_jitter_ms', 'Jitter ngẫu nhiên (ms)'],
  ['post_cooldown_min', 'Nghỉ tối thiểu giữa 2 bài (phút)'],
  ['scheduler_interval_min', 'Scheduler check mỗi (phút)'],
  ['scheduler_max_posts_per_day', 'Tối đa bài/ngày/máy'],
  ['watermark_remove', 'Xóa watermark (1 = có, 0 = không)'],
  ['watermark_crop_px', 'Pixel cắt bên phải để bỏ watermark']
];
function renderSettings() {
  $('settings-form').innerHTML = SETTING_FIELDS.map(([k, label]) => `
    <div class="row">
      <label style="flex:1.4;display:flex;align-items:center;font-size:13px">${esc(label)}</label>
      <input data-key="${k}" value="${esc(state.settings[k] || '')}" style="flex:2">
    </div>`).join('');
}
async function saveSettings() {
  const body = {};
  document.querySelectorAll('#settings-form input[data-key]').forEach((i) => { body[i.dataset.key] = i.value; });
  await api('/api/settings', 'POST', body);
  alert('Đã lưu.');
  await refresh();
}

// ---------- REFRESH ----------
async function refresh() {
  try {
    const [dev, vid, lnk, set, sched, tools, reup, discovery, tiktok, products, autopilotState] = await Promise.all([
      api('/api/devices'), api('/api/videos'), api('/api/links'), api('/api/settings'), api('/api/scheduler'), api('/api/tools/status'), api('/api/reup'), api('/api/douyin/discovery'), api('/api/tiktok/account'), api('/api/shopee-products'), api('/api/autopilot')
    ]);
    state.autopilot = autopilotState;
    state.products = products.products;
    state.devices = dev.devices;
    state.videos = vid.videos;
    state.links = lnk.links;
    state.reup = reup.jobs;
    state.publications = reup.publications;
    state.services = reup.services;
    state.commenting = reup.commenting;
    state.shopeeOpenApi = reup.shopeeOpenApi;
    state.settings = set.settings;
    state.discovery = discovery;
    state.tiktok = tiktok;
    renderTikTokAccount(); renderDiscovery(); renderReup(); renderProducts(); renderPreview(); renderAutopilot(); renderFullRun(); renderDevices(); renderVideos(); renderLinks(); renderSettings();
    $('btn-scheduler').textContent = (sched.enabled ? 'Tắt' : 'Bật') + ' Scheduler';
    $('btn-scheduler').classList.toggle('on', sched.enabled);
    $('tools-status').textContent = `ffmpeg: ${tools.ffmpeg ? 'OK' : 'MISSING'} | yt-dlp: ${tools.ytdlp ? 'OK' : 'MISSING'}`;
  } catch (e) {
    console.error('refresh lỗi: ' + e.message);
  }
}

// ---------- ACTIONS ----------
$('btn-rescan').onclick = async () => {
  try {
    const r = await api('/api/devices/rescan', 'POST', {});
    alert('Đã quét. ADB: ' + (r.adb || 'không tìm thấy') + '\n' + r.devices.map((d) => d.serial + ' ' + d.state).join('\n'));
    await refresh();
  } catch (e) { alert(e.message); }
};
$('btn-ytdlp').onclick = async () => {
  $('btn-ytdlp').disabled = true;
  try {
    const r = await api('/api/tools/install-ytdlp', 'POST', {});
    alert('Đã cài: ' + r.path);
  } catch (e) { alert('Lỗi: ' + e.message); }
  $('btn-ytdlp').disabled = false;
  await refresh();
};
$('btn-ffmpeg').onclick = async () => {
  $('btn-ffmpeg').disabled = true;
  try {
    const r = await api('/api/tools/install-ffmpeg', 'POST', {});
    alert('Đã cài: ' + r.path);
  } catch (e) { alert('Lỗi: ' + e.message); }
  $('btn-ffmpeg').disabled = false;
  await refresh();
};
$('btn-scheduler').onclick = async () => {
  await api('/api/scheduler/toggle', 'POST', {});
  await refresh();
};
$('btn-download').onclick = async () => {
  const url = $('video-url').value.trim();
  if (!url) { alert('Nhập URL video.'); return; }
  try {
    const r = await api('/api/videos/download', 'POST', { url, title: $('video-title').value.trim() });
    alert(r.message);
    $('video-url').value = '';
  } catch (e) { alert(e.message); }
};
$('btn-add-links').onclick = async () => {
  const text = $('links-textarea').value;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return;
  const r = await api('/api/links', 'POST', { contents: lines });
  alert('Đã thêm ' + r.added + ' link.');
  $('links-textarea').value = '';
  await refresh();
};
$('btn-save-settings').onclick = saveSettings;

// ---------- LOGS ----------
function appendLog(entry) {
  const box = $('log-box');
  const div = document.createElement('div');
  div.className = entry.msg.startsWith('[ERR]') ? 'err' : '';
  div.textContent = `[${new Date(entry.t).toLocaleTimeString('vi-VN')}] ${entry.msg}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
socket.on('logs', (logs) => {
  $('log-box').innerHTML = '';
  logs.forEach(appendLog);
});
socket.on('log', appendLog);

refresh();
setInterval(refresh, 15000);
