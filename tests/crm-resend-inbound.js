// Resend inbound: Svix signature, plus-tag matching, and dedupe with a later Outlook sync.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const key = crypto.randomBytes(24);
const secret = `whsec_${key.toString('base64')}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-resend-'));
process.env.DATA_DIR = dataDir;
process.env.RESEND_INBOUND_WEBHOOK_SECRET = secret;
process.env.RESEND_API_KEY = 're_test_not_real';
process.env.CRM_REPLY_TO_INBOUND = 'quotes@reply.jfhauling.ca';
process.env.OPENAI_API_KEY = '';
process.env.MS_CLIENT_ID = 'test-client-id';
process.env.MS_CLIENT_SECRET = 'test-client-secret';
process.env.MS_REDIRECT_URI = 'https://jfhauling.ca/crm/oauth/callback';
process.env.AI_AUTOREPLY_ENABLED = 'false';

const leads = require('../server/leads');
const inboundHook = require('../server/resend-inbound');
const outlook = require('../server/outlook');
const mailer = require('../server/mailer');

let failed = 0;
function check(name, cond, detail) {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
function sign(id, ts, body) {
  return `v1,${crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
}
function eventFor({ emailId, from, to, messageId, subject }) {
  return JSON.stringify({
    type: 'email.received',
    created_at: '2026-11-18T12:00:00.000Z',
    data: { email_id: emailId, created_at: '2026-11-18T12:00:00.000Z', from, to, cc: [], bcc: [], message_id: messageId, subject },
  });
}
function receivedEmail({ from, to, messageId, subject, text }) {
  return {
    from, to, subject, text, html: null, message_id: messageId, created_at: '2026-11-18T12:00:00.000Z',
    headers: { from: `Jane Tester <${from}>` },
  };
}

(async () => {
  const now = Date.now();
  const raw = '{"type":"email.received"}';
  const id = 'msg_test_1';
  const ts = String(Math.floor(now / 1000));
  check('a valid Svix signature is accepted', inboundHook.verifySignature({ secret, rawBody: raw, id, timestamp: ts, signature: sign(id, ts, raw), now }).ok);
  check('a wrong signature is rejected', !inboundHook.verifySignature({ secret, rawBody: raw, id, timestamp: ts, signature: 'v1,bm90LXRoZS1zaWduYXR1cmU=', now }).ok);
  check('a missing secret is rejected', inboundHook.verifySignature({ secret: '', rawBody: raw, id, timestamp: ts, signature: sign(id, ts, raw), now }).reason === 'unset');
  check('a stale timestamp is rejected', !inboundHook.verifySignature({ secret, rawBody: raw, id, timestamp: String(Math.floor(now / 1000) - 3600), signature: sign(id, String(Math.floor(now / 1000) - 3600), raw), now }).ok);

  const jane = leads.create({ source: 'email', name: 'Jane Tester', email: 'jane@example.ca', message: 'Need a container' }, { defaultSource: 'email' });
  const replies = mailer.customerReplyList(jane.lead);
  check('customer mail replies to the lead tag and to Outlook', Array.isArray(replies) && replies[0] === `JF Hauling <quotes+${jane.lead.id}@reply.jfhauling.ca>` && replies[1] === 'jfhauling@outlook.com');

  const messageId = '<cust-reply-1@mail.test>';
  const payload = eventFor({
    emailId: 'email_resend_1',
    from: 'other.person@example.ca',
    to: [`quotes+${jane.lead.id.toLowerCase()}@reply.jfhauling.ca`],
    messageId,
    subject: 'Re: container',
  });
  const ts2 = String(Math.floor(Date.now() / 1000));
  const filed = await inboundHook.handle({
    rawBody: payload,
    headers: { 'svix-id': 'msg_file', 'svix-timestamp': ts2, 'svix-signature': sign('msg_file', ts2, payload) },
    body: JSON.parse(payload),
  }, {
    fetchImpl: async (url) => {
      if (String(url).includes('/emails/receiving/')) return new Response(JSON.stringify(receivedEmail({ from: 'other.person@example.ca', to: [`quotes+${jane.lead.id}@reply.jfhauling.ca`], messageId, subject: 'Re: container', text: 'We still want Thursday.' })), { status: 200 });
      return new Response('{}', { status: 404 });
    },
  });
  const after = leads.find(jane.lead.id);
  const inboundItems = (after.timeline || []).filter((item) => item.direction === 'in');
  check('a plus-tag files the reply on that lead', filed.status === 200 && filed.body.created === false && filed.body.lead_id === jane.lead.id && inboundItems.length === 1 && inboundItems[0].body.includes('Thursday') && !leads.all().some((row) => row.email === 'other.person@example.ca'));

  const again = await inboundHook.handle({
    rawBody: payload,
    headers: { 'svix-id': 'msg_file', 'svix-timestamp': ts2, 'svix-signature': sign('msg_file', ts2, payload) },
    body: JSON.parse(payload),
  }, { fetchImpl: async () => new Response(JSON.stringify(receivedEmail({ from: 'other.person@example.ca', to: [], messageId, subject: 'Re: container', text: 'duplicate' })), { status: 200 }) });
  check('the same Resend email is a duplicate', again.body.duplicate === true && (leads.find(jane.lead.id).timeline || []).filter((item) => item.direction === 'in').length === 1);

  outlook.saveTokens({ refreshToken: 'refresh-test', accessToken: 'access-test', expiresAt: Date.now() + 3600 * 1000, account: 'jfhauling@outlook.com' });
  const pulled = await outlook.pullInbox(async (url) => {
    if (String(url).includes('/messages')) {
      return new Response(JSON.stringify({ value: [{
        id: 'AAMkOUTLOOK1',
        subject: 'Re: container',
        from: { emailAddress: { address: 'jane@example.ca', name: 'Jane Tester' } },
        bodyPreview: 'We still want Thursday.',
        receivedDateTime: '2026-11-18T12:00:00.000Z',
        isDraft: false,
        internetMessageId: messageId,
      }] }), { status: 200 });
    }
    return new Response('{}', { status: 500 });
  });
  check('a later Outlook sync of the same message does not file it again', pulled.ok === true && pulled.logged === 0 && (leads.find(jane.lead.id).timeline || []).filter((item) => item.direction === 'in').length === 1);

  const port = await freePort();
  const httpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-resend-http-'));
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME || os.homedir(), TMPDIR: os.tmpdir(), NODE_ENV: 'test',
      PORT: String(port), DATA_DIR: httpDir, ADMIN_PASSWORD: 'isolated', CRM_PASSWORD: 'pw', CRM_API_TOKEN: 'tok',
      RESEND_API_KEY: 're_test_not_real', RESEND_INBOUND_WEBHOOK_SECRET: secret, CRM_REPLY_TO_INBOUND: 'quotes@reply.jfhauling.ca',
      OPENAI_API_KEY: '', MS_CLIENT_ID: '', ROUTING_ENABLED: 'false',
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(base + '/api/config')).ok) break; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 80));
  }
  const body = eventFor({ emailId: 'email_http_1', from: 'pat@example.ca', to: ['quotes@reply.jfhauling.ca'], messageId: '<http@mail.test>', subject: 'Haul' });
  const httpTs = String(Math.floor(Date.now() / 1000));
  const bad = await fetch(base + '/api/resend/inbound', { method: 'POST', headers: { 'Content-Type': 'application/json', 'svix-id': 'msg_bad', 'svix-timestamp': httpTs, 'svix-signature': 'v1,bm90LXRoZS1zaWduYXR1cmU=' }, body });
  const good = await fetch(base + '/api/resend/inbound', { method: 'POST', headers: { 'Content-Type': 'application/json', 'svix-id': 'msg_good', 'svix-timestamp': httpTs, 'svix-signature': sign('msg_good', httpTs, body) }, body });
  const goodBody = await good.json();
  check('the webhook route rejects a bad signature and does not file without the email body', bad.status === 401 && good.status === 502 && goodBody.error === 'Could not read that email.');
  child.kill('SIGTERM');
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close((err) => (err ? reject(err) : resolve(port))); });
  });
}
