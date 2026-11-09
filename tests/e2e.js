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
  const auth = { Authorization: 'Basic ' + Buffer.from('admin:' + ADMIN).toString('base64') };
  const adminQuotes = async () => (await (await fetch(BASE + '/admin/api/quotes', { headers: auth })).json()).quotes;
  const started = await post('/api/chat/start');
  ok(started.step === 'pickup' && !/what's your name/i.test(started.messages.join(' ')), 'starts by asking for the pickup, not a name');

  // 1. Happy path: load first, estimate immediately, contact only when they request the quote
  let { r, log } = await convo('Happy path — 40 ft container Listowel → Stratford', ['Listowel, ON', 'Stratford, ON', 'container40', '18,000 lbs', future, 'Tailgate needed']);
  const reviewIdx = log.findIndex((x) => x.step === 'review' && x.estimate);
  const contactIdx = log.findIndex((x) => x.step === 'name' || x.step === 'phone' || x.step === 'email');
  ok(r.step === 'review', 'reached the estimate before any contact details');
  ok(reviewIdx !== -1 && contactIdx === -1, 'name, phone and email are not asked before the estimate');
  ok(r.estimate && r.estimate.low > 0 && r.estimate.high > r.estimate.low, `ballpark estimate shown ($${r.estimate?.low}–$${r.estimate?.high})`);
  ok(/ballpark/i.test(r.messages.join(' ')) && /dispatcher/i.test(r.messages.join(' ')), 'labelled ballpark pending dispatcher');
  ok(/km/.test(r.messages.join(' ')), 'distance computed via routing');
  ok((r.quickReplies || []).some((q) => q.label === 'Request this quote') && (r.quickReplies || []).some((q) => q.label === 'Ask for more info'), 'offers request and more-info after the estimate');
  const beforeSave = (await adminQuotes()).map((q) => q.id).sort().join();
  r = await post('/api/chat', { sessionId: r.sessionId, text: 'submit' });
  ok(r.step === 'review' && !r.reference, 'typing submit on the estimate does not send it');
  const still = (await adminQuotes()).map((q) => q.id).sort().join();
  ok(still === beforeSave, 'estimate-only lookup is not saved');
  r = await post('/api/chat', { sessionId: r.sessionId, text: 'intent:request' });
  ok(r.step === 'name', 'requesting the quote asks for a name');
  r = await post('/api/chat', { sessionId: r.sessionId, text: 'Jane Tester' });
  ok(r.step === 'phone', 'phone is required next');
  r = await post('/api/chat', { sessionId: r.sessionId, text: '519 555 0100' });
  ok(r.step === 'email', 'email is required next');
  r = await post('/api/chat', { sessionId: r.sessionId, text: 'not-an-email' });
  ok(r.step === 'email' && /valid email/.test(r.messages[0]), 'invalid email rejected and re-asked');
  r = await post('/api/chat', { sessionId: r.sessionId, text: 'jane@example.ca' });
  ok(r.step === 'done' && /^Q-/.test(r.reference || ''), 'submitted only after contact details, reference ' + r.reference);
  const ref1 = r.reference;

  // 2. Over-limit weight → continue for dispatcher review, then contact to send
  ({ r, log } = await convo('Over-limit weight (25,000 lbs) → dispatcher review', ['Listowel', 'Kitchener, ON', 'general', '30 ft', '25000 lbs']));
  ok(r.step === 'overLimit' && /20,000 lbs/.test(r.messages[0]) && /call/i.test(r.messages[0]), 'weight over 20,000 lbs politely flagged, call offered');
  ({ r } = await (async () => { const x = await post('/api/chat', { sessionId: r.sessionId, text: 'limit:continue' }); return { r: x }; })());
  ok(r.step === 'pickupDate', 'continued to remaining questions');
  r = await post('/api/chat', { sessionId: r.sessionId, text: 'ASAP' });
  r = await post('/api/chat', { sessionId: r.sessionId, text: 'none' });
  ok(r.step === 'review' && !r.estimate && /Needs dispatcher review/.test(r.messages.join(' ')), 'no estimate given for over-limit load; flagged');
  r = await post('/api/chat', { sessionId: r.sessionId, text: 'intent:request' });
  r = await post('/api/chat', { sessionId: r.sessionId, text: 'Bob Heavy' });
  r = await post('/api/chat', { sessionId: r.sessionId, text: '226-555-0199' });
  r = await post('/api/chat', { sessionId: r.sessionId, text: 'bob@example.ca' });
  ok(r.step === 'done', 'flagged request submitted with contact details ' + r.reference);
  const ref2 = r.reference;

  // 3. Over-limit length: 53 ft container → retry; 45 ft general → metric retry; manual km fallback
  const beforeKm = (await adminQuotes()).map((q) => q.id).sort().join();
  ({ r, log } = await convo('Over-limit length → corrected; unmappable address → km fallback', ['Zzqxv Nowhere Lane 99999', 'Qqzzx Imaginary Place', '53 ft container', 'limit:retry', 'general', '45 ft', '11 m', '9 tonnes', 'tomorrow', 'hazmat - class 3']));
  ok(log.some((x) => x.step === 'overLimit' && /40 ft/.test(x.messages[0])), '53 ft container flagged as over 40 ft');
  ok(log.filter((x) => x.step === 'overLimit').length >= 2, '45 ft general freight flagged as over 40 ft');
  ok(r.step === 'km' || r.step === 'review', 'reached distance step (' + r.step + ')');
  if (r.step === 'km') {
    r = await post('/api/chat', { sessionId: r.sessionId, text: 'about 120 km' });
    ok(r.step === 'review' && r.estimate, 'manual km fallback produced estimate');
  }
  ok(r.estimate && r.estimate.special.includes('hazmat'), 'hazmat surcharge applied from notes');
  ok(/19,842 lbs/.test(r.messages.join(' ')), '9 tonnes converted to 19,842 lbs (under limit)');
  ok((await adminQuotes()).map((q) => q.id).sort().join() === beforeKm, 'estimate with no contact is not saved');
  r = await post('/api/chat', { sessionId: r.sessionId, text: 'Ask for more info' });
  ok(r.step === 'name', 'asking for more info starts contact collection');
  r = await post('/api/chat', { sessionId: r.sessionId, text: 'Al Long' });
  r = await post('/api/chat', { sessionId: r.sessionId, text: '5195550111' });
  r = await post('/api/chat', { sessionId: r.sessionId, text: 'al@example.ca' });
  ok(r.step === 'done', 'more-info request submitted ' + r.reference);
  const ref3 = r.reference;

  // 4. Edit from review, still before contact details
  ({ r } = await convo('Edit weight from review', ['Listowel', 'Palmerston, ON', 'container20', '8000 kg', 'Flexible', 'none', 'edit:weightLbs', '21000']));
  ok(r.step === 'overLimit', 'editing weight to 21,000 lbs re-triggers limit check');
  r = await post('/api/chat', { sessionId: r.sessionId, text: '15000' });
  ok(r.step === 'review' && r.estimate, 'corrected weight returns to review with estimate');

  // 5. Admin — only the submitted requests, with contact details, are stored
  const no = await fetch(BASE + '/admin/api/quotes');
  ok(no.status === 401, 'admin API requires password');
  const a = await (await fetch(BASE + '/admin/api/quotes', { headers: auth })).json();
  const q1 = a.quotes.find((q) => q.id === ref1);
  const q2 = a.quotes.find((q) => q.id === ref2);
  const q3 = a.quotes.find((q) => q.id === ref3);
  ok(q1 && q1.customer.email === 'jane@example.ca' && q1.customer.phone && q1.customer.name === 'Jane Tester' && q1.intent === 'request', 'saved request includes contact details');
  ok(q2 && q2.status === 'needs review' && q2.customer.email === 'bob@example.ca', 'admin lists the flagged request');
  ok(q3 && q3.intent === 'more-info' && q3.customer.email === 'al@example.ca', 'more-info request saved with contact details');
  const csv = await (await fetch(BASE + '/admin/quotes.csv', { headers: auth })).text();
  ok(csv.includes(ref1), 'CSV export includes request');
  const c = await (await fetch(BASE + '/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Contact Test', email: 'c@example.ca', message: 'Hello there, test message' }) })).json();
  ok(c.ok, 'contact form saved');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
