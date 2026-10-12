const fs = require('fs');
const path = require('path');
const { db } = require('../server/db');

const id = Number(process.argv[2]);
const file = path.resolve(process.argv[3] || '');
if (!Number.isInteger(id) || id < 1 || !fs.existsSync(file)) {
  throw new Error('Usage: node scripts/attach_source.js JOB_ID VIDEO_FILE');
}
const result = db.prepare("UPDATE reup_jobs SET source_path = ?, status = 'source_ready', error = '' WHERE id = ?").run(file, id);
db.close();
if (!result.changes) throw new Error(`Không có job #${id}`);
console.log(`Job #${id}: ${file}`);
