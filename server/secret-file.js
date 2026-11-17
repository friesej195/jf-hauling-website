// Small JSON files on the persistent disk. Token files are owner-read/write only.
const fs = require('fs');
const path = require('path');

function writeJson(file, obj, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const json = JSON.stringify(obj);
  fs.writeFileSync(tmp, json, { mode: mode || 0o600 });
  fs.renameSync(tmp, file);
  if (mode) {
    try { fs.chmodSync(file, mode); } catch { /* ignore */ }
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

module.exports = { writeJson, readJson };
