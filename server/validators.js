// Field parsers/validators shared by the guided assistant and the AI mode.
// Each returns { ok: true, value } or { ok: false, error }.
const config = require('../config');
const L = config.limits;

const SKIP = /^(skip|none|n\/?a|no|nope|-|no company|individual|personal|private)$/i;
const FT_PER_M = 3.28084;
const LBS_PER_KG = 2.20462;

const fmtLbs = (lbs) => `${Math.round(lbs).toLocaleString('en-CA')} lbs (${Math.round(lbs / LBS_PER_KG).toLocaleString('en-CA')} kg)`;
const fmtFt = (ft) => `${+ft.toFixed(1)} ft (${(ft / FT_PER_M).toFixed(1)} m)`;

const V = {
  name(s) {
    s = String(s || '').trim();
    if (s.length < 2 || s.length > 80 || !/[a-z]/i.test(s)) return { ok: false, error: 'Could you give me your name (first and last is great)?' };
    return { ok: true, value: s };
  },
  company(s) {
    s = String(s || '').trim();
    if (!s || SKIP.test(s)) return { ok: true, value: '' };
    if (s.length > 120) return { ok: false, error: 'That company name looks a bit long — could you shorten it?' };
    return { ok: true, value: s };
  },
  email(s) {
    s = String(s || '').trim();
    const m = s.match(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i);
    if (!m) return { ok: false, error: "That doesn't look like a valid email address — could you double-check it? (e.g. name@company.ca)" };
    return { ok: true, value: m[0].toLowerCase() };
  },
  phone(s) {
    s = String(s || '').trim();
    const digits = s.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) return { ok: false, error: 'Please enter a phone number with area code (e.g. 519-555-0123).' };
    let pretty = s;
    const d = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
    if (d.length === 10) pretty = `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
    const ext = s.match(/(?:ext\.?|x)\s*(\d+)/i);
    if (ext && d.length === 10) pretty += ` ext. ${ext[1]}`;
    return { ok: true, value: pretty };
  },
  place(s) {
    s = String(s || '').trim();
    if (s.length < 3 || !/[a-z]/i.test(s)) return { ok: false, error: 'Please give at least a city/town (a full street address is even better), e.g. "Listowel, ON" or "123 Main St, Stratford".' };
    if (s.length > 200) return { ok: false, error: 'Could you shorten that address a little?' };
    return { ok: true, value: s };
  },
  freightType(s) {
    s = String(s || '').trim().toLowerCase();
    if (/\bsheds?\b|portable buildings?|garden shed|bunkie/.test(s) && !/container/.test(s)) return { ok: true, value: 'shed' };
    if (/^container20$|\b20\s*(ft|foot|feet|')?\b.*(container|can|box)|^20\s*(ft|foot|feet|')?$|twenty/.test(s)) return { ok: true, value: 'container20', lengthFt: 20 };
    if (/^container40$|\b40\s*(ft|foot|feet|')?\b.*(container|can|box)|^40\s*(ft|foot|feet|')?$|forty|high\s*cube|hc\b/.test(s)) return { ok: true, value: 'container40', lengthFt: 40 };
    const big = s.match(/\b(4[5-9]|5[0-9])\s*(ft|foot|feet|')?/);
    if (big && /container|can|box|ft|foot|feet|'/.test(s)) return { ok: false, overLimit: 'length', lengthFt: +big[1], error: '' };
    if (/^general$|general|freight|pallet|skid|crate|machine|equipment|lumber|material|other|ltl|ftl|flatbed|load/.test(s)) return { ok: true, value: 'general' };
    if (/container/.test(s)) return { ok: false, error: 'Is that a 20 ft or a 40 ft container?' };
    return { ok: false, error: 'Please choose one: 20 ft container, 40 ft container, sheds, or general freight.' };
  },
  length(s) {
    s = String(s || '').trim().toLowerCase().replace(/,/g, '');
    const m = s.match(/(\d+(?:\.\d+)?)\s*(ft|feet|foot|'|m\b|metres?|meters?|in\b|inch|inches|"|cm)?/);
    if (!m) return { ok: false, error: 'How long is the load? A number with units works, e.g. "24 ft" or "7.5 m".' };
    let v = +m[1]; const u = m[2] || 'ft';
    if (/^m|^met/.test(u)) v *= FT_PER_M; else if (/^in|"/.test(u)) v /= 12; else if (u === 'cm') v = v / 100 * FT_PER_M;
    if (v <= 0) return { ok: false, error: 'The length needs to be more than zero.' };
    if (v > L.maxLengthFt + 1e-9) return { ok: false, overLimit: 'length', lengthFt: v, error: '' };
    return { ok: true, value: Math.round(v * 10) / 10 };
  },
  weight(s) {
    s = String(s || '').trim().toLowerCase().replace(/(\d),(\d{3})/g, '$1$2');
    const m = s.match(/(\d+(?:\.\d+)?)\s*(k\b|lbs?|pounds?|kgs?|kilo(?:gram)?s?|t\b|tonnes?|tons?|mt\b)?/);
    if (!m) return { ok: false, error: 'What does it weigh? e.g. "12,000 lbs" or "5,000 kg".' };
    let v = +m[1]; const u = m[2] || 'lbs';
    if (/^kg|^kilo/.test(u)) v *= LBS_PER_KG;
    else if (/^t$|^tonne|^mt$/.test(u)) v *= 1000 * LBS_PER_KG;
    else if (/^ton/.test(u)) v *= 2000; // short tons
    else if (u === 'k') v *= 1000;
    if (v <= 0) return { ok: false, error: 'The weight needs to be more than zero.' };
    if (v > L.maxWeightLbs + 1e-9) return { ok: false, overLimit: 'weight', weightLbs: v, error: '' };
    return { ok: true, value: Math.round(v) };
  },
  pickupDate(s) {
    s = String(s || '').trim();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (/^(asap|as soon as possible|flexible|any ?time|not sure|tbd|unsure)$/i.test(s)) return { ok: true, value: s.toUpperCase() === 'ASAP' ? 'ASAP' : 'Flexible' };
    if (/^today$/i.test(s)) return { ok: true, value: iso(today) };
    if (/^tomorrow$/i.test(s)) { const d = new Date(today); d.setDate(d.getDate() + 1); return { ok: true, value: iso(d) }; }
    let d = null;
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) d = new Date(+m[1], +m[2] - 1, +m[3]);
    else { const t = Date.parse(s); if (!isNaN(t)) d = new Date(t); }
    if (!d || isNaN(d)) {
      if (s.length >= 3 && s.length <= 60) return { ok: true, value: s }; // keep free text like "week of Nov 9"
      return { ok: false, error: 'When should we pick up? Pick a date, or type "ASAP" or "Flexible".' };
    }
    d.setHours(0, 0, 0, 0);
    if (d < today) return { ok: false, error: "That date is in the past — what date works for pickup?" };
    return { ok: true, value: iso(d) };
  },
  notes(s) {
    s = String(s || '').trim();
    if (!s || /^(none|no|nope|n\/?a|nothing|no notes|skip)$/i.test(s)) return { ok: true, value: '' };
    return { ok: true, value: s.slice(0, 1000) };
  },
  km(s) {
    s = String(s || '').trim().toLowerCase().replace(/,/g, '');
    const m = s.match(/(\d+(?:\.\d+)?)\s*(km|kilomet\w*|mi\b|miles?)?/);
    if (!m) return { ok: false, error: 'Roughly how many kilometres is the trip? A number is fine, e.g. "180 km".' };
    let v = +m[1]; if (/^mi/.test(m[2] || '')) v *= 1.60934;
    if (v <= 0 || v > 6000) return { ok: false, error: 'Please enter a distance between 1 and 6,000 km.' };
    return { ok: true, value: Math.round(v) };
  },
};
module.exports = { V, fmtLbs, fmtFt, LBS_PER_KG, FT_PER_M };
