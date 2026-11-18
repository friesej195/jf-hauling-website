// Resend inbound webhook. The signing secret stays in the environment and is never logged.
const crypto = require('crypto');
const config = require('../config');
const inbound = require('./inbound-email');

const TOLERANCE_SEC = 5 * 60;

function signingKey(secret) {
  const raw = String(secret || '');
  if (!raw) return null;
  const b64 = raw.startsWith('whsec_') ? raw.slice('whsec_'.length) : raw;
  try {
    const key = Buffer.from(b64, 'base64');
    return key.length ? key : null;
  } catch {
    return null;
  }
}

function verifySignature({ secret, rawBody, id, timestamp, signature, now = Date.now() }) {
  if (!secret) return { ok: false, reason: 'unset' };
  const key = signingKey(secret);
  if (!key || !id || !timestamp || !signature || rawBody == null) return { ok: false, reason: 'missing' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'timestamp' };
  if (Math.abs(now / 1000 - ts) > TOLERANCE_SEC) return { ok: false, reason: 'stale' };
  const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
  const match = String(signature).split(' ').some((part) => {
    if (!part.startsWith('v1,')) return false;
    const given = part.slice(3);
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  });
  return match ? { ok: true } : { ok: false, reason: 'signature' };
}

function addressOnly(value) {
  const raw = String(value || '').trim();
  const wrapped = raw.match(/<([^>]+)>/);
  return (wrapped ? wrapped[1] : raw).trim().toLowerCase();
}

function displayName(value) {
  const raw = String(value || '').trim();
  const wrapped = raw.match(/^(.*)<[^>]+>$/);
  if (!wrapped) return '';
  return wrapped[1].replace(/"/g, '').trim().slice(0, 120);
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function inboundBase() {
  const configured = String(config.mail.replyToInbound || '').trim();
  if (!configured || configured === '-') return '';
  const addr = addressOnly(configured);
  if (!addr.includes('@')) return '';
  return addr;
}

function leadIdFromRecipients(addresses) {
  const base = inboundBase();
  if (!base) return '';
  const at = base.indexOf('@');
  const local = base.slice(0, at).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const domain = base.slice(at + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${local}\\+([a-z0-9-]+)@${domain}$`, 'i');
  for (const value of addresses) {
    const match = addressOnly(value).match(re);
    if (match) return match[1];
  }
  return '';
}

function collectRecipients(data, full) {
  const lists = [data && data.to, data && data.cc, data && data.bcc, data && data.received_for, full && full.to, full && full.cc, full && full.bcc, full && full.received_for];
  const out = [];
  for (const list of lists) {
    if (Array.isArray(list)) out.push(...list);
    else if (list) out.push(list);
  }
  return out;
}

function ownAddress(email) {
  const addr = addressOnly(email);
  return addr === 'quotes@jfhauling.ca' || addr === 'jfhauling@outlook.com' || addr === addressOnly(config.business.email);
}

async function fetchReceived(emailId, fetchImpl) {
  const key = config.resend.apiKey;
  if (!key || !emailId) return null;
  try {
    const res = await fetchImpl(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function handle(req, { fetchImpl = fetch, now = Date.now() } = {}) {
  const secret = config.resend.inboundWebhookSecret;
  const headers = req.headers || {};
  const check = verifySignature({
    secret,
    rawBody: req.rawBody,
    id: headers['svix-id'],
    timestamp: headers['svix-timestamp'],
    signature: headers['svix-signature'],
    now,
  });
  if (!check.ok) {
    const error = check.reason === 'unset' ? 'Inbound webhook is not configured.' : 'Invalid webhook.';
    return { status: 401, body: { error } };
  }
  let event = req.body;
  if (!event || typeof event !== 'object') {
    try { event = JSON.parse(req.rawBody || ''); } catch { event = null; }
  }
  if (!event || event.type !== 'email.received') return { status: 200, body: { ok: true, ignored: true } };
  const data = event.data || {};
  const emailId = String(data.email_id || '').trim().slice(0, 80);
  if (!emailId) return { status: 400, body: { error: 'email_id is required.' } };
  const full = await fetchReceived(emailId, fetchImpl);
  if (!full) return { status: 502, body: { error: 'Could not read that email.' } };
  const headerFrom = full.headers && (full.headers.from || full.headers.From);
  const fromEmail = addressOnly(headerFrom) || addressOnly(full.from) || addressOnly(data.from);
  const fromName = displayName(headerFrom) || displayName(full.from) || '';
  if (!fromEmail || ownAddress(fromEmail)) return { status: 200, body: { ok: true, ignored: true } };
  const subject = String(full.subject || data.subject || '').slice(0, 200);
  const bodyText = String(full.text || '').trim() || htmlToText(full.html);
  const messageId = String(full.message_id || data.message_id || '').trim().slice(0, 200);
  const result = await inbound.receive({
    external_id: emailId,
    from_email: fromEmail,
    from_name: fromName,
    subject,
    body_text: bodyText || subject || 'Email',
    received_at: full.created_at || data.created_at || event.created_at,
    internet_message_id: messageId,
    lead_id: leadIdFromRecipients(collectRecipients(data, full)),
    attachments: full.attachments,
  }, { fetchImpl });
  if (!result.ok) return { status: result.status || 400, body: { error: result.error || 'Could not file that email.' } };
  console.log(`[resend] inbound id=${result.lead_id} duplicate=${result.duplicate ? 'yes' : 'no'}`);
  return {
    status: result.status,
    body: { ok: true, lead_id: result.lead_id, created: result.created, duplicate: result.duplicate },
  };
}

module.exports = { verifySignature, handle, leadIdFromRecipients, htmlToText, inboundBase };
