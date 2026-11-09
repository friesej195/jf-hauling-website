// The "AI dispatcher" conversation engine.
// Works with NO API key as a guided state machine. If an LLM is configured
// (see llm.js) it is used only to understand free-form text and phrase replies;
// every field is still validated here and limits are always enforced here.
const crypto = require('crypto');
const config = require('../config');
const { V, fmtLbs, fmtFt } = require('./validators');
const { estimateDistance } = require('./routing');
const pricing = require('./pricing');
const llm = require('./llm');

const B = config.business;
const L = config.limits;
// Load details come first so a ballpark price does not require contact info.
// Name, phone and email are collected only after the customer asks dispatch to follow up.
const LOAD_FIELDS = ['pickup', 'delivery', 'freightType', 'lengthFt', 'weightLbs', 'pickupDate', 'notes'];
const CONTACT_FIELDS = ['name', 'phone', 'email'];
const FIELDS = [...LOAD_FIELDS, ...CONTACT_FIELDS];
const LABELS = {
  name: 'Name', email: 'Email', phone: 'Phone', pickup: 'Pickup', delivery: 'Delivery',
  freightType: 'Freight type', lengthFt: 'Length', weightLbs: 'Weight', pickupDate: 'Pickup date', notes: 'Special notes',
};
const FT_LABEL = { container20: '20 ft container', container40: '40 ft container', general: 'General freight' };
const MAX_KG = Math.round(L.maxWeightLbs / 2.20462).toLocaleString('en-CA');
const MAX_M = (L.maxLengthFt / 3.28084).toFixed(1);
const callLine = () => `call us at **${B.phone}**`;

const sessions = new Map();
const TTL = 3 * 60 * 60 * 1000;
setInterval(() => { const now = Date.now(); for (const [k, s] of sessions) if (now - s.touched > TTL) sessions.delete(k); }, 10 * 60 * 1000).unref();

function newSession() {
  const s = { id: crypto.randomUUID(), step: 'pickup', data: {}, answered: {}, flags: [], distance: null, estimate: null, intent: null, editing: false, submitted: null, transcript: [], touched: Date.now(), mode: llm.enabled() ? 'ai' : 'guided' };
  if (sessions.size > 5000) sessions.delete(sessions.keys().next().value);
  sessions.set(s.id, s);
  return s;
}
function getSession(id) { const s = id && sessions.get(id); if (s) s.touched = Date.now(); return s; }

// ---------- Questions for each step ----------
function question(s, step = s.step) {
  const d = s.data;
  switch (step) {
    case 'name': {
      const lead = s.editing ? '' : (s.intent === 'more-info'
        ? 'Sure — dispatch can follow up with more detail. '
        : "Great — we'll send this quote request to dispatch. ");
      return { text: lead + "What's your name?", input: 'text', placeholder: 'Your name' };
    }
    case 'phone': return { text: 'What phone number should dispatch call? A number with the area code is required.', input: 'tel', placeholder: '519-555-0123' };
    case 'email': return { text: 'And the email for this quote? An email address is required so dispatch can follow up.', input: 'email', placeholder: 'name@company.ca' };
    case 'pickup': {
      const intro = s.editing ? '' : "Hi! Welcome to " + B.name + " — pickup and gooseneck flat deck hauling across Ontario. We haul containers, general freight and more, up to " + config.limits.maxLengthFt + " ft and " + config.limits.maxWeightLbs.toLocaleString('en-CA') + " lbs" + (B.fullyInsured ? ", and we're fully insured" : '') + ". Tell me the pickup, the drop-off and the load, and I'll give you a **ballpark estimate** right away. Your name and contact details are only needed if you want dispatch to follow up.\n\n";
      return { text: intro + 'Where are we picking up? A street address is best, but a city or town works (e.g. "Listowel, ON").', input: 'text', placeholder: 'Pickup address or city' };
    }
    case 'delivery': return { text: 'And where is it going?', input: 'text', placeholder: 'Delivery address or city' };
    case 'freightType': return { text: 'What are we moving?', input: 'text', placeholder: 'e.g. 40 ft container', quick: [{ label: '20 ft container', value: 'container20' }, { label: '40 ft container', value: 'container40' }, { label: 'General freight', value: 'general' }] };
    case 'lengthFt': return { text: `How long is the load? Our maximum is **${L.maxLengthFt} ft (${MAX_M} m)**. Feet or metres are fine.`, input: 'text', placeholder: 'e.g. 24 ft or 7 m' };
    case 'weightLbs': return {
      text: (d.freightType && d.freightType !== 'general'
        ? 'What is the total weight, **including the container itself** (gross)? '
        : 'About how much does the load weigh? ') + `Our maximum payload is **${L.maxWeightLbs.toLocaleString('en-CA')} lbs (≈ ${MAX_KG} kg)**. Pounds, kg or tonnes are fine.`,
      input: 'text', placeholder: 'e.g. 15,000 lbs or 6,800 kg',
    };
    case 'pickupDate': return { text: 'When would you like it picked up?', input: 'date', placeholder: 'Pickup date', quick: [{ label: 'ASAP', value: 'ASAP' }, { label: 'Flexible', value: 'Flexible' }] };
    case 'notes': return { text: 'Anything special we should know? For example hazardous materials, tailgate/liftgate needed, appointment times, site access, or residential delivery.', input: 'text', placeholder: 'Special notes (optional)', quick: [{ label: 'No special notes', value: 'none' }, { label: 'Hazmat / dangerous goods', value: 'Hazmat / dangerous goods' }, { label: 'Tailgate needed', value: 'Tailgate needed' }] };
    case 'km': return { text: "I couldn't map that route automatically. Roughly how many **kilometres** is it from pickup to delivery? (Miles are fine too.)", input: 'text', placeholder: 'e.g. 180 km' };
    case 'review': return reviewMessage(s);
    case 'overLimit': return overLimitMessage(s);
    case 'editPick': return { text: 'Which detail would you like to change?', input: 'none', quick: editChoices(s) };
    case 'done': return { text: `Your request has been sent. Reference **${s.submitted}**. A dispatcher will follow up to confirm. Need it sooner? ${callLine()}.`, input: 'none', quick: [{ label: 'Start a new quote', value: 'restart' }] };
    default: return { text: '', input: 'text' };
  }
}

function editChoices(s) {
  const fields = LOAD_FIELDS.filter((f) => f !== 'lengthFt' || s.data.freightType === 'general');
  if (s.intent) fields.push(...CONTACT_FIELDS.filter((f) => s.answered[f]));
  return fields.map((f) => ({ label: LABELS[f], value: 'edit:' + f })).concat([{ label: 'Distance (km)', value: 'edit:km' }]);
}

function summaryLines(s) {
  const d = s.data;
  const out = [
    `**Pickup:** ${d.pickup}`,
    `**Delivery:** ${d.delivery}`,
    `**Freight:** ${FT_LABEL[d.freightType] || '—'}${d.lengthFt ? ' · ' + fmtFt(d.lengthFt) : ''}`,
    `**Weight:** ${d.weightLbs ? fmtLbs(d.weightLbs) : '—'}`,
    `**Pickup date:** ${d.pickupDate}`,
    `**Notes:** ${d.notes || 'None'}`,
  ];
  if (d.name) out.push(`**Name:** ${d.name}`);
  if (d.email || d.phone) out.push(`**Contact:** ${[d.email, d.phone].filter(Boolean).join(' · ')}`);
  if (s.distance) out.push(`**Distance:** ~${s.distance.loadedKm.toLocaleString('en-CA')} km (${Math.round(s.distance.loadedKm * 0.621371).toLocaleString('en-CA')} mi)${s.distance.source === 'customer' ? ' (your estimate)' : ' by road'}`);
  return out;
}

function reviewMessage(s) {
  const lines = summaryLines(s);
  let text = "Here's what I have:\n" + lines.join('\n');
  if (s.flags.length) {
    text += `\n\n⚠️ **Needs dispatcher review:** ${s.flags.map((f) => f.message).join(' ')} We can't give an online estimate for this one, but we'd be glad to talk it through — ${callLine()}, or ask us to follow up and we'll be in touch.`;
  } else if (s.estimate) {
    const e = s.estimate;
    text += `\n\n**Ballpark estimate: $${e.low.toLocaleString('en-CA')} – $${e.high.toLocaleString('en-CA')} ${e.currency}** (${e.taxNote}).`;
    text += '\nThis is a rough estimate only, **pending confirmation by our dispatcher**; the final price depends on route, wait time, site access and current rates.';
    if (e.special.includes('hazmat')) text += '\nHazmat loads need dispatcher approval and paperwork before booking.';
  }
  text += s.flags.length
    ? '\n\nWant dispatch to look at this?'
    : '\n\nWant dispatch to follow up on this estimate?';
  const quick = [{ label: 'Request this quote', value: 'intent:request' }, { label: 'Ask for more info', value: 'intent:more' }, { label: 'Change something', value: 'edit' }];
  if (s.distance && s.distance.source !== 'customer') quick.push({ label: 'Distance looks wrong', value: 'edit:km' });
  quick.push({ label: 'Start over', value: 'restart' });
  return { text, input: 'none', quick };
}

function overLimitMessage(s) {
  const f = s.pendingLimit;
  const what = f.type === 'length'
    ? `a load of ${fmtFt(f.value)} is longer than our **${L.maxLengthFt} ft (${MAX_M} m) maximum**`
    : `${fmtLbs(f.value)} is over our **${L.maxWeightLbs.toLocaleString('en-CA')} lbs (≈ ${MAX_KG} kg) maximum payload**`;
  return {
    text: `Sorry — ${what}, so I can't quote it online. Please ${callLine()} and we'll see what we can do or point you in the right direction.\n\nIf you mistyped, you can enter a different ${f.type}. Or continue and we'll send your request to a dispatcher to review (no online estimate).`,
    input: 'none',
    quick: [{ label: `Enter a different ${f.type}`, value: 'limit:retry' }, { label: 'Continue — dispatcher review', value: 'limit:continue' }, { label: `Call ${B.phone}`, value: 'limit:call' }],
  };
}

// ---------- Flow helpers ----------
function nextMissing(s) {
  for (const f of LOAD_FIELDS) {
    if (f === 'lengthFt' && s.data.freightType !== 'general') continue;
    if (!s.answered[f]) return f;
  }
  if (!s.distance) return 'distance';
  // Contact details are asked only after they choose to send this to dispatch.
  if (!s.intent) return 'review';
  for (const f of CONTACT_FIELDS) if (!s.answered[f]) return f;
  return 'submit';
}

function contactReady(data) {
  return V.name(data && data.name).ok && V.phone(data && data.phone).ok && V.email(data && data.email).ok;
}

function applyField(s, field, raw) {
  const vmap = { lengthFt: 'length', weightLbs: 'weight', pickup: 'place', delivery: 'place' };
  const r = V[vmap[field] || field](raw);
  if (r.overLimit) {
    s.pendingLimit = { type: r.overLimit, value: r.overLimit === 'length' ? r.lengthFt : r.weightLbs, field: r.overLimit === 'length' && field === 'freightType' ? 'freightType' : field };
    return { overLimit: true };
  }
  if (!r.ok) return { error: r.error };
  s.data[field] = r.value;
  s.answered[field] = true;
  if (field === 'freightType') {
    if (r.lengthFt) { s.data.lengthFt = r.lengthFt; s.answered.lengthFt = true; }
    else if (s.data.lengthFt === 20 || s.data.lengthFt === 40) { delete s.data.lengthFt; s.answered.lengthFt = false; }
    s.flags = s.flags.filter((x) => x.type !== 'length');
  }
  if (field === 'lengthFt') s.flags = s.flags.filter((x) => x.type !== 'length');
  if (field === 'weightLbs') s.flags = s.flags.filter((x) => x.type !== 'weight');
  if (['pickup', 'delivery'].includes(field)) s.distance = null; // re-route
  return { ok: true };
}

async function ensureDistanceAndEstimate(s) {
  if (!s.distance) {
    const d = await estimateDistance(s.data.pickup, s.data.delivery);
    if (!d) return 'km';
    s.distance = d;
  }
  s.estimate = s.flags.length ? null : pricing.estimate({
    freightType: s.data.freightType, weightLbs: s.data.weightLbs, loadedKm: s.distance.loadedKm, deadheadKm: s.distance.deadheadKm, notes: s.data.notes,
  });
  return 'review';
}

async function advance(s) {
  let n = nextMissing(s);
  if (n === 'distance') n = await ensureDistanceAndEstimate(s);
  else if ((n === 'review' || n === 'submit') && s.distance) {
    s.estimate = s.flags.length ? null : pricing.estimate({
      freightType: s.data.freightType, weightLbs: s.data.weightLbs, loadedKm: s.distance.loadedKm, deadheadKm: s.distance.deadheadKm, notes: s.data.notes,
    });
  }
  s.step = n;
  if (n === 'review') s.editing = false;
}

async function finishSubmit(s, onSubmit) {
  if (s.submitted) { s.step = 'done'; return reply(s); }
  if (!s.intent || !contactReady(s.data)) {
    if (!s.intent) { s.step = 'review'; return reply(s, ['Choose "Request this quote" or "Ask for more info" when you want dispatch to follow up.']); }
    s.step = CONTACT_FIELDS.find((f) => !s.answered[f]) || 'name';
    return reply(s, ['Name, phone and email are all required before this can be sent to dispatch.']);
  }
  const ref = await onSubmit(s);
  s.submitted = ref;
  s.step = 'done';
  return reply(s, ['Thank you!']);
}

async function afterAdvance(s, onSubmit, pre) {
  if (s.step === 'submit') return finishSubmit(s, onSubmit);
  return reply(s, pre);
}

function intentFrom(text) {
  if (/^intent:request$/i.test(text) || /^request this quote$/i.test(text)) return 'request';
  if (/^intent:more$/i.test(text) || /^ask for more info$/i.test(text)) return 'more-info';
  return null;
}

function reply(s, pre = []) {
  const q = question(s);
  const messages = [...pre, q.text].filter(Boolean);
  s.transcript.push(...messages.map((t) => ({ from: 'bot', text: t, at: new Date().toISOString() })));
  return {
    sessionId: s.id, step: s.step, messages, quickReplies: q.quick || [], input: q.input || 'text', placeholder: q.placeholder || '',
    mode: s.mode, estimate: s.step === 'review' ? s.estimate : null, flags: s.flags, done: s.step === 'done', reference: s.submitted,
  };
}

// ---------- Public API ----------
async function start() { return reply(newSession()); }

async function handle(sessionId, rawText, onSubmit) {
  let s = getSession(sessionId);
  if (!s) { s = newSession(); return reply(s, ['(Your previous session expired, so let\'s start fresh.)']); }
  const text = String(rawText || '').trim().slice(0, 1500);
  if (!text) return reply(s);
  s.transcript.push({ from: 'customer', text, at: new Date().toISOString() });

  if (/^(restart|start over|new quote|reset)$/i.test(text)) {
    sessions.delete(s.id);
    return reply(newSession());
  }
  if (s.step === 'done') return reply(s, ['Your request is already submitted. Tap "Start a new quote" for another one.']);

  // --- Over-limit decision ---
  if (s.step === 'overLimit') {
    const f = s.pendingLimit;
    if (/^limit:continue$|continue|review/i.test(text)) {
      s.flags = s.flags.filter((x) => x.type !== f.type);
      s.flags.push({ type: f.type, value: f.value, message: f.type === 'length' ? `Load length ${fmtFt(f.value)} exceeds our ${L.maxLengthFt} ft limit.` : `Weight ${fmtLbs(f.value)} exceeds our ${L.maxWeightLbs.toLocaleString('en-CA')} lbs payload limit.` });
      if (f.field === 'freightType') { s.data.freightType = /container|can|box/i.test(f.raw || '') ? 'container40' : 'general'; s.answered.freightType = true; s.data.freightTypeNote = f.raw; }
      if (f.type === 'length') { s.data.lengthFt = Math.round(f.value * 10) / 10; s.answered.lengthFt = true; }
      else { s.data.weightLbs = Math.round(f.value); s.answered.weightLbs = true; }
      s.pendingLimit = null;
      await advance(s);
      return afterAdvance(s, onSubmit, ["Okay — I've flagged this for a dispatcher to review. Let's finish the rest of the details."]);
    }
    if (/^limit:call$/i.test(text)) return reply(s, [`You can reach dispatch at **${B.phone}**. The estimate stays here if you'd still like to ask dispatch to follow up.`]);
    // retry or any other text → re-ask the field (and try to parse the text as the new value)
    const field = f.field;
    s.pendingLimit = null;
    if (!/^limit:retry$/i.test(text)) {
      const r = applyField(s, field, text);
      if (r.overLimit) { s.pendingLimit.raw = text; s.step = 'overLimit'; return reply(s); }
      if (r.ok) { await advance(s); return afterAdvance(s, onSubmit); }
    }
    s.step = field;
    return reply(s);
  }

  // --- Review actions. Contact details are not saved until the customer asks to follow up. ---
  if (s.step === 'review' || s.step === 'editPick') {
    const chosen = s.step === 'review' ? intentFrom(text) : null;
    if (chosen) {
      s.intent = chosen;
      await advance(s);
      return afterAdvance(s, onSubmit);
    }
    const em = text.match(/^edit:(\w+)$/);
    if (em) {
      s.editing = true;
      if (em[1] === 'km') { s.step = 'km'; return reply(s, ['No problem — let me know the approximate distance.']); }
      if (!FIELDS.includes(em[1])) return reply(s, ['Please choose one of the options below.']);
      s.step = em[1];
      return reply(s);
    }
    if (/^edit$|change|edit|fix|wrong/i.test(text)) { s.step = 'editPick'; return reply(s); }
    if (!llm.enabled()) return reply(s, ['Please choose one of the options below.']);
  }

  // --- Manual km entry ---
  if (s.step === 'km') {
    const r = V.km(text);
    if (!r.ok) return reply(s, [r.error]);
    s.distance = { loadedKm: r.value, deadheadKm: 0, source: 'customer' };
    await advance(s);
    return afterAdvance(s, onSubmit, ['Thanks, got it.']);
  }

  // --- AI mode: extract any fields from natural language ---
  const quickVals = FIELDS.includes(s.step) ? (question(s).quick || []).map((q) => q.value.toLowerCase()) : [];
  if (llm.enabled() && !quickVals.includes(text.toLowerCase())) {
    const scope = s.intent ? FIELDS : LOAD_FIELDS;
    const ai = await llm.interpret(s, text, nextMissing(s), scope);
    if (ai) {
      const errors = [];
      let hitLimit = false;
      for (const [k, v] of Object.entries(ai.fields || {})) {
        if (!scope.includes(k) || v === null || v === undefined || v === '') continue;
        const r = applyField(s, k, String(v));
        if (r.overLimit) { s.pendingLimit.raw = String(v); hitLimit = true; break; }
        if (r.error) errors.push(r.error);
      }
      if (hitLimit) { s.step = 'overLimit'; return reply(s); }
      const wasReview = s.step === 'review';
      await advance(s);
      if (s.step === 'submit') return finishSubmit(s, onSubmit);
      if (errors.length) return reply(s, errors.slice(0, 1));
      // Use the model's phrasing only for normal data-collection steps; limits,
      // estimates and the review summary always come from the server.
      if (ai.reply && FIELDS.includes(s.step) && !wasReview) {
        const q = question(s);
        const msg = ai.reply.trim();
        s.transcript.push({ from: 'bot', text: msg, at: new Date().toISOString() });
        return { sessionId: s.id, step: s.step, messages: [msg], quickReplies: q.quick || [], input: q.input || 'text', placeholder: q.placeholder || '', mode: s.mode, estimate: null, flags: s.flags, done: false };
      }
      return reply(s);
    }
    // fall through to guided handling if the AI call failed
  }

  // --- Guided mode: the current step consumes the answer ---
  if (!FIELDS.includes(s.step)) return reply(s);
  const field = s.step;
  const r = applyField(s, field, text);
  if (r.overLimit) { s.pendingLimit.raw = text; s.step = 'overLimit'; return reply(s); }
  if (r.error) return replyErrorOnly(s, r.error);
  await advance(s);
  return afterAdvance(s, onSubmit);
}

function replyErrorOnly(s, error) {
  // Show the validation message and keep the same input controls.
  const q = question(s);
  s.transcript.push({ from: 'bot', text: error, at: new Date().toISOString() });
  return { sessionId: s.id, step: s.step, messages: [error], quickReplies: q.quick || [], input: q.input || 'text', placeholder: q.placeholder || '', mode: s.mode, estimate: null, flags: s.flags, done: false };
}

module.exports = { start, handle, summaryLines, FT_LABEL, getSession, contactReady };
