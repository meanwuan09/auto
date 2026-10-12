const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { db } = require('../db');
const activity = require('./activity');

const ROOT = path.join(__dirname, '..', '..');
const MEDIA = process.env.REUP_MEDIA_DIR || path.join(ROOT, 'media', 'reup');
const PYTHON = process.env.DUB_PYTHON || path.join(ROOT, 'data', 'dub-venv', 'Scripts', 'python.exe');
const VOICES = { female: 'vi-VN-HoaiMyNeural', male: 'vi-VN-NamMinhNeural' };
let running = null;
const waiting = [];

const files = (id) => ({
  ocr: path.join(MEDIA, `${id}-ocr.json`),
  speech: path.join(MEDIA, `${id}-transcript.json`),
  draft: path.join(MEDIA, `${id}-reviewed-vi.draft.json`),
  reviewed: path.join(MEDIA, `${id}-reviewed-vi.json`)
});

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function state(id) {
  const f = files(id);
  return { transcribing: running === Number(id) || waiting.includes(Number(id)), hasDraft: fs.existsSync(f.draft), hasReviewed: fs.existsSync(f.reviewed) };
}

function python(args, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ['-X', 'utf8', ...args], { cwd: ROOT, windowsHide: true });
    let detail = '';
    const timer = setTimeout(() => child.kill(), 30 * 60 * 1000);
    child.stdout.on('data', (chunk) => {
      console.log(`[Lời thoại] ${chunk.toString().trim()}`);
      onProgress(activity.progressLine(chunk));
    });
    child.stderr.on('data', (chunk) => { detail = (detail + chunk.toString()).slice(-1500); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(detail || `exit ${code}`)); });
  });
}

// Burned-in Chinese subtitles (OCR) are the most reliable source on Douyin; videos without them
// fall back to Whisper speech recognition so the cue list is never silently empty.
async function extract(id) {
  const job = db.prepare('SELECT id, source_path FROM reup_jobs WHERE id = ?').get(id);
  if (!job?.source_path || !fs.existsSync(job.source_path)) throw new Error('Chưa có video nguồn');
  if (running) throw new Error(`Đang lấy lời thoại cho video #${running}`);
  const f = files(id);
  running = Number(id);
  try {
    fs.rmSync(f.draft, { force: true });
    const progress = (line) => activity.set(`extract-${id}`, `Lấy lời thoại video #${id}`, line);
    progress('Đọc chữ trên video (OCR)…');
    await python([path.join(ROOT, 'scripts', 'ocr_subtitles.py'), job.source_path, f.ocr, '--draft', f.draft], progress);
    const draft = readJson(f.draft) || { source_language: 'zh', target_language: 'vi', voice: VOICES.female, segments: [] };
    if (!draft.segments.some((segment) => segment.voiced !== false)) {
      progress('Không có phụ đề — nghe lời nói bằng Whisper…');
      await python([path.join(ROOT, 'scripts', 'transcribe_video.py'), job.source_path, f.speech, '--language', 'zh'], progress);
      const speech = readJson(f.speech)?.segments || [];
      draft.segments.push(...speech.filter((segment) => segment.text && segment.end > segment.start)
        .map((segment) => ({ start: segment.start, end: segment.end, source: segment.text, text: '' })));
      draft.segments.sort((a, b) => a.start - b.start);
      draft.review_method = 'Whisper speech recognition; no burned-in subtitles found';
    }
    fs.writeFileSync(f.draft, JSON.stringify(draft, null, 1), 'utf8');
    db.prepare("UPDATE reup_jobs SET error = '', status = CASE WHEN status = 'failed' AND dubbed_path = '' THEN 'source_ready' ELSE status END WHERE id = ?").run(id);
    return { cues: draft.segments.length };
  } finally {
    running = null;
    activity.clear(`extract-${id}`);
  }
}

function load(id) {
  const f = files(id);
  const document = readJson(f.reviewed) || readJson(f.draft);
  if (!document) throw new Error('Chưa có lời thoại. Bấm "Lấy lời thoại" trước.');
  return { ...state(id), voice: document.voice, segments: document.segments };
}

// The editor sends one entry per cue: Vietnamese text, whether to speak it, or removal.
// Saving writes the draft; when every remaining cue has text it also writes the reviewed
// file that dub_reviewed.py renders from, which makes "Lồng tiếng" use it.
function save(id, edits, voice) {
  const f = files(id);
  const document = readJson(f.reviewed) || readJson(f.draft);
  if (!document) throw new Error('Chưa có lời thoại để lưu');
  if (!Array.isArray(edits) || edits.length !== document.segments.length) throw new Error('Danh sách câu không khớp; tải lại cửa sổ');
  if (voice && !Object.values(VOICES).includes(voice)) throw new Error('Giọng đọc không hợp lệ');
  if (voice) { document.voice = voice; delete document.voices; for (const segment of document.segments) delete segment.speaker; }
  document.segments = document.segments.map((segment, index) => ({
    ...segment, text: String(edits[index]?.text || '').trim().slice(0, 500), voiced: edits[index]?.voiced !== false, remove: edits[index]?.remove === true
  })).filter((segment) => !segment.remove).map(({ remove, ...segment }) => segment);
  if (!document.segments.length) throw new Error('Cần giữ lại ít nhất một câu');
  fs.writeFileSync(f.draft, JSON.stringify(document, null, 1), 'utf8');
  // An earlier "no reviewed translation" dub failure no longer applies once the user is translating.
  db.prepare("UPDATE reup_jobs SET error = '', status = CASE WHEN status = 'failed' AND source_path != '' AND dubbed_path = '' THEN 'source_ready' ELSE status END WHERE id = ?").run(id);
  const missing = document.segments.filter((segment) => !segment.text).length;
  if (missing) {
    fs.rmSync(f.reviewed, { force: true });
    return { ...state(id), missing };
  }
  document.review_method = document.review_method || 'Translated by the user in the dashboard';
  fs.writeFileSync(f.reviewed, JSON.stringify(document, null, 1), 'utf8');
  db.prepare('UPDATE reup_jobs SET approved = 0 WHERE id = ?').run(id);
  return { ...state(id), missing: 0 };
}

// Unattended translation for "Chạy trọn gói". Without a reviewer the OCR draft is cleaned by rule:
// flicker reads and text repeated many times (product packaging) are dropped, overlapping or
// too-long lines become subtitle-only so the dub never has to rush or overlap.
const MAX_SYLLABLES_PER_SECOND = 7.5;
async function autoTranslate(id) {
  const machine = require('./machine-translate');
  const f = files(id);
  const document = readJson(f.draft);
  if (!document?.segments?.length) throw new Error('Chưa có lời thoại để dịch');
  const key = (text) => String(text || '').replace(/\s+/g, '').slice(0, 4);
  const repeats = new Map();
  for (const segment of document.segments) repeats.set(key(segment.source), (repeats.get(key(segment.source)) || 0) + 1);
  let segments = document.segments
    .filter((segment) => segment.end - segment.start >= 0.5 && /[㐀-鿿]/.test(segment.source || ''))
    .filter((segment) => repeats.get(key(segment.source)) < 3)
    .sort((a, b) => a.start - b.start)
    // OCR often reads one subtitle twice with slightly different characters; keep the longer read.
    .reduce((kept, segment) => {
      const previous = kept[kept.length - 1];
      const chars = (text) => new Set(String(text || '').replace(/\s+/g, '').slice(0, 10));
      const shared = (a, b) => [...chars(a)].filter((c) => chars(b).has(c)).length / Math.max(1, Math.min(chars(a).size, chars(b).size));
      const same = previous && segment.start < previous.end && shared(previous.source, segment.source) >= 0.6;
      if (!same) kept.push(segment);
      else if (segment.end - segment.start > previous.end - previous.start) kept[kept.length - 1] = segment;
      return kept;
    }, []);
  if (!segments.length) throw new Error('Lời thoại chỉ có chữ rác/bao bì; cần dịch tay');
  const { provider, lines } = await machine.translate(segments.map((segment) => segment.source), segments.map((segment) => segment.end - segment.start));
  let spokenEnd = 0;
  segments = segments.map((segment, index) => {
    const text = lines[index] || '';
    const tooFast = machine.syllables(text) / (segment.end - segment.start) > MAX_SYLLABLES_PER_SECOND;
    const voiced = segment.voiced !== false && segment.start >= spokenEnd - 0.05 && !tooFast;
    if (voiced) spokenEnd = segment.end;
    const { speaker, ...rest } = segment;
    return { ...rest, text, voiced };
  }).filter((segment) => segment.text);
  if (!segments.some((segment) => segment.voiced)) throw new Error('Không còn câu nào đọc được sau khi dịch máy; cần dịch tay');
  delete document.voices;
  document.voice = document.voice || VOICES.female;
  document.max_speed = 1.5;
  document.too_fast = 'subtitle'; // dub_reviewed.py measures real speech length and demotes lines it cannot fit
  document.segments = segments;
  document.review_method = `Machine translation (${provider}), cleaned automatically; not reviewed by a person`;
  fs.writeFileSync(f.draft, JSON.stringify(document, null, 1), 'utf8');
  fs.writeFileSync(f.reviewed, JSON.stringify(document, null, 1), 'utf8');
  db.prepare("UPDATE reup_jobs SET error = '' WHERE id = ?").run(id);
  return { provider, cues: segments.length, voiced: segments.filter((segment) => segment.voiced).length };
}

// Quick-button jobs queue here; OCR and Whisper are heavy, so they run one video at a time.
let draining = false;
function enqueueExtract(id) {
  if (!waiting.includes(Number(id))) waiting.push(Number(id));
  drainExtracts();
}

async function drainExtracts() {
  if (draining) return;
  draining = true;
  try {
    while (waiting.length) {
      if (running) { await new Promise((resolve) => setTimeout(resolve, 5000)); continue; }
      const id = waiting.shift();
      try {
        const { cues } = await extract(id);
        console.log(`[Lời thoại #${id}] ${cues} câu — mở Dịch để soát`);
      } catch (error) {
        db.prepare('UPDATE reup_jobs SET error = ? WHERE id = ?').run(`Lấy lời thoại: ${error.message.slice(-400)}`, id);
      }
    }
  } finally { draining = false; }
}

module.exports = { VOICES, state, extract, load, save, autoTranslate, enqueueExtract, queued: () => [...waiting], transcribing: () => running };
