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
  const pricing = require('../server/pricing');
  const rates = require('../config').pricing.shedPerKmByWidth;
  ok(rates[8] === 3 && rates[10] === 3.5 && rates[12] === 5 && rates[14] === 8, 'shed per-km rates are $3.00, $3.50, $5.00 and $8.00');
  function shedPrice(width, loadedKm, deadheadKm, weightLbs) {
    return pricing.estimate({ freightType: 'shed', shedWidthFt: width, weightLbs, loadedKm, deadheadKm, notes: '' });
  }
  const twelve = shedPrice(12, 100, 0, 20000);
  ok(twelve.lines.some((l) => l.label === 'Distance: 100 km × $5.00/km (12 ft wide shed)' && l.amount === 500), '12 ft shed distance line is km × $5.00');
  ok(twelve.lines.some((l) => l.label === 'Base fee' && l.amount === 150), 'shed estimate keeps the base fee');
  ok(!twelve.lines.some((l) => /Heavy load|Container surcharge|mule/i.test(l.label)), 'shed estimate has no weight, container, or mule charge');
  ok(twelve.subtotal === 650 && twelve.low === 550 && twelve.high === 750 && twelve.taxNote === 'plus applicable HST' && !twelve.minimumApplied, '12 ft shed keeps the range and HST note');
  ok(shedPrice(8, 100, 0).lines.some((l) => l.label === 'Distance: 100 km × $3.00/km (8 ft wide shed)' && l.amount === 300), '8 ft shed distance is $3.00/km');
  ok(shedPrice(10, 100, 0).lines.some((l) => l.label === 'Distance: 100 km × $3.50/km (10 ft wide shed)' && l.amount === 350), '10 ft shed distance is $3.50/km');
  ok(shedPrice(14, 100, 0).lines.some((l) => l.label === 'Distance: 100 km × $8.00/km (14 ft wide shed)' && l.amount === 800), '14 ft shed distance is $8.00/km');
  const withTravel = shedPrice(10, 100, 80);
  ok(withTravel.lines.some((l) => l.label === 'Travel to pickup: 30 km × $1.25/km' && l.amount === 37.5), 'shed estimates still charge deadhead beyond the free kilometres');
  const tiny = shedPrice(8, 1, 0);
  ok(tiny.minimumApplied && tiny.subtotal === 350 && tiny.lines.some((l) => l.label === 'Distance: 1 km × $3.00/km (8 ft wide shed)'), 'shed estimates still use the minimum charge');
  const general = pricing.estimate({ freightType: 'general', weightLbs: 4000, loadedKm: 100, deadheadKm: 0, notes: '' });
  ok(general.lines.some((l) => l.label === 'Distance: 100 km × $2.75/km' && l.amount === 275), 'general freight still uses the standard per-km rate');
  const heavy = pricing.estimate({ freightType: 'general', weightLbs: 12000, loadedKm: 100, deadheadKm: 0, notes: '' });
  ok(heavy.lines.some((l) => /Heavy load/.test(l.label)), 'general freight still gets a heavy-weight charge');

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

  // Sheds: width, then length, then mule. No weight and no free-form length.
  // Price stays the same as general freight for the same distance (weight is not collected, so no heavy surcharge).
  ({ r } = await convo('Freight options', ['Listowel, ON', 'Stratford, ON']));
  const labels = (r.quickReplies || []).map((q) => q.label);
  ok(labels.indexOf('40 ft container') !== -1 && labels.indexOf('40 ft container') < labels.indexOf('Sheds') && labels.indexOf('Sheds') < labels.indexOf('General freight'), 'Sheds option is right after containers');

  let shed = await convo('Shed size steps', ['Listowel, ON', 'Milton, ON', 'shed']);
  ok(shed.r.step === 'shedWidthFt' && shed.r.input === 'choice', 'shed asks for a width choice, not a typed length or weight');
  ok(/What size is your shed\?/.test(shed.r.messages.join('\n')), 'shed width step asks what size the shed is');
  ok((shed.r.quickReplies || []).map((q) => q.label).join() === '8 ft,10 ft,12 ft,14 ft', 'width choices are 8, 10, 12 and 14 ft');
  shed.r = await post('/api/chat', { sessionId: shed.r.sessionId, text: '16 ft' });
  ok(shed.r.step === 'shedWidthFt' && (shed.r.quickReplies || []).length === 4, 'free-form length is rejected for shed width');
  shed.r = await post('/api/chat', { sessionId: shed.r.sessionId, text: '4000 lbs' });
  ok(shed.r.step === 'shedWidthFt', 'a weight is not accepted in place of shed size');
  shed.r = await post('/api/chat', { sessionId: shed.r.sessionId, text: '8' });
  ok(shed.r.step === 'shedLengthFt' && shed.r.input === 'choice' && /What size is your shed\?/.test(shed.r.messages.join('\n')), 'after width, asks for the length');
  const expectLengths = [];
  for (let n = 8; n <= 50; n += 2) expectLengths.push(String(n));
  ok((shed.r.quickReplies || []).map((q) => q.value).join() === expectLengths.join(), 'length choices are every 2 ft from 8 through 50');
  ok((shed.r.quickReplies || []).some((q) => q.label === "8' x 12'"), 'length choices show the size as width x length');
  shed.r = await post('/api/chat', { sessionId: shed.r.sessionId, text: '15 ft' });
  ok(shed.r.step === 'shedLengthFt', 'a length off the list is rejected');
  shed.r = await post('/api/chat', { sessionId: shed.r.sessionId, text: '7 m' });
  ok(shed.r.step === 'shedLengthFt', 'a typed metric length is rejected for sheds');
  shed.r = await post('/api/chat', { sessionId: shed.r.sessionId, text: '12' });
  ok(shed.r.step === 'shedMule' && /8' x 12'/.test(shed.r.messages.join(' ')) && /Will we need to use the shed mule\?/.test(shed.r.messages.join(' ')), 'shows 8\' x 12\' and asks about the shed mule');
  ok((shed.r.quickReplies || []).map((q) => q.label).join() === 'Yes,No' && shed.r.input === 'choice', 'mule answer is Yes or No');
  shed.r = await post('/api/chat', { sessionId: shed.r.sessionId, text: 'yes' });
  ok(shed.r.step === 'pickupDate', 'mule yes continues without asking for weight');
  shed.r = await post('/api/chat', { sessionId: shed.r.sessionId, text: 'Flexible' });
  shed.r = await post('/api/chat', { sessionId: shed.r.sessionId, text: 'none' });
  const shedText = shed.r.messages.join('\n');
  ok(shed.r.step === 'review' && shed.r.estimate, 'shed estimate is shown without a weight');
  ok(/\*\*Shed size:\*\* 8' x 12'/.test(shedText), 'review shows 8\' x 12\'');
  ok(/\*\*Shed mule:\*\* Yes/.test(shedText), 'review records the mule as Yes');
  ok(/Check with dispatcher for mule pricing\./.test(shedText), 'mule pricing note is shown with the estimate');
  ok(shed.r.estimate.muleNote === 'Check with dispatcher for mule pricing.', 'estimate carries the mule note');
  ok(!(shed.r.estimate.lines || []).some((l) => /mule/i.test(l.label)), 'mule is not added as a price');
  ok(!/\*\*Weight:\*\*/.test(shedText), 'shed review does not include a weight');
  ok(!shed.log.some((x) => x.step === 'weightLbs' || x.step === 'lengthFt'), 'shed never stopped on weight or free-form length');

  const gen = await convo('Matching general-freight quote', ['Listowel, ON', 'Milton, ON', 'general', '12 ft', '4,000 lbs', 'Flexible', 'none']);
  ok(gen.log.some((x) => x.step === 'lengthFt') && gen.log.some((x) => x.step === 'weightLbs'), 'general freight still asks for length and weight');
  const shedDist = (shed.r.estimate.lines || []).find((l) => /ft wide shed/.test(l.label));
  const shedKm = shedDist && Number((shedDist.label.match(/Distance: (\d+) km/) || [])[1]);
  ok(shedDist && shedDist.label === `Distance: ${shedKm} km × $3.00/km (8 ft wide shed)` && shedDist.amount === Math.round(shedKm * 3 * 100) / 100, 'live 8 ft shed estimate uses $3.00 per loaded km');
  const genDist = (gen.r.estimate.lines || []).find((l) => /^Distance:/.test(l.label));
  ok(genDist && genDist.label === `Distance: ${shedKm} km × $2.75/km` && gen.r.estimate.subtotal !== shed.r.estimate.subtotal, 'general freight on the same route still uses $2.75/km');
  ok(!(shed.r.estimate.lines || []).some((l) => /container surcharge|Heavy load/i.test(l.label)), 'shed estimate has no container surcharge or weight charge');

  const shedNo = await convo('Shed without mule', ['Listowel, ON', 'Milton, ON', 'shed', '8', '12', 'no', 'Flexible', 'none']);
  ok(shedNo.r.step === 'review' && shedNo.r.estimate && !shedNo.r.estimate.muleNote && /\*\*Shed mule:\*\* No/.test(shedNo.r.messages.join(' ')), 'mule No is recorded and does not attach a mule note');
  ok(!/Check with dispatcher for mule pricing/.test(shedNo.r.messages.join(' ')), 'mule No does not show the mule pricing note');
  ok(shedNo.r.estimate.subtotal === shed.r.estimate.subtotal, 'mule answer does not change the shed price');

  const longShed = await convo('50 ft shed', ['Listowel, ON', 'Milton, ON', 'shed', '14', '50', 'no', 'Flexible', 'none']);
  const wideDist = (longShed.r.estimate && longShed.r.estimate.lines || []).find((l) => /14 ft wide shed/.test(l.label));
  const wideKm = wideDist && Number((wideDist.label.match(/Distance: (\d+) km/) || [])[1]);
  ok(longShed.r.step === 'review' && longShed.r.estimate && /14' x 50'/.test(longShed.r.messages.join(' ')) && wideDist && wideDist.label === `Distance: ${wideKm} km × $8.00/km (14 ft wide shed)` && wideDist.amount === Math.round(wideKm * 8 * 100) / 100, 'a 50 ft shed is quoted at the 14 ft width rate');

  const beforeShed = (await adminQuotes()).map((q) => q.id);
  shed.r = await post('/api/chat', { sessionId: shed.r.sessionId, text: 'intent:request' });
  ok(shed.r.step === 'name', 'requesting a shed quote asks for a name only after the estimate');
  shed.r = await post('/api/chat', { sessionId: shed.r.sessionId, text: 'Pat Shed' });
  shed.r = await post('/api/chat', { sessionId: shed.r.sessionId, text: '5195550142' });
  shed.r = await post('/api/chat', { sessionId: shed.r.sessionId, text: 'pat.shed@example.ca' });
  ok(shed.r.step === 'done' && /^Q-/.test(shed.r.reference || ''), 'shed quote saved without a weight ' + shed.r.reference);
  ok(!beforeShed.includes(shed.r.reference), 'shed estimate was not saved before contact details');
  const refShed = shed.r.reference;

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
  const qShed = a.quotes.find((q) => q.id === refShed);
  ok(qShed && qShed.shipment.freightType === 'shed' && qShed.shipment.shedWidthFt === 8 && qShed.shipment.shedLengthFt === 12 && qShed.shipment.shedSize === "8' x 12'" && qShed.shipment.shedMule === true && qShed.shipment.muleNote === 'Check with dispatcher for mule pricing.' && qShed.shipment.weightLbs == null && qShed.customer.name === 'Pat Shed', 'saved shed quote stores width x length, the mule answer and note, and no weight');
  const csv = await (await fetch(BASE + '/admin/quotes.csv', { headers: auth })).text();
  ok(csv.includes(ref1), 'CSV export includes request');
  ok(csv.includes('"8","12","Yes","Check with dispatcher for mule pricing."'), 'CSV export includes shed width, length, mule and the note');
  const c = await (await fetch(BASE + '/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Contact Test', email: 'c@example.ca', message: 'Hello there, test message' }) })).json();
  ok(c.ok, 'contact form saved');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
