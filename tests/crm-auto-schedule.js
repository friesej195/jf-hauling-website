// An outgoing email books a job only when it confirms one date.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-auto-'));
process.env.DATA_DIR = dataDir;
process.env.OPENAI_API_KEY = '';
process.env.RESEND_API_KEY = '';
process.env.MS_CLIENT_ID = '';

const config = require('../config');
const leads = require('../server/leads');
const store = require('../server/store');
const autoSchedule = require('../server/auto-schedule');

let failed = 0;
function check(name, cond, detail) {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const FRIDAY = new Date('2026-11-20T20:00:00.000Z');
const SIGNATURE = '\n\nJohn Friesen\nJF Hauling · Pickup & Gooseneck Flat Deck Hauling\n226-545-1745 · jfhauling@outlook.com\njfhauling.ca';

async function detect(text, now = FRIDAY) {
  const found = await autoSchedule.detectConfirmedDate(text, { now });
  return found.confirmed ? found.date : '';
}

(async () => {
  check('a booked weekday and calendar date is that date', await detect("we're booked for Thursday Nov 26") === '2026-11-26');
  check('see you with a time keeps the date', await detect('see you Dec 2 at 9am') === '2026-12-02');
  check('scheduled for Monday is the next Monday', await detect('scheduled for Monday') === '2026-11-23');
  check('a numeric pickup date is month then day', await detect('pickup is set for 12/03') === '2026-12-03');
  check('tomorrow uses the Toronto send date', await detect('see you tomorrow', new Date('2026-11-21T04:30:00.000Z')) === '2026-11-21');
  check('tomorrow moves forward after midnight in Toronto', await detect('see you tomorrow', new Date('2026-11-21T05:30:00.000Z')) === '2026-11-22');
  check('a past month rolls to the next year', await detect('see you Dec 2', new Date('2026-12-15T15:00:00.000Z')) === '2027-12-02');

  check('a choice of dates is not a booking', await detect('I could do Dec 2 or Dec 3, which works?') === '');
  check('asking if they are free is not a booking', await detect('are you available Friday?') === '');
  check('a quote expiry is not a booking', await detect('quote valid until Dec 1') === '');
  check('a message with no date is not a booking', await detect("Thanks, I'll send the price.") === '');
  check('a date with no booking words is not a booking', await detect("I'll send the price tomorrow") === '');

  check('the signature and a quoted reply do not supply the date', await detect(`Thanks for the note.${SIGNATURE}\n\nWe're booked for Thursday Nov 26`) === '' && await detect('Thanks for the update.\n\nOn Fri, Nov 20, 2026 at 1:00 PM Jane Tester <jane@example.ca> wrote:\nWe\'re booked for Thursday Nov 26') === '');
  check('a date above the signature still counts', await detect(`We're booked for Thursday Nov 26.${SIGNATURE}`) === '2026-11-26');

  const made = leads.create({
    source: 'website', name: 'Jane Tester', email: 'jane@example.ca', phone: '519-555-0100', message: 'Need a container moved',
  }, { defaultSource: 'website' });
  store.update('leads', made.lead.id, { createdAt: ago(120) });
  check('the open quote is waiting on a reply', leads.needsReply({ minutes: 30 }).leads.some((row) => row.id === made.lead.id));
  const booked = await autoSchedule.apply(made.lead.id, "we're booked for Thursday Nov 26", { channel: 'email', now: FRIDAY });
  const job = leads.find(made.lead.id);
  const note = (job.timeline || []).map((item) => item.body).join('\n');
  check('the email books the job, records the note, and stops the reminder', booked.scheduled && booked.date === '2026-11-26' && job.status === 'Booked' && job.jobDate === '2026-11-26' && leads.folderOf(job) === 'scheduled' && note.includes('Auto-scheduled for Thu Nov 26 from your email') && !leads.needsReply({ minutes: 0 }).leads.some((row) => row.id === job.id) && !leads.needsAttention(job));
  const undone = leads.undoMove(job.id);
  check('undo puts the quote back', undone.status === 'New' && undone.jobDate === '' && leads.folderOf(undone) !== 'scheduled');

  leads.scheduleLead(made.lead.id, '2026-11-25');
  const moved = await autoSchedule.apply(made.lead.id, 'see you Dec 2 at 9am', { channel: 'email', now: FRIDAY });
  const updated = leads.find(made.lead.id);
  check('a later email updates the job date', moved.scheduled && updated.status === 'Booked' && updated.jobDate === '2026-12-02' && (updated.timeline || []).some((item) => item.body.includes('Auto-scheduled for Wed Dec 2 from your email')));
  const restored = leads.undoMove(updated.id);
  check('undo restores the previous job date', restored.status === 'Booked' && restored.jobDate === '2026-11-25');

  const beforeNotes = (leads.find(made.lead.id).timeline || []).length;
  const same = await autoSchedule.apply(made.lead.id, 'see you Nov 25', { channel: 'email', now: FRIDAY });
  check('the same date does not book it again', same.reason === 'same' && same.scheduled === false && (leads.find(made.lead.id).timeline || []).length === beforeNotes);

  const texted = leads.create({ source: 'phone', name: 'Sam Text', phone: '519-555-0199', message: 'Call me' }, { defaultSource: 'phone' });
  const text = await autoSchedule.apply(texted.lead.id, 'pickup is set for 12/03', { channel: 'sms', now: FRIDAY });
  const textLead = leads.find(texted.lead.id);
  check('a text uses the same booking', text.scheduled && textLead.jobDate === '2026-12-03' && (textLead.timeline || []).some((item) => item.body.includes('from your text')));

  const closed = leads.create({ source: 'email', name: 'Cara Closed', email: 'cara@example.ca', message: 'No thanks' }, { defaultSource: 'email' });
  leads.closeLead(closed.lead.id, { reason: 'Not interested', by: 'owner' });
  const skipped = await autoSchedule.apply(closed.lead.id, "we're booked for Thursday Nov 26", { channel: 'email', now: FRIDAY });
  const still = leads.find(closed.lead.id);
  check('a closed quote is never auto-scheduled', skipped.reason === 'closed' && still.status === 'Closed' && !still.jobDate);

  const asked = leads.create({ source: 'website', name: 'Quinn Question', email: 'quinn@example.ca', message: 'Need a date' }, { defaultSource: 'website' });
  const offer = await autoSchedule.apply(asked.lead.id, 'I could do Dec 2 or Dec 3, which works?', { channel: 'email', now: FRIDAY });
  check('an offer leaves the quote where it is', offer.scheduled === false && leads.find(asked.lead.id).status !== 'Booked');

  config.llm.apiKey = 'sk-test';
  const calls = [];
  function modelFetch(verdict, { fail = false } = {}) {
    return async (url) => {
      calls.push(String(url));
      if (fail) throw new Error('offline');
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }), { status: 200 });
    };
  }
  const agreed = await autoSchedule.detectConfirmedDate("we're booked for Thursday Nov 26", { now: FRIDAY, fetchImpl: modelFetch({ confirmed: true, date: '2026-11-26' }) });
  const vetoed = await autoSchedule.detectConfirmedDate("we're booked for Thursday Nov 26", { now: FRIDAY, fetchImpl: modelFetch({ confirmed: false, date: '' }) });
  const invented = await autoSchedule.detectConfirmedDate("we're booked for Thursday Nov 26", { now: FRIDAY, fetchImpl: modelFetch({ confirmed: true, date: '2026-01-01' }) });
  const offline = await autoSchedule.detectConfirmedDate('see you Dec 2 at 9am', { now: FRIDAY, fetchImpl: modelFetch({}, { fail: true }) });
  const before = calls.length;
  await autoSchedule.detectConfirmedDate('are you available Friday?', { now: FRIDAY, fetchImpl: modelFetch({ confirmed: true, date: '2026-11-20' }) });
  await autoSchedule.detectConfirmedDate("Thanks, I'll send the price.", { now: FRIDAY, fetchImpl: modelFetch({ confirmed: true, date: '2026-11-26' }) });
  check('OpenAI can agree, and a no, a made-up date, or an error does not book', agreed.confirmed && agreed.date === '2026-11-26' && !vetoed.confirmed && !invented.confirmed && !offline.confirmed);
  check('questions and dateless mail skip the model', calls.length === before);
  config.llm.apiKey = '';

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
