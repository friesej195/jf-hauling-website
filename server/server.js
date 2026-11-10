// JF Hauling website + quote assistant API.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const store = require('./store');
const dispatcher = require('./dispatcher');
const mailer = require('./mailer');
const llm = require('./llm');
const { fmtLbs, fmtFt, fmtShedSize, MULE_NOTE, V } = require('./validators');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN' });
  next();
});

const PUB = path.join(__dirname, '..', 'public');
const B = config.business;
const isPlaceholder = (v) => !v || /^\[.*\]$/.test(String(v).trim());
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- HTML templating: {{TOKENS}} + <!--#include name--> ----------
function tokens() {
  const phoneHref = B.phoneHref || (isPlaceholder(B.phone) ? '' : '+1' + B.phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''));
  return {
    NAME: esc(B.name), PHONE: esc(B.phone), PHONE_HREF: esc(phoneHref ? 'tel:' + phoneHref : '#contact'),
    EMAIL: esc(B.email), EMAIL_HREF: esc(isPlaceholder(B.email) ? '#contact' : 'mailto:' + B.email),
    SINCE: B.sinceYear, MAX_FT: config.limits.maxLengthFt, MAX_LBS: config.limits.maxWeightLbs.toLocaleString('en-CA'),
    MAX_M: (config.limits.maxLengthFt / 3.28084).toFixed(1), MAX_KG: Math.round(config.limits.maxWeightLbs / 2.20462).toLocaleString('en-CA'),
    YEAR: new Date().getFullYear(), OG_IMAGE: esc((config.server.siteUrl || '').replace(/\/$/, '') + '/img/brand/og-image.png'), SERVICE_AREA: esc(B.serviceArea),
    ADDRESS_LINE: isPlaceholder(B.addressLine) ? '' : esc(B.addressLine) + '<br>',
    HOURS_BLOCK: isPlaceholder(B.hours) ? '' : `<li><span class="ci-label">Hours</span>${esc(B.hours)}</li>`,
    // "Fully insured" trust claim (config.business.fullyInsured) — each token is empty when the setting is off.
    INSURED_INLINE: B.fullyInsured ? ' · Fully insured' : '',
    INSURED_SENTENCE: B.fullyInsured ? ' Fully insured.' : '',
    WHY_GRID: B.fullyInsured ? 'g2' : 'g3',
    INSURED_WHY: B.fullyInsured ? '<div class="why"><div class="num"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg></div><div><h3>Fully insured</h3><p>Fully insured for your peace of mind, so you can hand over your load with confidence.</p></div></div>' : '',
    INSURED_ABOUT: B.fullyInsured ? '<div class="card"><h3>Fully insured</h3><p>Fully insured for your peace of mind.</p></div>' : '',
  };
}
const cache = new Map();
function render(file) {
  const dev = process.env.NODE_ENV !== 'production';
  if (!dev && cache.has(file)) return cache.get(file);
  let html = fs.readFileSync(file, 'utf8');
  html = html.replace(/<!--#include (\w+)-->/g, (_, n) => fs.readFileSync(path.join(PUB, 'partials', n + '.html'), 'utf8'));
  const t = tokens();
  html = html.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in t ? t[k] : m));
  cache.set(file, html);
  return html;
}
const PAGES = { '/': 'index', '/services': 'services', '/about': 'about', '/service-area': 'service-area', '/contact': 'contact', '/quote': 'quote', '/links': 'links' };
for (const [route, name] of Object.entries(PAGES)) {
  app.get([route, `/${name}.html`], (req, res) => res.type('html').send(render(path.join(PUB, name + '.html'))));
}
app.get('/partials/*', (req, res) => res.status(404).end());
app.use(express.static(PUB, { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0, index: false }));

// ---------- Simple per-IP rate limit ----------
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const k = req.ip + req.path; const now = Date.now();
    const h = hits.get(k) || { n: 0, t: now };
    if (now - h.t > windowMs) { h.n = 0; h.t = now; }
    h.n++; hits.set(k, h);
    if (h.n > max) return res.status(429).json({ error: `Too many requests — please wait a moment or call ${B.phone}.` });
    next();
  };
}
setInterval(() => hits.clear(), 60 * 60 * 1000).unref();

// ---------- Public API ----------
app.get('/api/config', (req, res) => res.json({
  name: B.name, phone: B.phone, email: B.email, limits: config.limits, aiEnabled: llm.enabled(), exampleRates: config.pricing.isExample,
}));

function makeRef() {
  const d = new Date();
  return `Q-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

const dash = (v) => (v === undefined || v === null || v === '' ? '—' : String(v));

function quoteAlert(rec) {
  const c = rec.customer;
  const sh = rec.shipment;
  const lines = [
    `Quote reference: ${rec.id}`,
    `Status: ${rec.status}`,
    `Received: ${rec.createdAt}`,
    `Follow-up: ${rec.intent === 'more-info' ? 'Ask for more info' : 'Request this quote'}`,
    '',
    'Customer',
    `Name: ${dash(c.name)}`,
    `Company: ${dash(c.company)}`,
    `Email: ${dash(c.email)}`,
    `Phone: ${dash(c.phone)}`,
    '',
    'Load',
    `Pickup: ${dash(sh.pickup)}`,
    `Drop-off: ${dash(sh.delivery)}`,
    `Freight: ${dash(sh.freightTypeLabel)}`,
    ...(sh.freightType === 'shed'
      ? [
        `Shed size: ${dash(sh.shedSize || (sh.shedWidthFt && sh.shedLengthFt ? fmtShedSize(sh.shedWidthFt, sh.shedLengthFt) : ''))}`,
        `Shed mule: ${sh.shedMule ? 'Yes' : 'No'}`,
        ...(sh.shedMule ? [sh.muleNote || MULE_NOTE] : []),
      ]
      : [
        `Length: ${sh.lengthFt ? fmtFt(sh.lengthFt) : '—'}`,
        `Weight: ${sh.weightLbs ? fmtLbs(sh.weightLbs) : '—'}`,
      ]),
    `Pickup date: ${dash(sh.pickupDate)}`,
    `Notes: ${dash(sh.notes)}`,
    '',
    'Route and estimate',
    `Distance: ${rec.distance ? `${rec.distance.loadedKm} km (${rec.distance.source})` : 'unknown'}`,
    rec.estimate
      ? `Estimate: $${rec.estimate.low}–$${rec.estimate.high} ${rec.estimate.currency}${rec.estimate.taxNote ? ` (${rec.estimate.taxNote})` : ''}`
      : 'Estimate: none shown (needs dispatcher review)',
  ];
  if (rec.flags && rec.flags.length) {
    lines.push('', 'Flags');
    for (const f of rec.flags) lines.push(`- ${f.message}`);
  }
  return lines.join('\n');
}

async function saveQuote(s) {
  const name = V.name(s.data && s.data.name);
  const phone = V.phone(s.data && s.data.phone);
  const email = V.email(s.data && s.data.email);
  if (!name.ok || !phone.ok || !email.ok) {
    const err = new Error('Name, phone and email are required to submit a quote request.');
    err.status = 400;
    throw err;
  }
  s.data.name = name.value;
  s.data.phone = phone.value;
  s.data.email = email.value;
  const id = makeRef();
  const isShed = s.data.freightType === 'shed';
  const shedSize = isShed ? fmtShedSize(s.data.shedWidthFt, s.data.shedLengthFt) : '';
  const rec = {
    id, createdAt: new Date().toISOString(), status: s.flags.length ? 'needs review' : 'new', mode: s.mode, intent: s.intent === 'more-info' ? 'more-info' : 'request',
    customer: { name: s.data.name, company: s.data.company, email: s.data.email, phone: s.data.phone },
    shipment: {
      pickup: s.data.pickup, delivery: s.data.delivery, freightType: s.data.freightType, freightTypeLabel: dispatcher.FT_LABEL[s.data.freightType],
      freightTypeNote: s.data.freightTypeNote || '',
      lengthFt: isShed ? (s.data.shedLengthFt ?? null) : (s.data.lengthFt ?? null),
      weightLbs: isShed ? null : (s.data.weightLbs ?? null),
      shedWidthFt: isShed ? (s.data.shedWidthFt ?? null) : null,
      shedLengthFt: isShed ? (s.data.shedLengthFt ?? null) : null,
      shedSize,
      shedMule: isShed ? !!s.data.shedMule : null,
      muleNote: isShed && s.data.shedMule ? MULE_NOTE : '',
      pickupDate: s.data.pickupDate, notes: s.data.notes,
    },
    distance: s.distance, estimate: s.estimate, flags: s.flags, transcript: s.transcript,
  };
  store.insert('quotes', rec);
  await mailer.notify(
    `[${B.name}] Quote request ${id}${s.flags.length ? ' — NEEDS REVIEW' : ''}`,
    quoteAlert(rec),
    { replyTo: rec.customer.email, reference: id },
  );
  return id;
}

app.post('/api/chat/start', rateLimit(30, 60 * 1000), async (req, res) => res.json(await dispatcher.start()));
app.post('/api/chat', rateLimit(90, 60 * 1000), async (req, res) => {
  try {
    const { sessionId, text } = req.body || {};
    res.json(await dispatcher.handle(String(sessionId || ''), String(text || ''), saveQuote));
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error('[chat]', e);
    res.status(500).json({ error: `Sorry, something went wrong. Please try again or call ${B.phone}.` });
  }
});

app.post('/api/contact', rateLimit(10, 10 * 60 * 1000), async (req, res) => {
  const { name = '', email = '', phone = '', message = '', website = '' } = req.body || {};
  if (website) return res.json({ ok: true }); // honeypot
  if (String(name).trim().length < 2 || !/^\S+@\S+\.\S+$/.test(String(email).trim()) || String(message).trim().length < 5)
    return res.status(400).json({ error: 'Please include your name, a valid email and a short message.' });
  const rec = { id: 'M-' + crypto.randomBytes(3).toString('hex').toUpperCase(), createdAt: new Date().toISOString(), name: String(name).slice(0, 100), email: String(email).slice(0, 150), phone: String(phone).slice(0, 40), message: String(message).slice(0, 3000), status: 'new' };
  try {
    store.insert('messages', rec);
    const body = [
      `Message reference: ${rec.id}`,
      `Received: ${rec.createdAt}`,
      '',
      `Name: ${rec.name}`,
      `Email: ${rec.email}`,
      `Phone: ${rec.phone || '—'}`,
      '',
      rec.message,
    ].join('\n');
    await mailer.notify(`[${B.name}] Website message ${rec.id}`, body, { replyTo: rec.email, reference: rec.id });
    res.json({ ok: true });
  } catch (e) {
    console.error('[contact]', e && e.message ? e.message : 'save failed');
    res.status(500).json({ error: 'Sorry, something went wrong. Please try again.' });
  }
});

// ---------- Admin (HTTP Basic auth; username can be anything) ----------
function adminAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const [, b64] = h.split(' ');
  const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  const a = Buffer.from(pass), b = Buffer.from(config.server.adminPassword);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Admin", charset="UTF-8"').status(401).send('Authentication required.');
}
app.get('/admin', adminAuth, (req, res) => res.type('html').send(render(path.join(__dirname, 'admin.html'))));
app.get('/admin/api/quotes', adminAuth, (req, res) => res.json({ quotes: store.readAll('quotes').reverse(), messages: store.readAll('messages').reverse(), exampleRates: config.pricing.isExample, emailEnabled: mailer.enabled(), aiEnabled: llm.enabled() }));
app.post('/admin/api/:kind/:id/status', adminAuth, (req, res) => {
  const kind = req.params.kind === 'messages' ? 'messages' : 'quotes';
  const status = String(req.body.status || '').slice(0, 30);
  const r = store.update(kind, req.params.id, { status });
  r ? res.json(r) : res.status(404).json({ error: 'not found' });
});
app.get('/admin/quotes.csv', adminAuth, (req, res) => {
  const cols = ['id', 'createdAt', 'status', 'name', 'company', 'email', 'phone', 'pickup', 'delivery', 'freight', 'lengthFt', 'weightLbs', 'shedWidthFt', 'shedLengthFt', 'shedMule', 'muleNote', 'pickupDate', 'notes', 'km', 'estimateLow', 'estimateHigh', 'flags'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = store.readAll('quotes').map((r) => [r.id, r.createdAt, r.status, r.customer.name, r.customer.company, r.customer.email, r.customer.phone, r.shipment.pickup, r.shipment.delivery, r.shipment.freightTypeLabel, r.shipment.lengthFt, r.shipment.weightLbs, r.shipment.shedWidthFt, r.shipment.shedLengthFt, r.shipment.shedMule === true ? 'Yes' : r.shipment.shedMule === false ? 'No' : '', r.shipment.muleNote, r.shipment.pickupDate, r.shipment.notes, r.distance?.loadedKm, r.estimate?.low, r.estimate?.high, (r.flags || []).map((f) => f.message).join(' ')].map(q).join(','));
  res.type('text/csv').attachment('quote-requests.csv').send([cols.join(','), ...rows].join('\n'));
});

app.use((req, res) => res.status(404).type('html').send(render(path.join(PUB, '404.html'))));

if (config.server.adminPassword === 'change-me') console.warn('⚠  ADMIN_PASSWORD is the default "change-me" — set it before going live.');
if (config.pricing.isExample) console.warn('⚠  Pricing uses EXAMPLE rates — edit config.js before going live.');
console.log(`[mailer] mode=${mailer.mode()}`);
app.listen(config.server.port, () => console.log(`${B.name} site running on http://localhost:${config.server.port} (assistant mode: ${llm.enabled() ? 'AI + guided' : 'guided'})`));
