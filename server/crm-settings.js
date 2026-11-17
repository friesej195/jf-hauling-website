// CRM switches that are not secrets. The global AI auto-reply toggle lives here.
const path = require('path');
const config = require('../config');
const { writeJson, readJson } = require('./secret-file');

function file() { return path.join(config.server.dataDir, 'crm-settings.json'); }

function read() {
  const saved = readJson(file());
  return {
    aiAutoReply: !saved || saved.aiAutoReply !== false,
  };
}

function write(patch) {
  const next = { ...read(), ...patch };
  writeJson(file(), { aiAutoReply: !!next.aiAutoReply }, 0o600);
  return read();
}

module.exports = { read, write };
