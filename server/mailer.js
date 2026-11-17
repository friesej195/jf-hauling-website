// Dispatch alerts. Resend (HTTPS) is preferred when RESEND_API_KEY is set.
// SMTP is the fallback when that key is blank and SMTP_HOST is set.
// Does nothing in any other case. Never logs secrets or customer addresses.
const config = require('../config');

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
  return `JF Hauling <${addressOnly(fromAddress())}>`;
}

async function sendResend(message, fetchImpl = fetch) {
  const to = Array.isArray(message.to) ? message.to : [message.to];
  const payload = { from: message.from, to, subject: message.subject, text: message.text };
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
  const message = { from: fromAddress(), to: config.mail.notifyTo, replyTo, subject, text };
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

async function sendCustomer({ to, subject, text, messageId, inReplyTo, references, reference, fetchImpl } = {}) {
  const active = mode();
  if (active === 'off') return { ok: false, error: 'off' };
  const replyTo = config.business.email;
  const bcc = config.mail.crmBcc && config.mail.crmBcc !== '-' && config.mail.crmBcc !== 'off' ? config.mail.crmBcc : '';
  const headers = {};
  if (messageId) headers['Message-ID'] = messageId;
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
  if (references && references.length) headers.References = references.join(' ');
  const message = { from: crmFrom(), to, replyTo, bcc, subject, text, headers };
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
        subject,
        text,
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
  mode,
  enabled: () => mode() !== 'off' && !!config.mail.notifyTo,
};
