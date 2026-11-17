// Leads live in DATA_DIR/leads.json beside quotes.json and messages.json.
// Writes go through the existing atomic JSON store (temp file, then rename).
const crypto = require('crypto');
const store = require('./store');

const SOURCES = ['website', 'email', 'phone', 'other'];
const STATUSES = ['New', 'Contacted', 'Quoted', 'Booked', 'Lost'];
const CLOSED = new Set(['Booked', 'Lost']);

function all() {
  const rows = store.readAll('leads');
  return Array.isArray(rows) ? rows : [];
}

function clip(v, n) {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
}
function clipMulti(v, n) {
  return String(v ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().slice(0, n);
}
function asText(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return null;
  return String(v);
}

function normDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return s;
}

function todayToronto(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function isDue(lead, today = todayToronto()) {
  return !!(lead && lead.followUpDate && !CLOSED.has(lead.status) && lead.followUpDate <= today);
}

function makeId(rows) {
  const d = new Date();
  const prefix = `L-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-`;
  let id;
  do { id = prefix + crypto.randomBytes(2).toString('hex').toUpperCase(); }
  while (rows.some((r) => r.id === id));
  return id;
}

function cleanInput(raw, { defaultSource = 'phone' } = {}) {
  const src = raw || {};
  const text = (v) => asText(v);
  const fields = ['source', 'name', 'phone', 'email', 'pickup', 'dropoff', 'loadType', 'shedSize', 'quotedPrice', 'message', 'status', 'followUpDate', 'externalId', 'note'];
  for (const key of fields) {
    if (text(src[key]) === null) return { error: 'Send plain text in each field.' };
  }
  const source = clip(text(src.source), 20) || defaultSource;
  if (!SOURCES.includes(source)) return { error: 'Source must be website, email, phone, or other.' };
  const status = clip(text(src.status), 20) || 'New';
  if (!STATUSES.includes(status)) return { error: 'Status must be New, Contacted, Quoted, Booked, or Lost.' };
  const followRaw = clip(text(src.followUpDate), 20);
  const followUpDate = normDate(followRaw);
  if (followRaw && followUpDate == null) return { error: 'Follow-up date must be a real calendar date.' };
  const externalId = clip(text(src.externalId), 240);
  if (externalId.length > 200) return { error: 'external_id is too long.' };
  const value = {
    source,
    name: clip(text(src.name), 120),
    phone: clip(text(src.phone), 80),
    email: clip(text(src.email), 150).toLowerCase(),
    pickup: clip(text(src.pickup), 200),
    dropoff: clip(text(src.dropoff), 200),
    loadType: clip(text(src.loadType), 80),
    shedSize: clip(text(src.shedSize), 40),
    quotedPrice: clip(text(src.quotedPrice), 80),
    message: clipMulti(text(src.message), 4000),
    status,
    followUpDate: followUpDate || '',
    externalId,
    note: clipMulti(text(src.note), 2000),
  };
  if (![value.name, value.phone, value.email, value.message].some(Boolean)) {
    return { error: 'Add a name, phone, email, or message.' };
  }
  return { value };
}

function create(raw, opts = {}) {
  const cleaned = cleanInput(raw, { defaultSource: opts.defaultSource || 'phone' });
  if (cleaned.error) return { ok: false, status: 400, error: cleaned.error };
  const v = cleaned.value;
  const rows = all();
  if (v.externalId) {
    const existing = rows.find((r) => r.externalId === v.externalId);
    if (existing) return { ok: true, duplicate: true, status: 200, lead: existing };
  }
  const now = new Date().toISOString();
  const lead = {
    id: makeId(rows),
    createdAt: now,
    updatedAt: now,
    source: v.source,
    name: v.name,
    phone: v.phone,
    email: v.email,
    pickup: v.pickup,
    dropoff: v.dropoff,
    loadType: v.loadType,
    shedSize: v.shedSize,
    quotedPrice: v.quotedPrice,
    message: v.message,
    status: v.status,
    notes: v.note ? [{ at: now, text: v.note }] : [],
    followUpDate: v.followUpDate,
    externalId: v.externalId,
    quoteId: opts.quoteId ? clip(opts.quoteId, 40) : '',
  };
  store.insert('leads', lead);
  return { ok: true, duplicate: false, status: 201, lead };
}

function quotePrice(rec) {
  const e = rec && rec.estimate;
  if (!e || e.low == null || e.high == null) return '';
  const money = (n) => Number(n).toLocaleString('en-CA');
  const tax = e.taxNote ? ` (${e.taxNote})` : '';
  return `$${money(e.low)}–$${money(e.high)} ${e.currency || 'CAD'}${tax}`;
}

function quoteMessage(rec) {
  const sh = (rec && rec.shipment) || {};
  const c = (rec && rec.customer) || {};
  const lines = [`Website quote ${rec.id || ''}`.trim()];
  lines.push(rec.intent === 'more-info' ? 'Customer asked for more info.' : 'Customer requested this quote.');
  if (c.company) lines.push(`Company: ${c.company}`);
  if (sh.freightTypeNote) lines.push(`Described the load as: ${sh.freightTypeNote}`);
  if (sh.freightType === 'shed') {
    if (sh.shedMule === true) lines.push(sh.muleNote || 'Shed mule: yes');
    else if (sh.shedMule === false) lines.push('Shed mule: no');
  } else {
    if (sh.lengthFt) lines.push(`Length: ${sh.lengthFt} ft`);
    if (sh.weightLbs) lines.push(`Weight: ${Number(sh.weightLbs).toLocaleString('en-CA')} lbs`);
  }
  if (sh.pickupDate) lines.push(`Pickup date: ${sh.pickupDate}`);
  if (rec.distance && rec.distance.loadedKm != null) lines.push(`Distance: ${rec.distance.loadedKm} km`);
  if (sh.notes) lines.push(`Notes: ${sh.notes}`);
  if (rec.flags && rec.flags.length) {
    lines.push('Needs dispatcher review:');
    for (const f of rec.flags) if (f && f.message) lines.push(`- ${f.message}`);
  }
  if (!rec.estimate) lines.push('No online price was shown.');
  else if (rec.estimate.isExample) lines.push('Online price uses the sample rate table.');
  return lines.filter(Boolean).join('\n');
}

function createFromQuote(rec) {
  const sh = (rec && rec.shipment) || {};
  const c = (rec && rec.customer) || {};
  return create({
    source: 'website',
    name: c.name || '',
    phone: c.phone || '',
    email: c.email || '',
    pickup: sh.pickup || '',
    dropoff: sh.delivery || '',
    loadType: sh.freightTypeLabel || sh.freightType || '',
    shedSize: sh.shedSize || '',
    quotedPrice: quotePrice(rec),
    message: quoteMessage(rec),
    status: 'New',
    externalId: rec && rec.id ? `quote:${rec.id}` : '',
  }, { defaultSource: 'website', quoteId: rec && rec.id ? rec.id : '' });
}

function pushNote(notes, text, at) {
  const next = Array.isArray(notes) ? notes.slice() : [];
  if (text) next.push({ at, text });
  return next.slice(-200);
}

function update(id, raw) {
  const current = all().find((r) => r.id === id);
  if (!current) return { ok: false, status: 404, error: 'That lead was not found.' };
  const cleaned = cleanInput({
    source: raw.source != null && raw.source !== '' ? raw.source : current.source,
    name: raw.name != null ? raw.name : current.name,
    phone: raw.phone != null ? raw.phone : current.phone,
    email: raw.email != null ? raw.email : current.email,
    pickup: raw.pickup != null ? raw.pickup : current.pickup,
    dropoff: raw.dropoff != null ? raw.dropoff : current.dropoff,
    loadType: raw.loadType != null ? raw.loadType : current.loadType,
    shedSize: raw.shedSize != null ? raw.shedSize : current.shedSize,
    quotedPrice: raw.quotedPrice != null ? raw.quotedPrice : current.quotedPrice,
    message: current.message || 'Lead',
    status: raw.status != null && raw.status !== '' ? raw.status : current.status,
    followUpDate: raw.followUpDate != null ? raw.followUpDate : current.followUpDate,
    externalId: current.externalId || '',
    note: raw.note || '',
  }, { defaultSource: current.source || 'phone' });
  if (cleaned.error) return { ok: false, status: 400, error: cleaned.error };
  const v = cleaned.value;
  const at = new Date().toISOString();
  let notes = Array.isArray(current.notes) ? current.notes.slice() : [];
  const add = (text) => { notes = pushNote(notes, text, at); };
  if (v.status !== current.status) add(`Status changed from ${current.status} to ${v.status}`);
  if ((v.followUpDate || '') !== (current.followUpDate || '')) {
    add(v.followUpDate ? `Follow-up set to ${v.followUpDate}` : 'Follow-up date cleared');
  }
  if (v.quotedPrice !== (current.quotedPrice || '')) {
    add(v.quotedPrice ? `Quoted price set to ${v.quotedPrice}` : 'Quoted price cleared');
  }
  const labels = [
    ['name', 'Name'], ['phone', 'Phone'], ['email', 'Email'], ['pickup', 'Pickup'],
    ['dropoff', 'Drop-off'], ['loadType', 'Load'], ['shedSize', 'Shed size'], ['source', 'Source'],
  ];
  for (const [key, label] of labels) {
    if ((v[key] || '') !== (current[key] || '')) add(`${label} updated`);
  }
  if (v.note) add(v.note);
  const saved = store.update('leads', id, {
    source: v.source,
    name: v.name,
    phone: v.phone,
    email: v.email,
    pickup: v.pickup,
    dropoff: v.dropoff,
    loadType: v.loadType,
    shedSize: v.shedSize,
    quotedPrice: v.quotedPrice,
    status: v.status,
    followUpDate: v.followUpDate,
    notes,
  });
  return saved ? { ok: true, lead: saved } : { ok: false, status: 404, error: 'That lead was not found.' };
}

function haystack(lead) {
  const notes = (lead.notes || []).map((n) => n.text).join(' ');
  return [
    lead.id, lead.quoteId, lead.externalId, lead.name, lead.phone, lead.email,
    lead.pickup, lead.dropoff, lead.loadType, lead.shedSize, lead.quotedPrice,
    lead.message, lead.status, lead.source, notes,
  ].join(' ').toLowerCase();
}

function query({ status = '', source = '', q = '', dueOnly = false } = {}) {
  const today = todayToronto();
  let rows = all().slice();
  if (dueOnly) {
    rows = rows.filter((r) => isDue(r, today));
    rows.sort((a, b) => String(a.followUpDate).localeCompare(String(b.followUpDate)) || String(a.createdAt).localeCompare(String(b.createdAt)));
  } else {
    rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  if (status && STATUSES.includes(status)) rows = rows.filter((r) => r.status === status);
  if (source && SOURCES.includes(source)) rows = rows.filter((r) => r.source === source);
  const needle = String(q || '').trim().toLowerCase();
  if (needle) rows = rows.filter((r) => haystack(r).includes(needle));
  return { rows, today };
}

function dueCount() {
  const today = todayToronto();
  return all().filter((r) => isDue(r, today)).length;
}

function find(id) {
  return all().find((r) => r.id === id) || null;
}

function toCsv(rows) {
  const cols = ['id', 'createdAt', 'source', 'status', 'name', 'phone', 'email', 'pickup', 'dropoff', 'loadType', 'shedSize', 'quotedPrice', 'followUpDate', 'message', 'notes', 'externalId', 'quoteId'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map((r) => [
    r.id, r.createdAt, r.source, r.status, r.name, r.phone, r.email, r.pickup, r.dropoff,
    r.loadType, r.shedSize, r.quotedPrice, r.followUpDate, r.message,
    (r.notes || []).map((n) => `${n.at} ${n.text}`).join(' | '),
    r.externalId, r.quoteId,
  ].map(cell).join(','));
  return `\uFEFF${cols.join(',')}\n${lines.join('\n')}${lines.length ? '\n' : ''}`;
}

function telHref(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return `tel:+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `tel:+${digits}`;
  if (digits.length >= 7 && digits.length <= 15) return `tel:+${digits}`;
  return '';
}

function mailHref(email) {
  const s = String(email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return '';
  return `mailto:${encodeURIComponent(s)}`;
}

function publicLead(lead) {
  return {
    id: lead.id,
    created: lead.createdAt,
    source: lead.source,
    name: lead.name || '',
    phone: lead.phone || '',
    email: lead.email || '',
    pickup_location: lead.pickup || '',
    dropoff_location: lead.dropoff || '',
    load_type: lead.loadType || '',
    shed_size: lead.shedSize || '',
    quoted_price: lead.quotedPrice || '',
    original_message: lead.message || '',
    status: lead.status,
    notes: (lead.notes || []).map((n) => ({ at: n.at, text: n.text })),
    follow_up_date: lead.followUpDate || '',
    external_id: lead.externalId || '',
    quote_id: lead.quoteId || '',
  };
}

module.exports = {
  SOURCES, STATUSES, all, create, createFromQuote, update, query, dueCount, find, toCsv,
  telHref, mailHref, publicLead, isDue, todayToronto, quotePrice, quoteMessage,
};
