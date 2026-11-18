// Leads live in DATA_DIR/leads.json beside quotes.json and messages.json.
// Writes go through the existing atomic JSON store (temp file, then rename).
const crypto = require('crypto');
const store = require('./store');

const SOURCES = ['website', 'email', 'phone', 'sms', 'other'];
const EXTERNAL_MAX = 512;
const STATUSES = ['New', 'Contacted', 'Quoted', 'Booked', 'Lost', 'Closed'];
const CLOSED = new Set(['Booked', 'Lost', 'Closed']);

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
  if (!STATUSES.includes(status)) return { error: 'Status must be New, Contacted, Quoted, Booked, Lost, or Closed.' };
  const followRaw = clip(text(src.followUpDate), 20);
  const followUpDate = normDate(followRaw);
  if (followRaw && followUpDate == null) return { error: 'Follow-up date must be a real calendar date.' };
  const externalId = clip(text(src.externalId), EXTERNAL_MAX + 40);
  if (externalId.length > EXTERNAL_MAX) return { error: 'external_id is too long.' };
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
    timeline: [],
    aiAutoReply: false,
    needsJohan: false,
    openedAt: '',
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

function addTimeline(id, event) {
  const current = all().find((r) => r.id === id);
  if (!current) return { ok: false, status: 404, error: 'That lead was not found.' };
  const externalId = clip(event.externalId, EXTERNAL_MAX);
  const messageId = clip(event.messageId, 240);
  const timeline = Array.isArray(current.timeline) ? current.timeline.slice() : [];
  if (externalId && timeline.some((item) => item.externalId === externalId)) {
    return { ok: true, duplicate: true, lead: current };
  }
  if (messageKey(messageId)) {
    const prior = findByMessageId(messageId);
    if (prior) return { ok: true, duplicate: true, lead: prior };
  }
  const at = event.at || new Date().toISOString();
  const kind = ['email', 'sms', 'note'].includes(event.kind) ? event.kind : 'note';
  const rawBody = clipMulti(event.body, 8000);
  const stripped = event.skipStrip || kind === 'note' ? { clean: rawBody, full: rawBody } : require('./thread').stripQuoted(rawBody);
  const body = clipMulti(stripped.clean, 4000);
  const bodyFull = stripped.full && stripped.full !== stripped.clean ? clipMulti(stripped.full, 8000) : '';
  const item = {
    id: crypto.randomBytes(4).toString('hex'),
    at,
    kind,
    direction: event.direction === 'in' || event.direction === 'out' ? event.direction : '',
    subject: clip(event.subject, 200),
    body,
    bodyFull,
    ai: !!event.ai,
    system: !!event.system,
    externalId,
    messageId,
    attachments: require('./thread').attachmentList(event.attachments),
  };
  if (!item.body && !item.subject && !item.attachments.length) return { ok: false, status: 400, error: 'That message was empty.' };
  timeline.push(item);
  const patch = { timeline: timeline.slice(-300) };
  if (item.direction === 'in' && kind !== 'note' && !event.skipUnread) patch.unread = true;
  if ((kind === 'email' || kind === 'sms') && (item.direction === 'in' || item.direction === 'out')) {
    patch.manualFolder = '';
    if (item.direction === 'out') patch.markedRepliedAt = item.at;
  }
  const saved = store.update('leads', id, patch);
  return saved ? { ok: true, duplicate: false, lead: saved, item } : { ok: false, status: 404, error: 'That lead was not found.' };
}

function touchContact(id, at) {
  const when = at && !Number.isNaN(new Date(at).getTime()) ? new Date(at).toISOString() : new Date().toISOString();
  return store.update('leads', id, { lastContactAt: when });
}

function setFlags(id, patch) {
  const current = all().find((r) => r.id === id);
  if (!current) return null;
  const next = {};
  if (patch.aiAutoReply != null) next.aiAutoReply = !!patch.aiAutoReply;
  if (patch.needsJohan != null) next.needsJohan = !!patch.needsJohan;
  return store.update('leads', id, next);
}

function messageKey(id) {
  return String(id || '').trim().replace(/^<|>$/g, '').toLowerCase();
}

function findByExternalId(externalId) {
  const id = String(externalId || '');
  if (!id) return null;
  return all().find((r) => r.externalId === id || (r.timeline || []).some((item) => item.externalId === id)) || null;
}

function findByMessageId(messageId) {
  const needle = messageKey(messageId);
  if (!needle) return null;
  return all().find((row) => (row.timeline || []).some((item) => messageKey(item.messageId) === needle)) || null;
}

function findLoose(id) {
  const needle = String(id || '').trim().toLowerCase();
  if (!needle) return null;
  return all().find((row) => String(row.id).toLowerCase() === needle) || null;
}

function needsAttention(lead) {
  if (!lead || lead.status === 'Closed' || lead.status === 'Lost') return false;
  if (folderOf(lead) === 'replies') return true;
  if (lead.status === 'Booked') return false;
  if (folderOf(lead) === 'new') return true;
  return !!awaitingReply(lead);
}

function attentionCount() {
  let count = 0;
  for (const lead of all()) if (needsAttention(lead)) count += 1;
  return count;
}

function findByEmail(email) {
  const needle = String(email || '').trim().toLowerCase();
  if (!needle) return null;
  const matches = all().filter((r) => String(r.email || '').toLowerCase() === needle);
  matches.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  return matches[0] || null;
}

function findByPhone(phone) {
  const phoneUtil = require('./phone');
  const matches = all().filter((r) => phoneUtil.phonesMatch(r.phone, phone));
  matches.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  return matches[0] || null;
}

function mostRecent(rows) {
  return rows.slice().sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))[0] || null;
}

function matchLead({ leadId = '', email = '', phone = '' } = {}) {
  if (leadId) {
    const tagged = findLoose(leadId);
    if (tagged) return tagged;
  }
  const emailNeedle = String(email || '').trim().toLowerCase();
  const emailRows = emailNeedle ? all().filter((row) => String(row.email || '').toLowerCase() === emailNeedle) : [];
  const phoneUtil = require('./phone');
  const phoneRows = phone ? all().filter((row) => phoneUtil.phonesMatch(row.phone, phone)) : [];
  const open = (rows) => rows.filter((row) => row.status !== 'Closed' && row.status !== 'Lost');
  if (open(emailRows).length) return mostRecent(open(emailRows));
  if (open(phoneRows).length) return mostRecent(open(phoneRows));
  if (emailRows.length) return mostRecent(emailRows);
  if (phoneRows.length) return mostRecent(phoneRows);
  return null;
}

function ensureThread(id) {
  const lead = all().find((row) => row.id === id);
  if (!lead) return null;
  const origin = `origin:${lead.id}`;
  const hasOrigin = (lead.timeline || []).some((item) => item.externalId === origin);
  if (!hasOrigin && String(lead.message || '').trim()) {
    addTimeline(lead.id, {
      kind: lead.source === 'sms' ? 'sms' : 'email',
      direction: 'in',
      subject: lead.source === 'website' ? 'Quote request' : '',
      body: lead.message,
      at: lead.createdAt || new Date().toISOString(),
      externalId: origin,
      skipUnread: true,
    });
  }
  return find(id);
}

function ensureAllThreads() {
  for (const lead of all()) ensureThread(lead.id);
}

function threadItems(lead) {
  const items = conversation(lead).slice().reverse();
  return items;
}

function lastSnippet(lead) {
  const items = threadItems(lead).filter((item) => item.kind === 'email' || item.kind === 'sms');
  const last = items[items.length - 1];
  if (!last) return '';
  const who = last.direction === 'out' ? 'You: ' : '';
  return `${who}${String(last.body || last.subject || '').replace(/\s+/g, ' ').trim()}`.slice(0, 90);
}

function threadStamp(lead) {
  const items = threadItems(lead);
  const last = items[items.length - 1];
  return `${items.length}:${last ? last.at : ''}`;
}

function conversation(lead) {
  const items = [];
  const seen = new Set();
  for (const item of (lead && lead.timeline) || []) {
    const key = `${item.kind}|${item.at}|${item.direction}|${item.body}`;
    if (item.externalId && seen.has(`id:${item.externalId}`)) continue;
    if (item.externalId) seen.add(`id:${item.externalId}`);
    seen.add(key);
    items.push(item);
  }
  for (const note of (lead && lead.notes) || []) {
    const key = `note|${note.at}||${note.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ at: note.at, kind: 'note', direction: '', subject: '', body: note.text, ai: false });
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return items;
}

function haystack(lead) {
  const notes = (lead.notes || []).map((n) => n.text).join(' ');
  const timeline = (lead.timeline || []).map((n) => `${n.subject || ''} ${n.body || ''}`).join(' ');
  return [
    lead.id, lead.quoteId, lead.externalId, lead.name, lead.phone, lead.email,
    lead.pickup, lead.dropoff, lead.loadType, lead.shedSize, lead.quotedPrice,
    lead.message, lead.status, lead.source, notes, timeline,
  ].join(' ').toLowerCase();
}

function hasOutbound(lead) {
  return (lead.timeline || []).some((item) => (item.kind === 'email' || item.kind === 'sms') && item.direction === 'out');
}

function isOriginalInbound(lead, item) {
  const ext = String((item && item.externalId) || '');
  if (ext.startsWith('origin:')) return true;
  if (lead && lead.externalId && ext === lead.externalId) return true;
  return false;
}

function latestUnansweredReplyAt(lead) {
  if (!lead) return '';
  let latest = '';
  for (const item of lead.timeline || []) {
    if ((item.kind !== 'email' && item.kind !== 'sms') || item.direction !== 'in') continue;
    if (isOriginalInbound(lead, item)) continue;
    if (String(item.at) > latest) latest = String(item.at);
  }
  if (!latest) return '';
  const outbound = latestOutboundAt(lead);
  if (outbound && outbound >= latest) return '';
  if (lead.markedRepliedAt && String(lead.markedRepliedAt) >= latest) return '';
  return latest;
}

function folderOf(lead) {
  if (!lead) return 'new';
  if (lead.status === 'Closed' || lead.status === 'Lost') return 'closed';
  if (lead.manualFolder === 'replies') return 'replies';
  if (lead.manualFolder === 'replied') return 'replied';
  if (latestUnansweredReplyAt(lead)) return 'replies';
  if (lead.status === 'Booked') return 'scheduled';
  if (lead.reopenedAt && !outboundAfter(lead, lead.reopenedAt)) return 'opened';
  if (hasOutbound(lead) || lead.markedRepliedAt) return 'replied';
  if (lead.openedAt) return 'opened';
  return 'new';
}

function setReplyFolder(id, folder) {
  const lead = all().find((row) => row.id === id);
  if (!lead) return null;
  const now = new Date().toISOString();
  if (folder === 'replied') return store.update('leads', id, { manualFolder: 'replied', markedRepliedAt: now });
  if (folder === 'replies') return store.update('leads', id, { manualFolder: 'replies', markedRepliedAt: '' });
  return lead;
}

function scheduleLead(id, jobDateRaw) {
  const lead = all().find((row) => row.id === id);
  if (!lead) return null;
  const raw = String(jobDateRaw || '').trim();
  const jobDate = raw ? normDate(raw) : (lead.jobDate || '');
  if (raw && jobDate == null) return { error: 'Job date must be a real calendar date.' };
  const patch = { status: 'Booked', manualFolder: '', jobDate: jobDate || '' };
  if (lead.status !== 'Booked') patch.statusBeforeSchedule = lead.status || 'Quoted';
  const saved = store.update('leads', id, patch);
  if (saved) {
    addTimeline(id, {
      kind: 'note',
      system: true,
      body: jobDate ? `Scheduled for ${jobDate}` : 'Scheduled',
      externalId: `sys:schedule:${saved.updatedAt}`,
      skipUnread: true,
      skipStrip: true,
    });
  }
  return saved ? find(id) : null;
}

function unscheduleLead(id) {
  const lead = all().find((row) => row.id === id);
  if (!lead) return null;
  const previous = STATUSES.includes(lead.statusBeforeSchedule) && !['Booked', 'Closed', 'Lost'].includes(lead.statusBeforeSchedule)
    ? lead.statusBeforeSchedule
    : (hasOutbound(lead) ? 'Quoted' : 'Contacted');
  const saved = store.update('leads', id, {
    status: previous,
    statusBeforeSchedule: '',
    jobDate: '',
    manualFolder: '',
  });
  if (saved) {
    addTimeline(id, {
      kind: 'note',
      system: true,
      body: 'Moved back from scheduled',
      externalId: `sys:unschedule:${saved.updatedAt}`,
      skipUnread: true,
      skipStrip: true,
    });
  }
  return saved ? find(id) : null;
}

function outboundAfter(lead, at) {
  if (!at) return hasOutbound(lead);
  return (lead.timeline || []).some((item) => (item.kind === 'email' || item.kind === 'sms') && item.direction === 'out' && String(item.at) > String(at));
}

function folderCounts() {
  const counts = { new: 0, opened: 0, replied: 0, replies: 0, scheduled: 0, closed: 0 };
  for (const lead of all()) counts[folderOf(lead)] += 1;
  return counts;
}

function closeLead(id, { reason = '', by = 'owner', blankOk = false } = {}) {
  const lead = all().find((row) => row.id === id);
  if (!lead) return null;
  const cleaned = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const already = lead.status === 'Closed' || lead.status === 'Lost';
  const patch = {
    status: 'Closed',
    closedReason: blankOk ? cleaned : (cleaned || 'Not interested'),
    closedAt: new Date().toISOString(),
    closedBy: by === 'ai' ? 'ai' : 'owner',
    aiAutoReply: false,
  };
  if (!already) {
    patch.statusBeforeClose = lead.status || 'New';
    patch.aiAutoReplyBeforeClose = !!lead.aiAutoReply;
  }
  const saved = store.update('leads', id, patch);
  if (saved) {
    addTimeline(id, {
      kind: 'note',
      system: true,
      body: `Closed${saved.closedReason ? `: ${saved.closedReason}` : ''}`,
      externalId: `sys:close:${saved.closedAt}`,
      skipUnread: true,
      skipStrip: true,
    });
  }
  return find(id);
}

function undoClose(id) {
  const lead = all().find((row) => row.id === id);
  if (!lead) return null;
  if (lead.status !== 'Closed' && lead.status !== 'Lost') return lead;
  const previous = STATUSES.includes(lead.statusBeforeClose) && lead.statusBeforeClose !== 'Closed' && lead.statusBeforeClose !== 'Lost'
    ? lead.statusBeforeClose
    : 'Contacted';
  const saved = store.update('leads', id, {
    status: previous,
    closedReason: '',
    closedAt: '',
    closedBy: '',
    statusBeforeClose: '',
    aiAutoReply: lead.aiAutoReplyBeforeClose === true,
    aiAutoReplyBeforeClose: false,
  });
  if (saved) {
    addTimeline(id, { kind: 'note', system: true, body: 'Reopened', externalId: `sys:undo:${saved.updatedAt}`, skipUnread: true, skipStrip: true });
  }
  return find(id);
}

function reopenLead(id) {
  const lead = all().find((row) => row.id === id);
  if (!lead) return null;
  const now = new Date().toISOString();
  const saved = store.update('leads', id, {
    status: 'Contacted',
    closedReason: '',
    closedAt: '',
    closedBy: '',
    reopenedAt: now,
    openedAt: lead.openedAt || now,
  });
  if (saved) {
    addTimeline(id, { kind: 'note', system: true, body: 'Reopened', externalId: `sys:reopen:${now}`, skipUnread: true, skipStrip: true });
  }
  return find(id);
}

function markOpened(id) {
  const lead = all().find((row) => row.id === id);
  if (!lead) return null;
  const patch = {};
  if (!lead.openedAt) patch.openedAt = new Date().toISOString();
  if (lead.unread) patch.unread = false;
  if (!Object.keys(patch).length) return lead;
  return store.update('leads', id, patch);
}

function replyChannel(lead, requested) {
  const canEmail = !!(lead && String(lead.email || '').trim());
  const canText = !!(lead && String(lead.phone || '').trim());
  let channel = requested === 'sms' || requested === 'text' ? 'sms' : requested === 'email' ? 'email' : '';
  if (!channel) channel = canEmail ? 'email' : 'sms';
  if (channel === 'email' && !canEmail) channel = canText ? 'sms' : '';
  if (channel === 'sms' && !canText) channel = canEmail ? 'email' : '';
  return { channel, canEmail, canText };
}

function customerEvents(lead) {
  const events = [];
  if (lead && lead.createdAt) {
    events.push({
      at: lead.createdAt,
      channel: lead.source === 'website' ? 'quote' : 'lead',
      preview: lead.message || '',
    });
  }
  for (const item of (lead && lead.timeline) || []) {
    if ((item.kind === 'email' || item.kind === 'sms') && item.direction === 'in' && item.at) {
      events.push({ at: item.at, channel: item.kind === 'sms' ? 'sms' : 'email', preview: item.body || item.subject || '' });
    }
  }
  return events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

function latestOutboundAt(lead) {
  let latest = '';
  for (const item of (lead && lead.timeline) || []) {
    if ((item.kind === 'email' || item.kind === 'sms') && item.direction === 'out' && String(item.at) > latest) latest = item.at;
  }
  return latest;
}

function awaitingReply(lead) {
  if (!lead || lead.status === 'Lost' || lead.status === 'Closed') return null;
  if (lead.manualFolder === 'replied') return null;
  if (lead.status === 'Booked' && !latestUnansweredReplyAt(lead)) return null;
  const events = customerEvents(lead);
  if (!events.length) return null;
  const last = events[events.length - 1];
  const outbound = latestOutboundAt(lead);
  const answered = [outbound, lead.markedRepliedAt].filter(Boolean).sort().pop();
  if (answered && answered >= last.at) return null;
  return last;
}

function needsReply({ minutes = 30, since = '', now = new Date() } = {}) {
  const stamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const nowMs = new Date(stamp).getTime();
  const leadsOut = [];
  for (const lead of all()) {
    const waiting = awaitingReply(lead);
    if (!waiting) continue;
    const waitMs = nowMs - new Date(waiting.at).getTime();
    if (!Number.isFinite(waitMs)) continue;
    if (since) {
      if (String(waiting.at) < String(since)) continue;
    } else if (waitMs < minutes * 60 * 1000) continue;
    const base = String(configSite()).replace(/\/$/, '');
    leadsOut.push({
      id: lead.id,
      name: lead.name || '',
      phone: lead.phone || '',
      email: lead.email || '',
      source: lead.source || '',
      folder: folderOf(lead),
      waitingSince: new Date(waiting.at).toISOString(),
      waitingMinutes: Math.floor(waitMs / 60000),
      lastInboundChannel: waiting.channel,
      lastInboundPreview: String(waiting.preview || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      crmUrl: `${base}/crm/lead/${encodeURIComponent(lead.id)}`,
    });
  }
  leadsOut.sort((a, b) => String(a.waitingSince).localeCompare(String(b.waitingSince)));
  return { now: stamp, leads: leadsOut };
}

function configSite() {
  try {
    const config = require('../config');
    return config.server.siteUrl || 'https://jfhauling.ca';
  } catch {
    return 'https://jfhauling.ca';
  }
}

function query({ status = '', source = '', q = '', dueOnly = false, folder = '' } = {}) {
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
  if (folder === 'new' || folder === 'opened' || folder === 'replied' || folder === 'replies' || folder === 'scheduled' || folder === 'closed') rows = rows.filter((r) => folderOf(r) === folder);
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
  addTimeline, setFlags, touchContact, findByExternalId, findByEmail, findByPhone, conversation,
  hasOutbound, folderOf, folderCounts, markOpened, replyChannel, needsReply, awaitingReply, closeLead, reopenLead, undoClose, setReplyFolder, scheduleLead, unscheduleLead, latestUnansweredReplyAt,
  findByMessageId, findLoose, messageKey, needsAttention, attentionCount, matchLead, ensureThread, ensureAllThreads,
  threadItems, lastSnippet, threadStamp,
};
