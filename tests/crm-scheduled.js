// Booked jobs live in Scheduled, and a later customer reply still needs an answer.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-sched-'));
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

(async () => {
  const existing = leads.create({ source: 'phone', name: 'Bea Booked', phone: '519-555-0177', message: 'Already booked', status: 'Booked' }, { defaultSource: 'phone' });
  check('an existing Booked quote is in Scheduled', leads.folderOf(leads.find(existing.lead.id)) === 'scheduled' && leads.folderCounts().scheduled === 1);

  const made = leads.create({
    source: 'website', name: 'Jane Tester', email: 'jane@example.ca', phone: '519-555-0100',
    message: 'Need a container moved', pickup: 'Listowel, ON', dropoff: 'Barrie, ON', loadType: '20 ft container',
  }, { defaultSource: 'website' });
  store.update('leads', made.lead.id, { createdAt: ago(120) });
  leads.ensureThread(made.lead.id);
  const bad = leads.scheduleLead(made.lead.id, 'not-a-date');
  const scheduled = leads.scheduleLead(made.lead.id, '2026-11-25');
  const job = leads.find(made.lead.id);
  check('Mark scheduled uses Booked, keeps the job date, and leaves the reminder', bad && bad.error && job.status === 'Booked' && job.jobDate === '2026-11-25' && job.statusBeforeSchedule === 'New' && leads.folderOf(job) === 'scheduled' && !leads.needsReply({ minutes: 0 }).leads.some((row) => row.id === job.id) && !leads.needsAttention(job));

  leads.addTimeline(job.id, { kind: 'email', direction: 'in', subject: 'Re: container', body: 'Can we do Friday instead?', at: ago(40), externalId: 'in-friday', messageId: '<friday@mail.test>' });
  const replied = leads.find(job.id);
  const due = leads.needsReply({ minutes: 30 });
  const row = due.leads.find((item) => item.id === job.id);
  const thread = leads.threadItems(replied).map((item) => item.body);
  check('a reply on a scheduled job stays in the thread and moves to New replies', leads.folderOf(replied) === 'replies' && thread.some((body) => body.includes('Friday instead')) && row && row.waitingMinutes >= 39 && row.waitingMinutes <= 41 && leads.folderCounts().scheduled === 1);

  leads.addTimeline(job.id, { kind: 'email', direction: 'out', subject: 'Re: container', body: 'Friday works.', at: ago(5), externalId: 'out-friday' });
  const back = leads.find(job.id);
  check('answering puts the booked job back in Scheduled and stops the reminder', leads.folderOf(back) === 'scheduled' && back.status === 'Booked' && !leads.needsReply({ minutes: 0 }).leads.some((item) => item.id === job.id));

  const undone = leads.unscheduleLead(job.id);
  check('Move back restores the previous status', undone.status === 'New' && undone.jobDate === '' && leads.folderOf(undone) !== 'scheduled');

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
