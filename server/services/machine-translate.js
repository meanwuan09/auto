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

module.exports = { provider, translate, syllables };
