// Mocked dispatch-alert and DATA_DIR tests. No network and no real email.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const CUSTOMER = 'customer@example.test';
const OWNER = 'owner-notify@example.test';
const FROM = 'JF Hauling Website <quotes@example.test>';
const DEFAULT_FROM = 'JF Hauling Website <quotes@jfhauling.ca>';
const API_KEY = 're_test_key_not_real';
let failed = 0;

function check(name, cond, detail) {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function cleanEnv(extra = {}) {
  return { PATH: process.env.PATH, HOME: process.env.HOME || os.homedir(), TMPDIR: os.tmpdir(), NODE_ENV: 'test', ...extra };
}

function writePreload(file) {
  fs.writeFileSync(file, `
const fs = require('fs');
const Module = require('module');
const orig = Module.prototype.require;
const logFile = process.env.MOCK_MAIL_LOG;
const mode = process.env.MOCK_MAIL_MODE || 'success';
const customer = process.env.FIXTURE_CUSTOMER || '';
const owner = process.env.FIXTURE_OWNER || '';
const apiKey = process.env.RESEND_API_KEY || '';
function note(obj) { fs.appendFileSync(logFile, JSON.stringify(obj) + '\\n'); }
global.fetch = async (url, opts = {}) => {
  const body = opts.body ? JSON.parse(opts.body) : {};
  const auth = (opts.headers && opts.headers.Authorization) || '';
  note({
    event: 'resend',
    url: String(url),
    authOk: auth === 'Bearer ' + apiKey,
    authHasKeyText: auth.includes(apiKey) && apiKey.length > 0,
    from: body.from || '',
    to: body.to || [],
    replyTo: body.reply_to || '',
    subject: body.subject || '',
    text: body.text || '',
    toIsOwner: Array.isArray(body.to) && body.to.length === 1 && body.to[0] === owner,
    toIsCustomer: Array.isArray(body.to) && body.to.includes(customer),
    replyIsCustomer: body.reply_to === customer,
  });
  if (mode === 'fail') return new Response(JSON.stringify({ message: 'rejected ' + customer }), { status: 422 });
  if (mode === 'throw') throw new Error('network down for ' + customer);
  return new Response(JSON.stringify({ id: 'email_mock' }), { status: 200 });
};
Module.prototype.require = function (id) {
  if (id === 'nodemailer') {
    return {
      createTransport(opts) {
        note({ event: 'smtp-transport', port: opts.port, secure: !!opts.secure, hasAuth: !!opts.auth });
        return {
          sendMail(msg) {
            note({
              event: 'smtp-send',
              from: msg.from || '',
              to: msg.to,
              replyTo: msg.replyTo || '',
              subject: msg.subject || '',
              text: msg.text || '',
              toIsOwner: msg.to === owner,
              toIsCustomer: msg.to === customer,
              replyIsCustomer: msg.replyTo === customer,
            });
            if (mode === 'fail') return Promise.reject(new Error('smtp rejected ' + customer));
            return Promise.resolve({ messageId: 'mock' });
          },
        };
      },
    };
  }
  return orig.apply(this, arguments);
};
`);
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function runNode(args, env) {
  return spawnSync(process.execPath, args, { cwd: ROOT, env: cleanEnv(env), encoding: 'utf8' });
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

async function startServer(dir, extra) {
  const port = await freePort();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-mail-'));
  const out = path.join(logDir, 'out.log');
  const err = path.join(logDir, 'err.log');
  const mailLog = path.join(logDir, 'mail.log');
  const preload = path.join(logDir, 'preload.js');
  fs.writeFileSync(mailLog, '');
  writePreload(preload);
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: cleanEnv({
      PORT: String(port),
      DATA_DIR: dir,
      ADMIN_PASSWORD: 'isolated-test-only',
      ROUTING_ENABLED: 'false',
      OPENAI_API_KEY: '',
      RESEND_API_KEY: '',
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      SMTP_FROM: '',
      MAIL_FROM: '',
      NOTIFY_TO: OWNER,
      MOCK_MAIL_LOG: mailLog,
      MOCK_MAIL_MODE: 'success',
      FIXTURE_CUSTOMER: CUSTOMER,
      FIXTURE_OWNER: OWNER,
      NODE_OPTIONS: `--require ${preload}`,
      ...extra,
    }),
    stdio: ['ignore', fs.openSync(out, 'a'), fs.openSync(err, 'a')],
  });
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error('server exited');
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/config`);
      if (res.ok) { await res.json(); return { port, child, out, err, mailLog }; }
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

async function post(port, url, body) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json() };
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

(async () => {
  const missing = path.join(os.tmpdir(), `jf-missing-${Date.now()}`, 'nested', 'data');
  const created = runNode(['-e', `
    const fs = require('fs');
    const store = require('./server/store');
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    store.insert('quotes', { id: 'Q-DIR', customer: { email: ${JSON.stringify(CUSTOMER)} } });
    store.insert('messages', { id: 'M-DIR', email: ${JSON.stringify(CUSTOMER)} });
    const q = store.readAll('quotes');
    const m = store.readAll('messages');
    process.stdout.write(JSON.stringify({
      q: q.length, m: m.length, qid: q[0] && q[0].id, mid: m[0] && m[0].id,
      quotesFile: fs.existsSync(require('path').join(process.env.DATA_DIR, 'quotes.json')),
      messagesFile: fs.existsSync(require('path').join(process.env.DATA_DIR, 'messages.json')),
    }));
  `], { DATA_DIR: missing });
  const createdJson = JSON.parse(created.stdout || '{}');
  check('DATA_DIR is created when missing and both files land there', created.status === 0 && createdJson.q === 1 && createdJson.m === 1 && createdJson.qid === 'Q-DIR' && createdJson.mid === 'M-DIR' && createdJson.quotesFile && createdJson.messagesFile);

  const mailCases = [
    {
      name: 'off',
      env: { RESEND_API_KEY: '', SMTP_HOST: '', NOTIFY_TO: OWNER },
      expect: (out, err, log) => {
        check('no provider logs mode=off and does not send', out.includes('MODE off') && out.includes('RESULT false') && log.length === 0);
        check('off mode does not log the customer address', !out.includes(CUSTOMER) && !err.includes(CUSTOMER));
      },
    },
    {
      name: 'resend preferred over smtp',
      env: { RESEND_API_KEY: API_KEY, SMTP_HOST: 'smtp.example.test', SMTP_USER: 'smtp-user', MAIL_FROM: FROM, NOTIFY_TO: OWNER },
      expect: (out, err, log) => {
        const sends = log.filter((e) => e.event === 'resend');
        check('Resend is selected when both providers are configured', out.includes('MODE resend') && sends.length === 1 && !log.some((e) => e.event.startsWith('smtp')));
        check('Resend payload uses the owner recipient, customer reply-to, and MAIL_FROM', sends[0] && sends[0].url === 'https://api.resend.com/emails' && sends[0].authOk && sends[0].toIsOwner && !sends[0].toIsCustomer && sends[0].replyIsCustomer && sends[0].from === FROM);
        check('successful send log has the reference and no customer address', /\[mailer\] sent ref=Q-TEST mode=resend/.test(out) && !out.includes(CUSTOMER) && !err.includes(CUSTOMER));
      },
    },
    {
      name: 'resend default from',
      env: { RESEND_API_KEY: API_KEY, MAIL_FROM: '', NOTIFY_TO: '' },
      expect: (out, err, log) => {
        const expectedTo = runNode(['-e', "process.stdout.write(require('./config').mail.notifyTo)"], { NOTIFY_TO: '' }).stdout;
        const send = log.find((e) => e.event === 'resend');
        check('blank MAIL_FROM and NOTIFY_TO use the built-in from address and owner recipient', send && send.from === DEFAULT_FROM && send.to.length === 1 && send.to[0] === expectedTo && expectedTo.length > 3 && send.replyIsCustomer);
        check('default-recipient send log stays free of the customer address', /\[mailer\] sent ref=Q-TEST mode=resend/.test(out) && !out.includes(CUSTOMER) && !err.includes(CUSTOMER));
      },
    },
    {
      name: 'resend failure',
      env: { RESEND_API_KEY: API_KEY, MAIL_FROM: FROM, NOTIFY_TO: OWNER, MOCK_MAIL_MODE: 'throw' },
      expect: (out, err, log) => {
        check('Resend failure returns false and logs the reference', out.includes('RESULT false') && /\[mailer\] failed ref=Q-TEST mode=resend error=/.test(err));
        check('failure log redacts the customer address', !out.includes(CUSTOMER) && !err.includes(CUSTOMER) && err.includes('[redacted]'));
        check('a failed Resend call does not fall through to SMTP', !log.some((e) => String(e.event).startsWith('smtp')));
      },
    },
    {
      name: 'smtp fallback',
      env: { RESEND_API_KEY: '', SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'smtp-user', SMTP_FROM: '', MAIL_FROM: '', NOTIFY_TO: OWNER },
      expect: (out, err, log) => {
        const send = log.find((e) => e.event === 'smtp-send');
        check('SMTP is used only when Resend is unset', out.includes('MODE smtp') && send && !log.some((e) => e.event === 'resend'));
        check('SMTP from falls back to the SMTP user and reply-to is the customer', send && send.from === 'smtp-user' && send.toIsOwner && !send.toIsCustomer && send.replyIsCustomer && /\[mailer\] sent ref=Q-TEST mode=smtp/.test(out));
        check('SMTP success log has no customer address', !out.includes(CUSTOMER) && !err.includes(CUSTOMER));
      },
    },
    {
      name: 'smtp from overrides',
      env: { RESEND_API_KEY: '', SMTP_HOST: 'smtp.example.test', SMTP_USER: 'smtp-user', SMTP_FROM: 'dispatch@example.test', MAIL_FROM: FROM, NOTIFY_TO: OWNER },
      expect: (_out, _err, log) => {
        const send = log.find((e) => e.event === 'smtp-send');
        check('MAIL_FROM wins over SMTP_FROM when both are set', send && send.from === FROM);
      },
    },
    {
      name: 'smtp failure',
      env: { RESEND_API_KEY: '', SMTP_HOST: 'smtp.example.test', SMTP_USER: 'smtp-user', NOTIFY_TO: OWNER, MOCK_MAIL_MODE: 'fail' },
      expect: (out, err) => {
        check('SMTP failure is logged with the reference and a redacted address', out.includes('RESULT false') && /\[mailer\] failed ref=Q-TEST mode=smtp error=/.test(err) && err.includes('[redacted]') && !err.includes(CUSTOMER) && !out.includes(CUSTOMER));
      },
    },
  ];

  for (const item of mailCases) {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-unit-'));
    const mailLog = path.join(logDir, 'mail.log');
    const preload = path.join(logDir, 'preload.js');
    fs.writeFileSync(mailLog, '');
    writePreload(preload);
    const result = runNode(['-e', `
      const mailer = require('./server/mailer');
      console.log('MODE ' + mailer.mode());
      mailer.notify('Quote Q-TEST', 'Quote reference: Q-TEST\\nEmail: ${CUSTOMER}', { replyTo: ${JSON.stringify(CUSTOMER)}, reference: 'Q-TEST' })
        .then((ok) => console.log('RESULT ' + ok))
        .catch((e) => { console.log('RESULT throw'); console.error(e && e.message); });
    `], { ...item.env, MOCK_MAIL_LOG: mailLog, FIXTURE_CUSTOMER: CUSTOMER, FIXTURE_OWNER: OWNER, NODE_OPTIONS: `--require ${preload}` });
    check(`${item.name} process exits`, result.status === 0, result.status === 0 ? '' : 'non-zero exit');
    item.expect(result.stdout, result.stderr, readLog(mailLog));
  }

  const dataDir = path.join(os.tmpdir(), `jf-http-${Date.now()}`, 'var', 'data');
  check('HTTP data directory starts missing', !fs.existsSync(dataDir));
  const server = await startServer(dataDir, { RESEND_API_KEY: API_KEY, MAIL_FROM: FROM, NOTIFY_TO: OWNER });
  check('startup creates DATA_DIR', fs.existsSync(dataDir));
  const startup = fs.readFileSync(server.out, 'utf8');
  check('startup logs resend mode without the API key', startup.includes('[mailer] mode=resend') && !startup.includes(API_KEY));

  const quote = await submitQuote(server.port, ['Listowel, ON', 'Stratford, ON', 'container20', '8000 lbs', 'Flexible', 'Tailgate needed', '120 km', 'intent:request', 'Test Person', '5195550199', CUSTOMER]);
  const ref = quote.body.reference;
  const quoteFile = JSON.parse(fs.readFileSync(path.join(dataDir, 'quotes.json'), 'utf8'));
  check('quote submission is stored under DATA_DIR', quote.body.done === true && quoteFile.length === 1 && quoteFile[0].id === ref);

  const review = await submitQuote(server.port, ['Listowel', 'Kitchener, ON', 'general', '30 ft', '25000 lbs', 'limit:continue', 'ASAP', 'none', '80 km', 'intent:request', 'Bob Heavy', '2265550199', CUSTOMER]);
  const shedQuote = await submitQuote(server.port, ['Listowel, ON', 'Guelph, ON', 'shed', '8', '12', 'yes', 'Flexible', 'none', '90 km', 'intent:request', 'Shed Owner', '5195550166', CUSTOMER]);
  const shedNo = await submitQuote(server.port, ['Listowel, ON', 'Owen Sound, ON', 'shed', '10', '24', 'no', 'ASAP', 'none', '40 km', 'intent:request', 'No Mule', '2265550101', CUSTOMER]);
  const contact = await post(server.port, '/api/contact', { name: 'Test Person', email: CUSTOMER, phone: '5195550199', message: 'Need a call about the lane.' });
  const messages = JSON.parse(fs.readFileSync(path.join(dataDir, 'messages.json'), 'utf8'));
  check('contact message is stored under the same DATA_DIR', contact.status === 200 && contact.body.ok === true && messages.length === 1);

  const sends = readLog(server.mailLog).filter((e) => e.event === 'resend');
  const quoteSend = sends.find((e) => e.subject.includes(ref));
  const reviewSend = sends.find((e) => e.subject.includes(review.body.reference) && /NEEDS REVIEW/.test(e.subject));
  const shedSend = sends.find((e) => shedQuote.body.reference && e.subject.includes(shedQuote.body.reference));
  const shedNoSend = sends.find((e) => shedNo.body.reference && e.subject.includes(shedNo.body.reference));
  const contactSend = sends.find((e) => e.subject.includes(messages[0].id));
  const quoteParts = [
    ['reference', `Quote reference: ${ref}`],
    ['name', 'Name: Test Person'],
    ['email', `Email: ${CUSTOMER}`],
    ['phone', 'Phone: 519-555-0199'],
    ['pickup', 'Pickup: Listowel, ON'],
    ['drop-off', 'Drop-off: Stratford, ON'],
    ['freight', 'Freight: 20 ft container'],
    ['date', 'Pickup date: Flexible'],
    ['notes', 'Notes: Tailgate needed'],
    ['distance', 'Distance: 120 km'],
  ];
  const missingParts = !quoteSend ? ['payload'] : quoteParts.filter((p) => !quoteSend.text.includes(p[1])).map((p) => p[0]);
  if (quoteSend && !/Weight: 8,?000 lbs/.test(quoteSend.text)) missingParts.push('weight');
  if (quoteSend && !/Estimate: \$\d+–\$\d+ CAD/.test(quoteSend.text)) missingParts.push('estimate');
  check('quote alert includes the dispatch details', quoteSend && quoteSend.toIsOwner && !quoteSend.toIsCustomer && quoteSend.replyIsCustomer && quoteSend.from === FROM && missingParts.length === 0, missingParts.join(','));
  check('over-limit alert says review and includes the flag', review.body.done === true && reviewSend && /Estimate: none shown/.test(reviewSend.text) && /Flags\n- Weight/.test(reviewSend.text) && reviewSend.replyIsCustomer);
  const shedSaved = quoteFile.length >= 0 && JSON.parse(fs.readFileSync(path.join(dataDir, 'quotes.json'), 'utf8')).find((q) => q.id === shedQuote.body.reference);
  const shedLine = shedSaved && (shedSaved.estimate.lines || []).find((l) => l.label === 'Distance: 90 km × $3.00/km (8 ft wide shed)');
  check('shed alert includes width x length, mule yes, and the mule note, without a weight', shedQuote.body.done === true && shedSend && shedSend.toIsOwner && shedSend.replyIsCustomer && shedSend.text.includes("Shed size: 8' x 12'") && shedSend.text.includes('Shed mule: Yes') && shedSend.text.includes('Check with dispatcher for mule pricing.') && !/^Weight:/m.test(shedSend.text) && shedSaved && shedSaved.shipment.shedWidthFt === 8 && shedSaved.shipment.shedLengthFt === 12 && shedSaved.shipment.shedSize === "8' x 12'" && shedSaved.shipment.shedMule === true && shedSaved.shipment.muleNote === 'Check with dispatcher for mule pricing.' && shedSaved.shipment.weightLbs == null && shedLine && shedLine.amount === 270 && !(shedSaved.estimate.lines || []).some((l) => /Heavy load/.test(l.label)));
  const savedNo = JSON.parse(fs.readFileSync(path.join(dataDir, 'quotes.json'), 'utf8')).find((q) => q.id === shedNo.body.reference);
  const noLine = savedNo && (savedNo.estimate.lines || []).find((l) => l.label === 'Distance: 40 km × $3.50/km (10 ft wide shed)');
  check('shed alert with mule no omits the mule pricing note', shedNo.body.done === true && shedNoSend && shedNoSend.text.includes("Shed size: 10' x 24'") && shedNoSend.text.includes('Shed mule: No') && !shedNoSend.text.includes('Check with dispatcher for mule pricing.') && noLine && noLine.amount === 140 && savedNo.estimate.minimumApplied === true && savedNo.estimate.subtotal === 350);
  check('contact alert goes to dispatch with reply-to set', contactSend && contactSend.toIsOwner && contactSend.replyIsCustomer && contactSend.text.includes(`Message reference: ${messages[0].id}`) && contactSend.text.includes('Need a call about the lane.') && contactSend.text.includes('Phone: 5195550199'));

  const logs = fs.readFileSync(server.out, 'utf8') + fs.readFileSync(server.err, 'utf8');
  check('quote and contact sends are logged by reference only', logs.includes(`[mailer] sent ref=${ref} mode=resend`) && logs.includes(`[mailer] sent ref=${messages[0].id} mode=resend`) && !logs.includes(CUSTOMER) && !logs.includes(API_KEY));

  const auth = { Authorization: 'Basic ' + Buffer.from('admin:isolated-test-only').toString('base64') };
  const admin = await (await fetch(`http://127.0.0.1:${server.port}/admin/api/quotes`, { headers: auth })).json();
  check('admin shows mail as enabled while Resend is configured', admin.emailEnabled === true && admin.quotes.length === 4 && admin.messages.length === 1);
  const adminHtml = await (await fetch(`http://127.0.0.1:${server.port}/admin`, { headers: auth })).text();
  check('admin page names Resend as the way to turn alerts on', adminHtml.includes('RESEND_API_KEY') && !adminHtml.includes('set SMTP_* variables'));
  await stop(server.child);

  const failDir = path.join(os.tmpdir(), `jf-http-fail-${Date.now()}`, 'data');
  const failing = await startServer(failDir, { RESEND_API_KEY: API_KEY, MAIL_FROM: FROM, NOTIFY_TO: OWNER, MOCK_MAIL_MODE: 'fail' });
  const failedQuote = await submitQuote(failing.port, ['Listowel, ON', 'Stratford, ON', 'container20', '8000 lbs', 'Flexible', 'none', '50 km', 'intent:request', 'Test Person', '5195550199', CUSTOMER]);
  const failLogs = fs.readFileSync(failing.out, 'utf8') + fs.readFileSync(failing.err, 'utf8');
  const saved = JSON.parse(fs.readFileSync(path.join(failDir, 'quotes.json'), 'utf8'));
  check('a failed alert still keeps the quote and logs the reference', failedQuote.body.done === true && saved[0].id === failedQuote.body.reference && failLogs.includes(`[mailer] failed ref=${failedQuote.body.reference} mode=resend error=HTTP 422`) && !failLogs.includes(CUSTOMER));
  await stop(failing.child);

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS', e && e.message ? e.message : e);
  process.exit(1);
});
