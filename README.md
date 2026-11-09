# JF Hauling — Website + AI Dispatcher Quote Assistant

A complete website for **JF Hauling** (Listowel, Ontario) — container moves and general freight hauled with 3500 dually (dual rear wheel) pickup trucks pulling gooseneck trailers — with a built-in online quote assistant ("AI dispatcher").

- **Pages:** Home, Services, About, Service Area, Contact, Get a Quote (plus a private Admin page).
- **Quote assistant:** a chat that asks the customer for everything a dispatcher needs, checks the load against your limits (**40 ft / 20,000 lbs**), works out the driving distance, and shows a **ballpark estimate** that is always labelled "pending dispatcher confirmation". It appears as a floating "Get a Quote" button on every page and full-size on the Quote page.
- **Requests are saved** on the server (in `DATA_DIR`) and listed on a password-protected **Admin page** (`/admin`), with a CSV download. New quotes and contact messages email dispatch when Resend or SMTP is configured.
- **No AI subscription needed.** The assistant works as a guided step-by-step chat out of the box. If you add an AI key later, it also understands free-form messages ("I need a 40 ft can moved from Listowel to Guelph next Tuesday, about 15,000 lbs"). Your limits and validation are always enforced by the server either way.

---

## 1. Run it on your computer

You need **Node.js 18 or newer** (free from <https://nodejs.org>).

```bash
cd trucking-site
npm install
npm start
```

Open <http://localhost:3000>. Admin page: <http://localhost:3000/admin> (any username; password = `ADMIN_PASSWORD`, default `change-me`).

To test the whole quote flow automatically while the site is running: `npm test`
(set `ADMIN_PASSWORD` the same as the running server, e.g. `ADMIN_PASSWORD=change-me npm test`).

---

## 2. Things you need to set (all in ONE place)

Everything lives in **`config.js`**. You can also set the same values as environment variables (copy `.env.example` to `.env`) — handy on a hosting service.

### Business details (`config.js` → `business`)
| Setting | Current value | Notes |
|---|---|---|
| `name` / `BUSINESS_NAME` | `JF Hauling` | |
| `phone` / `PHONE` | `226-545-1745` | Shown everywhere |
| `phoneHref` / `PHONE_HREF` | `+12265451745` | Tap-to-call links |
| `email` / `EMAIL` | `jfhauling@outlook.com` | **Temporary** — change the `OWNER_EMAIL` line at the top of `config.js` (also used for quote alerts) |
| `addressLine` / `ADDRESS_LINE` | `[Street Address]` | Placeholder; hidden on the site until you fill it in |
| `hours` / `HOURS` | `[Business Hours…]` | Placeholder; hidden on the site until you fill it in |
| `fullyInsured` / `FULLY_INSURED` | `true` | Shows "Fully insured" in the hero, top bar, Why section, About page, footer, meta description and quote assistant greeting; `false` hides it everywhere |

### ⚠ Pricing — the numbers are EXAMPLES (`config.js` → `pricing`)
These are made-up sample rates so the estimator works. **Replace them with your real rates**, then set `isExample: false` (this removes the "SAMPLE RATES" tag customers see and the warning on the admin page).

| Setting | Example value | What it does |
|---|---|---|
| `baseFee` | $150 | Flat fee on every job |
| `perKmLoaded` | $2.75/km | Per km from pickup to delivery for containers and general freight |
| `shedPerKmByWidth` | 8 ft $3.00 · 10 ft $3.50 · 12 ft $5.00 · 14 ft $8.00 | Shed per-km rate by width. Replaces `perKmLoaded` for sheds. No weight charge. Shown as `Distance: X km × $5.00/km (12 ft wide shed)` |
| `perKmDeadhead` | $1.25/km | Per km driving from Listowel to the pickup (0 = don't charge) |
| `deadheadFreeKm` | 50 km | First km from Listowel to pickup that are free |
| `minimumCharge` | $350 | Lowest price for any job |
| `containerSurcharge` | 20 ft: $75 · 40 ft: $125 · general: $0 | Added by freight type |
| `heavyWeightThresholdLbs` / `heavyWeightPer1000Lbs` | over 10,000 lbs: $15 per extra 1,000 lbs | Weight surcharge |
| `specialSurcharges` | hazmat $150, tailgate $75, liftgate $75, residential $50 | Added when the customer's notes mention these words |
| `fuelSurchargePercent` | 0 % | Optional fuel surcharge |
| `rangePercent` | ±15 % | Estimate is shown as a range (e.g. $530–$710) |
| `taxNote` | "plus applicable HST" | Shown beside every estimate |

**How an estimate is worked out:** base fee + (km × per-km rate) + travel to pickup beyond the free km + container surcharge + heavy-weight charge + special-handling add-ons (+ fuel %), never below the minimum, then shown as a ± range. Sheds use `shedPerKmByWidth` instead of `perKmLoaded` and do not get a weight charge. Customers can open "How we got this" to see the breakdown.

### Limits (`config.js` → `limits`)
`maxLengthFt: 40`, `maxWeightLbs: 20000`. Anything over is politely refused online, the customer is offered your phone number, and they can still send it in as a **"needs review"** request (no price shown).

### Server and options (environment variables)
| Variable | Default | |
|---|---|---|
| `PORT` | 3000 | |
| `ADMIN_PASSWORD` | `change-me` | **Change before going live** |
| `OPENAI_API_KEY` | (blank) | Optional — turns on AI understanding |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible service works (e.g. OpenRouter, Groq, Together, a local Ollama at `http://localhost:11434/v1`) |
| `OPENAI_MODEL` | `gpt-4o-mini` | |
| `RESEND_API_KEY` | (blank) | Preferred dispatch alerts. When set, every new quote and contact message is sent through the Resend HTTPS API |
| `MAIL_FROM` | `JF Hauling Website <quotes@jfhauling.ca>` | From address for Resend. Also used for SMTP when set. The domain must be verified in Resend |
| `NOTIFY_TO` | owner address in `config.js` | Who receives the alerts. Reply-To is the customer's email |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` | (blank) | Fallback only, used when `RESEND_API_KEY` is blank and `SMTP_HOST` is set. `SMTP_PORT` defaults to 587 |
| `ROUTING_ENABLED` | `true` | `false` = always ask the customer for approximate km |
| `DATA_DIR` | `./data` | Where `quotes.json` and `messages.json` are saved. The directory is created if it is missing |

Startup logs `[mailer] mode=resend`, `mode=smtp`, or `mode=off`. Each send logs `[mailer] sent ref=...` or `[mailer] failed ref=...` with the quote or message reference only.

**Resend:** create an API key, verify `jfhauling.ca` (so `quotes@jfhauling.ca` can send), then set `RESEND_API_KEY`. Leave `NOTIFY_TO` blank to use the owner address at the top of `config.js`.

**SMTP fallback:** set `SMTP_HOST` only when `RESEND_API_KEY` is blank. For Outlook, `SMTP_HOST=smtp-mail.outlook.com`, `SMTP_PORT=587`, `SMTP_USER` is the mailbox, and `SMTP_PASS` is an app password. `SMTP_FROM` is optional.

---

## 3. How the distance is estimated

The assistant uses free OpenStreetMap services: **Nominatim** to find the addresses and the **OSRM** demo server for driving distance (also the drive from Listowel to the pickup). These are community services with fair-use limits (about 1 lookup per second — the app respects that and caches results). If a lookup fails or an address can't be found, the assistant simply asks the customer for the approximate km. Customers can also tap "Distance looks wrong" to type their own. For heavier traffic you can point `NOMINATIM_URL` / `OSRM_URL` at a paid or self-hosted service.

---

## 4. Where requests go

- Quote requests: `DATA_DIR/quotes.json` · Contact messages: `DATA_DIR/messages.json` (plain files — no database to manage; back up that folder). The default folder is `data/` in the project. On Render it is `/var/data`.
- **Admin page** `/admin`: list, search, filter by status (new / needs review / contacted / quoted / booked / closed), click a row to see every detail including the full chat, and **Download CSV** for Excel.

---

## 5. Putting it online (plain-language options)

Whichever you choose, set at least `ADMIN_PASSWORD` (and your real rates) and make sure the `data` folder is kept between restarts.

**Render:** `render.yaml` describes the web service on the Starter plan, a 1 GB persistent disk mounted at `/var/data`, and `DATA_DIR=/var/data`. Quotes and contact messages written there survive deploys and restarts. A disk turns off zero-downtime deploys, so each deploy is briefly unavailable. Set `RESEND_API_KEY` in the Dashboard (a blueprint sync does not fill a new secret on a service that already exists) and verify the sending domain in Resend. Download the admin CSV before the first disk deploy if any quotes are still only on the current instance — attaching the disk does not copy the old ephemeral files. Then add your domain under *Settings → Custom Domains*.

**Railway:** *New Project → Deploy from GitHub repo*. Railway detects Node and runs `npm start`. Add variables under *Variables*, and add a *Volume* mounted at `/data` with `DATA_DIR=/data`.

**Your own VPS (DigitalOcean, Linode, etc., ~$5–6/month):**
```bash
# on an Ubuntu server
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
# copy the project up (scp/git), then:
cd trucking-site && npm install --omit=dev
cp .env.example .env && nano .env        # set ADMIN_PASSWORD etc.
sudo npm i -g pm2 && NODE_ENV=production pm2 start server/server.js --name jf-hauling && pm2 save && pm2 startup
```
Put **Caddy** in front for free automatic HTTPS: `/etc/caddy/Caddyfile` → `yourdomain.ca { reverse_proxy localhost:3000 }`.

Always use HTTPS in production (Render/Railway do this for you) — the admin password is sent with each admin page request.

---

## 6. Project layout

```
config.js              ← ALL business details, limits, example rates, options
.env.example           ← same settings as environment variables
server/server.js       ← web server, page templating, API, admin
server/dispatcher.js   ← the quote conversation (guided + AI), limit checks
server/validators.js   ← parsing of names, phones, ft/m, lbs/kg/tonnes, dates
server/pricing.js      ← ballpark estimate from the pricing table
server/routing.js      ← OpenStreetMap distance lookup with fallback
server/llm.js          ← optional OpenAI-compatible AI layer
server/mailer.js       ← Resend or SMTP dispatch alerts
server/admin.html      ← admin page
public/                ← pages, styles, images, chat widget (public/js/chat.js)
tests/e2e.js           ← automated end-to-end quote tests (npm test)
tests/mail.js          ← mocked alert and storage tests (npm run test:mail)
tests/screenshots.py   ← Playwright screenshots
screenshots/           ← screenshots of the site
```

Page text lives in `public/*.html`; `{{NAME}}`, `{{PHONE}}` etc. are filled in automatically from `config.js`.

## 7. Good to know
- Estimates are only as good as the rates you enter; every estimate tells the customer it's a ballpark pending dispatcher confirmation.
- For containers, the assistant asks for **total weight including the container** and checks that against 20,000 lbs. If your 20,000 lbs limit means cargo only (not counting the container), change the wording in `server/dispatcher.js` (the `weightLbs` question) and on the Services page.
- No testimonials, fleet sizes or certifications are on the site; add real ones to the HTML pages if you'd like.

## Branding

- Logo files live in `public/img/brand/` (transparent PNG, header/footer sizes, favicons, `og-image.png` for social sharing). The original artwork is kept in `/workspace/brand/`.
- Colours are set at the top of `public/css/style.css`: `--charcoal` (#2A2D32) and `--accent` safety yellow (#F6B913). Buttons on yellow use dark text for contrast.
- Set `SITE_URL` in `.env` (e.g. `https://www.yourdomain.ca`) so link previews on social media can find the share image.
