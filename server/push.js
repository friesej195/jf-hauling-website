// Web Push for the CRM home-screen app. The private VAPID key stays on the disk.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { writeJson, readJson } = require('./secret-file');

const SUBJECT_DEFAULT = 'mailto:jfhauling@outlook.com';
let sender = null;
let ready = null;

function keyFile() { return path.join(config.server.dataDir, 'vapid.json'); }
function subFile() { return path.join(config.server.dataDir, 'push-subscriptions.json'); }

function subject() {
  const value = String(process.env.VAPID_SUBJECT || '').trim();
  return value || SUBJECT_DEFAULT;
}

function ensureKeys() {
  if (ready) return ready;
  const fromEnv = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
    ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
    : null;
  const saved = readJson(keyFile());
  let keys = fromEnv || (saved && saved.publicKey && saved.privateKey ? saved : null);
  if (!keys) {
    const webpush = require('web-push');
    keys = webpush.generateVAPIDKeys();
    writeJson(keyFile(), { publicKey: keys.publicKey, privateKey: keys.privateKey }, 0o600);
    console.log('[push] saved new VAPID keys on the data disk');
  }
  const webpush = require('web-push');
  webpush.setVapidDetails(subject(), keys.publicKey, keys.privateKey);
  ready = keys;
  return keys;
}

function publicKey() {
  try { return ensureKeys().publicKey; } catch { return ''; }
}

function configured() {
  return !!publicKey();
}

function list() {
  const rows = readJson(subFile());
  return Array.isArray(rows) ? rows : [];
}

function save(subscription) {
  const endpoint = subscription && subscription.endpoint;
  const keys = subscription && subscription.keys;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) return null;
  const rows = list().filter((row) => row.endpoint !== endpoint);
  rows.push({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, createdAt: new Date().toISOString() });
  writeJson(subFile(), rows, 0o600);
  return rows;
}

function remove(endpoint) {
  const rows = list().filter((row) => row.endpoint !== endpoint);
  writeJson(subFile(), rows, 0o600);
  return rows;
}

function setSender(fn) { sender = fn; }

async function deliver(sub, payload) {
  const body = JSON.stringify(payload);
  try {
    if (sender) {
      await sender(sub, payload);
      return;
    }
    const webpush = require('web-push');
    ensureKeys();
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body);
  } catch (err) {
    const code = err && (err.statusCode || err.status);
    if (code === 404 || code === 410) {
      remove(sub.endpoint);
      console.log('[push] removed expired subscription');
    } else {
      console.error(`[push] send failed status=${code || 'error'}`);
    }
  }
}

function withBadge(payload) {
  let badge = 0;
  try { badge = require('./leads').attentionCount(); } catch { badge = 0; }
  if (!Number.isFinite(badge) || badge < 0) badge = 0;
  return Object.assign({}, payload, { badge: Math.floor(badge) });
}

async function broadcast(payload) {
  if (!configured()) return 0;
  const rows = list();
  const body = withBadge(payload);
  await Promise.all(rows.map((sub) => deliver(sub, body)));
  return rows.length;
}

function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Someone';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

function place(value) {
  return String(value || '').split(',')[0].trim();
}

function quoteText(lead) {
  const who = shortName(lead.name);
  const load = lead.loadType || '';
  const route = [place(lead.pickup), place(lead.dropoff)].filter(Boolean).join(' to ');
  const detail = [load, route].filter(Boolean).join(', ');
  return detail ? `New quote: ${who} - ${detail}` : `New quote: ${who}`;
}

function inboundText(lead, channel, preview) {
  const who = shortName(lead.name || lead.email || lead.phone);
  const kind = channel === 'sms' ? 'Text' : 'Email';
  const bit = String(preview || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return bit ? `${kind} from ${who}: ${bit}` : `${kind} from ${who}`;
}

function leadUrl(id) {
  return id ? `/crm/lead/${encodeURIComponent(id)}` : '/crm/';
}

async function notifyNewLead(lead) {
  if (!lead) return;
  const body = lead.source === 'website' ? quoteText(lead) : inboundText(lead, lead.source === 'sms' ? 'sms' : 'email', lead.message);
  await broadcast({ title: 'JF Hauling', body, url: leadUrl(lead.id) });
}

async function notifyInbound(lead, channel, preview) {
  if (!lead) return;
  await broadcast({ title: 'JF Hauling', body: inboundText(lead, channel, preview), url: leadUrl(lead.id) });
}

async function notifyCustom({ title, body, leadId }) {
  await broadcast({
    title: String(title || 'JF Hauling').slice(0, 80),
    body: String(body || '').slice(0, 180),
    url: leadUrl(leadId),
  });
}

module.exports = {
  ensureKeys, publicKey, configured, list, save, remove, setSender, deliver, broadcast,
  notifyNewLead, notifyInbound, notifyCustom, quoteText, shortName, withBadge,
};
