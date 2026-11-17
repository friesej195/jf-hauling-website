# JF Hauling CRM — Outlook, texting, and AI replies

The leads list is at `/crm`. Sign-in uses `CRM_PASSWORD`. This page is how to turn on email from `jfhauling@outlook.com`, texts, and the optional AI reply.

Nothing here belongs in the git repo. Put every secret in the Render service **jf-hauling** → Environment. A blueprint sync does not fill a new secret on a service that already exists, so type them in the Dashboard and save. Render redeploys. Do not paste the secret values into a file in this project.

The refresh token for Outlook is written to `/var/data/outlook-token.json` on the existing disk (mode 600). Leads stay in `/var/data/leads.json`.

## Env vars

| Variable | Required for | Notes |
|---|---|---|
| `CRM_PASSWORD` | `/crm` sign-in | No default. Sign-in stays off until this is set |
| `CRM_API_TOKEN` | `POST /api/leads` | Optional once Outlook inbox check is on |
| `MS_CLIENT_ID` | Outlook | Application (client) ID from Azure |
| `MS_CLIENT_SECRET` | Outlook | The secret **Value**, not the Secret ID |
| `MS_REDIRECT_URI` | Outlook | Default `https://jfhauling.ca/crm/oauth/callback`. Must match Azure exactly |
| `MS_TENANT` | Outlook | Optional. Leave unset. The app uses `consumers` for a personal Outlook.com account |
| `TWILIO_ACCOUNT_SID` | Texts | Starts with `AC` |
| `TWILIO_AUTH_TOKEN` | Texts | Used to send and to check `X-Twilio-Signature` |
| `TWILIO_FROM_NUMBER` | Texts | Your Twilio number in E.164, e.g. `+12265550199` |
| `OPENAI_API_KEY` | AI draft and auto-reply | Also used by the public quote assistant if you want that |
| `OPENAI_MODEL` | AI | Optional. Default `gpt-4o-mini` |
| `AI_AUTOREPLY_ENABLED` | AI auto-reply kill switch | Optional. Unset or `true` allows auto-reply. `false` stops every automatic send. Draft with AI still works when the key is set |

Until the Microsoft vars are set, Settings says Outlook is off. Until the three Twilio vars are set, texting is off. Until `OPENAI_API_KEY` is set, Draft with AI and auto-reply are off.

## 1. Register the Azure app (Outlook.com)

Use the Microsoft account that owns `jfhauling@outlook.com` (or a Microsoft account that can sign in as that mailbox).

1. Open [https://portal.azure.com](https://portal.azure.com) and sign in.
2. Search for **App registrations** and open it.
3. **New registration**.
   - Name: `JF Hauling CRM`
   - Supported account types: **Personal Microsoft accounts only**
     - If that mailbox is a work account, choose **Accounts in any organizational directory and personal Microsoft accounts** instead. Leave `MS_TENANT` unset either way (`consumers` works for a personal Outlook.com account; use `MS_TENANT=common` only if you chose “any org + personal” and sign-in fails).
   - Redirect URI: platform **Web** (not Single-page application). A single-page app cannot use a client secret.
   - URI: `https://jfhauling.ca/crm/oauth/callback`
4. Register.
5. On the app’s **Overview** page, copy **Application (client) ID**. That is `MS_CLIENT_ID`.
6. **Certificates & secrets** → **New client secret**. Copy the **Value** immediately. That is `MS_CLIENT_SECRET`. The Secret ID is not the secret.
7. **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**. Add:
   - `Mail.Send`
   - `Mail.Read`
   - `User.Read`
   - `offline_access` is requested by the CRM at sign-in. If the permission list shows it under OpenId permissions, add it too. You do not need application (app-only) permissions.
8. Personal Microsoft accounts do not use “Grant admin consent” the way a company tenant does. The first time you press **Connect Outlook**, Microsoft asks you to accept these permissions. An unverified-publisher warning is normal for a private app. Continue only because this is your own app.
9. On Render, set `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, and `MS_REDIRECT_URI` (`https://jfhauling.ca/crm/oauth/callback`). Save and wait for the deploy.
10. Open `https://jfhauling.ca/crm/settings` and press **Connect Outlook**. Sign in as `jfhauling@outlook.com` and accept the prompt.
11. Settings should say Outlook is connected. **Check inbox** reads the latest Inbox messages. The server also checks about once a minute after boot and then every 10 minutes.
    - A message from someone already on a lead is filed on that lead’s conversation.
    - A new message that looks like a haul, shed, container, or quote request becomes a lead with source `email`. The Graph message id is stored so a later send replies in that thread.
    - Mail from noreply, mailer-daemon, newsletters, and from `jfhauling@outlook.com` is skipped.

Sending from a lead uses that thread when the lead’s reference is a Graph message id. Otherwise it sends a new message and keeps a copy in Sent.

## 2. Twilio number

1. In the Twilio console, copy the Account SID and Auth Token.
2. Buy or choose a Canadian SMS-capable number. Copy it in E.164 form (`+1` and 10 digits).
3. On Render, set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`.
4. Twilio → Phone Numbers → your number → Messaging:
   - A message comes in: **Webhook**, HTTP **POST**
   - URL: `https://jfhauling.ca/api/twilio/sms`
5. Save. The CRM checks `X-Twilio-Signature` with the auth token. A request that fails the check is rejected.
6. An inbound text is filed on the lead with the same phone number (Canadian numbers are matched on the last 10 digits). If nobody matches, it creates a lead with source `sms`.

Outbound texts from the lead page use the lead’s phone, normalized to `+1` when it is a 10-digit Canadian number.

## 3. OpenAI key and auto-reply

1. Set `OPENAI_API_KEY` on Render. Optional: `OPENAI_MODEL` (default `gpt-4o-mini`).
2. **Draft with AI** on a lead fills the email or text box. You still press Send. This works even when auto-reply is off.
3. Each lead has **AI auto-reply**, default **off**. Turn it on only for that lead.
4. Settings has a global switch, **AI auto-reply for leads that have it on**. Turning it off stops every automatic send. `AI_AUTOREPLY_ENABLED=false` does the same from the server and wins over the Settings switch.
5. When a lead’s switch is on and a new email or text arrives from that person, the CRM may send one reply on the same channel and mark it **AI** on the conversation.
6. Limits, always on:
   - At most 3 AI auto-replies per lead per 24 hours.
   - No auto-reply to noreply, mailer-daemon, bulk mail, or to `jfhauling@outlook.com` / the Twilio number.
   - If the customer asks to speak to a person, complains, or mentions payment or cancellation, auto-reply turns off for that lead and the lead is flagged **Needs Johan**.
   - The reply does not promise a firm price, date, or availability. It points people at `https://jfhauling.ca/quote` and says Johan or the dispatcher will confirm. Shed mule pricing is “check with the dispatcher”.

## 4. What you do not need

You do not need a separate program posting to `POST /api/leads` for email once Outlook is connected. That API still works if you set `CRM_API_TOKEN`.
