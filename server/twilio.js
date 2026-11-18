// Twilio SMS. The auth token is only used to sign and to call the API. It is never logged.
const crypto = require('crypto');
const config = require('../config');
const phone = require('./phone');

function configured() {
  return !!(config.twilio.accountSid && config.twilio.authToken && config.twilio.fromNumber);
}

function validateSignature(url, params, signature, authToken) {
  if (!url || !signature || !authToken) return false;
  const keys = Object.keys(params || {}).sort();
  let data = String(url);
  for (const key of keys) {
    const value = params[key];
    if (Array.isArray(value)) {
      for (const item of value) data += key + (item == null ? '' : String(item));
    } else data += key + (value == null ? '' : String(value));
  }
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requestUrl(req) {
  return `${req.protocol}://${req.get('host')}${req.originalUrl}`;
}

async function sendSms({ to, body, fetchImpl = fetch }) {
  if (!configured()) return { ok: false, error: 'twilio-off' };
  const dest = phone.toE164(to);
  const from = phone.toE164(config.twilio.fromNumber);
  if (!dest || !from) return { ok: false, error: 'no-phone' };
  const guard = require('./address-guard');
  const payload = new URLSearchParams({ To: dest, From: from, Body: guard.stripBlocked(body).slice(0, 1000) });
  const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilio.accountSid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: payload,
  });
  if (!res.ok) {
    console.error(`[twilio] sms failed status=${res.status}`);
    return { ok: false, error: 'twilio-send' };
  }
  return { ok: true, to: dest };
}

async function ingestInbound({ from, body, messageSid, fetchImpl = fetch }) {
  const leads = require('./leads');
  const text = String(body || '').trim().slice(0, 1000);
  const sid = String(messageSid || '').trim().slice(0, 80);
  if (!from || !text || !sid) return { ok: false, error: 'missing' };
  if (phone.phonesMatch(from, config.twilio.fromNumber)) return { ok: true, ignored: true };
  if (leads.findByExternalId(sid)) return { ok: true, duplicate: true };
  const e164 = phone.toE164(from) || String(from).slice(0, 20);
  let lead = leads.matchLead({ phone: from });
  let isNew = false;
  if (!lead) {
    const made = leads.create({
      source: 'sms',
      phone: e164,
      message: text,
      externalId: sid,
    }, { defaultSource: 'sms' });
    if (!made.ok) return { ok: false, error: made.error };
    lead = made.lead;
    if (made.duplicate) return { ok: true, duplicate: true, lead };
    isNew = true;
    console.log(`[leads] created id=${lead.id} source=sms`);
  }
  const added = leads.addTimeline(lead.id, {
    kind: 'sms',
    direction: 'in',
    body: text,
    externalId: sid,
  });
  if (!added || added.duplicate) return { ok: true, duplicate: true, lead };
  let closed = false;
  try {
    const intent = require('./intent');
    const decision = await intent.applyCustomerIntent(lead.id, text, fetchImpl);
    closed = !!decision.closed;
    if (!closed && !decision.reopened) {
      const push = require('./push');
      const notice = isNew ? push.notifyNewLead(leads.find(lead.id) || lead) : push.notifyInbound(lead, 'sms', text);
      notice.catch(() => console.error(`[push] failed id=${lead.id}`));
    }
  } catch { /* intent and push are optional */ }
  if (!closed && !isNew) {
    try {
      const ai = require('./ai-reply');
      await ai.handleAutoReply(lead.id, { channel: 'sms', from: e164, text, fetchImpl });
    } catch {
      console.error(`[ai] failed id=${lead.id} reason=sms`);
    }
  }
  return { ok: true, lead, created: isNew };
}

module.exports = { configured, validateSignature, requestUrl, sendSms, ingestInbound };
