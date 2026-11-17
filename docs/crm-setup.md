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

## 4. Inbox job

The website does not read the Outlook mailbox. An external job that can read that inbox posts each message to `POST /api/leads/inbound-email` with `CRM_API_TOKEN`. `GET /api/leads/known-emails` lists the addresses already on leads. `POST /api/leads` still creates a lead by hand from another system.
