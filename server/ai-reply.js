// Drafts and optional auto-replies for one lead. Nothing sends unless the guards pass.
const config = require('../config');
const settings = require('./crm-settings');
const leads = require('./leads');
const phone = require('./phone');

const DAY_MS = 24 * 60 * 60 * 1000;

function keySet() { return !!config.llm.apiKey; }

function envAllows() {
  const v = process.env.AI_AUTOREPLY_ENABLED;
  if (v == null || v === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

function globalOn() {
  return keySet() && envAllows() && settings.read().aiAutoReply !== false;
}

function isBulkAddress(email) {
  const outlook = require('./outlook');
  return outlook.isBulkAddress(email);
}

function ownSender(from) {
  const email = String(from || '').toLowerCase().trim();
  const business = String(config.business.email || '').toLowerCase();
  let mailbox = '';
  try { mailbox = String(require('./outlook').accountEmail() || '').toLowerCase(); } catch { /* not loaded */ }
  if (email && (email === business || (mailbox && email === mailbox))) return true;
  if (config.twilio.fromNumber && phone.phonesMatch(from, config.twilio.fromNumber)) return true;
  return false;
}

function needsHuman(text) {
  const t = String(text || '');
  return [
    /speak (?:to|with) (?:a |the )?(?:person|human|owner|manager|someone|johan)/i,
    /talk to (?:a |the )?(?:person|human|owner|manager|someone|johan)/i,
    /real person/i,
    /\bcomplaint\b/i,
    /\bcomplain(?:ed|ing|t)?\b/i,
    /\bunhappy\b/i,
    /\bdisappointed\b/i,
    /\brefund\b/i,
    /\bpayment\b/i,
    /\binvoice\b/i,
    /\bpaid\b/i,
    /\bcancell?ation\b/i,
    /\bcancel(?:led|ed|ling| the| my| this)?\b/i,
  ].some((re) => re.test(t));
}

function recentAiCount(lead, now = new Date()) {
  const cutoff = now.getTime() - DAY_MS;
  return (lead && lead.timeline || []).filter((item) => {
    if (!item || !item.ai || item.direction !== 'out') return false;
    const at = new Date(item.at).getTime();
    return Number.isFinite(at) && at >= cutoff;
  }).length;
}

function assess({ lead, from, text, now = new Date() }) {
  if (!keySet()) return { ok: false, reason: 'no-key' };
  if (!envAllows() || settings.read().aiAutoReply === false) return { ok: false, reason: 'global-off' };
  if (!lead || !lead.aiAutoReply) return { ok: false, reason: 'lead-off' };
  if ((String(from || '').includes('@') && isBulkAddress(from)) || ownSender(from)) return { ok: false, reason: 'bulk' };
  if (needsHuman(text)) return { ok: false, needsJohan: true, reason: 'needs-johan' };
  if (recentAiCount(lead, now) >= 3) return { ok: false, reason: 'limit' };
  return { ok: true };
}

function systemPrompt(lead) {
  const b = config.business;
  const lines = [
    `You write a short, friendly reply as ${b.name}.`,
    `${b.name} is based in Listowel, Ontario, and has served all of Ontario since ${b.sinceYear}.`,
    'The trucks are 3500 dually pickups pulling gooseneck flat decks.',
    `Loads can be up to ${config.limits.maxLengthFt} ft and ${config.limits.maxWeightLbs.toLocaleString('en-CA')} lbs.`,
    `Phone ${b.phone}. Email ${b.email}.`,
    'Steer the customer to get an instant quote at https://jfhauling.ca/quote. Offer the phone number as the backup.',
    'Use the lead details when they help. Never promise a firm price, a pickup date, or availability beyond the website estimate.',
    'Say Johan or the dispatcher will confirm the final price and timing.',
    'Shed mule pricing: check with the dispatcher.',
    "Sign off as 'JF Hauling'.",
    'Reply with only the message to send. No subject line and no markdown.',
  ];
  const detail = [
    lead && lead.name ? `Name: ${lead.name}` : '',
    lead && lead.pickup ? `Pickup: ${lead.pickup}` : '',
    lead && lead.dropoff ? `Drop-off: ${lead.dropoff}` : '',
    lead && lead.loadType ? `Load: ${lead.loadType}` : '',
    lead && lead.shedSize ? `Shed size: ${lead.shedSize}` : '',
    lead && lead.quotedPrice ? `Website estimate, not a firm price: ${lead.quotedPrice}` : '',
  ].filter(Boolean);
  return `${lines.join(' ')}${detail.length ? `\n\nLead:\n${detail.join('\n')}` : ''}`;
}

async function generateReply({ lead, text, channel, fetchImpl = fetch }) {
  if (!keySet()) return { ok: false, error: 'ai' };
  const model = config.llm.model || 'gpt-4o-mini';
  const base = String(config.llm.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const payload = {
    model,
    temperature: 0.4,
    max_tokens: 400,
    messages: [
      { role: 'system', content: systemPrompt(lead) },
      { role: 'user', content: `Channel: ${channel === 'sms' ? 'text message' : 'email'}\n\nCustomer message:\n${String(text || '').slice(0, 4000)}` },
    ],
  };
  const res = await fetchImpl(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.llm.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[ai] draft failed status=${res.status}`);
    return { ok: false, error: 'ai' };
  }
  const reply = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  const cleaned = String(reply || '').trim();
  if (!cleaned) return { ok: false, error: 'ai-empty' };
  return { ok: true, text: cleaned.slice(0, channel === 'sms' ? 1000 : 4000), model };
}

async function handleAutoReply(leadId, { channel, from, text, subject, fetchImpl = fetch }) {
  const lead = leads.find(leadId);
  if (!lead) return { sent: false, reason: 'missing' };
  const decision = assess({ lead, from, text });
  if (decision.needsJohan) {
    leads.setFlags(lead.id, { needsJohan: true, aiAutoReply: false });
    leads.addTimeline(lead.id, {
      kind: 'note',
      body: 'AI auto-reply stopped. Needs Johan. The customer asked for a person, raised a complaint, or mentioned payment or cancellation.',
    });
    console.log(`[ai] stopped id=${lead.id} reason=needs-johan`);
    return { sent: false, needsJohan: true };
  }
  if (!decision.ok) {
    if (decision.reason === 'limit') console.log(`[ai] skipped id=${lead.id} reason=limit`);
    return { sent: false, reason: decision.reason };
  }
  const draft = await generateReply({ lead, text, channel, fetchImpl });
  if (!draft.ok) return { sent: false, reason: draft.error || 'ai' };
  if (channel === 'email') {
    const outlook = require('./outlook');
    const sent = await outlook.sendEmail({
      to: lead.email,
      subject: subject ? `Re: ${String(subject).replace(/^re:\s*/i, '')}` : 'JF Hauling',
      body: draft.text,
      replyToId: outlook.graphMessageId(lead),
      fetchImpl,
    });
    if (!sent.ok) return { sent: false, reason: sent.error };
    leads.addTimeline(lead.id, { kind: 'email', direction: 'out', subject: subject ? `Re: ${String(subject).replace(/^re:\s*/i, '')}` : 'JF Hauling', body: draft.text, ai: true });
  } else if (channel === 'sms') {
    const twilio = require('./twilio');
    const sent = await twilio.sendSms({ to: lead.phone, body: draft.text, fetchImpl });
    if (!sent.ok) return { sent: false, reason: sent.error };
    leads.addTimeline(lead.id, { kind: 'sms', direction: 'out', body: draft.text, ai: true });
  } else {
    return { sent: false, reason: 'channel' };
  }
  console.log(`[ai] sent id=${lead.id} channel=${channel}`);
  return { sent: true };
}

module.exports = {
  keySet, envAllows, globalOn, needsHuman, recentAiCount, assess, systemPrompt, generateReply, handleAutoReply, isBulkAddress, ownSender,
};
