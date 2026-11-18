// A customer reply waits in New replies until Johan answers, including the 30-minute reminder.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-replies-'));
process.env.DATA_DIR = dataDir;
process.env.OPENAI_API_KEY = 'sk-test-not-real';
process.env.OPENAI_MODEL = 'gpt-4o-mini';
process.env.AI_AUTOREPLY_ENABLED = 'true';
process.env.RESEND_API_KEY = '';
process.env.MS_CLIENT_ID = '';

const leads = require('../server/leads');
const inbound = require('../server/inbound-email');
const store = require('../server/store');

let failed = 0;
function check(name, cond, detail) {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

(async () => {
  const made = leads.create({
    source: 'website', name: 'Jane Tester', email: 'jane@example.ca', phone: '519-555-0100',
    message: 'Need a container moved', pickup: 'Listowel, ON', dropoff: 'Barrie, ON', loadType: '20 ft container',
  }, { defaultSource: 'website' });
  store.update('leads', made.lead.id, { createdAt: ago(180) });
  leads.ensureThread(made.lead.id);
  const quote = leads.find(made.lead.id);
  check('a new quote stays in New until the customer writes back', leads.folderOf(quote) === 'new' && leads.folderCounts().replies === 0);

  leads.addTimeline(made.lead.id, { kind: 'email', direction: 'out', subject: 'Re: Quote request', body: 'We can do Thursday.', at: ago(90), externalId: 'out-1' });
  leads.addTimeline(made.lead.id, { kind: 'email', direction: 'in', subject: 'Re: Quote request', body: 'Thursday still works.', at: ago(40), externalId: 'in-reply-1', messageId: '<reply-1@mail.test>' });
  const waiting = leads.find(made.lead.id);
  const due = leads.needsReply({ minutes: 30, now: new Date() });
  const row = due.leads.find((item) => item.id === made.lead.id);
  check('a customer reply moves the quote to New replies and the reminder uses that reply time', leads.folderOf(waiting) === 'replies' && leads.folderCounts().replies === 1 && leads.needsAttention(waiting) && row && row.waitingMinutes >= 39 && row.waitingMinutes <= 41 && row.lastInboundPreview.includes('Thursday still works') && row.folder === 'replies');

  leads.addTimeline(made.lead.id, { kind: 'sms', direction: 'out', body: 'See you Thursday.', at: ago(5), externalId: 'out-sms-1' });
  const answered = leads.find(made.lead.id);
  check('sending a reply moves it back to Replied and stops the reminder', leads.folderOf(answered) === 'replied' && !leads.needsReply({ minutes: 0 }).leads.some((item) => item.id === made.lead.id));

  leads.addTimeline(made.lead.id, { kind: 'sms', direction: 'in', body: 'Can you come Friday instead?', at: ago(50), externalId: 'in-sms-1' });
  // The Friday text is older than the outbound we just stored at 5 minutes ago, so it is already answered.
  leads.addTimeline(made.lead.id, { kind: 'sms', direction: 'in', body: 'Actually Friday morning.', at: ago(2), externalId: 'in-sms-2' });
  const again = leads.find(made.lead.id);
  check('a newer text puts the quote back in New replies', leads.folderOf(again) === 'replies' && leads.needsReply({ minutes: 0 }).leads.some((item) => item.id === made.lead.id && item.lastInboundChannel === 'sms'));

  leads.setReplyFolder(made.lead.id, 'replied');
  const marked = leads.find(made.lead.id);
  check('Mark replied moves it to Replied and the 30-minute reminder stops', leads.folderOf(marked) === 'replied' && !leads.needsReply({ minutes: 0 }).leads.some((item) => item.id === made.lead.id));
  leads.setReplyFolder(made.lead.id, 'replies');
  check('the quote can be moved back to New replies', leads.folderOf(leads.find(made.lead.id)) === 'replies');

  const decline = await inbound.receive({
    external_id: 'in-no',
    from_email: 'jane@example.ca',
    subject: 'No thanks',
    body_text: 'No thanks, we went with someone else.',
    internet_message_id: '<no-thanks@mail.test>',
  }, {
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ not_interested: true, interested: false, confidence: 0.95, reason: 'went with someone else' }) } }] }), { status: 200 }),
  });
  const closed = leads.find(made.lead.id);
  check('a not-interested reply goes to Closed, not New replies', decline.auto_replied === false && closed.status === 'Closed' && leads.folderOf(closed) === 'closed' && leads.folderCounts().replies === 0);

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
