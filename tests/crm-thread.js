// Matching a reply to the right lead, skipping a second copy, and hiding quoted history.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-thread-'));
process.env.DATA_DIR = dataDir;
process.env.OPENAI_API_KEY = '';
process.env.RESEND_API_KEY = '';
process.env.MS_CLIENT_ID = '';
process.env.AI_AUTOREPLY_ENABLED = 'false';

const leads = require('../server/leads');
const inbound = require('../server/inbound-email');
const thread = require('../server/thread');
const store = require('../server/store');
const settings = require('../server/crm-settings');

let failed = 0;
function check(name, cond, detail) {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const quoted = thread.stripQuoted('Thursday still works.\n\nOn Tue, Nov 18, 2026 at 9:01 AM JF Hauling wrote:\n> We can move it Thursday.\n\nJohan Friesen\nJF Hauling · Pickup & Gooseneck Flat Deck Hauling');
  const original = thread.stripQuoted('Please call me.\n-----Original Message-----\nFrom: JF Hauling\nSent: Monday');
  check('quoted history and the signature are stripped, and the original is kept', quoted.clean === 'Thursday still works.' && quoted.full.includes('Johan Friesen') && original.clean === 'Please call me.' && original.full.includes('Original Message'));

  const closed = leads.create({ source: 'email', name: 'Old Jane', email: 'jane@example.ca', phone: '519-555-0100', message: 'Old quote' }, { defaultSource: 'email' });
  store.update('leads', closed.lead.id, { status: 'Closed', updatedAt: new Date(Date.now() + 5000).toISOString() });
  const open = leads.create({ source: 'website', name: 'Jane Tester', email: 'Jane@Example.ca', phone: '5195550100', message: 'Need a 20 ft container from Listowel to Barrie' }, { defaultSource: 'website' });
  check('an email matches the open lead, not a newer closed one with the same address', leads.matchLead({ email: 'jane@example.ca' }).id === open.lead.id);
  check('a phone matches that same open lead', leads.matchLead({ phone: '+1 (519) 555-0100' }).id === open.lead.id);

  const other = leads.create({ source: 'email', name: 'Other', email: 'other@example.ca', message: 'Different job' }, { defaultSource: 'email' });
  const tagged = await inbound.receive({
    external_id: 'resend-1',
    from_email: 'someone.else@example.ca',
    subject: 'Re: container',
    body_text: quoted.full,
    internet_message_id: '<reply-1@mail.test>',
    lead_id: open.lead.id,
    attachments: [{ filename: 'gate-photo.jpg', content_type: 'image/jpeg' }],
  });
  const lead = leads.find(open.lead.id);
  const reply = (lead.timeline || []).find((item) => item.externalId === 'resend-1');
  check('a plus-tag files the reply on that lead with the clean text and the attachment', tagged.lead_id === open.lead.id && tagged.created === false && reply && reply.body === 'Thursday still works.' && reply.bodyFull.includes('wrote:') && reply.attachments[0].filename === 'gate-photo.jpg' && lead.unread === true && !leads.all().some((row) => row.email === 'someone.else@example.ca'));

  const again = await inbound.receive({
    external_id: 'outlook-graph-id',
    from_email: 'jane@example.ca',
    subject: 'Re: container',
    body_text: 'Thursday still works.',
    internet_message_id: '<reply-1@mail.test>',
  });
  check('the Outlook copy of the same Message-ID is a duplicate', again.duplicate === true && (leads.find(open.lead.id).timeline || []).filter((item) => item.messageId === '<reply-1@mail.test>').length === 1);

  const first = leads.ensureThread(open.lead.id);
  const second = leads.ensureThread(open.lead.id);
  const origins = (second.timeline || []).filter((item) => item.externalId === `origin:${open.lead.id}`);
  check('the original quote is added once', origins.length === 1 && origins[0].body.includes('Listowel') && origins[0].subject === 'Quote request' && (first.timeline || []).filter((item) => item.externalId === `origin:${open.lead.id}`).length === 1);
  check('the thread is chronological and the list snippet is the latest reply', leads.threadItems(second)[0].externalId === `origin:${open.lead.id}` && leads.lastSnippet(second).includes('Thursday still works.') && leads.matchLead({ leadId: other.lead.id, email: 'jane@example.ca' }).id === other.lead.id);
  settings.write({ emailText: 'Custom Signoff Line From Johan' });
  const custom = thread.stripQuoted('See you then.\n\nCustom Signoff Line From Johan\nmore quoted mail');
  check('an edited email signature is stripped from the displayed reply', custom.clean === 'See you then.' && custom.full.includes('Custom Signoff'));

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
