// The signature added to CRM email and texts. Defaults match the owner's Outlook signature.
const settings = require('./crm-settings');

const DEFAULT_EMAIL_HTML = `<table cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;color:#2A2D32;font-size:14px;">
<tr>
<td style="padding-right:14px;vertical-align:middle;"><img src="https://jfhauling.ca/img/brand/logo-160.png" width="80" height="81" alt="JF Hauling" style="display:block;"></td>
<td style="border-left:3px solid #F6B913;padding-left:14px;vertical-align:middle;line-height:1.5;">
<strong style="font-size:16px;">John Friesen</strong><br>
JF Hauling &middot; Pickup &amp; Gooseneck Flat Deck Hauling<br>
<a href="tel:+12265451745" style="color:#2A2D32;text-decoration:none;">226-545-1745</a> &middot; <a href="mailto:jfhauling@outlook.com" style="color:#2A2D32;">jfhauling@outlook.com</a><br>
<a href="https://jfhauling.ca" style="color:#2A2D32;font-weight:bold;">jfhauling.ca</a> &middot; Serving all of Ontario since 2018
</td></tr></table>`;

const DEFAULT_EMAIL_TEXT = 'John Friesen\nJF Hauling · Pickup & Gooseneck Flat Deck Hauling\n226-545-1745 · jfhauling@outlook.com\njfhauling.ca';

const DEFAULT_SMS = '\n- John, JF Hauling 226-545-1745 jfhauling.ca';

const SIGN_OFF = /^(?:jf hauling\.?|best(?:\s+regards)?,?(?:\s+joh(?:a)?n)?\.?|thanks,?(?:\s+joh(?:a)?n)?\.?|thank you,?(?:\s+joh(?:a)?n)?\.?|cheers,?(?:\s+joh(?:a)?n)?\.?|regards,?(?:\s+joh(?:a)?n)?\.?|-\s*joh(?:a)?n\b.*|joh(?:a)?n friesen)$/i;

function applyNameChange(value) {
  return String(value || '')
    .replace(/Johan Friesen/g, 'John Friesen')
    .replace(/- Johan, JF Hauling/g, '- John, JF Hauling')
    .replace(/ &middot; Listowel, ON &middot; /g, ' &middot; ')
    .replace(/ · Listowel, ON · /g, ' · ')
    .replace(/ · Listowel, ON/g, '')
    .replace(/ &middot; Listowel, ON/g, '');
}

function current() {
  const saved = settings.read();
  return {
    emailHtml: saved.emailHtml || DEFAULT_EMAIL_HTML,
    emailText: saved.emailText || DEFAULT_EMAIL_TEXT,
    sms: saved.sms || DEFAULT_SMS,
  };
}

function cleanSignatureHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '');
}

function stripSignOff(body) {
  const lines = String(body || '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').split('\n');
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    if (!last) { lines.pop(); continue; }
    if (SIGN_OFF.test(last)) { lines.pop(); continue; }
    break;
  }
  return lines.join('\n').trim();
}

function stripTrailingBlock(text, block) {
  const body = String(text || '').replace(/\s+$/, '');
  const sig = String(block || '').trim();
  if (!sig || !body.endsWith(sig)) return body;
  return body.slice(0, body.length - sig.length).trim();
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

function messageToHtml(text) {
  const inner = escapeHtml(text).replace(/\n/g, '<br>');
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#2A2D32;font-size:15px;line-height:1.5;">${inner}</div>`;
}

function composeEmail(raw) {
  const sig = current();
  let message = stripSignOff(raw);
  message = stripTrailingBlock(message, sig.emailText);
  message = stripTrailingBlock(message, sig.sms);
  const text = message ? `${message}\n\n${sig.emailText.trim()}` : sig.emailText.trim();
  const html = `${messageToHtml(message)}<br>${cleanSignatureHtml(sig.emailHtml)}`;
  return { text, html };
}

function composeSms(raw) {
  const sig = String(current().sms || '');
  let message = stripSignOff(raw);
  message = stripTrailingBlock(message, sig);
  const line = sig.trim();
  if (!line) return message.slice(0, 1000);
  if (message.endsWith(line)) return message.slice(0, 1000);
  const addition = sig.startsWith('\n') ? sig : `\n${line}`;
  const room = 1000 - addition.length;
  if (room < 1) return addition.slice(0, 1000);
  return `${message.slice(0, room).trimEnd()}${addition}`;
}

module.exports = {
  DEFAULT_EMAIL_HTML,
  DEFAULT_EMAIL_TEXT,
  DEFAULT_SMS,
  applyNameChange,
  current,
  cleanSignatureHtml,
  stripSignOff,
  composeEmail,
  composeSms,
};
