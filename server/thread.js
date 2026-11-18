// Turns a raw customer email into the new text, and keeps the original for "show full".
function savedSignature() {
  try {
    const current = require('./signature').current();
    return {
      emailText: String(current.emailText || '').trim(),
      sms: String(current.sms || '').trim(),
    };
  } catch {
    return { emailText: '', sms: '' };
  }
}

function stripQuoted(raw) {
  const full = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!full) return { clean: '', full: '' };
  const markers = [
    /\nOn [^\n]{0,300} wrote:\s*\n/i,
    /\n-{3,}\s*Original Message\s*-{3,}/i,
    /\n_{5,}\n/,
    /\nFrom:\s[^\n]+\nSent:\s/i,
    /\nJohan Friesen\nJF Hauling/i,
    /\n- Johan, JF Hauling\b/,
  ];
  let cut = full.length;
  for (const re of markers) {
    const match = full.match(re);
    if (match && match.index < cut) cut = match.index;
  }
  const saved = savedSignature();
  for (const block of [saved.emailText, saved.sms]) {
    if (block.length < 8) continue;
    const at = full.indexOf(block);
    if (at > 0 && at < cut) cut = at;
  }
  let head = full.slice(0, cut);
  const lines = head.split('\n');
  while (lines.length && /^>/.test(lines[lines.length - 1].trim())) lines.pop();
  const clean = lines.join('\n').trim();
  return { clean: clean || full, full };
}

function attachmentList(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 8).map((row) => ({
    filename: String((row && (row.filename || row.name)) || 'Attachment').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Attachment',
    contentType: String((row && (row.contentType || row.content_type)) || '').slice(0, 80),
  })).filter((row) => row.filename);
}

module.exports = { stripQuoted, attachmentList };
