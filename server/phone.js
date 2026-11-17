// Canadian and US numbers become +1 E.164. Other lengths keep a leading +.
function digits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function toE164(phone) {
  let d = digits(phone);
  if (!d) return '';
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (d.length >= 8 && d.length <= 15) return `+${d}`;
  return '';
}

function last10(phone) {
  const d = digits(phone);
  if (d.length < 10) return '';
  return d.slice(-10);
}

function phonesMatch(a, b) {
  const da = last10(a);
  const db = last10(b);
  return !!(da && db && da === db);
}

module.exports = { digits, toE164, last10, phonesMatch };
