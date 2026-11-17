// Outlook send shape, Twilio signatures, AI guardrails, and the lead timeline.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-ch-'));
const TOKEN = 'twilio-test-token';
const SID = `AC${'1'.repeat(32)}`;
const FROM = '+12265451745';
process.env.DATA_DIR = dataDir;
process.env.OPENAI_API_KEY = 'sk-test-not-real';
process.env.OPENAI_MODEL = 'gpt-4o-mini';
process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
process.env.AI_AUTOREPLY_ENABLED = 'true';
process.env.TWILIO_ACCOUNT_SID = SID;
process.env.TWILIO_AUTH_TOKEN = TOKEN;
process.env.TWILIO_FROM_NUMBER = FROM;
process.env.MS_CLIENT_ID = 'test-client-id';
process.env.MS_CLIENT_SECRET = 'test-client-secret';
process.env.MS_REDIRECT_URI = 'https://jfhauling.ca/crm/oauth/callback';
process.env.MS_TENANT = 'consumers';
process.env.CRM_PASSWORD = 'crm-test-password';

const leads = require('../server/leads');
const outlook = require('../server/outlook');
const twilio = require('../server/twilio');
const ai = require('../server/ai-reply');
const settings = require('../server/crm-settings');

let failed = 0;
function check(name, cond, detail) {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function signTwilio(url, params, token) {
  const keys = Object.keys(params).sort();
  let data = url;
  for (const key of keys) data += key + params[key];
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
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

function cleanEnv(extra) {
  return { PATH: process.env.PATH, HOME: process.env.HOME || os.homedir(), TMPDIR: os.tmpdir(), NODE_ENV: 'test', ...extra };
}

(async () => {
  const fixtureUrl = 'https://jfhauling.ca/api/twilio/sms';
  const fixtureParams = {
    Body: 'Can you haul a shed?',
    From: '+15195550100',
    MessageSid: `SM${'a'.repeat(32)}`,
    To: FROM,
  };
  const fixtureSig = signTwilio(fixtureUrl, fixtureParams, TOKEN);
  check('Twilio signature matches the documented HMAC fixture', fixtureSig === 'TdT40ahPdaU35T3yCTYg5Z+J4f8=' && twilio.validateSignature(fixtureUrl, fixtureParams, fixtureSig, TOKEN));
  check('a changed message body fails the Twilio signature', !twilio.validateSignature(fixtureUrl, { ...fixtureParams, Body: 'something else' }, fixtureSig, TOKEN));
  check('a missing Twilio signature is rejected', !twilio.validateSignature(fixtureUrl, fixtureParams, '', TOKEN));

  const authUrl = outlook.authorizeUrl('state-1');
  check('Outlook sign-in uses the consumers tenant and mail scopes', authUrl.startsWith('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize') && authUrl.includes('offline_access') && authUrl.includes('Mail.Send') && authUrl.includes('Mail.Read') && authUrl.includes('User.Read') && authUrl.includes('test-client-id') && authUrl.includes(encodeURIComponent('https://jfhauling.ca/crm/oauth/callback')));
  check('the authorize URL does not carry the client secret', !authUrl.includes('test-client-secret'));

  outlook.saveTokens({ refreshToken: 'refresh-test', accessToken: 'access-test', expiresAt: Date.now() + 3600 * 1000, account: 'jfhauling@outlook.com' });
  const mode = fs.statSync(outlook.tokenFile()).mode & 0o777;
  check('the Outlook refresh token file is mode 600', mode === 0o600);
  const tokenText = fs.readFileSync(outlook.tokenFile(), 'utf8');
  check('the token file keeps the refresh token and not a log line', tokenText.includes('refresh-test') && !tokenText.includes('console'));

  const graphId = 'AAMkAGI2THVsaW5nIDExMORE';
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method, body: opts.body ? String(opts.body) : '', auth: (opts.headers && opts.headers.Authorization) || '' });
    if (String(url).includes('/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'We can look at that shed.\n\nJF Hauling' } }] }), { status: 200 });
    }
    if (String(url).endsWith('/reply')) return new Response('', { status: 202 });
    if (String(url).endsWith('/sendMail')) return new Response('', { status: 202 });
    if (String(url).includes('/Messages.json')) return new Response('{"sid":"SM1"}', { status: 201 });
    return new Response('{}', { status: 500 });
  };

  const reply = await outlook.deliverEmail({
    accessToken: 'access-test',
    to: 'erin@example.ca',
    subject: 'Re: Shed move',
    body: 'We can look at that shed.\n\nJF Hauling',
    replyToId: graphId,
    fetchImpl,
  });
  const replyCall = calls.find((c) => c.url.includes('/reply'));
  check('a Graph message id is answered with /reply and the comment body', reply.ok && reply.threaded && replyCall && replyCall.method === 'POST' && replyCall.url === `https://graph.microsoft.com/v1.0/me/messages/${graphId}/reply` && replyCall.auth === 'Bearer access-test' && JSON.parse(replyCall.body).comment === 'We can look at that shed.\n\nJF Hauling' && !replyCall.body.includes('test-client-secret'));

  calls.length = 0;
  const fallbackFetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body ? String(opts.body) : '' });
    if (String(url).endsWith('/reply')) return new Response('', { status: 404 });
    if (String(url).endsWith('/sendMail')) return new Response('', { status: 202 });
    return new Response('', { status: 500 });
  };
  const sent = await outlook.deliverEmail({
    accessToken: 'access-test',
    to: 'erin@example.ca',
    subject: 'JF Hauling — Shed',
    body: 'Hello from dispatch',
    replyToId: graphId,
    fetchImpl: fallbackFetch,
  });
  const mailCall = calls.find((c) => c.url.endsWith('/sendMail'));
  const mailBody = mailCall ? JSON.parse(mailCall.body) : {};
  check('a missing Graph message falls back to sendMail', sent.ok && sent.threaded === false && mailCall.url === 'https://graph.microsoft.com/v1.0/me/sendMail' && mailBody.message.subject === 'JF Hauling — Shed' && mailBody.message.body.contentType === 'Text' && mailBody.message.body.content === 'Hello from dispatch' && mailBody.message.toRecipients[0].emailAddress.address === 'erin@example.ca' && mailBody.saveToSentItems === true);

  const made = leads.create({
    source: 'email',
    name: 'Erin Mail',
    email: 'erin@example.ca',
    phone: '519-555-0142',
    message: 'Can you move a shed from Listowel to Guelph?',
    externalId: graphId,
  }, { defaultSource: 'email' });
  leads.setFlags(made.lead.id, { aiAutoReply: true });
  const inbound = leads.addTimeline(made.lead.id, {
    kind: 'email', direction: 'in', subject: 'Shed move', body: 'Can you move a shed from Listowel to Guelph?', externalId: 'inbound-erin-1',
  });
  const dup = leads.addTimeline(made.lead.id, {
    kind: 'email', direction: 'in', subject: 'again', body: 'again', externalId: 'inbound-erin-1',
  });
  const convo = leads.conversation(leads.find(made.lead.id));
  check('timeline stores direction, subject, and body and dedupes the message id', inbound.ok && inbound.duplicate === false && dup.duplicate === true && convo.some((item) => item.direction === 'in' && item.kind === 'email' && item.subject === 'Shed move' && item.body.includes('Guelph')));

  calls.length = 0;
  const auto = await ai.handleAutoReply(made.lead.id, {
    channel: 'email',
    from: 'erin@example.ca',
    text: 'Can you move a shed from Listowel to Guelph?',
    subject: 'Shed move',
    fetchImpl,
  });
  const aiCall = calls.find((c) => c.url.includes('/chat/completions'));
  const aiBody = aiCall ? JSON.parse(aiCall.body) : {};
  const system = aiBody.messages && aiBody.messages[0] && aiBody.messages[0].content;
  check('auto-reply asks OpenAI as JF Hauling and then replies in the Graph thread', auto.sent === true && aiCall && aiCall.auth === 'Bearer sk-test-not-real' && !aiCall.body.includes('sk-test-not-real') && aiBody.model === 'gpt-4o-mini' && /226-545-1745/.test(system) && system.includes('https://jfhauling.ca/quote') && /40 ft/.test(system) && /20,000/.test(system) && /Listowel/.test(system) && /check with the dispatcher/i.test(system) && /JF Hauling/.test(system) && calls.some((c) => c.url.endsWith('/reply')));
  const afterAi = leads.find(made.lead.id);
  check('the AI reply is on the timeline and marked AI', (afterAi.timeline || []).some((item) => item.ai && item.direction === 'out' && item.kind === 'email' && item.body.includes('JF Hauling')));

  const limited = leads.create({ source: 'sms', name: 'Tex Ter', phone: '519-555-0100', message: 'Haul a skid steer?', externalId: 'SMlimit' }, { defaultSource: 'sms' });
  leads.setFlags(limited.lead.id, { aiAutoReply: true });
  const recent = new Date().toISOString();
  for (let i = 0; i < 3; i++) {
    leads.addTimeline(limited.lead.id, { kind: 'sms', direction: 'out', body: `Auto ${i}`, ai: true, externalId: `ai-${i}`, at: recent });
  }
  let fetched = false;
  const blocked = await ai.handleAutoReply(limited.lead.id, {
    channel: 'sms',
    from: '+15195550100',
    text: 'Any update?',
    fetchImpl: async () => { fetched = true; return new Response('{}', { status: 500 }); },
  });
  check('a fourth AI auto-reply in 24 hours is not sent', blocked.sent === false && blocked.reason === 'limit' && fetched === false);

  const oldLead = leads.create({ source: 'email', name: 'Old Replies', email: 'old@example.ca', message: 'Need a container moved', externalId: 'AAMkOLDREPLIES1234567890' }, { defaultSource: 'email' });
  leads.setFlags(oldLead.lead.id, { aiAutoReply: true });
  const oldAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  for (let i = 0; i < 3; i++) leads.addTimeline(oldLead.lead.id, { kind: 'email', direction: 'out', body: 'old', ai: true, externalId: `old-ai-${i}`, at: oldAt });
  check('AI replies older than 24 hours do not count toward the cap', ai.assess({ lead: leads.find(oldLead.lead.id), from: 'old@example.ca', text: 'Still need the container moved' }).ok === true);

  const human = leads.create({ source: 'email', name: 'Pat Angry', email: 'pat.angry@example.ca', message: 'About my shed', externalId: 'AAMkHUMAN1234567890XXXX' }, { defaultSource: 'email' });
  leads.setFlags(human.lead.id, { aiAutoReply: true });
  fetched = false;
  const stopped = await ai.handleAutoReply(human.lead.id, {
    channel: 'email',
    from: 'pat.angry@example.ca',
    text: 'Please cancel this and I want a refund. I need to speak to a person.',
    subject: 'Cancel',
    fetchImpl: async () => { fetched = true; return new Response('{}', { status: 500 }); },
  });
  const humanLead = leads.find(human.lead.id);
  check('payment, cancellation, or asking for a person stops auto-reply and flags Needs Johan', stopped.needsJohan === true && fetched === false && humanLead.needsJohan === true && humanLead.aiAutoReply === false && (humanLead.timeline || []).some((item) => /Needs Johan/.test(item.body)));

  check('noreply and our own address are not auto-replied', ai.assess({ lead: leads.find(made.lead.id), from: 'noreply@news.example', text: 'A newsletter' }).reason === 'bulk' && ai.assess({ lead: leads.find(made.lead.id), from: 'jfhauling@outlook.com', text: 'hello' }).reason === 'bulk');
  leads.setFlags(made.lead.id, { aiAutoReply: false });
  check('a lead with auto-reply off does not send', ai.assess({ lead: leads.find(made.lead.id), from: 'erin@example.ca', text: 'hello' }).reason === 'lead-off');
  leads.setFlags(made.lead.id, { aiAutoReply: true });
  settings.write({ aiAutoReply: false });
  check('the global settings switch stops auto-reply', ai.assess({ lead: leads.find(made.lead.id), from: 'erin@example.ca', text: 'hello' }).reason === 'global-off');
  settings.write({ aiAutoReply: true });
  process.env.AI_AUTOREPLY_ENABLED = 'false';
  check('AI_AUTOREPLY_ENABLED=false is a kill switch', ai.assess({ lead: leads.find(made.lead.id), from: 'erin@example.ca', text: 'hello' }).reason === 'global-off');
  process.env.AI_AUTOREPLY_ENABLED = 'true';

  const port = await freePort();
  const httpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-ch-http-'));
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: cleanEnv({
      PORT: String(port),
      DATA_DIR: httpDir,
      ADMIN_PASSWORD: 'isolated-test-only',
      CRM_PASSWORD: 'crm-test-password',
      CRM_API_TOKEN: 'crm-test-token',
      ROUTING_ENABLED: 'false',
      OPENAI_API_KEY: '',
      TWILIO_ACCOUNT_SID: SID,
      TWILIO_AUTH_TOKEN: TOKEN,
      TWILIO_FROM_NUMBER: FROM,
      MS_CLIENT_ID: '',
      MS_CLIENT_SECRET: '',
    }),
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/config`);
      if (res.ok) break;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const hook = `http://127.0.0.1:${port}/api/twilio/sms`;
  async function postSms(params, signature) {
    return fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature || signTwilio(hook, params, TOKEN) },
      body: new URLSearchParams(params),
    });
  }
  const firstParams = { From: '+15195550199', To: FROM, Body: 'Can you haul a shed tomorrow?', MessageSid: `SM${'b'.repeat(32)}` };
  const first = await postSms(firstParams);
  const bad = await postSms({ ...firstParams, Body: 'tampered', MessageSid: `SM${'c'.repeat(32)}` }, signTwilio(hook, firstParams, TOKEN));
  const second = await postSms({ From: '+15195550199', To: FROM, Body: 'Also a flat deck.', MessageSid: `SM${'d'.repeat(32)}` });
  const own = await postSms({ From: FROM, To: FROM, Body: 'echo', MessageSid: `SM${'e'.repeat(32)}` });
  const stored = JSON.parse(fs.readFileSync(path.join(httpDir, 'leads.json'), 'utf8'));
  const smsLead = stored.find((l) => l.phone === '+15195550199');
  check('a signed Twilio webhook creates one text lead and files the reply on it', first.status === 200 && (await first.text()).includes('<Response') && bad.status === 403 && second.status === 200 && own.status === 200 && stored.length === 1 && smsLead && smsLead.source === 'sms' && (smsLead.timeline || []).filter((item) => item.kind === 'sms' && item.direction === 'in').length === 2 && (smsLead.timeline || []).some((item) => item.body.includes('flat deck')));

  const login = await fetch(`http://127.0.0.1:${port}/crm/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'crm-test-password' }),
  });
  if (login.status === 303) {
    const cookie = (login.headers.getSetCookie()[0] || '').split(';')[0];
    const page = await (await fetch(`http://127.0.0.1:${port}/crm/settings`, { headers: { cookie } })).text();
    check('settings explain Outlook is off and show the Twilio webhook', page.includes('MS_CLIENT_ID') && page.includes('Texting is on') && page.includes('https://jfhauling.ca/api/twilio/sms') && page.includes('noindex'));
  } else check('settings explain that Outlook and Twilio are not set up', false, 'login ' + login.status);
  child.kill('SIGTERM');

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('HARNESS', err && err.stack ? err.stack : err);
  process.exit(1);
});
