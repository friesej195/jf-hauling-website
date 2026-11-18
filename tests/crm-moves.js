// Every quote can be moved from the top of the page, including one that is only Opened.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-moves-'));
process.env.DATA_DIR = dataDir;
process.env.OPENAI_API_KEY = '';
process.env.RESEND_API_KEY = '';
process.env.MS_CLIENT_ID = '';

const leads = require('../server/leads');
const store = require('../server/store');

let failed = 0;
function check(name, cond, detail) {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close((err) => (err ? reject(err) : resolve(port))); });
  });
}

(async () => {
  const made = leads.create({ source: 'website', name: 'Owen Open', email: 'owen@example.ca', phone: '519-555-0144', message: 'Need a shed moved' }, { defaultSource: 'website' });
  store.update('leads', made.lead.id, { createdAt: ago(90) });
  const opened = leads.markOpened(made.lead.id);
  check('an opened quote is not already replied or scheduled', leads.folderOf(opened) === 'opened' && leads.needsReply({ minutes: 30 }).leads.some((row) => row.id === opened.id));
  leads.rememberUndo(opened.id);
  leads.setReplyFolder(opened.id, 'replied');
  const replied = leads.find(opened.id);
  check('Mark replied stops the reminder', leads.folderOf(replied) === 'replied' && !leads.needsReply({ minutes: 0 }).leads.some((row) => row.id === opened.id));
  leads.undoMove(opened.id);
  check('undo puts an opened quote back', leads.folderOf(leads.find(opened.id)) === 'opened');
  leads.scheduleLead(opened.id, '2026-12-01');
  check('Mark scheduled stops the reminder', leads.folderOf(leads.find(opened.id)) === 'scheduled' && !leads.needsReply({ minutes: 0 }).leads.some((row) => row.id === opened.id));
  leads.addTimeline(opened.id, { kind: 'sms', direction: 'in', body: 'Is Friday still ok?', at: ago(20), externalId: 'sms-back' });
  const after = leads.find(opened.id);
  check('a reply on a scheduled quote is in the thread and New replies', leads.folderOf(after) === 'replies' && leads.threadItems(after).some((item) => item.body.includes('Friday still ok')));

  const port = await freePort();
  const httpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-moves-http-'));
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME || os.homedir(), TMPDIR: os.tmpdir(), NODE_ENV: 'test',
      PORT: String(port), DATA_DIR: httpDir, ADMIN_PASSWORD: 'isolated', CRM_PASSWORD: 'pw', CRM_API_TOKEN: 'tok',
      OPENAI_API_KEY: '', RESEND_API_KEY: '', MS_CLIENT_ID: '', ROUTING_ENABLED: 'false',
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(base + '/api/config')).ok) break; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 80));
  }
  const created = await (await fetch(base + '/api/leads', {
    method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Jane Tester', email: 'jane@example.ca', phone: '519-555-0100', original_message: 'Need a container' }),
  })).json();
  const login = await fetch(base + '/crm/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=pw' });
  const cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : []).map((line) => line.split(';')[0]).join('; ');
  const detail = await (await fetch(base + `/crm/lead/${created.lead.id}`, { headers: { Cookie: cookie } })).text();
  const list = await (await fetch(base + '/crm/?folder=opened', { headers: { Cookie: cookie } })).text();
  check('an opened quote shows Mark replied, Mark scheduled, and Close at the top', detail.includes('class="move-row"') && detail.includes('>Mark replied</button>') && detail.includes('>Mark scheduled</button>') && detail.includes('type="date"') && detail.includes('>Close</button>') && !detail.includes('>Reopen</button>'));
  check('the list menu has the same moves', list.includes('Actions for Jane Tester') && list.includes('>Mark replied</button>') && list.includes('>Mark scheduled</button>') && list.includes('>Close</button>'));
  child.kill('SIGTERM');
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
