// Optional natural-language layer using any OpenAI-compatible chat API.
// Enabled only when OPENAI_API_KEY is set. The model ONLY extracts fields and
// suggests a friendly reply; the server validates every value and enforces limits.
const config = require('../config');
const C = config.llm;

const enabled = () => !!C.apiKey;

const FIELD_HELP = {
  name: 'customer full name',
  company: 'company name, or "skip" if personal',
  email: 'email address',
  phone: 'phone number',
  pickup: 'pickup address or city',
  delivery: 'delivery address or city',
  freightType: 'one of "container20", "container40", "shed", "general" (if they mention another container size, return it verbatim e.g. "53 ft container"; a shed or portable building is "shed")',
  lengthFt: 'load length WITH units as text, e.g. "24 ft" or "7 m" (general freight and sheds)',
  weightLbs: 'weight WITH units as text, e.g. "15000 lbs" or "6000 kg"',
  pickupDate: 'pickup date as YYYY-MM-DD, or "ASAP"/"Flexible"',
  notes: 'special notes (hazmat, tailgate, liftgate, appointments, access), or "none"',
};

async function interpret(s, userText, nextField, FIELDS) {
  const B = config.business;
  const known = Object.fromEntries(FIELDS.filter((f) => s.answered[f]).map((f) => [f, s.data[f]]));
  const missing = FIELDS.filter((f) => !s.answered[f] && !(f === 'lengthFt' && s.data.freightType && s.data.freightType !== 'general' && s.data.freightType !== 'shed'));
  const today = new Date().toISOString().slice(0, 10);
  const system = `You are the friendly online quote assistant for ${B.name}, a trucking company based in Listowel, Ontario, Canada offering flat deck hauling with 3500 dually (dual rear wheel) pickup trucks pulling gooseneck flat deck trailers (NOT semis or tractor-trailers) and moves shipping containers (20 ft and 40 ft), sheds, and general freight across ${B.serviceArea}. Limits: max load length ${config.limits.maxLengthFt} ft, max payload ${config.limits.maxWeightLbs} lbs. Use Canadian English. Today is ${today}.
Your job: read the customer's latest message and extract any of these fields they provided: ${JSON.stringify(FIELD_HELP)}.
Already collected: ${JSON.stringify(known)}. Still missing: ${JSON.stringify(missing)}. The question currently being asked is about "${nextField}".
Rules: never invent values; only extract what the customer actually said. Never quote prices or promise availability — the server computes estimates. Never say a load over the limits is OK. Do not ask for name, phone or email unless that is the current missing field — the load (pickup, drop-off, freight, size, weight, date, notes) comes first, and contact details are collected only after the estimate.
Respond ONLY with JSON: {"fields": {<fieldName>: <string>}, "reply": "<one or two short sentences: acknowledge briefly (answer simple questions about the company if asked) and then ask for the NEXT missing field after applying what you extracted>"}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${C.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${C.apiKey}` },
      body: JSON.stringify({
        model: C.model, temperature: 0.2, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          ...s.transcript.slice(-8).map((m) => ({ role: m.from === 'bot' ? 'assistant' : 'user', content: m.text })),
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const content = j.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(content.replace(/^```(?:json)?|```$/g, '').trim());
    return { fields: parsed.fields || {}, reply: typeof parsed.reply === 'string' ? parsed.reply.slice(0, 600) : '' };
  } catch (e) {
    console.warn('[llm] falling back to guided mode:', e.message);
    return null;
  } finally { clearTimeout(t); }
}
module.exports = { enabled, interpret };
