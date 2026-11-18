# JF Hauling CRM — email, texting, and AI replies

The leads list is at `/crm`. Sign-in uses `CRM_PASSWORD`. Customer email uses the same Resend (or SMTP) mail as quote alerts. A copy goes to `jfhauling@outlook.com`. Texts use Twilio. AI replies are optional.

Nothing here belongs in the git repo. Put every secret in the Render service **jf-hauling** → Environment. A blueprint sync does not fill a new secret on a service that already exists, so type them in the Dashboard and save. Render redeploys. Do not paste the secret values into a file in this project.

Leads stay in `/var/data/leads.json`. An Outlook Graph token is written only if you set `MS_CLIENT_ID` and connect; personal Outlook.com accounts cannot create that app anymore, so leave those Microsoft vars blank.

## Env vars

| Variable | Required for | Notes |
|---|---|---|
| `CRM_PASSWORD` | `/crm` sign-in | No default. Sign-in stays off until this is set |
| `CRM_API_TOKEN` | Inbound email API | Bearer token for `POST /api/leads`, `POST /api/leads/inbound-email`, and `GET /api/leads/known-emails` |
| `CRM_EMAIL_BCC` | Copy of CRM mail | Optional. Default `jfhauling@outlook.com`. Set to `-` for no copy |
| `RESEND_API_KEY` | Sending | Same key as quote alerts. Preferred over SMTP |
| `MAIL_FROM` | Sending | Optional. Default `JF Hauling Website <quotes@jfhauling.ca>`. CRM mail uses that address with the display name `JF Hauling` |
| `MS_CLIENT_ID` | Optional Graph | Leave blank. Personal Outlook.com cannot register an Azure app |
| `MS_CLIENT_SECRET` | Optional Graph | Only if `MS_CLIENT_ID` is set |
| `MS_REDIRECT_URI` | Optional Graph | Only if `MS_CLIENT_ID` is set |
| `TWILIO_ACCOUNT_SID` | Texts | Starts with `AC` |
| `TWILIO_AUTH_TOKEN` | Texts | Used to send and to check `X-Twilio-Signature` |
| `TWILIO_FROM_NUMBER` | Texts | Your Twilio number in E.164, e.g. `+12265550199` |
| `OPENAI_API_KEY` | AI draft and auto-reply | Also used by the public quote assistant if you want that |
| `OPENAI_MODEL` | AI | Optional. Default `gpt-4o-mini` |
| `AI_AUTOREPLY_ENABLED` | AI auto-reply kill switch | Optional. Unset or `true` allows auto-reply. `false` stops every automatic send. Draft with AI still works when the key is set |

Until `RESEND_API_KEY` or SMTP is set, CRM email cannot send. Until the three Twilio vars are set, texting is off. Until `OPENAI_API_KEY` is set, Draft with AI and auto-reply are off. Leave the Microsoft vars blank.

## 1. Customer email (no Azure app)

Settings shows: “Email sends via JF Hauling mail, replies go to jfhauling@outlook.com.” There is no Connect Outlook button unless `MS_CLIENT_ID` is set.

What the customer sees:

- From: `JF Hauling <quotes@jfhauling.ca>` (or whatever address is inside `MAIL_FROM`)
- Reply-To: `jfhauling@outlook.com`
- A copy (BCC) to `jfhauling@outlook.com`, or to `CRM_EMAIL_BCC` if you set it

Quote alerts already use this same Resend key and from address. They only need to reach one inbox. CRM mail needs to reach any customer.

Resend will send to any recipient only after the **from domain** is verified. That is `jfhauling.ca` when the from address is `quotes@jfhauling.ca`. It is not a limit on who you write to. If the domain is not verified, Resend only allows test mail from `onboarding@resend.dev` to the email on the Resend account, and a send to a customer fails.

What to check in Resend:

1. Domains → `jfhauling.ca` is verified (the DKIM and SPF records Resend shows are on the DNS for `jfhauling.ca`).
2. `RESEND_API_KEY` is set on the jf-hauling service.
3. `MAIL_FROM` is blank, or it is an address on that verified domain. The default is `JF Hauling Website <quotes@jfhauling.ca>`.

You do not verify `outlook.com`. Reply-To and BCC can be `jfhauling@outlook.com` without Outlook being a sending domain.

If quote alerts are already arriving from `quotes@jfhauling.ca`, the domain is verified and CRM mail can go to customers. If those alerts are not arriving, verify the domain before expecting CRM mail to work.

An assistant that reads the Outlook inbox pushes each message to the site. Send `Authorization: Bearer <CRM_API_TOKEN>`.

`POST /api/leads/inbound-email`

```json
{
  "external_id": "<message-id>",
  "from_email": "customer@example.ca",
  "from_name": "A Customer",
  "subject": "Shed move",
  "body_text": "Can you move a shed on Thursday?",
  "received_at": "2026-11-17T15:00:00.000Z",
  "internet_message_id": "<abc@mail.example>"
}
```

`external_id` is required and is stored once. `from_email` is required. The rest can be empty. `internet_message_id` is the RFC message id used so a later reply sets `In-Reply-To` and `References`.

Response:

```json
{ "lead_id": "L-261117-AB12", "created": false, "duplicate": false, "auto_replied": false }
```

- Same `external_id` again: `duplicate: true`, and nothing else is added.
- `from_email` matches a lead: the message is appended to that lead and `lastContactAt` is updated. `created` is false.
- No match: a new lead with source `email`. `created` is true. Auto-reply stays off on a new lead.
- If that lead’s AI auto-reply is on, the guarded auto-reply runs and the answer is sent with the same From, Reply-To, and BCC. `auto_replied` is true only when a message was actually sent.

`GET /api/leads/known-emails` returns `{ "emails": ["a@example.ca"] }` so the job can ignore mail from people who are not leads. Same bearer token.

`POST /api/leads` is unchanged.

Microsoft Graph remains in the code only when `MS_CLIENT_ID` is set. Personal Outlook.com accounts can no longer create an app registration without an Azure directory, so do not set it.

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

## 4. Folders and replies

The list has four folders:

- **New** — not opened yet
- **Opened** — you opened the quote and have not sent an email or a text yet
- **Replied** — at least one email or text went out (including an AI reply)
- **Closed** — the customer is not interested, or the lead is Lost. Booked jobs stay out of Closed

A clear “no thanks”, “went with someone else”, or “please stop” on an inbound email or text is classified by OpenAI. The lead is closed only when the model returns `not_interested` with confidence at least 0.8. The customer message is treated as untrusted and the model may return only JSON. If OpenAI is unset or fails, the lead is left as it is, and no automatic reply is sent for a message that just closed the lead. A later message that clearly wants the haul reopens it into Opened. The phone gets `Closed: Jane D. - too expensive` or `Reopened: Jane D.`

`POST /api/leads/<id>/close` with `{ "reason": "Not interested" }` and `POST /api/leads/<id>/reopen` use the same bearer token. On a lead, **Move to Closed** is at the top. It opens a sheet with optional reasons (Not interested, Went with someone else, Too expensive, Duplicate/spam, Other) and **Confirm**. In the list, swipe a row left or tap **⋯** and choose **Close**. **Undo** stays on screen for 5 seconds and puts the lead back. A closed lead shows **Closed by AI: reason** or **Closed: reason**, with **Reopen** in place of Move to Closed. Closing records `closedBy` as `owner`.

Opening a lead records that visit. Sending moves it to Replied. The status list (New, Contacted, Quoted, Booked, Lost) is unchanged.

On a lead, choose **Email** or **Text**, then **Draft with AI** or **Send**. A channel is greyed out when the lead has no address or no phone. AI auto-reply, status, and the note box are under **More**.

## Receiving replies on reply.jfhauling.ca

Leave the MX records on `jfhauling.ca` alone. Namecheap email forwarding for the root domain stays as it is. Receiving uses the subdomain `reply.jfhauling.ca` only. Until `CRM_REPLY_TO_INBOUND` is set, customer mail still uses Reply-To `jfhauling@outlook.com` and nothing else changes.

1. In Resend, open **Domains** and add `reply.jfhauling.ca`. Add the verification records Resend shows (DKIM, and SPF if you leave sending on). You can turn **Enable Sending** off if this subdomain only receives.
2. On that domain’s page, turn on **Receiving**. Resend shows the MX record to add. Copy that value. It is account-specific. The dashboard may show `receive.forge.rmta.net`, a regional host such as `receive-euw1.forge.rmta.net`, or `inbound-smtp.<region>.amazonaws.com`. Use the value on your domain page, not a guess.
3. In Namecheap, open **Domain List → jfhauling.ca → Advanced DNS → Add New Record**:
   - Type: **MX Record**
   - Host: `reply`
   - Value: the host Resend shows
   - Priority: the priority Resend shows (usually 10)
   Do not edit the MX records whose host is `@`.
4. Back in Resend, click **I've added the record** and wait until receiving shows verified.
5. Open **Webhooks → Add Webhook**. Endpoint: `https://jfhauling.ca/api/resend/inbound`. Event: `email.received`. Copy the signing secret.
6. Set these on the host (not in git):
   - `RESEND_INBOUND_WEBHOOK_SECRET` = the `whsec_...` signing secret
   - `CRM_REPLY_TO_INBOUND` = `quotes@reply.jfhauling.ca`
   `RESEND_API_KEY` must already be set. The webhook does not use `CRM_API_TOKEN`. A missing or wrong secret is rejected.

After `CRM_REPLY_TO_INBOUND` is set, each customer email uses both Reply-To addresses: `JF Hauling <quotes+<lead id>@reply.jfhauling.ca>` and `jfhauling@outlook.com`. A reply to the plus address is filed on that lead immediately. A reply that only reaches Outlook is still picked up by the Outlook check. The same internet message id is stored once, so the webhook and a later Outlook sync do not file it twice. The same not-interested check and guarded auto-reply run as for `POST /api/leads/inbound-email`.

## 5. Leads waiting for a reply

`GET /api/leads/needs-reply` uses the same bearer token. A lead is waiting when the latest customer event (the quote or lead being created, or a later inbound email or text) has no outbound email or text after it.

- `?minutes=30` (the default) returns those that have been waiting at least that many minutes.
- `?since=2026-11-17T12:00:00.000Z` returns every lead still waiting whose wait started at or after that time. `minutes` is ignored when `since` is set.
- Booked and Lost leads are left out.

```json
{
  "now": "2026-11-17T22:00:00.000Z",
  "leads": [{
    "id": "L-261117-AB12",
    "name": "Jane Tester",
    "phone": "519-555-0100",
    "email": "jane@example.ca",
    "source": "website",
    "folder": "opened",
    "waitingSince": "2026-11-17T20:00:00.000Z",
    "waitingMinutes": 120,
    "lastInboundChannel": "quote",
    "lastInboundPreview": "Tailgate needed",
    "crmUrl": "https://jfhauling.ca/crm/lead/L-261117-AB12"
  }]
}
```

`lastInboundChannel` is `quote`, `lead`, `email`, or `sms`.

`POST /api/notify` with `{ "title": "Still waiting", "body": "3 quotes need a reply", "leadId": "L-261117-AB12" }` pushes that text to every phone that enabled notifications. `leadId` is optional. Same bearer token.

## 6. Notifications on the phone

The server creates VAPID keys on the data disk the first time it starts if `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are not set. You do not have to generate them. Optional env vars: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (default `mailto:jfhauling@outlook.com`). The private key is never written to the logs.

iPhone (iOS 16.4 or newer):

1. Open `https://jfhauling.ca/crm` in Safari and sign in.
2. Share → **Add to Home Screen**.
3. Open **JF Leads** from the home-screen icon (not from the Safari tab).
4. Tap **Enable notifications** and allow them.
5. **Send test notification** in Settings checks that this phone received it.

The home-screen icon shows a number for leads that need attention: unopened New leads, plus any lead whose latest customer message has no reply after it. Booked, Lost, and Closed leads are not counted. The number updates when you open the CRM and when a notification arrives. On iPhone this badge only works in the installed home-screen app (iOS 16.4 or newer) after notifications are allowed. If the phone does not support the badge, nothing else changes.

Android: open the CRM, Add to Home Screen or just use Chrome, then tap **Enable notifications**. Chrome can show the same icon badge.

A new website quote, a new email lead, a new text lead, and a later email or text from a customer each send a short notification, for example `New quote: Jane D. - 20 ft container, Listowel to Barrie`. A lead typed in by hand does not.

## 7. What the customer sees on a reply

Customer mail is always From `JF Hauling <quotes@jfhauling.ca>` and Reply-To `jfhauling@outlook.com`. A BCC copy goes to `jfhauling@outlook.com` unless `CRM_EMAIL_BCC` says otherwise. Any From, Reply-To, or BCC that contains `grokbot` or `friesenj195` is refused. Those strings are not in this project. If a customer ever saw `friesenj195-9bzrhn@mail.grokbot.com`, it was coming from a Render env var, not from the site code. Check these values in the Dashboard (do not paste them into chat): `MAIL_FROM`, `SMTP_FROM`, `SMTP_USER`, `EMAIL`, `CRM_EMAIL_BCC`, and `NOTIFY_TO`. `NOTIFY_TO` only receives dispatch alerts. `MAIL_FROM` was the From address on quote alerts and, before this change, the address inside CRM From.

## 8. Inbox job

The website does not read the Outlook mailbox. An external job that can read that inbox posts each message to `POST /api/leads/inbound-email` with `CRM_API_TOKEN`. `GET /api/leads/known-emails` lists the addresses already on leads. `POST /api/leads` still creates a lead by hand from another system.
