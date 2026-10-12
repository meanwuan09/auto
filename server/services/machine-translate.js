// Machine translation for unattended runs. DeepSeek (OpenAI-compatible) is used when
// DEEPSEEK_API_KEY is set; otherwise Microsoft's free Edge translator, which translates
// literally and cannot shorten lines, so its output is checked against cue timing.
const fs = require('fs');
const path = require('path');

const MICROSOFT = 'https://edge.microsoft.com/translate/translatetext?from=zh-Hans&to=vi&isEnterpriseClient=false';
const CONFIG_FILE = path.join(__dirname, '..', '..', 'data', 'llm.json');

// Environment variables win; data/llm.json (not committed) keeps the key across restarts.
function settings() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  return {
    key: process.env.DEEPSEEK_API_KEY || file.deepseek_api_key || '',
    model: process.env.DEEPSEEK_MODEL || file.deepseek_model || 'deepseek-chat',
    baseUrl: process.env.DEEPSEEK_BASE_URL || file.deepseek_base_url || 'https://api.deepseek.com',
    provider: process.env.LLM_PROVIDER || file.provider || ''
  };
}

function provider() {
  const config = settings();
  return config.key && config.provider !== 'microsoft' ? 'deepseek' : 'microsoft';
}

async function microsoft(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 50) {
    const batch = lines.slice(i, i + 50);
    const response = await fetch(MICROSOFT, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify(batch), signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) throw new Error(`Microsoft Translator HTTP ${response.status}`);
    const body = await response.json();
    out.push(...body.map((item) => item.translations?.[0]?.text?.trim() || ''));
  }
  return out;
}

// Same rules used for the hand translations: context, pronouns, slang, short lines.
async function deepseek(lines, durations) {
  const numbered = lines.map((line, i) => `${i + 1}. [${durations[i].toFixed(1)}s] ${line}`).join('\n');
  const config = settings();
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` },
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({
      model: config.model, temperature: 0.3,
      messages: [
        { role: 'system', content: 'Bạn dịch phụ đề video Douyin sang tiếng Việt tự nhiên để lồng tiếng TikTok. Đọc cả danh sách để hiểu ngữ cảnh; dịch nghĩa tiếng lóng (ví dụ 山竹 là bàn chân mèo, 烧心 là khó chịu trong bụng); xưng hô hợp vai (chị/em, anh/em) thay vì tôi/bạn; mỗi câu phải đọc xong trong số giây ghi trong ngoặc (khoảng 5 âm tiết mỗi giây), rút gọn nếu cần. Trả về đúng số dòng, mỗi dòng dạng "số. bản dịch", không giải thích.' },
        { role: 'user', content: numbered }
      ]
    })
  });
  if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const text = (await response.json()).choices?.[0]?.message?.content || '';
  const out = Array(lines.length).fill('');
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\d+)[.)]\s*(.+)$/);
    if (match && Number(match[1]) >= 1 && Number(match[1]) <= lines.length) out[Number(match[1]) - 1] = match[2].trim();
  }
  if (out.filter(Boolean).length < lines.length * 0.8) throw new Error('DeepSeek returned an incomplete translation');
  return out;
}

async function translate(lines, durations = lines.map(() => 3)) {
  if (!lines.length) return { provider: provider(), lines: [] };
  if (provider() === 'deepseek') {
    try { return { provider: 'deepseek', lines: await deepseek(lines, durations) }; }
    catch (error) { console.error(`[Dịch] DeepSeek lỗi, dùng Microsoft: ${error.message}`); }
  }
  return { provider: 'microsoft', lines: await microsoft(lines) };
}

// Edge TTS speaks Vietnamese at roughly 5 syllables a second; dubbing allows up to ~1.5x.
function syllables(text) {
  return String(text).split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

// A TikTok caption from what the video says: one hook line and hashtags that match the content.
async function writeCaption({ lines, title, topic, topicTags, ai }) {
  const config = settings();
  if (provider() !== 'deepseek') throw new Error('Cần DeepSeek để viết caption');
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      model: config.model, temperature: 0.7,
      messages: [
        { role: 'system', content: 'Bạn viết caption TikTok Việt Nam cho video đã lồng tiếng Việt. Viết 1 câu mở đầu gây tò mò, tự nhiên như người Việt nói, tối đa 90 ký tự, có 1-2 emoji, đúng nội dung video, không nhắc Douyin/Trung Quốc, không chèn link, không hứa hẹn sai sự thật. Sau đó 4-5 hashtag tiếng Việt viết liền không dấu (ví dụ #meovat #giadung), sát nội dung video, có thể dùng lại hashtag chủ đề được gợi ý nếu hợp. Chỉ trả về đúng một dòng: câu mở đầu rồi các hashtag.' },
        { role: 'user', content: `Chủ đề kênh: ${topic}\nHashtag chủ đề gợi ý: ${topicTags || '(không có)'}\nTiêu đề gốc: ${title}\nLời thoại tiếng Việt:\n${lines.slice(0, 25).join('\n')}` }
      ]
    })
  });
  if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  let text = ((await response.json()).choices?.[0]?.message?.content || '').split('\n').map((line) => line.trim()).filter(Boolean).join(' ');
  text = text.replace(/https?:\/\/\S+/g, '').replace(/^["“]|["”]$/g, '').trim();
  if (text.replace(/#\S+/g, '').trim().length < 10 || !/#\S/.test(text)) throw new Error('DeepSeek trả caption không hợp lệ');
  if (ai && !/(^|\s)#ai(?=\s|$)/i.test(text)) text += ' #AI';
  return text.slice(0, 300);
}

// One short, genuine-sounding comment per video, from its caption, the text shown in its frames and
// what viewers already said; the owner reviews each one.
async function writeComments(topic, videos) {
  const config = settings();
  if (provider() !== 'deepseek') throw new Error('Cần DeepSeek để soạn bình luận');
  const clean = (text, max) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const numbered = videos.map((video, i) => [
    `${i + 1}. Mô tả: ${clean(video.caption, 250) || '(trống)'}`,
    video.screen ? `   Chữ trên video (OCR, có thể mất dấu): ${clean(video.screen, 250)}` : '',
    video.comments?.length ? `   Bình luận đang có: ${video.comments.slice(0, 5).map((text) => `"${clean(text, 100)}"`).join(' | ')}` : ''
  ].filter(Boolean).join('\n')).join('\n');
  const descriptions = videos;
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      model: config.model, temperature: 0.9,
      messages: [
        { role: 'system', content: `Bạn là người xem TikTok Việt Nam yêu thích chủ đề "${topic}". Với mỗi video (mô tả, chữ hiện trên video và vài bình luận đang có), viết 1 bình luận ngắn bằng tiếng Việt như người thật: tối đa 80 ký tự, nói đúng nội dung video (khen một chi tiết cụ thể, hỏi một câu, hoặc kể trải nghiệm ngắn), giọng tự nhiên, có thể 0-1 emoji. Không quảng cáo, không xin follow, không nhắc kênh của mình, không chèn link hay hashtag, không lặp lại cùng một mẫu câu, không chép lại bình luận đang có. Ưu tiên chi tiết trong chữ trên video khi mô tả chỉ toàn hashtag. Trả về đúng số dòng, mỗi dòng dạng "số. bình luận".` },
        { role: 'user', content: numbered }
      ]
    })
  });
  if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const text = (await response.json()).choices?.[0]?.message?.content || '';
  const out = Array(descriptions.length).fill('');
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\d+)[.)]\s*(.+)$/);
    if (match && Number(match[1]) >= 1 && Number(match[1]) <= descriptions.length) {
      out[Number(match[1]) - 1] = match[2].replace(/https?:\/\/\S+/g, '').replace(/#\S+/g, '').replace(/^["“]|["”]$/g, '').trim().slice(0, 150);
    }
  }
  return out;
}

module.exports = { provider, translate, syllables, writeCaption, writeComments };
