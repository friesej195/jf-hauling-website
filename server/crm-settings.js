// CRM switches that are not secrets. The global AI auto-reply toggle lives here.
const path = require('path');
const config = require('../config');
const { writeJson, readJson } = require('./secret-file');

function file() { return path.join(config.server.dataDir, 'crm-settings.json'); }

function migrateSaved() {
  const saved = readJson(file());
  if (!saved || typeof saved !== 'object') return false;
  const signature = require('./signature');
  const next = { ...saved };
  let changed = false;
  for (const key of ['emailHtml', 'emailText', 'sms']) {
    if (typeof next[key] !== 'string') continue;
    const updated = signature.applyNameChange(next[key]);
    if (updated !== next[key]) {
      next[key] = updated;
      changed = true;
    }
  }
  if (changed) writeJson(file(), next, 0o600);
  return changed;
}

function read() {
  migrateSaved();
  const saved = readJson(file()) || {};
  const signature = require('./signature');
  return {
    aiAutoReply: saved.aiAutoReply !== false,
    emailHtml: typeof saved.emailHtml === 'string' && saved.emailHtml.trim() ? saved.emailHtml : signature.DEFAULT_EMAIL_HTML,
    emailText: typeof saved.emailText === 'string' && saved.emailText.trim() ? saved.emailText : signature.DEFAULT_EMAIL_TEXT,
    sms: typeof saved.sms === 'string' && saved.sms.trim() ? saved.sms : signature.DEFAULT_SMS,
  };
}

function write(patch) {
  const next = { ...read(), ...patch };
  writeJson(file(), {
    aiAutoReply: !!next.aiAutoReply,
    emailHtml: String(next.emailHtml || ''),
    emailText: String(next.emailText || ''),
    sms: String(next.sms || ''),
  }, 0o600);
  return read();
}

module.exports = { read, write, migrateSaved, file };
