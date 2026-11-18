// Move to Closed is on the lead and on each list row, and Undo puts the lead back.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const PASS = 'crm-test-password';
let failed = 0;
function check(name, cond, detail) {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close((err) => (err ? reject(err) : resolve(port))); });
  });
}
function cookieHeader(jar) {
  return [...jar.entries()].filter(([k]) => k !== 'lastCookie').map(([k, v]) => `${k}=${v}`).join('; ');
}
function jarFrom(res, jar = new Map()) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of list) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    if (/max-age=0/i.test(line)) jar.delete(pair.slice(0, i).trim());
    else jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return jar;
}
async function authed(port, jar, url, { method = 'GET', form } = {}) {
  const headers = { Cookie: cookieHeader(jar) };
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form);
  }
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers, body, redirect: 'manual' });
  return { status: res.status, text: await res.text(), location: res.headers.get('location') };
}
function csrfOf(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  return m ? m[1] : '';
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-close-ui-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME || os.homedir(), TMPDIR: os.tmpdir(), NODE_ENV: 'test',
      PORT: String(port), DATA_DIR: dataDir, ADMIN_PASSWORD: 'isolated', CRM_PASSWORD: PASS, CRM_API_TOKEN: 'tok',
      OPENAI_API_KEY: '', RESEND_API_KEY: '', MS_CLIENT_ID: '', ROUTING_ENABLED: 'false',
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(base + '/api/config')).ok) break; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 80));
  }
  const made = await (await fetch(base + '/api/leads', {
    method: 'POST',
    headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Jane Tester', email: 'jane@example.ca', phone: '519-555-0100', original_message: 'Need a container', pickup_location: 'Listowel, ON', dropoff_location: 'Barrie, ON', load_type: '20 ft container' }),
  })).json();
  const id = made.lead.id;
  const login = await fetch(base + '/crm/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: PASS }) });
  const jar = jarFrom(login);
  const list = await authed(port, jar, '/crm/?folder=new');
  const detail = await authed(port, jar, `/crm/lead/${id}`);
  const sw = await (await fetch(base + '/crm/sw.js')).text();
  check('the list has a swipe Close and a menu fallback', list.text.includes('class="swipe"') && list.text.includes('>Close</button>') && list.text.includes(`Actions for Jane Tester`) && list.text.includes('setAppBadge'));
  check('the lead shows Move to Closed and the reason sheet', detail.text.includes('Move to Closed') && detail.text.includes('id="close-sheet"') && detail.text.includes('Not interested') && detail.text.includes('Went with someone else') && detail.text.includes('Too expensive') && detail.text.includes('Duplicate/spam') && detail.text.includes('value="Other"') && detail.text.includes('>Confirm</button>') && !detail.text.includes('placeholder="Not interested"'));
  check('the service worker sets the icon badge from the push count', sw.includes('setAppBadge') && sw.includes('clearAppBadge') && sw.includes('data.badge'));
  const closed = await authed(port, jar, `/crm/lead/${id}/close`, { method: 'POST', form: { _csrf: csrfOf(detail.text), chip: 'Too expensive' } });
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'leads.json'), 'utf8')).find((row) => row.id === id);
  const after = await authed(port, jar, closed.location);
  check('confirming a reason closes as the owner and offers Undo', closed.status === 303 && /undo=/.test(closed.location || '') && saved.status === 'Closed' && saved.closedBy === 'owner' && saved.closedReason === 'Too expensive' && saved.statusBeforeClose === 'New' && after.text.includes('Moved to Closed') && after.text.includes('>Undo</button>') && after.text.includes('},5000)') && after.text.includes('>Reopen</button>') && !after.text.includes('Move to Closed'));
  const undone = await authed(port, jar, `/crm/lead/${id}/undo-close`, { method: 'POST', form: { _csrf: csrfOf(after.text), next: `/crm/?folder=opened` } });
  const restored = JSON.parse(fs.readFileSync(path.join(dataDir, 'leads.json'), 'utf8')).find((row) => row.id === id);
  const listAgain = await authed(port, jar, '/crm/?folder=opened');
  check('undo restores the previous status and the list action', undone.status === 303 && restored.status === 'New' && restored.closedBy === '' && listAgain.text.includes('Move to Closed') === false && listAgain.text.includes('class="swipe"') && listAgain.text.includes('Jane Tester'));
  child.kill('SIGTERM');
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
