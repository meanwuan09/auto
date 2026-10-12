// Live progress lines for long-running work, shown in the dashboard's activity bar.
const current = new Map();

function set(key, label, detail = '') {
  const previous = current.get(key);
  current.set(key, { key, label, detail: String(detail).slice(0, 160), since: previous?.since || Date.now() });
}

function clear(key) {
  current.delete(key);
}

function list() {
  return [...current.values()].map((item) => ({ ...item, seconds: Math.round((Date.now() - item.since) / 1000) }));
}

// Keep only the useful part of a script's progress output (e.g. "TTS cue 12/23", "OCR 34.5/66.7s").
function progressLine(text) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] || '';
}

module.exports = { set, clear, list, progressLine };
