// Folders, reply channel, customer-address guard, needs-reply, and Web Push.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const dataDir = path.join(os.tmpdir(), `jf-inbox-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.DATA_DIR = dataDir;
process.env.RESEND_API_KEY = 're_test_not_real';
process.env.MAIL_FROM = 'Bad Name <friesenj195-9bzrhn@mail.grokbot.com>';
process.env.EMAIL = 'friesenj195-9bzrhn@mail.grokbot.com';
process.env.CRM_EMAIL_BCC = 'also-friesenj195@mail.grokbot.com';
process.env.NOTIFY_TO = 'jfhauling@outlook.com';
process.env.MS_CLIENT_ID = '';
process.env.OPENAI_API_KEY = '';

const leads = require('../server/leads');
const mailer = require('../server/mailer');
const push = require('../server/push');

let failed = 0;
function check(name, cond, detail) {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const both = { email: 'a@example.ca', phone: '519-555-0100' };
  check('email is the default reply when both contacts exist', leads.replyChannel(both).channel === 'email' && leads.replyChannel(both, 'sms').channel === 'sms');
  check('text is the default when there is no email', leads.replyChannel({ phone: '519-555-0100' }).channel === 'sms');
  check('a missing phone cannot be selected', leads.replyChannel({ email: 'a@example.ca' }, 'sms').channel === 'email' && leads.replyChannel({ email: 'a@example.ca' }).canText === false);
  check('a lead with neither contact has no reply channel', leads.replyChannel({}).channel === '');

  const fresh = leads.create({ source: 'website', name: 'Jane Tester', email: 'jane@example.ca', phone: '519-555-0100', pickup: 'Listowel', dropoff: 'Barrie', loadType: '20 ft container', message: 'Tailgate needed' }, { defaultSource: 'website' });
  check('a new lead with no visit and no reply is in New', leads.folderOf(fresh.lead) === 'new');
  const opened = leads.markOpened(fresh.lead.id);
  check('opening a lead moves it to Opened once', leads.folderOf(opened) === 'opened' && leads.markOpened(fresh.lead.id).openedAt === opened.openedAt);
  leads.addTimeline(fresh.lead.id, { kind: 'email', direction: 'out', subject: 'Re: quote', body: 'We can help.', at: new Date(Date.now() + 1000).toISOString() });
  check('an outbound email moves the lead to Replied', leads.folderOf(leads.find(fresh.lead.id)) === 'replied');

  const old = { id: 'old', createdAt: '2020-01-01T00:00:00.000Z', status: 'New', timeline: [{ kind: 'sms', direction: 'out', at: '2020-01-02T00:00:00.000Z', body: 'Sent' }], openedAt: '' };
  check('an existing outbound message counts as Replied without a stored folder', leads.folderOf(old) === 'replied');
  check('an existing unopened lead with no reply stays New', leads.folderOf({ createdAt: '2020-01-01T00:00:00.000Z', status: 'New', timeline: [], openedAt: '' }) === 'new');

  const calls = [];
  const sent = await mailer.sendCustomer({
    to: 'jane@example.ca',
    subject: 'Hello from grokbot',
    text: 'Please write friesenj195-9bzrhn@mail.grokbot.com today.',
    messageId: '<crm.test@jfhauling.ca>',
    fetchImpl: async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      return new Response('{}', { status: 200 });
    },
  });
  const payload = JSON.stringify(calls[0] || {});
  check('customer mail refuses a grokbot From, Reply-To, and BCC', sent.ok && calls[0].from === 'JF Hauling <quotes@jfhauling.ca>' && calls[0].reply_to === 'jfhauling@outlook.com' && calls[0].bcc[0] === 'jfhauling@outlook.com' && !/grokbot|friesenj195/i.test(payload));

  const waitingLead = leads.create({ source: 'phone', name: 'Wait Ing', email: 'wait@example.ca', phone: '226-555-0101', message: 'Need a flat deck' }, { defaultSource: 'phone' });
  const oldAt = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  leads.addTimeline(waitingLead.lead.id, { kind: 'sms', direction: 'in', body: 'Still waiting on the flat deck quote for tomorrow morning please', at: oldAt, externalId: 'sms-wait-1' });
  const lost = leads.create({ source: 'email', name: 'Gone', email: 'gone@example.ca', message: 'old', status: 'Lost' }, { defaultSource: 'email' });
  const store = require('../server/store');
  const twoHours = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  store.update('leads', waitingLead.lead.id, { createdAt: twoHours });
  store.update('leads', lost.lead.id, { createdAt: twoHours });
  const recent = leads.needsReply({ minutes: 30, now: new Date() });
  const included = recent.leads.find((row) => row.id === waitingLead.lead.id);
  check('needs-reply lists a customer text older than 30 minutes', included && included.waitingMinutes >= 30 && included.lastInboundChannel === 'sms' && included.lastInboundPreview.length <= 140 && included.crmUrl === `https://jfhauling.ca/crm/lead/${encodeURIComponent(waitingLead.lead.id)}` && !recent.leads.some((row) => row.id === lost.lead.id));
  const since = leads.needsReply({ since: new Date(Date.now() - 10 * 60 * 1000).toISOString(), now: new Date() });
  check('since ignores the minute cutoff and keeps only newer waits', !since.leads.some((row) => row.id === waitingLead.lead.id));
  leads.addTimeline(waitingLead.lead.id, { kind: 'sms', direction: 'out', body: 'On my way to confirm.', at: new Date().toISOString() });
  check('a later outbound text drops the lead from needs-reply', !leads.needsReply({ minutes: 0 }).leads.some((row) => row.id === waitingLead.lead.id));

  const sub = { endpoint: 'https://push.example/device-1', keys: { p256dh: 'key', auth: 'auth' } };
  push.save(sub);
  push.save({ endpoint: 'https://push.example/device-2', keys: { p256dh: 'key2', auth: 'auth2' } });
  push.save(sub);
  check('subscriptions are stored per device and updated in place', push.list().length === 2 && push.list().filter((row) => row.endpoint === sub.endpoint).length === 1);
  let pushed = 0;
  push.setSender(async () => { pushed += 1; const err = new Error('gone'); err.statusCode = 410; throw err; });
  await push.deliver(sub, { title: 'JF Hauling', body: 'Test', url: '/crm/' });
  check('a 410 from the push service removes that device', pushed === 1 && !push.list().some((row) => row.endpoint === sub.endpoint));
  const quotePushes = [];
  push.setSender(async (row, payload) => { quotePushes.push(payload); });
  const quote = { id: 'L-1', source: 'website', name: 'Jane Tester', loadType: '20 ft container', pickup: 'Listowel, ON', dropoff: 'Barrie, ON' };
  await push.notifyNewLead(quote);
  check('a new quote push names the person, load, and route', quotePushes.some((payload) => payload.body === 'New quote: Jane T. - 20 ft container, Listowel to Barrie'));

  const port = await freePort();
  const httpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-inbox-http-'));
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME || os.homedir(), TMPDIR: os.tmpdir(), NODE_ENV: 'test',
      PORT: String(port), DATA_DIR: httpDir, CRM_PASSWORD: 'crm-test-password', CRM_API_TOKEN: 'crm-test-token',
      ADMIN_PASSWORD: 'isolated', RESEND_API_KEY: '', OPENAI_API_KEY: '', MS_CLIENT_ID: '', ROUTING_ENABLED: 'false',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/config`)).ok) break; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 80));
  }
  const base = `http://127.0.0.1:${port}`;
  const no = await fetch(base + '/api/leads/needs-reply');
  const denied = await fetch(base + '/api/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await fetch(base + '/api/leads', { method: 'POST', headers: { Authorization: 'Bearer crm-test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Now Person', email: 'now@example.ca', original_message: 'Call me' }) });
  const young = await (await fetch(base + '/api/leads/needs-reply?minutes=30', { headers: { Authorization: 'Bearer crm-test-token' } })).json();
  const immediate = await (await fetch(base + '/api/leads/needs-reply?minutes=0', { headers: { Authorization: 'Bearer crm-test-token' } })).json();
  const ping = await fetch(base + '/api/notify', { method: 'POST', headers: { Authorization: 'Bearer crm-test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Digest', body: '2 quotes are waiting' }) });
  const pingBody = await ping.json();
  check('needs-reply and notify require the bearer token and honour the age window', no.status === 401 && denied.status === 401 && young.leads.length === 0 && immediate.leads.some((row) => row.email === 'now@example.ca' && row.folder === 'new' && row.lastInboundChannel === 'lead') && ping.status === 200 && pingBody.ok === true);
  child.kill('SIGTERM');

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('HARNESS', err && err.stack ? err.stack : err);
  process.exit(1);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
