// Emails pushed in by an external inbox reader. Bearer token is checked by the route.
const leads = require('./leads');

function text(v, n) {
  if (v == null) return '';
  if (typeof v === 'object') return null;
  return String(v).replace(/\r\n/g, '\n').trim().slice(0, n);
}

function validEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || ''));
}

function when(value) {
  if (!value) return new Date().toISOString();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

async function receive(raw, { fetchImpl } = {}) {
  const body = raw || {};
  const externalId = text(body.external_id, 512);
  const fromEmail = text(body.from_email, 150);
  const fromName = text(body.from_name, 120);
  const subject = text(body.subject, 200);
  const bodyText = text(body.body_text, 4000);
  const internetId = text(body.internet_message_id, 200);
  if (externalId == null || fromEmail == null || subject == null || bodyText == null) {
    return { ok: false, status: 400, error: 'Send plain text in each field.' };
  }
  if (!externalId) return { ok: false, status: 400, error: 'external_id is required.' };
  if (!validEmail(fromEmail)) return { ok: false, status: 400, error: 'from_email must be an email address.' };
  const at = when(body.received_at);
  if (body.received_at && at == null) return { ok: false, status: 400, error: 'received_at must be a date.' };

  const duplicate = leads.findByExternalId(externalId);
  if (duplicate) {
    return { ok: true, status: 200, lead_id: duplicate.id, created: false, duplicate: true, auto_replied: false };
  }

  let lead = leads.findByEmail(fromEmail);
  let created = false;
  if (!lead) {
    const made = leads.create({
      source: 'email',
      name: fromName || '',
      email: fromEmail.toLowerCase(),
      message: [subject, bodyText].filter(Boolean).join('\n\n') || 'Email',
      externalId,
    }, { defaultSource: 'email' });
    if (!made.ok) return { ok: false, status: made.status || 400, error: made.error };
    if (made.duplicate) {
      return { ok: true, status: 200, lead_id: made.lead.id, created: false, duplicate: true, auto_replied: false };
    }
    lead = made.lead;
    created = true;
    console.log(`[leads] created id=${lead.id} source=email`);
  }

  const filed = leads.addTimeline(lead.id, {
    kind: 'email',
    direction: 'in',
    subject,
    body: bodyText || subject || 'Email',
    externalId,
    messageId: internetId,
    at,
  });
  if (!filed.ok) return { ok: false, status: filed.status || 400, error: filed.error };
  leads.touchContact(lead.id, at);
  if (!filed.duplicate) {
    const push = require('./push');
    const notice = created ? push.notifyNewLead(lead) : push.notifyInbound(lead, 'email', bodyText || subject);
    notice.catch(() => console.error(`[push] failed id=${lead.id}`));
  }

  let autoReplied = false;
  const fresh = leads.find(lead.id);
  if (fresh && fresh.aiAutoReply && !filed.duplicate) {
    const ai = require('./ai-reply');
    const result = await ai.handleAutoReply(fresh.id, {
      channel: 'email',
      from: fromEmail,
      text: [subject, bodyText].filter(Boolean).join('\n'),
      subject,
      fetchImpl,
    });
    autoReplied = !!result.sent;
  }
  return {
    ok: true,
    status: created ? 201 : 200,
    lead_id: lead.id,
    created,
    duplicate: false,
    auto_replied: autoReplied,
  };
}

function knownEmails() {
  const set = new Set();
  for (const lead of leads.all()) {
    const email = String(lead.email || '').trim().toLowerCase();
    if (email) set.add(email);
  }
  return [...set].sort();
}

module.exports = { receive, knownEmails };
