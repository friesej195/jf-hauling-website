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

async function sendResend({ from, to, replyTo, subject, text }) {
  const payload = { from, to: [to], subject, text };
  if (replyTo) payload.reply_to = replyTo;
  const res = await fetch('https://api.resend.com/emails', {
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

module.exports = {
  notify,
  mode,
  enabled: () => mode() !== 'off' && !!config.mail.notifyTo,
};
