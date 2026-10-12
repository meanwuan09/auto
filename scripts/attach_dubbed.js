const fs = require('fs');
const path = require('path');
const { db } = require('../server/db');

const id = Number(process.argv[2]);
const file = path.resolve(process.argv[3] || '');
if (!Number.isInteger(id) || id < 1 || !fs.existsSync(file) || !fs.existsSync(file.replace(/\.mp4$/i, '.qa.json'))) {
  throw new Error('Usage: node scripts/attach_dubbed.js JOB_ID VERIFIED_MP4');
}
const result = db.prepare("UPDATE reup_jobs SET dubbed_path = ?, status = 'review', approved = 0, error = '' WHERE id = ?").run(file, id);
db.close();
if (!result.changes) throw new Error(`Không có job #${id}`);
console.log(`Job #${id}: ${file}`);
