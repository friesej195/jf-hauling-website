// CRM email and text signatures are appended once, including after an AI sign-off.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-sig-'));
process.env.DATA_DIR = dataDir;
process.env.RESEND_API_KEY = 're_test_not_real';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'twilio-test-token';
process.env.TWILIO_FROM_NUMBER = '+12265550100';
process.env.OPENAI_API_KEY = '';
process.env.MS_CLIENT_ID = '';
process.env.MAIL_FROM = 'JF Hauling Website <quotes@jfhauling.ca>';

const signature = require('../server/signature');
const settings = require('../server/crm-settings');
const mailer = require('../server/mailer');
const twilio = require('../server/twilio');
const ai = require('../server/ai-reply');

let failed = 0;
function check(name, cond, detail) {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const once = signature.composeEmail('We can move that container Thursday.');
  const twice = signature.composeEmail(once.text);
  check('an email gains the Outlook signature in HTML and plain text', once.html.includes('https://jfhauling.ca/img/brand/logo-160.png') && once.html.includes('Johan Friesen') && once.html.includes('Gooseneck Flat Deck Hauling') && once.text.startsWith('We can move that container Thursday.') && once.text.includes(signature.DEFAULT_EMAIL_TEXT));
  check('the email signature is not added twice', twice.text.split('Johan Friesen').length === 2 && twice.html.split('logo-160.png').length === 2);
  const stripped = signature.composeEmail('We can look Thursday.\n\nJF Hauling');
  const best = signature.composeEmail('Thanks for the note.\n\nBest, Johan');
  check('a trailing JF Hauling or Best, Johan sign-off is replaced by the signature', !/\nJF Hauling\s*$/.test(stripped.text.split(signature.DEFAULT_EMAIL_TEXT)[0]) && stripped.text.includes('We can look Thursday.') && !best.text.includes('Best, Johan') && best.text.includes('Thanks for the note.') && best.text.split('Johan Friesen').length === 2);

  const sms = signature.composeSms('Thursday works.');
  const smsAgain = signature.composeSms(sms);
  check('a text gains the short signature once', sms === 'Thursday works.\n- Johan, JF Hauling 226-545-1745 jfhauling.ca' && smsAgain === sms);

  const calls = [];
  await mailer.sendCustomer({
    to: 'jane@example.ca',
    subject: 'Re: container',
    text: 'We can move that container Thursday.\n\nBest, Johan',
    fetchImpl: async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      return new Response('{}', { status: 200 });
    },
  });
  check('a sent email carries HTML and a single plain-text signature', calls[0] && calls[0].html.includes('<img src="https://jfhauling.ca/img/brand/logo-160.png"') && calls[0].text.includes('We can move that container Thursday.') && calls[0].text.split('Johan Friesen').length === 2 && !calls[0].text.includes('Best, Johan'));

  let smsBody = '';
  await twilio.sendSms({
    to: '519-555-0100',
    body: 'Thursday works.',
    fetchImpl: async (_url, opts) => {
      smsBody = new URLSearchParams(String(opts.body)).get('Body');
      return new Response('{"sid":"SM1"}', { status: 201 });
    },
  });
  check('a sent text carries the short signature', smsBody === 'Thursday works.\n- Johan, JF Hauling 226-545-1745 jfhauling.ca');

  settings.write({ sms: '\n- JF' });
  check('an edited text signature is what gets sent', signature.composeSms('See you') === 'See you\n- JF' && settings.read().emailHtml.includes('logo-160.png'));
  check('the AI prompt does not ask for its own sign-off', !/Sign off as/.test(ai.systemPrompt({ name: 'Jane' })) && /added after your reply/i.test(ai.systemPrompt({ name: 'Jane' })));

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
