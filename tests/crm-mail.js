// CRM mail without Microsoft Graph: Resend headers, inbound email, AI auto-reply.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-mailcrm-'));
process.env.DATA_DIR = dataDir;
process.env.RESEND_API_KEY = 're_test_not_real';
process.env.MAIL_FROM = 'JF Hauling Website <quotes@jfhauling.ca>';
process.env.CRM_EMAIL_BCC = 'jfhauling@outlook.com';
process.env.MS_CLIENT_ID = '';
process.env.MS_CLIENT_SECRET = '';
process.env.OPENAI_API_KEY = 'sk-test-not-real';
process.env.OPENAI_MODEL = 'gpt-4o-mini';
process.env.AI_AUTOREPLY_ENABLED = 'true';
process.env.NOTIFY_TO = 'jfhauling@outlook.com';

const mailer = require('../server/mailer');
const leads = require('../server/leads');
const inbound = require('../server/inbound-email');

let failed = 0;
function check(name, cond, detail) {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
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

(async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    calls.push({ url: String(url), body, auth: (opts.headers && opts.headers.Authorization) || '' });
    if (String(url).includes('/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'We can take a look.\n\nJF Hauling' } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 'email_mock' }), { status: 200 });
  };

  const made = leads.create({
    source: 'email', name: 'Erin Mail', email: 'erin@example.ca', message: 'Need a shed moved',
  }, { defaultSource: 'email' });
  leads.addTimeline(made.lead.id, {
    kind: 'email', direction: 'in', subject: 'Shed move', body: 'Can you move a shed Thursday?',
    messageId: 'cust-100@mail.test', externalId: 'graph-not-used',
  });
  calls.length = 0;
  const sent = await require('../server/crm-mail').sendLeadEmail({
    lead: leads.find(made.lead.id),
    to: 'erin@example.ca',
    subject: 'Re: Shed move',
    body: 'We can take a look.',
    fetchImpl,
  });
  const resend = calls.find((c) => c.url === 'https://api.resend.com/emails');
  const headers = resend && resend.body.headers;
  check('CRM mail uses the verified from address, Reply-To, and BCC', sent.ok && resend && resend.body.from === 'JF Hauling <quotes@jfhauling.ca>' && resend.body.reply_to === 'jfhauling@outlook.com' && resend.body.bcc[0] === 'jfhauling@outlook.com' && resend.body.to[0] === 'erin@example.ca' && !resend.auth.includes('undefined'));
  check('a reply sets Message-ID, In-Reply-To, and References', headers && /^<crm\..+@jfhauling\.ca>$/.test(headers['Message-ID']) && headers['In-Reply-To'] === '<cust-100@mail.test>' && headers.References.includes('<cust-100@mail.test>') && headers.References.includes(headers['Message-ID']) === false);
  const outbound = (leads.find(made.lead.id).timeline || []).find((item) => item.direction === 'out');
  check('the outbound Message-ID is stored on the timeline', outbound && outbound.messageId === headers['Message-ID']);

  leads.setFlags(made.lead.id, { aiAutoReply: true });
  calls.length = 0;
  const reply = await inbound.receive({
    external_id: 'msg-erin-2',
    from_email: 'Erin@Example.ca',
    from_name: 'Erin Mail',
    subject: 'Thursday',
    body_text: 'Does Thursday still work?',
    received_at: '2026-11-17T18:00:00.000Z',
    internet_message_id: '<erin-2@mail.test>',
  }, { fetchImpl });
  const aiCall = calls.find((c) => c.url.includes('/chat/completions'));
  const aiSend = calls.filter((c) => c.url === 'https://api.resend.com/emails').pop();
  const fresh = leads.find(made.lead.id);
  check('inbound mail matches the lead and triggers one guarded AI reply', reply.created === false && reply.duplicate === false && reply.auto_replied === true && reply.lead_id === made.lead.id && aiCall && aiCall.body.model === 'gpt-4o-mini' && !aiCall.body.messages[0].content.includes('sk-test') && aiSend.body.headers['In-Reply-To'] === '<erin-2@mail.test>' && aiSend.body.reply_to === 'jfhauling@outlook.com' && fresh.lastContactAt === '2026-11-17T18:00:00.000Z' && (fresh.timeline || []).some((item) => item.ai && item.direction === 'out'));

  const again = await inbound.receive({
    external_id: 'msg-erin-2',
    from_email: 'erin@example.ca',
    subject: 'Thursday',
    body_text: 'Does Thursday still work?',
  }, { fetchImpl: async () => { throw new Error('should not send'); } });
  check('the same external_id is a duplicate and does not send again', again.duplicate === true && again.auto_replied === false && again.lead_id === made.lead.id);

  const created = await inbound.receive({
    external_id: 'msg-new-1',
    from_email: 'new.customer@example.ca',
    from_name: 'New Customer',
    subject: 'Flat deck',
    body_text: 'Can you move a skid steer?',
    internet_message_id: 'new-1@mail.test',
  }, { fetchImpl: async () => { throw new Error('new leads do not auto-reply'); } });
  const newbie = leads.find(created.lead_id);
  check('an unknown sender becomes an email lead and does not auto-reply', created.created === true && created.duplicate === false && created.auto_replied === false && newbie.source === 'email' && newbie.email === 'new.customer@example.ca' && newbie.aiAutoReply === false && (newbie.timeline || []).some((item) => item.direction === 'in' && item.messageId === 'new-1@mail.test'));

  const port = await freePort();
  const httpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-mailcrm-http-'));
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME || os.homedir(), TMPDIR: os.tmpdir(), NODE_ENV: 'test',
      PORT: String(port), DATA_DIR: httpDir, ADMIN_PASSWORD: 'isolated', CRM_PASSWORD: 'crm-test-password',
      CRM_API_TOKEN: 'crm-test-token', RESEND_API_KEY: '', SMTP_HOST: '', OPENAI_API_KEY: '', MS_CLIENT_ID: '',
      ROUTING_ENABLED: 'false',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/config`)).ok) break;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 80));
  }
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: 'Bearer crm-test-token', 'Content-Type': 'application/json' };
  const noAuth = await fetch(base + '/api/leads/inbound-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await fetch(base + '/api/leads', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Pat Known', email: 'pat@example.ca', original_message: 'Existing lead' }) });
  const matched = await fetch(base + '/api/leads/inbound-email', { method: 'POST', headers: auth, body: JSON.stringify({ external_id: 'http-msg-1', from_email: 'pat@example.ca', subject: 'Re: haul', body_text: 'Following up', internet_message_id: '<http-1@mail.test>' }) });
  const matchedBody = await matched.json();
  const dup = await fetch(base + '/api/leads/inbound-email', { method: 'POST', headers: auth, body: JSON.stringify({ external_id: 'http-msg-1', from_email: 'pat@example.ca', body_text: 'Following up' }) });
  const dupBody = await dup.json();
  const createdHttp = await fetch(base + '/api/leads/inbound-email', { method: 'POST', headers: auth, body: JSON.stringify({ external_id: 'http-msg-2', from_email: 'sam@example.ca', from_name: 'Sam', subject: 'Quote', body_text: 'Need a container moved' }) });
  const freshBody = await createdHttp.json();
  const known = await (await fetch(base + '/api/leads/known-emails', { headers: { Authorization: 'Bearer crm-test-token' } })).json();
  const rows = JSON.parse(fs.readFileSync(path.join(httpDir, 'leads.json'), 'utf8'));
  const pat = rows.find((r) => r.email === 'pat@example.ca');
  check('the HTTP API dedupes, matches, creates, and lists known emails', noAuth.status === 401 && matched.status === 200 && matchedBody.created === false && matchedBody.duplicate === false && matchedBody.auto_replied === false && dup.status === 200 && dupBody.duplicate === true && dupBody.lead_id === matchedBody.lead_id && createdHttp.status === 201 && freshBody.created === true && known.emails.includes('pat@example.ca') && known.emails.includes('sam@example.ca') && pat && (pat.timeline || []).some((item) => item.externalId === 'http-msg-1' && item.messageId === '<http-1@mail.test>') && rows.filter((r) => r.email === 'pat@example.ca').length === 1);
  child.kill('SIGTERM');

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('HARNESS', err && err.stack ? err.stack : err);
  process.exit(1);
});