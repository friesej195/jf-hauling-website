// Optional email notification. Does nothing unless SMTP_HOST is set.
const config = require('../config');
let transporter = null;
function getTransport() {
  if (!config.smtp.host) return null;
  if (!transporter) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transporter;
}
async function notify(subject, text) {
  const t = getTransport();
  if (!t || !config.smtp.notifyTo) return false;
  try {
    await t.sendMail({ from: config.smtp.from || config.smtp.user, to: config.smtp.notifyTo, subject, text });
    return true;
  } catch (e) { console.warn('[mailer] failed:', e.message); return false; }
}
module.exports = { notify, enabled: () => !!(config.smtp.host && config.smtp.notifyTo) };
