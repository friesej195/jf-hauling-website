// Home-screen badge: unopened New leads plus leads still waiting on a reply.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-badge-'));
process.env.DATA_DIR = dataDir;
process.env.OPENAI_API_KEY = '';
process.env.RESEND_API_KEY = '';
process.env.MS_CLIENT_ID = '';

const leads = require('../server/leads');
const push = require('../server/push');

let failed = 0;
function check(name, cond) {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
}

(async () => {
  const fresh = leads.create({ source: 'website', name: 'New Nora', email: 'nora@example.ca', message: 'Need a container' }, { defaultSource: 'website' });
  const waiting = leads.create({ source: 'email', name: 'Wait Will', email: 'will@example.ca', message: 'Any update?' }, { defaultSource: 'email' });
  leads.markOpened(waiting.lead.id);
  leads.addTimeline(waiting.lead.id, { kind: 'email', direction: 'out', subject: 'Re: quote', body: 'We can look Thursday.' });
  leads.addTimeline(waiting.lead.id, { kind: 'email', direction: 'in', subject: 'Thursday', body: 'Thursday works.', at: new Date(Date.now() + 1000).toISOString() });
  const replied = leads.create({ source: 'email', name: 'Done Dana', email: 'dana@example.ca', message: 'Quote please' }, { defaultSource: 'email' });
  leads.addTimeline(replied.lead.id, { kind: 'email', direction: 'out', subject: 'Re: Quote', body: 'Sent a price.' });
  const booked = leads.create({ source: 'phone', name: 'Bea Booked', phone: '519-555-0101', message: 'Booked', status: 'Booked' }, { defaultSource: 'phone' });
  const lost = leads.create({ source: 'email', name: 'Lou Lost', email: 'lou@example.ca', message: 'No', status: 'Lost' }, { defaultSource: 'email' });
  check('the badge counts each new or waiting lead once and skips booked, lost, and replied', leads.attentionCount() === 2 && leads.needsAttention(leads.find(fresh.lead.id)) && leads.needsAttention(leads.find(waiting.lead.id)) && !leads.needsAttention(leads.find(replied.lead.id)) && !leads.needsAttention(leads.find(booked.lead.id)) && !leads.needsAttention(leads.find(lost.lead.id)));
  leads.closeLead(fresh.lead.id, { reason: 'Not interested', by: 'owner' });
  check('closing a new lead drops it from the badge', leads.attentionCount() === 1 && !leads.needsAttention(leads.find(fresh.lead.id)));

  const notices = [];
  push.setSender(async (_sub, payload) => { notices.push(payload); });
  push.save({ endpoint: 'https://push.example/badge', keys: { p256dh: 'k', auth: 'a' } });
  await push.notifyInbound(leads.find(waiting.lead.id), 'email', 'Thursday works.');
  check('every push carries the current badge count', notices.length === 1 && notices[0].badge === 1 && notices[0].body.startsWith('Email from Wait'));
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
