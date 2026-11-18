// Dispatch alerts. Resend (HTTPS) is preferred when RESEND_API_KEY is set.
// SMTP is the fallback when that key is blank and SMTP_HOST is set.
// Does nothing in any other case. Never logs secrets or customer addresses.
const config = require('../config');
const guard = require('./address-guard');

let transporter = null;

function mode() {
  if (config.resend.apiKey) return 'resend';
  if (config.smtp.host) return 'smtp';
  return 'off';
}

function fromAddress() {
  if (config.mail.from) return config.mail.from;
  if (mode() === 'smtp') return config.smtp.from || config.smtp.user || config.mail.defaultFrom;
  return config.mail.defaultFrom;
}

function getTransport() {
  if (!config.smtp.host) return null;
  if (!transporter) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      connectionTimeout: 15000,
      socketTimeout: 15000,
    });
  }
  return transporter;
}

function redact(value) {
  return String(value || '').replace(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi, '[redacted]');
}

function logResult(ok, reference, err) {
  const ref = reference || '-';
  if (ok) console.log(`[mailer] sent ref=${ref} mode=${mode()}`);
  else console.warn(`[mailer] failed ref=${ref} mode=${mode()} error=${redact(err && err.message ? err.message : err)}`);
}

function addressOnly(from) {
  const raw = String(from || '').trim();
  const wrapped = raw.match(/<([^>]+)>/);
  return (wrapped ? wrapped[1] : raw).trim();
}

function crmFrom() {
  return guard.customerFrom(fromAddress(), 'MAIL_FROM');
}

function customerReplyList(lead) {
  const configured = String(config.mail.replyToInbound || '').trim();
  const addr = addressOnly(configured).toLowerCase();
  if (!configured || configured === '-' || guard.blocked(configured) || !addr.includes('@')) {
    if (configured && guard.blocked(configured)) console.warn('[mailer] refused customer-visible address var=CRM_REPLY_TO_INBOUND');
    return guard.customerReplyTo(config.business.email, 'EMAIL');
  }
  const at = addr.indexOf('@');
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  const id = lead && lead.id ? String(lead.id).replace(/[^A-Za-z0-9-]/g, '') : '';
  const tagged = id ? `${local}+${id}@${domain}` : addr;
  return [`JF Hauling <${tagged}>`, guard.SAFE_REPLY];
}

async function sendResend(message, fetchImpl = fetch) {
  const to = Array.isArray(message.to) ? message.to : [message.to];
  const payload = { from: message.from, to, subject: message.subject, text: message.text };
  if (message.html) payload.html = message.html;
  if (message.replyTo) payload.reply_to = message.replyTo;
  if (message.bcc) payload.bcc = Array.isArray(message.bcc) ? message.bcc : [message.bcc];
  if (message.headers && Object.keys(message.headers).length) payload.headers = message.headers;
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resend.apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'jf-hauling-website',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    if (res.body && typeof res.body.cancel === 'function') await res.body.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
  }
}

async function notify(subject, text, opts = {}) {
  const active = mode();
  if (active === 'off' || !config.mail.notifyTo) return false;
  const replyTo = opts.replyTo ? String(opts.replyTo).trim() : '';
  const message = {
    from: guard.dispatchFrom(fromAddress(), 'MAIL_FROM'),
    to: guard.dispatchTo(config.mail.notifyTo, 'NOTIFY_TO'),
    replyTo,
    subject,
    text: guard.stripBlocked(text),
  };
  try {
    if (active === 'resend') {
      await sendResend(message);
    } else {
      const t = getTransport();
      if (!t) return false;
      await t.sendMail({
        from: message.from,
        to: message.to,
        replyTo: replyTo || undefined,
        subject,
        text,
      });
    }
    logResult(true, opts.reference);
    return true;
  } catch (e) {
    logResult(false, opts.reference, e);
    return false;
  }
}

async function sendCustomer({ to, subject, text, messageId, inReplyTo, references, reference, replyTo: requestedReply, fetchImpl } = {}) {
  const active = mode();
  if (active === 'off') return { ok: false, error: 'off' };
  const replyTo = requestedReply || customerReplyList();
  const bcc = guard.customerBcc(config.mail.crmBcc, 'CRM_EMAIL_BCC');
  const headers = guard.cleanHeaders({
    ...(messageId ? { 'Message-ID': messageId } : {}),
    ...(inReplyTo ? { 'In-Reply-To': inReplyTo } : {}),
    ...(references && references.length ? { References: references.join(' ') } : {}),
  });
  const signed = require('./signature').composeEmail(guard.stripBlocked(text));
  const message = { from: crmFrom(), to, replyTo, bcc, subject: guard.stripBlocked(subject), text: signed.text, html: signed.html, headers };
  try {
    if (active === 'resend') {
      await sendResend(message, fetchImpl);
    } else {
      const transport = getTransport();
      if (!transport) return { ok: false, error: 'off' };
      await transport.sendMail({
        from: message.from,
        to,
        bcc: bcc || undefined,
        replyTo: replyTo || undefined,
        subject: message.subject,
        text: message.text,
        html: message.html,
        messageId: messageId || undefined,
        inReplyTo: inReplyTo || undefined,
        references: references && references.length ? references : undefined,
      });
    }
    logResult(true, reference);
    return { ok: true };
  } catch (e) {
    logResult(false, reference, e);
    return { ok: false, error: 'mail-send' };
  }
}

module.exports = {
  notify,
  sendCustomer,
  crmFrom,
  customerReplyList,
  mode,
  enabled: () => mode() !== 'off' && !!config.mail.notifyTo,
};
