// End-to-end API test of the quote assistant. Usage: BASE=http://localhost:3000 ADMIN_PASSWORD=... node tests/e2e.js
const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN = process.env.ADMIN_PASSWORD || 'change-me';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔', m); } else { fail++; console.log('  ✘', m); } };
const post = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) })).json();

async function convo(title, answers) {
  console.log('\n▶ ' + title);
  let r = await post('/api/chat/start');
  const sid = r.sessionId; const log = [r];
  for (const a of answers) {
    r = await post('/api/chat', { sessionId: sid, text: a });
    log.push(r);
    console.log(`    > ${a}\n      [${r.step}] ${r.messages.join(' | ').replace(/\n/g, ' ').slice(0, 160)}`);
  }
  return { r, log };
}
const future = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);

(async () => {
  // 1. Happy path: 40 ft container, real routing
  let { r, log } = await convo('Happy path — 40 ft container Listowel → Stratford', ['Jane Tester', 'Acme Farms', 'not-an-email', 'jane@example.ca', '519 555 0100', 'Listowel, ON', 'Stratford, ON', 'container40', '18,000 lbs', future, 'Tailgate needed']);
  ok(log.some((x) => x.step === 'email' && /valid email/.test(x.messages[0])), 'invalid email rejected and re-asked');
  ok(r.step === 'review', 'reached review step');
  ok(r.estimate && r.estimate.low > 0 && r.estimate.high > r.estimate.low, `ballpark estimate shown ($${r.estimate?.low}–$${r.estimate?.high})`);
  ok(/ballpark/i.test(r.messages.join(' ')) && /dispatcher/i.test(r.messages.join(' ')), 'labelled ballpark pending dispatcher');
  ok(/km/.test(r.messages.join(' ')), 'distance computed via routing');
  r = await post('/api/chat', { sessionId: r.sessionId, text: 'submit' });
  ok(r.step === 'done' && /^Q-/.test(r.reference || ''), 'submitted, reference ' + r.reference);
  const ref1 = r.reference;

  // 2. Over-limit weight → continue for dispatcher review
  ({ r, log } = await convo('Over-limit weight (25,000 lbs) → dispatcher review', ['Bob Heavy', 'skip', 'bob@example.ca', '226-555-0199', 'Listowel', 'Kitchener, ON', 'general', '30 ft', '25000 lbs']));
  ok(r.step === 'overLimit' && /20,000 lbs/.test(r.messages[0]) && /call/i.test(r.messages[0]), 'weight over 20,000 lbs politely flagged, call offered');
  ({ r } = await (async () => { const x = await post('/api/chat', { sessionId: r.sessionId, text: 'limit:continue' }); return { r: x }; })());
  ok(r.step === 'pickupDate', 'continued to remaining questions');
  r = await post('/api/chat', { sessionId: r.sessionId, text: 'ASAP' });
  r = await post('/api/chat', { sessionId: r.sessionId, text: 'none' });
  ok(r.step === 'review' && !r.estimate && /Needs dispatcher review/.test(r.messages.join(' ')), 'no estimate given for over-limit load; flagged');
  r = await post('/api/chat', { sessionId: r.sessionId, text: 'submit' });
  ok(r.step === 'done', 'flagged request submitted ' + r.reference);
  const ref2 = r.reference;

  // 3. Over-limit length: 53 ft container → retry with 20 ft; 45 ft general → metric retry; manual km fallback
  ({ r, log } = await convo('Over-limit length → corrected; unmappable address → km fallback', ['Al Long', 'Long Co', 'al@example.ca', '5195550111', 'Zzqxv Nowhere Lane 99999', 'Qqzzx Imaginary Place', '53 ft container', 'limit:retry', 'general', '45 ft', '11 m', '9 tonnes', 'tomorrow', 'hazmat - class 3']));
  ok(log.some((x) => x.step === 'overLimit' && /40 ft/.test(x.messages[0])), '53 ft container flagged as over 40 ft');
  ok(log.filter((x) => x.step === 'overLimit').length >= 2, '45 ft general freight flagged as over 40 ft');
  ok(r.step === 'km' || r.step === 'review', 'reached distance step (' + r.step + ')');
  if (r.step === 'km') {
    r = await post('/api/chat', { sessionId: r.sessionId, text: 'about 120 km' });
    ok(r.step === 'review' && r.estimate, 'manual km fallback produced estimate');
  }
  ok(r.estimate && r.estimate.special.includes('hazmat'), 'hazmat surcharge applied from notes');
  ok(/19,842 lbs/.test(r.messages.join(' ')), '9 tonnes converted to 19,842 lbs (under limit)');
  r = await post('/api/chat', { sessionId: r.sessionId, text: 'submit' });
  ok(r.step === 'done', 'submitted ' + r.reference);

  // 4. Edit from review
  ({ r } = await convo('Edit weight from review', ['Ed Edit', 'skip', 'ed@example.ca', '5195550122', 'Listowel', 'Palmerston, ON', 'container20', '8000 kg', 'Flexible', 'none', 'edit:weightLbs', '21000']));
  ok(r.step === 'overLimit', 'editing weight to 21,000 lbs re-triggers limit check');
  r = await post('/api/chat', { sessionId: r.sessionId, text: '15000' });
  ok(r.step === 'review' && r.estimate, 'corrected weight returns to review with estimate');

  // 5. Admin
  const auth = { Authorization: 'Basic ' + Buffer.from('admin:' + ADMIN).toString('base64') };
  const no = await fetch(BASE + '/admin/api/quotes');
  ok(no.status === 401, 'admin API requires password');
  const a = await (await fetch(BASE + '/admin/api/quotes', { headers: auth })).json();
  ok(a.quotes.some((q) => q.id === ref1) && a.quotes.some((q) => q.id === ref2 && q.status === 'needs review'), 'admin lists saved requests (flagged one = "needs review")');
  const csv = await (await fetch(BASE + '/admin/quotes.csv', { headers: auth })).text();
  ok(csv.includes(ref1), 'CSV export includes request');
  const c = await (await fetch(BASE + '/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Contact Test', email: 'c@example.ca', message: 'Hello there, test message' }) })).json();
  ok(c.ok, 'contact form saved');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
