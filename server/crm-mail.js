// CRM customer email. Microsoft Graph is used only when MS_CLIENT_ID is set.
// Otherwise the same Resend or SMTP mail the quote alerts already use.
const crypto = require('crypto');
const config = require('../config');
const mailer = require('./mailer');
const outlook = require('./outlook');
const leads = require('./leads');

function graphOn() {
  return !!(config.microsoft.clientId && outlook.configured());
}

function normalizeId(id) {
  const s = String(id || '').trim();
  if (!s) return '';
  if (s.startsWith('<') && s.endsWith('>')) return s;
  return `<${s.replace(/^<|>$/g, '')}>`;
}

function threadFor(lead) {
  const items = ((lead && lead.timeline) || []).filter((item) => item.kind === 'email' && item.messageId);
  const lastIn = [...items].reverse().find((item) => item.direction === 'in');
  const domain = (mailer.crmFrom().match(/@([^>]+)>/) || [])[1] || 'jfhauling.ca';
  const messageId = `<crm.${lead.id}.${crypto.randomBytes(6).toString('hex')}@${domain}>`;
  const inReplyTo = lastIn ? normalizeId(lastIn.messageId) : '';
  const references = [...new Set(items.map((item) => normalizeId(item.messageId)).concat(inReplyTo ? [inReplyTo] : []))].filter(Boolean);
  return { messageId, inReplyTo, references };
}

async function sendLeadEmail({ lead, to, subject, body, ai = false, fetchImpl } = {}) {
  const sub = String(subject || 'JF Hauling').slice(0, 200);
  const text = String(body || '').slice(0, 4000);
  if (!to || !text) return { ok: false, error: !to ? 'no-email' : 'empty' };
  if (graphOn()) {
    const sent = await outlook.sendEmail({
      to,
      subject: sub,
      body: text,
      replyToId: outlook.graphMessageId(lead),
      fetchImpl,
    });
    if (!sent.ok) return sent;
    const added = leads.addTimeline(lead.id, { kind: 'email', direction: 'out', subject: sub, body: text, ai: !!ai });
    return { ok: true, threaded: !!sent.threaded, lead: added.lead };
  }
  if (mailer.mode() === 'off') return { ok: false, error: 'mail-off' };
  const thread = threadFor(lead);
  const sent = await mailer.sendCustomer({
    to,
    subject: sub,
    text,
    messageId: thread.messageId,
    inReplyTo: thread.inReplyTo,
    references: thread.references,
    reference: lead.id,
    replyTo: mailer.customerReplyList(lead),
    fetchImpl,
  });
  if (!sent.ok) return { ok: false, error: sent.error === 'off' ? 'mail-off' : 'mail-send' };
  const added = leads.addTimeline(lead.id, {
    kind: 'email', direction: 'out', subject: sub, body: text, ai: !!ai, messageId: thread.messageId,
  });
  return { ok: true, threaded: !!thread.inReplyTo, messageId: thread.messageId, lead: added.lead };
}

module.exports = { graphOn, threadFor, sendLeadEmail, normalizeId };
