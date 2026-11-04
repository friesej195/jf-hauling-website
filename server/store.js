// Tiny JSON-file store (no database server needed). Writes are atomic.
const fs = require('fs');
const path = require('path');
const config = require('../config');

const dir = config.server.dataDir;
fs.mkdirSync(dir, { recursive: true });

function file(name) { return path.join(dir, `${name}.json`); }

function readAll(name) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return []; }
}
function writeAll(name, rows) {
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, file(name));
}
function insert(name, row) {
  const rows = readAll(name);
  rows.push(row);
  writeAll(name, rows);
  return row;
}
function update(name, id, patch) {
  const rows = readAll(name);
  const r = rows.find((x) => x.id === id);
  if (!r) return null;
  Object.assign(r, patch, { updatedAt: new Date().toISOString() });
  writeAll(name, rows);
  return r;
}
module.exports = { readAll, insert, update };
