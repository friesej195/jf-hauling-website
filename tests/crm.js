// Leads CRM: website quotes become leads, /crm is a private phone UI, POST /api/leads dedupes.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const PASS = 'crm-test-password';
const TOKEN = 'crm-test-token';
let failed = 0;

function check(name, cond, detail) {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function cleanEnv(extra = {}) {
  return { PATH: process.env.PATH, HOME: process.env.HOME || os.homedir(), TMPDIR: os.tmpdir(), NODE_ENV: 'test', ...extra };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function startServer(dir, extra = {}) {
  const port = await freePort();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-crm-log-'));
  const out = path.join(logDir, 'out.log');
  const err = path.join(logDir, 'err.log');
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: cleanEnv({
      PORT: String(port),
      DATA_DIR: dir,
      ADMIN_PASSWORD: 'isolated-test-only',
      CRM_PASSWORD: PASS,
      CRM_API_TOKEN: TOKEN,
      ROUTING_ENABLED: 'false',
      OPENAI_API_KEY: '',
      RESEND_API_KEY: '',
      SMTP_HOST: '',
      ...extra,
    }),
    stdio: ['ignore', fs.openSync(out, 'a'), fs.openSync(err, 'a')],
  });
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error(fs.readFileSync(err, 'utf8'));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/config`);
      if (res.ok) return { port, child, out, err };
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not listen');
}

function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 2000);
  });
}

async function post(port, url, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

async function submitQuote(port, answers) {
  let r = await post(port, '/api/chat/start');
  const sid = r.body.sessionId;
  for (const text of answers) {
    r = await post(port, '/api/chat', { sessionId: sid, text });
    if (r.status !== 200) return r;
  }
  return r;
}

function jarFrom(res, jar = new Map()) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of list) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (/max-age=0/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
  jar.lastCookie = list[0] || '';
  return jar;
}

function cookieHeader(jar) {
  return [...jar.entries()].filter(([k]) => k !== 'lastCookie').map(([k, v]) => `${k}=${v}`).join('; ');
}

async function login(port, { password = PASS, next = '/crm/', proto } = {}) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (proto) headers['X-Forwarded-Proto'] = proto;
  const res = await fetch(`http://127.0.0.1:${port}/crm/login`, {
    method: 'POST',
    redirect: 'manual',
    headers,
    body: new URLSearchParams({ password, next }),
  });
  const jar = jarFrom(res);
  return { status: res.status, location: res.headers.get('location'), jar, cookie: jar.lastCookie || '' };
}

async function authed(port, jar, url, { method = 'GET', form } = {}) {
  const headers = { Cookie: cookieHeader(jar) };
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form);
  }
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers, body, redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get('location'), headers: res.headers };
}

function csrfOf(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  return m ? m[1] : '';
}

function todayToronto() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-crm-'));
  const server = await startServer(dataDir);
  const base = `http://127.0.0.1:${server.port}`;
  const logs = () => fs.readFileSync(server.out, 'utf8') + fs.readFileSync(server.err, 'utf8');

  const home = await (await fetch(base + '/')).text();
  const quotePage = await (await fetch(base + '/quote')).text();
  check('public home and quote pages do not link to the CRM', !home.includes('/crm') && !quotePage.includes('/crm') && !home.includes('CRM_PASSWORD'));

  const robots = await fetch(base + '/robots.txt');
  const robotsTxt = await robots.text();
  check('robots.txt disallows the CRM and the lead API', robots.status === 200 && robotsTxt.includes('Disallow: /crm') && robotsTxt.includes('Disallow: /api/leads') && !/sitemap/i.test(robotsTxt));
  const sitemap = await fetch(base + '/sitemap.xml');
  const sitemapTxt = await sitemap.text();
  check('there is no sitemap entry for /crm', !/\/crm\b/.test(sitemapTxt));

  const manifestRes = await fetch(base + '/crm/manifest.webmanifest');
  const manifest = await manifestRes.json();
  check('manifest is a private installable app', manifestRes.status === 200 && (manifestRes.headers.get('content-type') || '').includes('application/manifest+json') && manifest.display === 'standalone' && manifest.start_url === '/crm/' && manifest.scope === '/crm/' && manifest.theme_color === '#2A2D32' && manifest.icons.some((i) => i.sizes === '192x192') && manifest.icons.some((i) => i.sizes === '512x512'));
  const sw = await (await fetch(base + '/crm/sw.js')).text();
  check('service worker does not cache lead pages', sw.includes("addEventListener('fetch'") && !/caches\.|CRM_PASSWORD|crm-test/.test(sw));
  const icon = await fetch(base + '/crm/icon-192.png');
  check('home-screen icon is served from the CRM', icon.status === 200 && (icon.headers.get('content-type') || '').includes('image/png') && (icon.headers.get('x-robots-tag') || '').includes('noindex'));

  const jane = await submitQuote(server.port, ['Listowel, ON', 'Stratford, ON', 'container40', '18000 lbs', 'Flexible', 'Tailgate needed', '120 km', 'intent:request', 'Jane Tester', '5195550100', 'jane@example.ca']);
  const bob = await submitQuote(server.port, ['Listowel', 'Kitchener, ON', 'general', '30 ft', '25000 lbs', 'limit:continue', 'ASAP', 'none', '80 km', 'intent:request', 'Bob Heavy', '2265550199', 'bob@example.ca']);
  const pat = await submitQuote(server.port, ['Listowel, ON', 'Guelph, ON', 'shed', '12', '16', 'no', 'Flexible', 'none', '90 km', 'intent:request', 'Pat Shed', '5195550166', 'pat.shed@example.ca']);
  check('quote requests still complete', jane.body.done === true && bob.body.done === true && pat.body.done === true, [jane.body && jane.body.step, bob.body && bob.body.step, pat.body && pat.body.step].join(','));

  const quotes = JSON.parse(fs.readFileSync(path.join(dataDir, 'quotes.json'), 'utf8'));
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'leads.json'), 'utf8'));
  const janeLead = stored.find((l) => l.quoteId === jane.body.reference);
  const bobLead = stored.find((l) => l.quoteId === bob.body.reference);
  const patLead = stored.find((l) => l.quoteId === pat.body.reference);
  check('quotes.json is unchanged in role and leads.json is on the data dir', quotes.length === 3 && stored.length === 3 && quotes.some((q) => q.id === jane.body.reference && q.customer.email === 'jane@example.ca'));
  check('website quote becomes a New website lead with the price and load', janeLead && janeLead.source === 'website' && janeLead.status === 'New' && janeLead.name === 'Jane Tester' && janeLead.phone === '519-555-0100' && janeLead.email === 'jane@example.ca' && janeLead.pickup === 'Listowel, ON' && janeLead.dropoff === 'Stratford, ON' && janeLead.loadType === '40 ft container' && /\$\d/.test(janeLead.quotedPrice) && janeLead.quotedPrice.includes('CAD') && janeLead.message.includes('Tailgate needed') && janeLead.externalId === `quote:${jane.body.reference}`);
  check('over-limit quote is a lead with no online price', bobLead && bobLead.quotedPrice === '' && /No online price/.test(bobLead.message) && bobLead.status === 'New');
  check('shed quote keeps the shed size', patLead && patLead.shedSize === "12' x 16'" && patLead.loadType === 'Sheds & portable buildings' && /Shed mule: no/.test(patLead.message));
  check('lead save is logged without the customer email', logs().includes(`[leads] created id=${janeLead && janeLead.id} source=website quote=${jane.body.reference}`) && !logs().includes('jane@example.ca') && !logs().includes(PASS) && !logs().includes(TOKEN));

  const dup = await post(server.port, '/api/leads', { external_id: `quote:${jane.body.reference}`, name: 'Someone Else', email: 'other@example.ca' }, { Authorization: `Bearer ${TOKEN}` });
  const afterDup = JSON.parse(fs.readFileSync(path.join(dataDir, 'leads.json'), 'utf8'));
  check('website external id dedupes a repeated post', dup.status === 200 && dup.body.duplicate === true && dup.body.lead.id === janeLead.id && dup.body.lead.name === 'Jane Tester' && afterDup.length === 3);

  const open = await fetch(base + '/crm/');
  const openHtml = await open.text();
  check('signed-out CRM is the login page and hides leads', open.status === 200 && openHtml.includes('noindex') && (open.headers.get('x-robots-tag') || '').includes('noindex') && openHtml.includes('type="password"') && !openHtml.includes('Jane Tester') && !openHtml.includes(PASS));
  const dueOpen = await fetch(base + '/crm/due');
  check('follow-ups require sign-in', dueOpen.status === 401 && !(await dueOpen.text()).includes('Jane Tester'));

  const bad = await login(server.port, { password: 'nope' });
  check('wrong password is rejected', bad.status === 401 && !bad.cookie.includes('HttpOnly') && bad.location == null);

  const evil = await login(server.port, { next: 'https://evil.example/phish' });
  check('sign-in does not redirect off the site', evil.status === 303 && evil.location === '/crm/');
  const dotdot = await login(server.port, { next: '/crm/%2e%2e/admin' });
  check('sign-in ignores a path that leaves /crm', dotdot.location === '/crm/');

  const secure = await login(server.port, { proto: 'https', next: '/crm/due' });
  check('HTTPS sign-in sets an HttpOnly Secure cookie and returns to the CRM', secure.status === 303 && secure.location === '/crm/due' && /HttpOnly/i.test(secure.cookie) && /Secure/i.test(secure.cookie) && /SameSite=Lax/i.test(secure.cookie) && /Path=\/crm/i.test(secure.cookie) && !secure.cookie.includes(PASS));

  const session = await login(server.port, {});
  const list = await authed(server.port, session.jar, '/crm/');
  check('signed-in list shows website leads and the install manifest', list.status === 200 && list.text.includes('Jane Tester') && list.text.includes('Pat Shed') && list.text.includes('rel="manifest"') && list.text.includes('noindex') && list.text.includes('href="tel:+15195550100"') && !list.text.includes(PASS));
  const filtered = await authed(server.port, session.jar, '/crm/?status=New&source=website&q=stratford');
  check('status, source, and search filters narrow the list', filtered.text.includes('Jane Tester') && !filtered.text.includes('Pat Shed'));
  const none = await authed(server.port, session.jar, '/crm/?status=Lost');
  check('a status with no leads says nothing matches', none.text.includes('No leads match.') && !none.text.includes('Jane Tester'));

  const detail = await authed(server.port, session.jar, `/crm/lead/${janeLead.id}`);
  const csrf = csrfOf(detail.text);
  check('detail page has call, email, status, notes, and the quote', detail.status === 200 && detail.text.includes('href="tel:+15195550100"') && detail.text.includes('href="mailto:jane%40example.ca"') && detail.text.includes('Tailgate needed') && detail.text.includes(jane.body.reference) && csrf.length > 16);

  const today = todayToronto();
  const saved = await authed(server.port, session.jar, `/crm/lead/${janeLead.id}`, {
    method: 'POST',
    form: {
      _csrf: csrf,
      status: 'Contacted',
      followUpDate: today,
      note: 'Left a voicemail',
      name: 'Jane Tester',
      phone: '519-555-0100',
      email: 'jane@example.ca',
      source: 'website',
      pickup: 'Listowel, ON',
      dropoff: 'Stratford, ON',
      loadType: '40 ft container',
      shedSize: '',
      quotedPrice: janeLead.quotedPrice,
    },
  });
  check('saving a lead redirects back to it', saved.status === 303 && saved.location === `/crm/lead/${janeLead.id}?saved=1`);
  const after = await authed(server.port, session.jar, saved.location);
  check('detail shows the new status, follow-up, and timestamped note', after.text.includes('Saved.') && after.text.includes('Left a voicemail') && after.text.includes('Status changed from New to Contacted') && after.text.includes(`Follow-up set to ${today}`));
  const due = await authed(server.port, session.jar, '/crm/due');
  check('follow-ups due lists the contacted lead', due.status === 200 && due.text.includes('Jane Tester') && due.text.includes('Due today') && !due.text.includes('Pat Shed'));

  const booked = await authed(server.port, session.jar, `/crm/lead/${janeLead.id}`, {
    method: 'POST',
    form: {
      _csrf: csrfOf(after.text),
      status: 'Booked',
      followUpDate: today,
      note: '',
      name: 'Jane Tester',
      phone: '519-555-0100',
      email: 'jane@example.ca',
      source: 'website',
      pickup: 'Listowel, ON',
      dropoff: 'Stratford, ON',
      loadType: '40 ft container',
      shedSize: '',
      quotedPrice: janeLead.quotedPrice,
    },
  });
  const dueAfter = await authed(server.port, session.jar, '/crm/due');
  check('booked leads drop off follow-ups due', booked.status === 303 && !dueAfter.text.includes('Jane Tester'));

  const fresh = await authed(server.port, session.jar, '/crm/new');
  const created = await authed(server.port, session.jar, '/crm/new', {
    method: 'POST',
    form: {
      _csrf: csrfOf(fresh.text),
      name: 'Call-in Chris',
      phone: '226-545-1745',
      email: '',
      source: 'phone',
      pickup: 'Fordwich',
      dropoff: 'London, ON',
      loadType: 'Flat-deck',
      shedSize: '',
      quotedPrice: '$450',
      followUpDate: '',
      message: 'Called about a flat deck tomorrow.',
      note: 'Will confirm in the morning',
    },
  });
  const phoneLead = JSON.parse(fs.readFileSync(path.join(dataDir, 'leads.json'), 'utf8')).find((l) => l.name === 'Call-in Chris');
  check('a hand-entered call is saved as a phone lead', created.status === 303 && phoneLead && phoneLead.source === 'phone' && phoneLead.loadType === 'Flat-deck' && phoneLead.quotedPrice === '$450' && phoneLead.notes.some((n) => n.text === 'Will confirm in the morning' && n.at));

  const noCsrf = await authed(server.port, session.jar, `/crm/lead/${phoneLead.id}`, {
    method: 'POST',
    form: { status: 'Lost', name: 'Call-in Chris', phone: '226-545-1745', source: 'phone', message: 'x' },
  });
  check('a lead update without the form token is refused', noCsrf.status === 403 && JSON.parse(fs.readFileSync(path.join(dataDir, 'leads.json'), 'utf8')).find((l) => l.id === phoneLead.id).status === 'New');

  const csv = await authed(server.port, session.jar, '/crm/export.csv');
  check('CSV download includes the leads', csv.status === 200 && (csv.headers.get('content-type') || '').includes('text/csv') && csv.text.includes('Jane Tester') && csv.text.includes('Call-in Chris') && csv.text.includes('Flat-deck') && csv.text.includes('Left a voicemail'));
  const csvLocked = await fetch(base + '/crm/export.csv');
  check('CSV stays behind the password', csvLocked.status === 401);

  const missingAuth = await post(server.port, '/api/leads', { name: 'Nope' });
  const wrongAuth = await post(server.port, '/api/leads', { name: 'Nope' }, { Authorization: 'Bearer wrong-token' });
  check('the lead API rejects a missing or wrong token', missingAuth.status === 401 && wrongAuth.status === 401 && !JSON.stringify(wrongAuth.body).includes(TOKEN));

  const emailLead = await post(server.port, '/api/leads', {
    external_id: '<msg-100@mail.test>',
    name: 'Email Erin',
    email: 'erin@example.ca',
    phone: '519-555-0142',
    pickup_location: 'Palmerston',
    dropoff_location: 'Owen Sound',
    load_type: 'Container',
    shed_size: '',
    quoted_price: '',
    original_message: 'Can you move a container Friday?',
    follow_up_date: today,
    note: 'From the inbox',
  }, { Authorization: `Bearer ${TOKEN}` });
  const again = await post(server.port, '/api/leads', {
    external_id: '<msg-100@mail.test>',
    name: 'Different Name',
    email: 'erin@example.ca',
    original_message: 'second copy',
  }, { Authorization: `Bearer ${TOKEN}` });
  const third = await post(server.port, '/api/leads', {
    name: 'No External',
    email: 'one@example.ca',
    original_message: 'first',
  }, { Authorization: `Bearer ${TOKEN}` });
  const fourth = await post(server.port, '/api/leads', {
    name: 'No External 2',
    email: 'two@example.ca',
    original_message: 'second',
  }, { Authorization: `Bearer ${TOKEN}` });
  check('email API creates a lead and dedupes on external_id', emailLead.status === 201 && emailLead.body.duplicate === false && emailLead.body.lead.source === 'email' && emailLead.body.lead.pickup_location === 'Palmerston' && emailLead.body.lead.original_message.includes('Friday') && emailLead.body.lead.follow_up_date === today && again.status === 200 && again.body.duplicate === true && again.body.lead.id === emailLead.body.lead.id && again.body.lead.name === 'Email Erin');
  check('posts without an external id are kept separately', third.status === 201 && fourth.status === 201 && third.body.lead.id !== fourth.body.lead.id);
  const badStatus = await post(server.port, '/api/leads', { name: 'Bad', status: 'closed', external_id: 'msg-bad' }, { Authorization: `Bearer ${TOKEN}` });
  check('an unknown status is rejected', badStatus.status === 400 && !JSON.parse(fs.readFileSync(path.join(dataDir, 'leads.json'), 'utf8')).some((l) => l.externalId === 'msg-bad'));
  check('API log lines omit the message id and the token', logs().includes(`[leads] created id=${emailLead.body.lead.id} source=email`) && !logs().includes('<msg-100@mail.test>') && !logs().includes(TOKEN));

  await stop(server.child);

  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-crm-off-'));
  const bare = await startServer(bareDir, { CRM_PASSWORD: '', CRM_API_TOKEN: '' });
  const off = await fetch(`http://127.0.0.1:${bare.port}/crm/`);
  const offHtml = await off.text();
  const offApi = await post(bare.port, '/api/leads', { name: 'X', email: 'x@example.ca' }, { Authorization: 'Bearer anything' });
  check('blank CRM secrets keep sign-in and the API switched off', off.status === 503 && offHtml.includes('CRM_PASSWORD') && offHtml.includes('noindex') && offApi.status === 503 && !fs.existsSync(path.join(bareDir, 'leads.json')));
  await stop(bare.child);

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS', e && e.stack ? e.stack : e);
  process.exit(1);
});
