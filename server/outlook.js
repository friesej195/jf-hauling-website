// Microsoft Graph mail for the owner's Outlook.com mailbox.
// The refresh token stays on the persistent disk and is never logged.
const path = require('path');
const config = require('../config');
const { writeJson, readJson } = require('./secret-file');

const SCOPES = 'offline_access Mail.Send Mail.Read User.Read';
const GRAPH = 'https://graph.microsoft.com/v1.0';

function tenant() {
  const t = String(config.microsoft.tenant || 'consumers');
  if (/^(consumers|common|organizations|[0-9a-f-]{36})$/i.test(t)) return t;
  return 'consumers';
}

function configured() {
  return !!(config.microsoft.clientId && config.microsoft.clientSecret && config.microsoft.redirectUri);
}

function tokenFile() { return path.join(config.server.dataDir, 'outlook-token.json'); }

function loadTokens() {
  const saved = readJson(tokenFile());
  if (!saved || !saved.refreshToken) return null;
  return saved;
}

function connected() { return !!loadTokens(); }

function accountEmail() {
  const saved = loadTokens();
  return (saved && saved.account) || '';
}

function saveTokens(tokens) {
  const prev = loadTokens() || {};
  writeJson(tokenFile(), {
    refreshToken: tokens.refreshToken || prev.refreshToken,
    accessToken: tokens.accessToken || '',
    expiresAt: tokens.expiresAt || 0,
    account: tokens.account || prev.account || '',
  }, 0o600);
}

function disconnect() {
  const fs = require('fs');
  try { fs.unlinkSync(tokenFile()); } catch { /* already gone */ }
}

function authorizeUrl(state) {
  const u = new URL(`https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize`);
  u.searchParams.set('client_id', config.microsoft.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', config.microsoft.redirectUri);
  u.searchParams.set('response_mode', 'query');
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('state', state);
  u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

async function tokenRequest(fields, fetchImpl) {
  const body = new URLSearchParams({
    client_id: config.microsoft.clientId,
    client_secret: config.microsoft.clientSecret,
    scope: SCOPES,
    ...fields,
  });
  const res = await fetchImpl(`https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const err = new Error('token');
    err.status = res.status;
    err.code = json.error || '';
    throw err;
  }
  return json;
}

async function exchangeCode(code, fetchImpl = fetch) {
  const json = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.microsoft.redirectUri,
  }, fetchImpl);
  const account = await mailbox(json.access_token, fetchImpl);
  saveTokens({
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    account,
  });
  console.log('[outlook] connected');
  return account;
}

async function mailbox(accessToken, fetchImpl) {
  try {
    const res = await fetchImpl(`${GRAPH}/me?$select=mail,userPrincipalName`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return '';
    const json = await res.json();
    return String(json.mail || json.userPrincipalName || '').toLowerCase();
  } catch {
    return '';
  }
}

async function getAccessToken(fetchImpl = fetch) {
  const saved = loadTokens();
  if (!saved) {
    const err = new Error('not-connected');
    err.code = 'not-connected';
    throw err;
  }
  if (saved.accessToken && saved.expiresAt > Date.now() + 60 * 1000) return saved.accessToken;
  try {
    const json = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: saved.refreshToken,
    }, fetchImpl);
    const account = saved.account || await mailbox(json.access_token, fetchImpl);
    saveTokens({
      refreshToken: json.refresh_token || saved.refreshToken,
      accessToken: json.access_token,
      expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
      account,
    });
    return json.access_token;
  } catch (err) {
    if (err && (err.code === 'invalid_grant' || err.status === 400)) disconnect();
    console.error(`[outlook] refresh failed status=${err && err.status ? err.status : 'error'}`);
    throw err;
  }
}

// Graph message ids are long and do not look like a quote ref or an internet message id.
function graphMessageId(lead) {
  if (!lead || lead.source !== 'email') return '';
  const id = String(lead.externalId || '').trim();
  if (!id || id.startsWith('quote:') || id.includes('@') || /\s/.test(id) || id.length < 20) return '';
  return id;
}

async function deliverEmail({ accessToken, to, subject, body, html, replyToId, fetchImpl }) {
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  if (replyToId) {
    const replyUrl = `${GRAPH}/me/messages/${encodeURIComponent(replyToId)}/reply`;
    const reply = await fetchImpl(replyUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ comment: body }),
    });
    if (reply.ok || reply.status === 202) return { ok: true, threaded: true };
    if (reply.status !== 404) {
      console.error(`[outlook] reply failed status=${reply.status}`);
      return { ok: false, error: 'outlook-send' };
    }
  }
  const payload = {
    message: {
      subject: subject || 'JF Hauling',
      body: html ? { contentType: 'HTML', content: html } : { contentType: 'Text', content: body },
      toRecipients: [{ emailAddress: { address: to } }],
    },
    saveToSentItems: true,
  };
  const res = await fetchImpl(`${GRAPH}/me/sendMail`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok && res.status !== 202) {
    console.error(`[outlook] send failed status=${res.status}`);
    return { ok: false, error: 'outlook-send' };
  }
  return { ok: true, threaded: false };
}

async function sendEmail({ to, subject, body, replyToId, fetchImpl = fetch }) {
  if (!configured()) return { ok: false, error: 'outlook-off' };
  if (!connected()) return { ok: false, error: 'outlook' };
  let accessToken;
  try { accessToken = await getAccessToken(fetchImpl); }
  catch { return { ok: false, error: 'outlook' }; }
  const signed = require('./signature').composeEmail(body);
  return deliverEmail({ accessToken, to, subject, body: signed.text, html: signed.html, replyToId, fetchImpl });
}

function isBulkAddress(email) {
  const e = String(email || '').toLowerCase().trim();
  if (!e || !e.includes('@')) return true;
  const local = e.split('@')[0].replace(/\+.*$/, '');
  if (/^(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|newsletter|newsletters|notifications|notification|bounce|bounces|daemon|news|updates|info-news)$/.test(local)) return true;
  if (/noreply|no-reply|donotreply|mailer-daemon|newsletter/.test(local)) return true;
  return false;
}

function looksLikeInquiry(subject, body) {
  return /quote|haul|hauling|shed|container|trailer|flat[\s-]?deck|pick[\s-]?up|drop[\s-]?off|\bload\b|freight|\bmove\b|moving|skid|equipment|deliver/i.test(`${subject || ''}\n${body || ''}`);
}

function ownAddress() {
  const saved = (accountEmail() || '').toLowerCase();
  const business = String(config.business.email || '').toLowerCase();
  return { saved, business };
}

async function pullInbox(fetchImpl = fetch) {
  if (!configured() || !connected()) return { ok: false, reason: 'off', created: 0, logged: 0 };
  const leads = require('./leads');
  let accessToken;
  try { accessToken = await getAccessToken(fetchImpl); }
  catch { return { ok: false, reason: 'auth', created: 0, logged: 0 }; }
  const url = `${GRAPH}/me/mailFolders/inbox/messages?$top=25&$orderby=receivedDateTime desc&$select=id,subject,from,bodyPreview,receivedDateTime,isDraft,internetMessageId`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    console.error(`[outlook] inbox failed status=${res.status}`);
    return { ok: false, reason: 'inbox', created: 0, logged: 0 };
  }
  const json = await res.json();
  const messages = Array.isArray(json.value) ? json.value : [];
  let created = 0;
  let logged = 0;
  const own = ownAddress();
  for (const msg of messages) {
    if (!msg || msg.isDraft || !msg.id) continue;
    const internetId = String(msg.internetMessageId || '').trim();
    if (leads.findByExternalId(msg.id)) continue;
    if (internetId && leads.findByMessageId(internetId)) continue;
    const from = msg.from && msg.from.emailAddress ? msg.from.emailAddress : {};
    const email = String(from.address || '').toLowerCase();
    const name = String(from.name || '').trim();
    const subject = String(msg.subject || '').slice(0, 200);
    const preview = String(msg.bodyPreview || '').slice(0, 4000);
    if (!email || email === own.saved || email === own.business || isBulkAddress(email)) continue;
    let lead = leads.findByEmail(email);
    let isNew = false;
    if (!lead) {
      if (!looksLikeInquiry(subject, preview)) continue;
      const made = leads.create({
        source: 'email',
        name,
        email,
        message: [subject, preview].filter(Boolean).join('\n\n'),
        externalId: msg.id,
      }, { defaultSource: 'email' });
      if (!made.ok) continue;
      lead = made.lead;
      if (made.duplicate) continue;
      isNew = true;
      created += 1;
      console.log(`[leads] created id=${lead.id} source=email`);
    }
    const added = leads.addTimeline(lead.id, {
      kind: 'email',
      direction: 'in',
      subject,
      body: preview,
      externalId: msg.id,
      messageId: internetId,
      at: msg.receivedDateTime || new Date().toISOString(),
    });
    if (added && added.duplicate) continue;
    logged += 1;
    let closed = false;
    try {
      const intent = require('./intent');
      const decision = await intent.applyCustomerIntent(lead.id, `${subject}\n${preview}`, fetchImpl);
      closed = !!decision.closed;
    } catch { /* classification is optional */ }
    if (!closed && !isNew) {
      try {
        const ai = require('./ai-reply');
        await ai.handleAutoReply(lead.id, { channel: 'email', from: email, text: `${subject}\n${preview}`, subject, fetchImpl });
      } catch (err) {
        console.error(`[ai] failed id=${lead.id} reason=email`);
      }
    }
  }
  return { ok: true, created, logged };
}

let pollStarted = false;
function startInboxPoll() {
  if (pollStarted) return;
  pollStarted = true;
  const run = () => {
    pullInbox().catch(() => console.error('[outlook] inbox check failed'));
  };
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, 10 * 60 * 1000).unref();
}

module.exports = {
  SCOPES, configured, connected, accountEmail, authorizeUrl, exchangeCode, disconnect,
  graphMessageId, deliverEmail, sendEmail, getAccessToken, pullInbox, startInboxPoll,
  isBulkAddress, looksLikeInquiry, saveTokens, loadTokens, tokenFile,
};
