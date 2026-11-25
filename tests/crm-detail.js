// The quote page is one scroll: details, Actions, the thread, and a pinned reply box.
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
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-detail-'));
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
  const message = 'Need a 20 ft container moved from Listowel to Barrie next week. Tailgate needed, and please call before you arrive.';
  const made = await (await fetch(base + '/api/leads', {
    method: 'POST',
    headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Jane Tester', email: 'jane@example.ca', phone: '519-555-0100',
      original_message: message, pickup_location: 'Listowel, ON', dropoff_location: 'Barrie, ON',
      load_type: '20 ft container', quoted_price: '$850 CAD',
    }),
  })).json();
  const id = made.lead.id;
  const login = await fetch(base + '/crm/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: PASS }) });
  const jar = jarFrom(login);
  const detail = await authed(port, jar, `/crm/lead/${id}`);
  const threadAt = detail.text.indexOf('id="thread"');
  const messageAt = detail.text.indexOf(message);
  check('the quote is one panel with the full message, contacts, and Actions', detail.status === 200 && detail.text.includes('class="panel lead-sheet"') && detail.text.includes('>Actions</a>') && detail.text.includes('href="tel:+15195550100"') && detail.text.includes('>519-555-0100</a>') && detail.text.includes('href="mailto:jane%40example.ca"') && detail.text.includes('20 ft container') && detail.text.includes('Listowel, ON') && detail.text.includes('Barrie, ON') && detail.text.includes('$850 CAD') && messageAt !== -1 && messageAt < threadAt);
  check('changes live in the Actions sheet and close asks you to confirm', detail.text.includes('id="actions"') && detail.text.includes('>Mark replied</button>') && detail.text.includes('>Mark scheduled</button>') && detail.text.includes('Quote amount') && detail.text.includes('name="status"') && detail.text.includes('Move to Closed') && detail.text.includes('id="close-sheet"') && detail.text.includes('>Confirm</button>') && detail.text.includes("confirm('Mark this quote '") && !detail.text.includes('class="move-row"') && !detail.text.includes('>Call</a>'));
  check('the thread is not its own scroll area and the reply box has both sends', !detail.text.includes('overflow-y:auto') && detail.text.includes('class="composer"') && detail.text.includes('>Send Email</button>') && detail.text.includes('>Send Text</button>') && detail.text.includes('opens the Messages app'));
  const list = await authed(port, jar, '/crm/?folder=opened');
  check('the lead list still has its own menu', list.text.includes('Actions for Jane Tester') && list.text.includes('class="swipe"'));
  const texted = await authed(port, jar, `/crm/lead/${id}/reply`, { method: 'POST', form: { _csrf: csrfOf(detail.text), channel: 'sms', body: 'On my way', subject: 'JF Hauling' } });
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'leads.json'), 'utf8')).find((row) => row.id === id);
  const sms = (saved.timeline || []).find((item) => item.kind === 'sms' && item.direction === 'out');
  check('Send Text without Twilio opens Messages and logs the text', texted.status === 200 && texted.text.includes('sms:+15195550100') && texted.text.includes('Open Messages') && sms && sms.body.includes('On my way') && saved.status !== 'Booked');
  child.kill('SIGTERM');
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
