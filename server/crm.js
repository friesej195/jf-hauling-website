// Private leads CRM. Password and API token come from the environment only.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const leads = require('./leads');
const outlook = require('./outlook');
const mailer = require('./mailer');
const crmMail = require('./crm-mail');
const inboundEmail = require('./inbound-email');
const push = require('./push');
const twilio = require('./twilio');
const ai = require('./ai-reply');
const crmSettings = require('./crm-settings');

const COOKIE = 'jf_crm';
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
const B = config.business;

function password() { return String(config.server.crmPassword || ''); }
function apiToken() { return String(config.server.crmApiToken || ''); }
function configured() { return password().length > 0; }

function shaEqual(given, expected) {
  const a = crypto.createHash('sha256').update(String(given ?? ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(expected ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', password()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function readSession(req) {
  if (!configured()) return null;
  const token = readCookie(req, COOKIE);
  if (!token || !token.includes('.')) return null;
  const i = token.lastIndexOf('.');
  const body = token.slice(0, i);
  const mac = token.slice(i + 1);
  const expected = crypto.createHmac('sha256', password()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  if (typeof payload.csrf !== 'string' || payload.csrf.length < 16) return null;
  return payload;
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function cookieBase(req) {
  return { httpOnly: true, secure: !!req.secure, sameSite: 'lax', path: '/crm' };
}

function setSession(req, res) {
  const payload = { exp: Date.now() + TTL_MS, csrf: crypto.randomBytes(24).toString('base64url') };
  res.cookie(COOKIE, sign(payload), { ...cookieBase(req), maxAge: TTL_MS });
  return payload;
}

function clearSession(req, res) {
  res.clearCookie(COOKIE, cookieBase(req));
}

function safeNext(v) {
  let s = String(v || '');
  if (s.length > 200) return '/crm/';
  try { s = decodeURIComponent(s); } catch { return '/crm/'; }
  if (s.includes('\\') || s.includes('//') || s.includes('..') || /[\u0000-\u001f]/.test(s)) return '/crm/';
  if (/^\/crm\/(?:login|logout)(?:\?|$)/.test(s)) return '/crm/';
  if (!/^\/crm(?:\/[\w./~-]*(?:\?[^#]*)?)?$/.test(s)) return '/crm/';
  return s === '/crm' ? '/crm/' : s;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(d);
}
function fmtDay(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = String(isoDate).split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

const SOURCE_LABEL = { website: 'Website', email: 'Email', phone: 'Phone', sms: 'Text', other: 'Other' };

function privateHeaders(res) {
  res.set({
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'",
  });
}

const CSS = `
:root{color-scheme:only light;--ink:#2A2D32;--muted:#5d6168;--line:#e4e5e7;--bg:#f3f3f2;--card:#fff;--yellow:#F6B913;--yellow-d:#e0a500;--green:#146c3a;--warn:#8a4b08}
*{box-sizing:border-box}
html{background:#f3f3f2}
body{margin:0;font-family:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;color:var(--ink);background:var(--bg);line-height:1.4;font-size:16px}
a{color:inherit}
button,input,select,textarea{font:inherit;color:inherit}
.appbar{position:sticky;top:0;z-index:5;background:#2A2D32;color:#fff;padding:calc(8px + env(safe-area-inset-top)) 12px 10px;display:flex;align-items:center;gap:8px}
.appbar .title{min-width:0;flex:1}
.appbar h1{font-size:1.15rem;line-height:1.1;margin:0;font-weight:800;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.appbar .sub{display:block;color:#F6B913;font-size:.72rem;font-weight:700;letter-spacing:.8px;text-transform:uppercase}
.appbar .spacer{flex:1}
.iconbtn, .textbtn{background:transparent;border:0;color:#fff;padding:8px;min-width:44px;min-height:44px;border-radius:10px;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}
.textbtn{font-weight:700;font-size:.82rem;min-width:0;min-height:32px;padding:2px 4px}
.appbar .tools{display:flex;flex-direction:column;align-items:flex-end;flex:0 0 auto}
main{padding:14px 14px calc(92px + env(safe-area-inset-bottom));max-width:720px;margin:0 auto}
.dock{position:fixed;left:0;right:0;bottom:0;z-index:6;display:grid;grid-template-columns:repeat(4,1fr);background:#fff;border-top:1px solid var(--line);padding:6px 6px calc(6px + env(safe-area-inset-bottom))}
.dock a{text-decoration:none;text-align:center;font-size:.92rem;font-weight:800;color:var(--muted);padding:8px 4px;border-radius:12px;min-height:48px;display:flex;align-items:center;justify-content:center;gap:6px}
.dock a.on{color:#2A2D32;background:#fff6dc}
.badge{display:inline-block;background:#F6B913;color:#2A2D32;border-radius:999px;min-width:1.2rem;padding:0 5px;font-size:.72rem}
.card{display:flex;gap:8px;background:#fff;border-radius:14px;box-shadow:0 1px 2px rgba(42,45,50,.06);margin:0 0 10px;overflow:hidden;border:1px solid #ececea}
.card-main{flex:1;text-decoration:none;padding:12px 12px 12px 14px;min-width:0}
.card-top{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
.card-top strong{font-size:1.05rem}
.route{margin-top:4px;font-weight:700;overflow-wrap:anywhere}
h1{font-size:1.55rem;line-height:1.15;margin:8px 0}
h2{font-size:1rem;margin:0 0 8px}
.meta,.msg{overflow-wrap:anywhere}
.savebar{position:sticky;bottom:calc(70px + env(safe-area-inset-bottom));padding:8px 0 4px;background:linear-gradient(transparent,#f3f3f2 28%)}
.meta{color:var(--muted);font-size:.86rem;margin-top:3px}
.call{align-self:stretch;display:flex;align-items:center;justify-content:center;background:#F6B913;color:#2A2D32;text-decoration:none;font-weight:800;padding:0 14px;min-width:72px}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.75rem;font-weight:800;white-space:nowrap}
.pill.New{background:#F6B913;color:#2A2D32}
.pill.Contacted{background:#e7eef8;color:#1e3a5f}
.pill.Quoted{background:#fff4d6;color:#6a4b00}
.pill.Booked{background:#e5f6ec;color:#146c3a}
.pill.Lost{background:#ececee;color:#5d6168}
.dueflag{color:#8a4b08;font-weight:800;font-size:.86rem}
.overdue{color:#9b2c2c}
.filters{display:grid;gap:8px;margin-bottom:12px}
.searchrow{display:flex;gap:8px;align-items:stretch}
form.filters .searchrow input{flex:1 1 auto;width:auto;min-width:0}
form.filters .searchrow .btn{flex:0 0 auto;width:auto;padding:0 16px}
.filters input,.filters select,label input,label select,label textarea{width:100%;padding:12px;border:1.5px solid #d5d6d8;border-radius:12px;background:#fff;font-size:16px}
label{display:grid;gap:4px;font-size:.82rem;font-weight:700;color:var(--muted)}
label textarea{min-height:88px;resize:vertical}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.btn{display:inline-flex;align-items:center;justify-content:center;width:100%;min-height:48px;border-radius:12px;border:0;font-weight:800;text-decoration:none;padding:12px 14px;cursor:pointer}
.btn-yellow{background:#F6B913;color:#2A2D32}
.btn-dark{background:#2A2D32;color:#fff}
.btn-line{background:#fff;color:#2A2D32;border:1.5px solid #2A2D32}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0}
.actions:has(> :only-child){grid-template-columns:1fr}
.panel{background:#fff;border:1px solid #ececea;border-radius:14px;padding:12px;margin:0 0 12px}
.panel h2{margin:0 0 8px;font-size:.95rem}
.kv{display:grid;grid-template-columns:92px 1fr;gap:6px 8px;font-size:.95rem}
.kv b{color:var(--muted);font-weight:700}
.note{border-top:1px solid var(--line);padding:8px 0}
.note:first-of-type{border-top:0}
.note time{display:block;color:var(--muted);font-size:.78rem}
.msg{white-space:pre-wrap;margin:0}
.banner{background:#e5f6ec;color:#146c3a;border-radius:12px;padding:10px 12px;margin:0 0 12px;font-weight:700}
.banner.bad{background:#fdecec;color:#9b2c2c}
.empty{background:#fff;border-radius:14px;padding:28px 16px;text-align:center;color:var(--muted)}
.login{max-width:420px;margin:8vh auto 0;padding:0 18px}
.login .mark{width:72px;height:72px;border-radius:18px}
.hint{color:var(--muted);font-size:.92rem}
details{margin-top:8px}
summary{min-height:44px;display:flex;align-items:center;font-weight:800;cursor:pointer}
.count{color:var(--muted);font-size:.88rem;margin:0 0 8px}
.back{color:#fff}
.tl{border-top:1px solid var(--line);padding:10px 0}
.tl:first-child{border-top:0}
.who{font-size:.72rem;font-weight:800;letter-spacing:.4px;text-transform:uppercase}
.who.out{color:#1e3a5f}
.who.in{color:#146c3a}
.flag{display:inline-block;background:#fdecec;color:#9b2c2c;font-weight:800;border-radius:999px;padding:2px 8px;font-size:.75rem;margin-left:6px}
.switch{display:flex;align-items:center;gap:10px;font-size:1rem;color:var(--ink);font-weight:800}
.switch input{width:1.3rem;height:1.3rem}
.draft-status{min-height:1.2em}
.panel .btn{margin-top:8px}
.folders{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:0 0 12px}
.folders a{display:flex;align-items:center;justify-content:center;gap:6px;min-height:48px;border-radius:12px;background:#fff;border:1.5px solid #e4e5e7;text-decoration:none;font-weight:800;font-size:.92rem;color:var(--ink)}
.folders a.on{background:#2A2D32;color:#fff;border-color:#2A2D32}
.folders a.on .badge{background:#F6B913;color:#2A2D32}
.seg{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.seg label{display:flex;align-items:center;justify-content:center;min-height:52px;border:1.5px solid #d5d6d8;border-radius:12px;font-weight:800;background:#fff;color:var(--ink)}
.seg input{position:absolute;opacity:0;width:1px;height:1px}
.seg label:has(input:checked){background:#2A2D32;color:#fff;border-color:#2A2D32}
.seg label.off{opacity:.45}
#reply-form:has(input[value="sms"]:checked) .email-only{display:none}
#reply-form:has(input[value="email"]:checked) .text-only{display:none}
`;

function page({ title, body, authed, active, dueCount, csrf, back }) {
  const dock = authed ? `<nav class="dock" aria-label="Leads">
    <a href="/crm/" class="${active === 'all' ? 'on' : ''}" ${active === 'all' ? 'aria-current="page"' : ''}>Leads</a>
    <a href="/crm/due" class="${active === 'due' ? 'on' : ''}" ${active === 'due' ? 'aria-current="page"' : ''}>Due${dueCount ? ` <span class="badge">${dueCount}</span>` : ''}</a>
    <a href="/crm/new" class="${active === 'new' ? 'on' : ''}" ${active === 'new' ? 'aria-current="page"' : ''}>New</a>
    <a href="/crm/export.csv">CSV</a>
  </nav>` : '';
  const logout = authed ? `<div class="tools"><a class="textbtn" href="/crm/settings">Settings</a><form method="post" action="/crm/logout"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="textbtn" type="submit">Log out</button></form></div>` : '';
  const backLink = back ? `<a class="iconbtn back" href="${esc(back)}" aria-label="Back">‹</a>` : '';
  const heading = title.replace(/ \|.*$/, '');
  return `<!doctype html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="googlebot" content="noindex, nofollow">
<meta name="color-scheme" content="only light">
<meta name="theme-color" content="#2A2D32">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="JF Leads">
<title>${esc(heading)} | ${esc(B.name)}</title>
<link rel="manifest" href="/crm/manifest.webmanifest">
<link rel="icon" href="/crm/icon-192.png" type="image/png">
<link rel="apple-touch-icon" href="/crm/apple-touch-icon.png">
<style>${CSS}</style>
</head>
<body>
${body.includes('class="login"') ? '' : `<header class="appbar">${backLink}<div class="title"><span class="sub">${esc(B.name)}</span><h1>${esc(heading)}</h1></div><div class="spacer"></div>${logout}</header>`}
${body}
${dock}
<script>if('serviceWorker' in navigator){navigator.serviceWorker.register('/crm/sw.js',{scope:'/crm/'}).catch(function(){})}</script>
</body>
</html>`;
}

function sendHtml(req, res, status, html) {
  privateHeaders(res);
  res.status(status).type('html').send(html);
}

function shell(req, session, opts) {
  return page({
    title: opts.title,
    body: `<main id="main">${opts.banner || ''}${opts.main}</main>`,
    authed: !!session,
    active: opts.active || '',
    dueCount: session ? leads.dueCount() : 0,
    csrf: session ? session.csrf : '',
    back: opts.back || '',
  });
}

function loginPage(req, res, { status = 200, error = '', next = '/crm/' } = {}) {
  if (!configured()) {
    const html = page({
      title: 'Leads',
      authed: false,
      body: `<main class="login"><img class="mark" src="/crm/icon-192.png" alt=""><h1>${esc(B.name)} leads</h1><p class="banner bad">CRM_PASSWORD is not set on the server yet. Add it in the host's environment, then open this page again.</p></main>`,
    });
    return sendHtml(req, res, 503, html);
  }
  const html = page({
    title: `Leads | ${B.name}`,
    authed: false,
    body: `<main class="login">
      <img class="mark" src="/crm/icon-192.png" alt="">
      <h1>${esc(B.name)} leads</h1>
      <p class="hint">Private. Add this page to your home screen to open it like an app.</p>
      ${error ? `<p class="banner bad" role="alert">${esc(error)}</p>` : ''}
      <form method="post" action="/crm/login">
        <input type="hidden" name="next" value="${esc(safeNext(next))}">
        <label>Password<input type="password" name="password" autocomplete="current-password" required autofocus></label>
        <p><button class="btn btn-yellow" type="submit">Sign in</button></p>
      </form>
    </main>`,
  });
  sendHtml(req, res, status, html);
}

const loginHits = new Map();
function loginBlocked(ip) {
  const now = Date.now();
  const hits = (loginHits.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  loginHits.set(ip, hits);
  return hits.length >= 8;
}
function loginFail(ip) {
  const hits = loginHits.get(ip) || [];
  hits.push(Date.now());
  loginHits.set(ip, hits);
}
function loginReset(ip) { loginHits.delete(ip); }

const apiHits = new Map();
function apiLimited(ip) {
  const now = Date.now();
  const hits = (apiHits.get(ip) || []).filter((t) => now - t < 60 * 1000);
  hits.push(now);
  apiHits.set(ip, hits);
  return hits.length > 60;
}

function requireSession(req, res, next) {
  const session = readSession(req);
  if (!session) return loginPage(req, res, { status: 401, next: req.originalUrl });
  req.crm = session;
  next();
}

function requireCsrf(req, res, next) {
  const given = String((req.body && req.body._csrf) || '');
  if (!shaEqual(given, req.crm.csrf)) {
    return sendHtml(req, res, 403, shell(req, req.crm, { title: 'Leads', main: '<p class="banner bad" role="alert">That form expired. Go back and try again.</p>', active: 'all' }));
  }
  next();
}

function filters(view, q) {
  const statusOpts = ['', ...leads.STATUSES].map((s) => `<option value="${esc(s)}"${s === (q.status || '') ? ' selected' : ''}>${s ? esc(s) : 'All statuses'}</option>`).join('');
  const sourceOpts = ['', ...leads.SOURCES].map((s) => `<option value="${esc(s)}"${s === (q.source || '') ? ' selected' : ''}>${s ? esc(SOURCE_LABEL[s]) : 'All sources'}</option>`).join('');
  const action = view === 'due' ? '/crm/due' : '/crm/';
  const folderField = view === 'due' ? '' : `<input type="hidden" name="folder" value="${esc(q.folder || 'new')}">`;
  return `<form class="filters" method="get" action="${action}">
    ${folderField}
    <div class="searchrow"><input type="search" name="q" value="${esc(q.q || '')}" placeholder="Search name, phone, city" aria-label="Search leads"><button class="btn btn-dark btn-inline" type="submit">Filter</button></div>
    <div class="row2"><select name="status" aria-label="Status">${statusOpts}</select><select name="source" aria-label="Source">${sourceOpts}</select></div>
  </form>`;
}

function folderTabs(active, q) {
  const counts = leads.folderCounts();
  const keep = new URLSearchParams();
  if (q.status) keep.set('status', q.status);
  if (q.source) keep.set('source', q.source);
  if (q.q) keep.set('q', q.q);
  const href = (folder) => {
    const params = new URLSearchParams(keep);
    params.set('folder', folder);
    return `/crm/?${params}`;
  };
  const tab = (folder, label) => `<a href="${href(folder)}" class="${active === folder ? 'on' : ''}" ${active === folder ? 'aria-current="page"' : ''}>${label} <span class="badge">${counts[folder]}</span></a>`;
  return `<nav class="folders" aria-label="Folders">${tab('new', 'New')}${tab('opened', 'Opened')}${tab('replied', 'Replied')}</nav>`;
}

function leadCard(lead, today) {
  const name = lead.name || lead.email || lead.phone || 'No name';
  const route = [lead.pickup, lead.dropoff].filter(Boolean).join(' → ');
  const bits = [lead.loadType, lead.shedSize, lead.quotedPrice].filter(Boolean).join(' · ');
  const tel = leads.telHref(lead.phone);
  let due = '';
  if (lead.followUpDate && lead.status !== 'Booked' && lead.status !== 'Lost') {
    if (lead.followUpDate < today) due = `<div class="dueflag overdue">Overdue · ${esc(fmtDay(lead.followUpDate))}</div>`;
    else if (lead.followUpDate === today) due = '<div class="dueflag">Due today</div>';
    else due = `<div class="dueflag">Follow up ${esc(fmtDay(lead.followUpDate))}</div>`;
  }
  return `<article class="card">
    <a class="card-main" href="/crm/lead/${esc(lead.id)}">
      <div class="card-top"><strong>${esc(name)}</strong><span class="pill ${esc(lead.status)}">${esc(lead.status)}</span></div>
      ${route ? `<div class="route">${esc(route)}</div>` : ''}
      <div class="meta">${esc(SOURCE_LABEL[lead.source] || lead.source)}${bits ? ` · ${esc(bits)}` : ''}</div>
      ${lead.needsJohan ? '<div class="dueflag overdue">Needs Johan</div>' : ''}
      ${due}
    </a>
    ${tel ? `<a class="call" href="${esc(tel)}">Call</a>` : ''}
  </article>`;
}

function listPage(req, res, { dueOnly }) {
  const folder = ['new', 'opened', 'replied'].includes(String(req.query.folder || '')) ? String(req.query.folder) : 'new';
  const q = { status: String(req.query.status || ''), source: String(req.query.source || ''), q: String(req.query.q || ''), folder: dueOnly ? '' : folder };
  const { rows, today } = leads.query({ ...q, dueOnly, folder: q.folder });
  const title = dueOnly ? 'Follow-ups' : (folder === 'opened' ? 'Opened' : folder === 'replied' ? 'Replied' : 'New');
  const narrowed = q.status || q.source || q.q;
  const empty = dueOnly
    ? 'No follow-ups due. Set a follow-up date on a lead and it will show up here until the job is booked or lost.'
    : folder === 'opened'
      ? 'No opened quotes waiting for a reply.'
      : folder === 'replied'
        ? 'No quotes you have replied to yet.'
        : narrowed
          ? 'No leads match.'
          : 'No new quotes. Website quotes land here until you open them.';
  const banner = dueOnly ? '' : `<div id="push-banner" class="panel" hidden><input type="hidden" name="_csrf" value="${esc(req.crm.csrf)}"><p id="push-ios" hidden>On iPhone, add JF Leads to your Home Screen, open it from the icon, then tap Enable notifications.</p><p id="push-ask">Get a ping on this phone when a quote or a reply comes in.</p><button type="button" class="btn btn-yellow" id="push-enable">Enable notifications</button></div>`;
  const main = `${dueOnly ? '' : folderTabs(folder, q)}${banner}${filters(dueOnly ? 'due' : 'all', q)}<p class="count">${rows.length} ${dueOnly ? 'due' : rows.length === 1 ? 'lead' : 'leads'}</p>${rows.length ? rows.map((r) => leadCard(r, today)).join('') : `<div class="empty">${empty}</div>`}${dueOnly ? '' : PUSH_JS}`;
  sendHtml(req, res, 200, shell(req, req.crm, { title, main, active: dueOnly ? 'due' : 'all' }));
}

function field(name, label, value, opts = {}) {
  const type = opts.type || 'text';
  const extra = opts.list ? ` list="${esc(opts.list)}"` : '';
  const ac = opts.auto ? ` autocomplete="${esc(opts.auto)}"` : ' autocomplete="off"';
  const inputmode = opts.mode ? ` inputmode="${esc(opts.mode)}"` : '';
  const required = opts.required ? ' required' : '';
  if (opts.multiline) return `<label>${esc(label)}<textarea name="${esc(name)}" maxlength="${opts.max || 4000}">${esc(value || '')}</textarea></label>`;
  return `<label>${esc(label)}<input name="${esc(name)}" type="${esc(type)}" value="${esc(value || '')}" maxlength="${opts.max || 200}"${extra}${ac}${inputmode}${required}></label>`;
}

const LOAD_LIST = ['20 ft container', '40 ft container', 'Container', 'Shed', 'Flat-deck', 'General freight', 'Equipment'];

function newPage(req, res, { error = '', value = {}, status = 200 } = {}) {
  const v = value;
  const main = `${error ? `<p class="banner bad" role="alert">${esc(error)}</p>` : '<p class="hint">For a call or a lead that did not come through the website.</p>'}
    <form method="post" action="/crm/new">
      <input type="hidden" name="_csrf" value="${esc(req.crm.csrf)}">
      <div class="panel">
        ${field('name', 'Name', v.name, { auto: 'name', max: 120 })}
        ${field('phone', 'Phone', v.phone, { type: 'tel', auto: 'tel', mode: 'tel', max: 80 })}
        ${field('email', 'Email', v.email, { type: 'email', auto: 'email', mode: 'email', max: 150 })}
        <label>Source<select name="source">${leads.SOURCES.map((s) => `<option value="${s}"${(v.source || 'phone') === s ? ' selected' : ''}>${esc(SOURCE_LABEL[s])}</option>`).join('')}</select></label>
      </div>
      <div class="panel">
        ${field('pickup', 'Pickup', v.pickup, { max: 200 })}
        ${field('dropoff', 'Drop-off', v.dropoff, { max: 200 })}
        ${field('loadType', 'Load type', v.loadType, { list: 'loads', max: 80 })}
        <datalist id="loads">${LOAD_LIST.map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist>
        ${field('shedSize', 'Shed size', v.shedSize, { max: 40 })}
        ${field('quotedPrice', 'Quoted price', v.quotedPrice, { max: 80 })}
        ${field('followUpDate', 'Follow-up date', v.followUpDate, { type: 'date' })}
        ${field('message', 'Original message', v.message, { multiline: true, max: 4000 })}
        ${field('note', 'Note', v.note, { multiline: true, max: 2000 })}
      </div>
      <button class="btn btn-yellow" type="submit">Save lead</button>
    </form>`;
  sendHtml(req, res, status, shell(req, req.crm, { title: 'New lead', main, active: 'new', back: '/crm/' }));
}

const SENT = { email: 'Email sent.', sms: 'Text sent.', ai: 'AI auto-reply updated.', cleared: 'Needs Johan cleared.', saved: 'Saved.' };
const ERRORS = {
  outlook: 'Connect Outlook in Settings before this can send.',
  'outlook-off': 'Outlook email is off until Microsoft sign-in is set up in Settings.',
  'outlook-send': 'Outlook could not send that email.',
  'mail-off': 'Email is off until Resend or SMTP is set up.',
  'mail-send': 'That email could not be sent.',
  twilio: 'Texting is off until Twilio is set up in Settings.',
  'twilio-off': 'Texting is off until Twilio is set up in Settings.',
  'twilio-send': 'That text could not be sent.',
  'no-email': 'This lead has no email address.',
  'no-phone': 'This lead has no mobile number we can text.',
  empty: 'Write a message before sending.',
  ai: 'AI replies are off until an OpenAI key is set.',
  'ai-empty': 'AI did not return a draft.',
};

function flash(req) {
  const sent = SENT[req.query.sent] || (req.query.saved === '1' ? SENT.saved : '');
  const problem = ERRORS[req.query.error] || '';
  return `${sent ? `<p class="banner" role="status">${esc(sent)}</p>` : ''}${problem ? `<p class="banner bad" role="alert">${esc(problem)}</p>` : ''}`;
}

function emailSubject(lead) {
  const last = leads.conversation(lead).find((item) => item.kind === 'email' && item.subject);
  if (last) return `Re: ${String(last.subject).replace(/^re:\s*/i, '')}`.slice(0, 200);
  return `JF Hauling${lead.loadType ? ` — ${lead.loadType}` : ''}`.slice(0, 200);
}

function timelineHtml(lead) {
  const items = leads.conversation(lead);
  if (!items.length) return '<p class="hint">Notes, emails, and texts will show up here.</p>';
  return items.map((item) => {
    const label = item.kind === 'email' ? (item.direction === 'in' ? 'Email in' : 'Email out') : item.kind === 'sms' ? (item.direction === 'in' ? 'Text in' : 'Text out') : 'Note';
    return `<article class="tl"><div class="who ${esc(item.direction || '')}">${esc(label)}${item.ai ? ' · AI' : ''}</div><time datetime="${esc(item.at)}">${esc(fmtWhen(item.at))}</time>${item.subject ? `<div class="meta">${esc(item.subject)}</div>` : ''}<div class="msg">${esc(item.body || '')}</div></article>`;
  }).join('');
}

const PUSH_JS = `<script>
(function(){
  var banner=document.getElementById('push-banner');
  var ios=document.getElementById('push-ios');
  var ask=document.getElementById('push-ask');
  var btn=document.getElementById('push-enable');
  var standalone=window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true;
  var iphone=/iPad|iPhone|iPod/.test(navigator.userAgent);
  function showBanner(){if(banner)banner.hidden=false;}
  if(iphone&&!standalone){if(ios)ios.hidden=false;if(ask)ask.hidden=true;if(btn)btn.hidden=true;showBanner();}
  else if(window.Notification&&Notification.permission!=='granted'&&!localStorage.getItem('jf_push_off'))showBanner();
  async function enable(){
    if(!window.Notification||!navigator.serviceWorker)return;
    var perm=await Notification.requestPermission();
    if(perm!=='granted'){localStorage.setItem('jf_push_off','1');return;}
    var key=await fetch('/crm/push/key').then(function(r){return r.json();});
    var reg=await navigator.serviceWorker.ready;
    var sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:vapidKey(key.publicKey)});
    var csrf=document.querySelector('input[name=_csrf]');
    await fetch('/crm/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({_csrf:csrf?csrf.value:'',subscription:sub.toJSON()})});
    if(banner)banner.hidden=true;
    var status=document.getElementById('push-status');
    if(status)status.textContent='Notifications are on for this phone.';
  }
  function vapidKey(str){var pad='='.repeat((4-str.length%4)%4);var b=atob((str+pad).replace(/-/g,'+').replace(/_/g,'/'));var a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a;}
  if(btn)btn.addEventListener('click',function(){enable().catch(function(){var status=document.getElementById('push-status');if(status)status.textContent='Notifications could not be turned on.';});});
})();
</script>`;

const DRAFT_JS = `<script>
document.querySelectorAll('[data-draft]').forEach(function(btn){
  btn.addEventListener('click', function(){
    var picked=document.querySelector('#reply-form input[name=channel]:checked');
    var channel = picked ? picked.value : btn.getAttribute('data-draft');
    var box = document.getElementById('reply-body');
    var status = document.getElementById('reply-draft-status');
    var csrf = document.querySelector('input[name=_csrf]');
    btn.disabled = true;
    if (status) status.textContent = 'Writing a draft…';
    fetch(btn.getAttribute('data-url'), { method:'POST', headers:{ 'Content-Type':'application/json', Accept:'application/json' }, body: JSON.stringify({ _csrf: csrf ? csrf.value : '', channel: channel }) })
      .then(function(r){ return r.json().then(function(data){ return { ok:r.ok, data:data }; }); })
      .then(function(res){
        if (res.ok && res.data && res.data.text) { box.value = res.data.text; if (status) status.textContent = 'Draft ready. Read it, then press send.'; }
        else if (status) status.textContent = (res.data && res.data.error) || 'No draft.';
      })
      .catch(function(){ if (status) status.textContent = 'No draft.'; })
      .then(function(){ btn.disabled = false; });
  });
});
</script>`;

function detailPage(req, res, lead, { error = '', status = 200 } = {}) {
  const tel = leads.telHref(lead.phone);
  const mail = leads.mailHref(lead.email);
  const name = lead.name || 'No name';
  const actions = [
    tel ? `<a class="btn btn-yellow" href="${esc(tel)}">Call</a>` : '',
    mail ? `<a class="btn btn-line" href="${esc(mail)}">Email</a>` : '',
  ].filter(Boolean).join('');
  const csrf = esc(req.crm.csrf);
  const emailHint = config.microsoft.clientId
    ? (outlook.connected() ? '' : '<p class="hint">Connect Outlook in Settings, then you can send from this lead.</p>')
    : `<p class="hint">Email sends via JF Hauling mail, replies go to ${esc(config.business.email)}.</p>${mailer.mode() === 'off' ? '<p class="hint">Sending is off until RESEND_API_KEY or SMTP is set.</p>' : ''}`;
  const smsHint = twilio.configured() ? '' : '<p class="hint">Texting is off until Twilio is set up in Settings.</p>';
  const aiHint = ai.keySet() ? '' : '<p class="hint">Draft with AI is off until an OpenAI key is set.</p>';
  const main = `
    ${flash(req)}
    ${error ? `<p class="banner bad" role="alert">${esc(error)}</p>` : ''}
    <p class="meta"><span class="pill ${esc(lead.status)}">${esc(lead.status)}</span> ${esc(SOURCE_LABEL[lead.source] || lead.source)} · ${esc(fmtWhen(lead.createdAt))}${lead.quoteId ? ` · Quote ${esc(lead.quoteId)}` : ''}${lead.needsJohan ? '<span class="flag">Needs Johan</span>' : ''}</p>
    ${[lead.pickup, lead.dropoff].filter(Boolean).length ? `<p class="route">${esc([lead.pickup, lead.dropoff].filter(Boolean).join(' → '))}</p>` : ''}
    <p class="meta">${esc([lead.loadType, lead.shedSize, lead.quotedPrice].filter(Boolean).join(' · '))}</p>
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    ${replyForm(lead, csrf, emailHint, smsHint, aiHint)}
    <section class="panel"><h2>Conversation</h2>${timelineHtml(lead)}</section>
    <details class="panel"><summary>More</summary>
    <form method="post" action="/crm/lead/${esc(lead.id)}/ai">
      <input type="hidden" name="_csrf" value="${csrf}">
      <label class="switch"><input type="checkbox" name="aiAutoReply" value="1"${lead.aiAutoReply ? ' checked' : ''}> AI auto-reply</label>
      <p class="hint">When this is on, a new email or text from this lead can be answered on the same channel. At most 3 automatic replies a day.</p>
      ${ai.globalOn() ? '' : '<p class="hint">The global auto-reply switch is off, so nothing sends on its own.</p>'}
      <button class="btn btn-dark" type="submit">Save auto-reply</button>
    </form>
    ${lead.needsJohan ? `<form method="post" action="/crm/lead/${esc(lead.id)}/ai"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="clearJohan" value="1"><button class="btn btn-line" type="submit">Clear Needs Johan</button></form>` : ''}
    <form method="post" action="/crm/lead/${esc(lead.id)}">
      <input type="hidden" name="_csrf" value="${csrf}">
      <div class="panel">
        <div class="row2">
          <label>Status<select name="status">${leads.STATUSES.map((s) => `<option${s === lead.status ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
          ${field('followUpDate', 'Follow-up', lead.followUpDate, { type: 'date' })}
        </div>
        ${field('note', 'Add a note', '', { multiline: true, max: 2000 })}
      </div>
      <details class="panel">
        <summary>Edit contact and job</summary>
        ${field('name', 'Name', lead.name, { max: 120 })}
        ${field('phone', 'Phone', lead.phone, { type: 'tel', mode: 'tel', max: 80 })}
        ${field('email', 'Email', lead.email, { type: 'email', mode: 'email', max: 150 })}
        <label>Source<select name="source">${leads.SOURCES.map((s) => `<option value="${s}"${lead.source === s ? ' selected' : ''}>${esc(SOURCE_LABEL[s])}</option>`).join('')}</select></label>
        ${field('pickup', 'Pickup', lead.pickup, { max: 200 })}
        ${field('dropoff', 'Drop-off', lead.dropoff, { max: 200 })}
        ${field('loadType', 'Load type', lead.loadType, { list: 'loads', max: 80 })}
        <datalist id="loads">${LOAD_LIST.map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist>
        ${field('shedSize', 'Shed size', lead.shedSize, { max: 40 })}
        ${field('quotedPrice', 'Quoted price', lead.quotedPrice, { max: 80 })}
      </details>
      <div class="savebar"><button class="btn btn-yellow" type="submit">Save</button></div>
    </form>
    </details>
    <section class="panel"><h2>Original message</h2><p class="msg">${esc(lead.message || '—')}</p>${lead.externalId ? `<p class="meta">Reference ${esc(lead.externalId)}</p>` : ''}</section>
    ${DRAFT_JS}`;
  sendHtml(req, res, status, shell(req, req.crm, { title: name, main, active: 'all', back: '/crm/' }));
}

function replyForm(lead, csrf, emailHint, smsHint, aiHint) {
  const choice = leads.replyChannel(lead);
  if (!choice.channel) return '<p class="hint">Add an email or a phone number before you can reply.</p>';
  const emailOn = choice.channel === 'email';
  return `<form class="panel" method="post" action="/crm/lead/${esc(lead.id)}/reply" id="reply-form">
    <input type="hidden" name="_csrf" value="${csrf}">
    <div class="seg" role="radiogroup" aria-label="Reply by">
      <label class="${choice.canEmail ? '' : 'off'}"><input type="radio" name="channel" value="email"${emailOn ? ' checked' : ''}${choice.canEmail ? '' : ' disabled'}>Email</label>
      <label class="${choice.canText ? '' : 'off'}"><input type="radio" name="channel" value="sms"${emailOn ? '' : ' checked'}${choice.canText ? '' : ' disabled'}>Text</label>
    </div>
    <p class="meta email-only">To ${esc(lead.email || '—')}</p>
    <p class="meta text-only">To ${esc(phoneDisplay(lead.phone) || '—')}</p>
    ${emailHint}${smsHint}${aiHint}
    <div class="email-only"><label>Subject<input name="subject" maxlength="200" value="${esc(emailSubject(lead))}"></label></div>
    <label>Message<textarea id="reply-body" name="body" maxlength="4000"></textarea></label>
    <p class="draft-status" id="reply-draft-status" role="status"></p>
    <button class="btn btn-line" type="button" data-draft="email" data-url="/crm/lead/${esc(lead.id)}/draft">Draft with AI</button>
    <button class="btn btn-yellow" type="submit">Send</button>
  </form>`;
}

function phoneDisplay(phone) {
  const e164 = require('./phone').toE164(phone);
  return e164 || phone || '';
}

function settingsPage(req, res) {
  const checked = /^\d+$/.test(String(req.query.checked || '')) ? String(req.query.checked) : '';
  const saved = req.query.saved === '1';
  const connected = outlook.connected();
  const account = outlook.accountEmail();
  const globalOn = crmSettings.read().aiAutoReply !== false;
  let outlookBlock;
  if (!config.microsoft.clientId) {
    outlookBlock = `<p class="banner">Email sends via JF Hauling mail, replies go to ${esc(config.business.email)}.</p>${mailer.mode() === 'off' ? '<p class="hint">Sending is off until RESEND_API_KEY or SMTP is set. Quote alerts use the same mail.</p>' : ''}`;
  } else if (!outlook.configured()) {
    outlookBlock = '<p class="banner bad">Outlook email is off. Set MS_CLIENT_SECRET and MS_REDIRECT_URI as well, or leave MS_CLIENT_ID blank to send with the website mail.</p>';
  } else if (connected) {
    outlookBlock = `<p class="banner">Outlook is connected${account ? ` as ${esc(account)}` : ''}.</p>
      <form method="post" action="/crm/inbox/check"><input type="hidden" name="_csrf" value="${esc(req.crm.csrf)}"><button class="btn btn-dark" type="submit">Check inbox</button></form>
      <form method="post" action="/crm/oauth/disconnect"><input type="hidden" name="_csrf" value="${esc(req.crm.csrf)}"><button class="btn btn-line" type="submit">Disconnect Outlook</button></form>`;
  } else {
    outlookBlock = '<p class="hint">Sign in once with the jfhauling@outlook.com Microsoft account. The refresh token stays on the server disk.</p><p><a class="btn btn-yellow" href="/crm/oauth/start">Connect Outlook</a></p>';
  }
  const twilioBlock = twilio.configured()
    ? `<p class="banner">Texting is on from ${esc(config.twilio.fromNumber)}. In Twilio, set the inbound webhook to <strong>https://jfhauling.ca/api/twilio/sms</strong>.</p>`
    : '<p class="banner bad">Texting is off. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER on the server.</p>';
  let aiBlock;
  if (!ai.keySet()) aiBlock = '<p class="banner bad">AI replies are off until OPENAI_API_KEY is set.</p>';
  else if (!ai.envAllows()) aiBlock = '<p class="banner bad">AI auto-reply is switched off on the server (AI_AUTOREPLY_ENABLED).</p>';
  else aiBlock = `<form method="post" action="/crm/settings"><input type="hidden" name="_csrf" value="${esc(req.crm.csrf)}"><label class="switch"><input type="checkbox" name="aiAutoReply" value="1"${globalOn ? ' checked' : ''}> AI auto-reply for leads that have it on</label><p class="hint">Each lead still starts off. This switch stops every automatic reply at once. Draft with AI still works.</p><button class="btn btn-dark" type="submit">Save</button></form>`;
  const main = `
    ${saved ? '<p class="banner" role="status">Saved.</p>' : ''}
    ${flash(req)}
    ${checked ? `<p class="banner" role="status">Inbox checked. ${esc(checked)} new message${checked === '1' ? '' : 's'} filed.</p>` : ''}
    <section class="panel"><h2>Notifications</h2>
      <p id="push-ios" hidden>On iPhone, add JF Leads to your Home Screen, open it from the icon, then tap Enable notifications.</p>
      <p id="push-status" class="hint" role="status"></p>
      <button type="button" class="btn btn-yellow" id="push-enable">Enable notifications</button>
      <form method="post" action="/crm/push/test"><input type="hidden" name="_csrf" value="${esc(req.crm.csrf)}"><button class="btn btn-dark" type="submit">Send test notification</button></form>
    </section>
    <section class="panel"><h2>Email</h2>${outlookBlock}</section>
    <section class="panel"><h2>Texting</h2>${twilioBlock}</section>
    <section class="panel"><h2>AI auto-reply</h2>${aiBlock}</section>
    <p class="hint">Setup steps are in docs/crm-setup.md.</p>${PUSH_JS}`;
  sendHtml(req, res, 200, shell(req, req.crm, { title: 'Settings', main, active: '', back: '/crm/' }));
}

const OAUTH_COOKIE = 'jf_oauth';
function setOauthCookie(req, res) {
  const state = crypto.randomBytes(16).toString('hex');
  const mac = crypto.createHmac('sha256', password()).update(state).digest('base64url');
  res.cookie(OAUTH_COOKIE, `${state}.${mac}`, { ...cookieBase(req), maxAge: 10 * 60 * 1000 });
  return state;
}
function oauthStateOk(req, state) {
  const token = readCookie(req, OAUTH_COOKIE);
  if (!token || !state || !token.includes('.')) return false;
  const i = token.lastIndexOf('.');
  const body = token.slice(0, i);
  const mac = token.slice(i + 1);
  const expected = crypto.createHmac('sha256', password()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b) || !shaEqual(body, String(state))) return false;
  return true;
}

function fromForm(body) {
  return {
    source: body.source,
    name: body.name,
    phone: body.phone,
    email: body.email,
    pickup: body.pickup,
    dropoff: body.dropoff,
    loadType: body.loadType,
    shedSize: body.shedSize,
    quotedPrice: body.quotedPrice,
    message: body.message,
    status: body.status,
    followUpDate: body.followUpDate,
    note: body.note,
  };
}

function fromApiBody(body) {
  const pick = (...keys) => {
    for (const k of keys) if (body[k] !== undefined && body[k] !== null) return body[k];
    return undefined;
  };
  return {
    source: pick('source'),
    name: pick('name'),
    phone: pick('phone'),
    email: pick('email'),
    pickup: pick('pickup_location', 'pickup'),
    dropoff: pick('dropoff_location', 'drop_off_location', 'dropoff'),
    loadType: pick('load_type', 'loadType'),
    shedSize: pick('shed_size', 'shedSize'),
    quotedPrice: pick('quoted_price', 'quotedPrice'),
    message: pick('original_message', 'message'),
    status: pick('status'),
    followUpDate: pick('follow_up_date', 'followUpDate'),
    externalId: pick('external_id', 'externalId'),
    note: pick('note'),
  };
}

const SW = `self.addEventListener('install',function(e){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET')return;
  e.respondWith(fetch(e.request));
});
self.addEventListener('push',function(event){
  var data={title:'JF Hauling',body:'New lead',url:'/crm/'};
  try{if(event.data)data=Object.assign(data,event.data.json());}catch(e){}
  event.waitUntil(self.registration.showNotification(data.title||'JF Hauling',{body:data.body||'',icon:'/crm/icon-192.png',badge:'/crm/icon-192.png',data:{url:data.url||'/crm/'}}));
});
self.addEventListener('notificationclick',function(event){
  event.notification.close();
  var url=(event.notification.data&&event.notification.data.url)||'/crm/';
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(function(list){
    for(var i=0;i<list.length;i++){
      if(list[i].url.indexOf('/crm')!==-1&&'focus'in list[i]){
        if(list[i].navigate)list[i].navigate(url);
        return list[i].focus();
      }
    }
    if(clients.openWindow)return clients.openWindow(url);
  }));
});
`;

function sendIcon(res, file) {
  const filePath = path.join(__dirname, '..', 'public', 'img', 'brand', file);
  res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'public, max-age=86400' });
  res.type('png').send(fs.readFileSync(filePath));
}

function mount(app) {
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send([
      'User-agent: *',
      'Disallow: /crm',
      'Disallow: /admin',
      'Disallow: /api/leads',
      'Disallow: /api/twilio',
      '',
    ].join('\n'));
  });

  app.get('/crm/manifest.webmanifest', (req, res) => {
    const manifest = {
      id: '/crm/',
      name: `${B.name} Leads`,
      short_name: 'JF Leads',
      description: `Private leads for ${B.name}`,
      start_url: '/crm/',
      scope: '/crm/',
      display: 'standalone',
      background_color: '#2A2D32',
      theme_color: '#2A2D32',
      lang: 'en-CA',
      icons: [
        { src: '/crm/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/crm/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      ],
    };
    res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-cache', 'Content-Type': 'application/manifest+json; charset=utf-8' });
    res.send(JSON.stringify(manifest));
  });
  app.get('/crm/sw.js', (req, res) => {
    res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/crm/' });
    res.type('application/javascript').send(SW);
  });
  app.get('/crm/icon-192.png', (req, res) => sendIcon(res, 'icon-192.png'));
  app.get('/crm/icon-512.png', (req, res) => sendIcon(res, 'icon-512.png'));
  app.get('/crm/apple-touch-icon.png', (req, res) => sendIcon(res, 'apple-touch-icon.png'));

  function bearerOk(req) {
    if (!apiToken()) return { ok: false, status: 503, error: 'Lead API is not configured.' };
    if (apiLimited(req.ip)) return { ok: false, status: 429, error: 'Too many requests. Try again in a minute.' };
    const header = String(req.headers.authorization || '');
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!match || !shaEqual(match[1], apiToken())) return { ok: false, status: 401, error: 'Authentication required.' };
    return { ok: true };
  }
  function jsonObject(req, res) {
    if (!req.is('application/json') || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'Send a JSON object.' });
      return false;
    }
    return true;
  }

  app.post('/api/leads', (req, res) => {
    privateHeaders(res);
    const auth = bearerOk(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    if (!jsonObject(req, res)) return;
    const result = leads.create(fromApiBody(req.body), { defaultSource: 'email' });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    if (!result.duplicate) console.log(`[leads] created id=${result.lead.id} source=${result.lead.source}`);
    res.status(result.status).json({ ok: true, duplicate: result.duplicate, lead: leads.publicLead(result.lead) });
  });

  app.post('/api/leads/inbound-email', async (req, res) => {
    privateHeaders(res);
    const auth = bearerOk(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    if (!jsonObject(req, res)) return;
    try {
      const result = await inboundEmail.receive(req.body);
      if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
      res.status(result.status).json({
        lead_id: result.lead_id,
        created: result.created,
        duplicate: result.duplicate,
        auto_replied: result.auto_replied,
      });
    } catch (err) {
      console.error('[leads] inbound email failed');
      res.status(500).json({ error: 'Could not file that email.' });
    }
  });

  app.get('/api/leads/known-emails', (req, res) => {
    privateHeaders(res);
    const auth = bearerOk(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    res.json({ emails: inboundEmail.knownEmails() });
  });
  app.get('/api/leads/needs-reply', (req, res) => {
    privateHeaders(res);
    const auth = bearerOk(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const since = String(req.query.since || '');
    if (since && Number.isNaN(new Date(since).getTime())) return res.status(400).json({ error: 'since must be a date.' });
    const minutes = req.query.minutes == null || req.query.minutes === '' ? 30 : Number(req.query.minutes);
    if (!Number.isFinite(minutes) || minutes < 0) return res.status(400).json({ error: 'minutes must be a number.' });
    res.json(leads.needsReply({ minutes, since }));
  });
  app.post('/api/notify', async (req, res) => {
    privateHeaders(res);
    const auth = bearerOk(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    if (!jsonObject(req, res)) return;
    const title = String(req.body.title || '').trim().slice(0, 80);
    const body = String(req.body.body || '').trim().slice(0, 180);
    if (!title || !body) return res.status(400).json({ error: 'title and body are required.' });
    const leadId = String(req.body.leadId || '').trim();
    await push.notifyCustom({ title, body, leadId });
    res.json({ ok: true, devices: push.list().length });
  });
  app.get('/crm/push/key', requireSession, (req, res) => {
    privateHeaders(res);
    const publicKey = push.publicKey();
    if (!publicKey) return res.status(503).json({ error: 'Notifications are not available.' });
    res.json({ publicKey });
  });
  app.post('/crm/push/subscribe', requireSession, requireCsrf, (req, res) => {
    privateHeaders(res);
    const saved = push.save(req.body && req.body.subscription);
    if (!saved) return res.status(400).json({ error: 'That subscription was not valid.' });
    res.json({ ok: true, devices: saved.length });
  });
  app.post('/crm/push/test', requireSession, requireCsrf, async (req, res) => {
    await push.notifyCustom({ title: 'JF Hauling', body: 'Test notification', leadId: '' });
    res.redirect(303, '/crm/settings?saved=1');
  });

  app.post('/crm/login', (req, res) => {
    const next = safeNext(req.body && req.body.next);
    if (!configured()) return loginPage(req, res, { status: 503 });
    const given = req.body && req.body.password;
    if (loginBlocked(req.ip)) {
      shaEqual(given, password());
      return loginPage(req, res, { status: 429, error: 'Too many tries. Wait a few minutes and try again.', next });
    }
    if (!shaEqual(given, password())) {
      loginFail(req.ip);
      return loginPage(req, res, { status: 401, error: 'That password is not right.', next });
    }
    loginReset(req.ip);
    setSession(req, res);
    res.redirect(303, next);
  });

  app.get('/crm', (req, res, next) => {
    if (req.path === '/crm') return res.redirect(302, '/crm/');
    next();
  });

  app.get('/crm/', (req, res, next) => {
    if (!readSession(req)) return loginPage(req, res, { status: 200, next: '/crm/' });
    next();
  }, requireSession, (req, res) => listPage(req, res, { dueOnly: false }));

  app.get('/crm/due', requireSession, (req, res) => listPage(req, res, { dueOnly: true }));
  app.get('/crm/new', requireSession, (req, res) => newPage(req, res, {}));
  app.post('/crm/new', requireSession, requireCsrf, (req, res) => {
    const raw = fromForm(req.body || {});
    if (!raw.source) raw.source = 'phone';
    const result = leads.create(raw, { defaultSource: 'phone' });
    if (!result.ok) return newPage(req, res, { error: result.error, value: raw, status: 400 });
    console.log(`[leads] created id=${result.lead.id} source=${result.lead.source}`);
    res.redirect(303, `/crm/lead/${result.lead.id}?saved=1`);
  });
  app.get('/crm/lead/:id', requireSession, (req, res) => {
    const found = leads.find(req.params.id);
    if (!found) return sendHtml(req, res, 404, shell(req, req.crm, { title: 'Leads', main: '<p class="empty">That lead is not on file.</p>', active: 'all' }));
    const lead = leads.markOpened(found.id) || found;
    detailPage(req, res, lead, { saved: req.query.saved === '1' });
  });
  app.post('/crm/lead/:id', requireSession, requireCsrf, (req, res) => {
    const lead = leads.find(req.params.id);
    if (!lead) return sendHtml(req, res, 404, shell(req, req.crm, { title: 'Leads', main: '<p class="empty">That lead is not on file.</p>', active: 'all' }));
    const result = leads.update(req.params.id, fromForm(req.body || {}));
    if (!result.ok) return detailPage(req, res, lead, { error: result.error, status: result.status || 400 });
    res.redirect(303, `/crm/lead/${lead.id}?saved=1`);
  });
  app.get('/crm/export.csv', requireSession, (req, res) => {
    privateHeaders(res);
    const { rows } = leads.query({});
    res.type('text/csv').attachment('jf-hauling-leads.csv').send(leads.toCsv(rows));
  });
  app.get('/crm/settings', requireSession, (req, res) => settingsPage(req, res));
  app.post('/crm/settings', requireSession, requireCsrf, (req, res) => {
    crmSettings.write({ aiAutoReply: req.body && req.body.aiAutoReply === '1' });
    res.redirect(303, '/crm/settings?saved=1');
  });
  app.get('/crm/oauth/start', requireSession, (req, res) => {
    if (!outlook.configured()) return res.redirect(303, '/crm/settings?error=outlook-off');
    const state = setOauthCookie(req, res);
    res.redirect(302, outlook.authorizeUrl(state));
  });
  app.get('/crm/oauth/callback', requireSession, async (req, res) => {
    res.clearCookie(OAUTH_COOKIE, cookieBase(req));
    if (req.query.error || !req.query.code || !oauthStateOk(req, req.query.state)) {
      return res.redirect(303, '/crm/settings?error=outlook');
    }
    try {
      await outlook.exchangeCode(String(req.query.code));
      res.redirect(303, '/crm/settings?saved=1');
    } catch {
      res.redirect(303, '/crm/settings?error=outlook');
    }
  });
  app.post('/crm/oauth/disconnect', requireSession, requireCsrf, (req, res) => {
    outlook.disconnect();
    console.log('[outlook] disconnected');
    res.redirect(303, '/crm/settings?saved=1');
  });
  app.post('/crm/inbox/check', requireSession, requireCsrf, async (req, res) => {
    const result = await outlook.pullInbox();
    const n = (result.created || 0) + (result.logged || 0);
    res.redirect(303, `/crm/settings?checked=${n}`);
  });
  app.post('/crm/lead/:id/ai', requireSession, requireCsrf, (req, res) => {
    const lead = leads.find(req.params.id);
    if (!lead) return sendHtml(req, res, 404, shell(req, req.crm, { title: 'Leads', main: '<p class="empty">That lead is not on file.</p>', active: 'all' }));
    if (req.body && req.body.clearJohan === '1') {
      leads.setFlags(lead.id, { needsJohan: false });
      return res.redirect(303, `/crm/lead/${lead.id}?sent=cleared`);
    }
    leads.setFlags(lead.id, { aiAutoReply: req.body && req.body.aiAutoReply === '1' });
    res.redirect(303, `/crm/lead/${lead.id}?sent=ai`);
  });
  app.post('/crm/lead/:id/reply', requireSession, requireCsrf, async (req, res) => {
    const lead = leads.find(req.params.id);
    if (!lead) return sendHtml(req, res, 404, shell(req, req.crm, { title: 'Leads', main: '<p class="empty">That lead is not on file.</p>', active: 'all' }));
    const choice = leads.replyChannel(lead, req.body && req.body.channel);
    const body = String((req.body && req.body.body) || '').trim().slice(0, 4000);
    const back = (code) => res.redirect(303, `/crm/lead/${lead.id}?error=${code}`);
    if (!choice.channel) return back(choice.canEmail ? 'no-phone' : 'no-email');
    if (!body) return back('empty');
    if (choice.channel === 'email') {
      const subject = String((req.body && req.body.subject) || '').trim().slice(0, 200);
      const sent = await crmMail.sendLeadEmail({ lead, to: lead.email, subject: subject || 'JF Hauling', body, ai: false });
      if (!sent.ok) return back(sent.error || 'mail-send');
    } else {
      const sent = await twilio.sendSms({ to: lead.phone, body: body.slice(0, 1000) });
      if (!sent.ok) return back(sent.error || 'twilio-send');
      leads.addTimeline(lead.id, { kind: 'sms', direction: 'out', body: body.slice(0, 1000), ai: false });
    }
    res.redirect(303, `/crm/lead/${lead.id}?sent=${choice.channel === 'email' ? 'email' : 'sms'}`);
  });
  app.post('/crm/lead/:id/email', requireSession, requireCsrf, async (req, res) => {
    const lead = leads.find(req.params.id);
    if (!lead) return sendHtml(req, res, 404, shell(req, req.crm, { title: 'Leads', main: '<p class="empty">That lead is not on file.</p>', active: 'all' }));
    const subject = String((req.body && req.body.subject) || '').trim().slice(0, 200);
    const body = String((req.body && req.body.body) || '').trim().slice(0, 4000);
    const back = (code) => res.redirect(303, `/crm/lead/${lead.id}?error=${code}`);
    if (!lead.email) return back('no-email');
    if (!body) return back('empty');
    const sent = await crmMail.sendLeadEmail({ lead, to: lead.email, subject: subject || 'JF Hauling', body, ai: false });
    if (!sent.ok) return back(sent.error || 'mail-send');
    res.redirect(303, `/crm/lead/${lead.id}?sent=email`);
  });
  app.post('/crm/lead/:id/sms', requireSession, requireCsrf, async (req, res) => {
    const lead = leads.find(req.params.id);
    if (!lead) return sendHtml(req, res, 404, shell(req, req.crm, { title: 'Leads', main: '<p class="empty">That lead is not on file.</p>', active: 'all' }));
    const body = String((req.body && req.body.body) || '').trim().slice(0, 1000);
    const back = (code) => res.redirect(303, `/crm/lead/${lead.id}?error=${code}`);
    if (!lead.phone) return back('no-phone');
    if (!body) return back('empty');
    const sent = await twilio.sendSms({ to: lead.phone, body });
    if (!sent.ok) return back(sent.error || 'twilio-send');
    leads.addTimeline(lead.id, { kind: 'sms', direction: 'out', body, ai: false });
    res.redirect(303, `/crm/lead/${lead.id}?sent=sms`);
  });
  app.post('/crm/lead/:id/draft', requireSession, requireCsrf, async (req, res) => {
    privateHeaders(res);
    const lead = leads.find(req.params.id);
    if (!lead) return res.status(404).json({ error: 'That lead was not found.' });
    const channel = req.body && req.body.channel === 'sms' ? 'sms' : 'email';
    const inbound = leads.conversation(lead).find((item) => item.direction === 'in');
    const text = (inbound && inbound.body) || lead.message || 'The customer has not written a message yet. Write a short check-in.';
    const draft = await ai.generateReply({ lead, text, channel });
    if (!draft.ok) return res.status(draft.error === 'ai-empty' ? 502 : 503).json({ error: ERRORS[draft.error] || ERRORS.ai });
    res.json({ text: draft.text });
  });
  app.post('/api/twilio/sms', async (req, res) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    if (!twilio.configured()) return res.status(503).type('text').send('Texting is not set up.');
    const params = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const ok = twilio.validateSignature(twilio.requestUrl(req), params, req.get('X-Twilio-Signature') || req.get('x-twilio-signature'), config.twilio.authToken);
    if (!ok) {
      console.error('[twilio] inbound rejected');
      return res.status(403).type('text').send('Forbidden');
    }
    try {
      await twilio.ingestInbound({ from: params.From, body: params.Body, messageSid: params.MessageSid || params.SmsMessageSid });
    } catch {
      console.error('[twilio] inbound failed');
    }
    res.type('text/xml').send('<Response></Response>');
  });
  app.post('/crm/logout', requireSession, requireCsrf, (req, res) => {
    clearSession(req, res);
    res.redirect(303, '/crm/');
  });

  app.use('/crm', (req, res) => {
    const session = readSession(req);
    if (!session) return loginPage(req, res, { status: 401, next: '/crm/' });
    sendHtml(req, res, 404, shell(req, session, { title: 'Leads', main: '<p class="empty">That page is not in the leads app.</p>', active: '' }));
  });

  app.use((err, req, res, next) => {
    if (req.path === '/api/leads' && err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
      privateHeaders(res);
      const status = err.type === 'entity.too.large' ? 413 : 400;
      return res.status(status).json({ error: status === 413 ? 'That lead is too large.' : 'Send a JSON object.' });
    }
    next(err);
  });
}

module.exports = { mount };
