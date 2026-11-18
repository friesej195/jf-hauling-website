// Customer-facing mail must not show a grokbot or friesenj195 address.
// The bad address is not in this repo. It can only arrive from an env var.
const BLOCKED = /grokbot|friesenj195/i;
const SAFE_FROM = 'JF Hauling <quotes@jfhauling.ca>';
const SAFE_REPLY = 'jfhauling@outlook.com';

function blocked(value) {
  return BLOCKED.test(String(value || ''));
}

function addressOnly(from) {
  const raw = String(from || '').trim();
  const wrapped = raw.match(/<([^>]+)>/);
  return (wrapped ? wrapped[1] : raw).trim();
}

function note(variable) {
  if (variable) console.warn(`[mailer] refused customer-visible address var=${variable}`);
}

function customerFrom(configured, variable) {
  const addr = addressOnly(configured);
  if (!addr || blocked(configured) || addr.toLowerCase() !== 'quotes@jfhauling.ca') {
    if (blocked(configured)) note(variable || 'MAIL_FROM');
    return SAFE_FROM;
  }
  return SAFE_FROM;
}

function customerReplyTo(configured, variable) {
  const addr = addressOnly(configured);
  if (!addr || blocked(configured) || addr.toLowerCase() !== SAFE_REPLY) {
    if (blocked(configured)) note(variable || 'EMAIL');
    return SAFE_REPLY;
  }
  return SAFE_REPLY;
}

function customerBcc(configured, variable) {
  const addr = addressOnly(configured);
  if (!addr || addr === '-' || addr === 'off') return '';
  if (blocked(configured)) {
    note(variable || 'CRM_EMAIL_BCC');
    return SAFE_REPLY;
  }
  return addr;
}

function dispatchFrom(configured, variable) {
  if (!blocked(configured)) return configured;
  note(variable || 'MAIL_FROM');
  return 'JF Hauling Website <quotes@jfhauling.ca>';
}

function dispatchTo(configured, variable) {
  if (!blocked(configured)) return configured;
  note(variable || 'NOTIFY_TO');
  return SAFE_REPLY;
}

function stripBlocked(text) {
  return String(text || '')
    .replace(/[^\s<>]*friesenj195[^\s<>]*/gi, '')
    .replace(/[^\s<>]*grokbot\.com[^\s<>]*/gi, '')
    .replace(/\bgrokbot\b/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function cleanHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (blocked(value)) {
      note(key);
      continue;
    }
    out[key] = value;
  }
  return out;
}

module.exports = {
  blocked, stripBlocked, customerFrom, customerReplyTo, customerBcc,
  dispatchFrom, dispatchTo, cleanHeaders, SAFE_FROM, SAFE_REPLY,
};
