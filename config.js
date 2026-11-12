/**
 * ============================================================
 *  CENTRAL SITE CONFIGURATION — edit this one file.
 * ============================================================
 *  Anything shown in [Square Brackets] is a PLACEHOLDER that
 *  the owner must replace before going live. Every page, the
 *  quote assistant, emails and the admin page read from here.
 *
 *  Values can also be overridden with environment variables
 *  (see .env.example) so you can change them on a host without
 *  touching code.
 * ============================================================
 */
require('dotenv').config({ quiet: true });

const OWNER_EMAIL = 'jfhauling@outlook.com'; // ← temporary contact + notification address; change here

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);

module.exports = {
  // ---------------------------------------------------------
  // 1. BUSINESS DETAILS  (PLACEHOLDERS — replace these)
  // ---------------------------------------------------------
  business: {
    name: env('BUSINESS_NAME', 'JF Hauling'),
    phone: env('PHONE', '226-545-1745'),
    phoneHref: env('PHONE_HREF', '+12265451745'), // used for tap-to-call links
    email: env('EMAIL', OWNER_EMAIL),
    addressLine: env('ADDRESS_LINE', '[Street Address]'),
    city: 'Listowel',
    province: 'Ontario',
    country: 'Canada',
    hours: env('HOURS', '[Business Hours, e.g. Mon–Fri 7:00–17:00]'),
    sinceYear: 2018, // year the business started (shown as "Since 2018")
    // Trust claim shown in the hero, top bar, "Why" section, About page, footer,
    // meta description and quote assistant greeting. Set to false to hide it everywhere.
    fullyInsured: env('FULLY_INSURED', 'true') === 'true',
    serviceArea: 'all of Ontario',
    // Base location used to estimate the drive to the pickup (deadhead).
    baseLat: 43.7351,
    baseLon: -80.9530,
  },

  // ---------------------------------------------------------
  // 2. EQUIPMENT LIMITS  (from the owner — the assistant enforces these)
  // ---------------------------------------------------------
  limits: {
    maxLengthFt: 40,        // longest load we can haul
    maxWeightLbs: 20000,    // maximum payload
  },

  // ---------------------------------------------------------
  // 3. PRICING TABLE — ⚠ EXAMPLE RATES ONLY ⚠
  //    These numbers are made-up placeholders so the estimator
  //    works out of the box. The owner MUST set real rates
  //    before launch. All amounts in Canadian dollars (CAD).
  // ---------------------------------------------------------
  pricing: {
    isExample: true,             // set to false once you have entered your real rates
    currency: 'CAD',
    baseFee: 150,                // EXAMPLE flat fee per job
    perKmLoaded: 2.75,           // EXAMPLE rate per km, pickup → delivery (containers and general freight)
    // Sheds replace perKmLoaded with a rate for the selected width. No weight charge.
    shedPerKmByWidth: { 8: 3.0, 10: 3.5, 12: 5, 14: 8 },
    perKmDeadhead: 1.25,         // EXAMPLE rate per km, Listowel base → pickup (set 0 to ignore)
    deadheadFreeKm: 50,          // first N km from base to pickup are not charged
    minimumCharge: 350,          // EXAMPLE minimum job price
    containerSurcharge: {        // EXAMPLE surcharge by freight type
      container20: 75,
      container40: 125,
      general: 0,
    },
    heavyWeightThresholdLbs: 10000, // over this weight…
    heavyWeightPer1000Lbs: 15,      // …EXAMPLE charge per extra 1,000 lbs
    specialSurcharges: {           // EXAMPLE add-ons triggered by keywords in the notes
      hazmat: 150,
      tailgate: 75,
      liftgate: 75,
      appointment: 0,
      residential: 50,
    },
    fuelSurchargePercent: 0,     // EXAMPLE fuel surcharge % applied to subtotal (0 = off)
    rangePercent: 15,            // estimate shown as a range ± this %
    taxNote: 'plus applicable HST',
  },

  // ---------------------------------------------------------
  // 4. DISTANCE ESTIMATION (free OpenStreetMap services)
  // ---------------------------------------------------------
  routing: {
    enabled: env('ROUTING_ENABLED', 'true') === 'true',
    nominatimUrl: env('NOMINATIM_URL', 'https://nominatim.openstreetmap.org'),
    osrmUrl: env('OSRM_URL', 'https://router.project-osrm.org'),
    // Nominatim's usage policy requires an identifying User-Agent / contact.
    userAgent: env('GEOCODER_USER_AGENT', `JFHaulingQuoteAssistant/1.0 (contact: ${OWNER_EMAIL})`),
    countryCodes: env('GEOCODER_COUNTRIES', 'ca,us'),
    timeoutMs: 8000,
  },

  // ---------------------------------------------------------
  // 5. OPTIONAL INTEGRATIONS (all off unless env vars are set)
  // ---------------------------------------------------------
  server: {
    port: num('PORT', 3000),
    siteUrl: env('SITE_URL', ''), // e.g. 'https://www.jfhauling.ca' — used for social-share image links
    adminPassword: env('ADMIN_PASSWORD', 'change-me'),
    dataDir: env('DATA_DIR', require('path').join(__dirname, 'data')),
  },
  llm: {
    apiKey: env('OPENAI_API_KEY', ''),
    baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    model: env('OPENAI_MODEL', 'gpt-4o-mini'),
  },
  // Dispatch alerts. Resend is used when RESEND_API_KEY is set; otherwise SMTP is
  // used when SMTP_HOST is set. MAIL_FROM blank means Resend uses the default
  // below, and SMTP keeps SMTP_FROM or SMTP_USER.
  mail: {
    notifyTo: env('NOTIFY_TO', OWNER_EMAIL),
    from: env('MAIL_FROM', ''),
    defaultFrom: 'JF Hauling Website <quotes@jfhauling.ca>',
  },
  resend: {
    apiKey: env('RESEND_API_KEY', ''),
  },
  smtp: {
    host: env('SMTP_HOST', ''),
    port: num('SMTP_PORT', 587),
    secure: env('SMTP_SECURE', 'false') === 'true',
    user: env('SMTP_USER', ''),
    pass: env('SMTP_PASS', ''),
    from: env('SMTP_FROM', ''),
  },

  // ---------------------------------------------------------
  // 6. GOOGLE REVIEWS
  //    Live reviews load from the Places API (New) when
  //    GOOGLE_PLACES_API_KEY is set on the server. The key
  //    does not belong in this file. See the README.
  // ---------------------------------------------------------
  google: {
    placeId: env('GOOGLE_PLACE_ID', 'ChIJcfVgYgpvKYgR-J2PWA1BUD4'), // 3117 Arthur St S, Fordwich, ON
    reviewUrl: env('GOOGLE_REVIEW_URL', 'https://g.page/r/CepCdhSKdQuJEAE/review'),
    mapsUrl: env('GOOGLE_MAPS_URL', 'https://www.google.com/maps/place/?q=place_id:ChIJcfVgYgpvKYgR-J2PWA1BUD4'),
    apiKey: env('GOOGLE_PLACES_API_KEY', ''),
    language: env('GOOGLE_REVIEWS_LANGUAGE', 'en'),
    // In-memory only, capped at 12 hours. Google's terms don't allow saving review text.
    cacheMs: (function () {
      const hours = num('GOOGLE_REVIEWS_CACHE_HOURS', 6);
      const n = Number.isFinite(hours) ? hours : 6;
      return Math.min(12, Math.max(1, n)) * 60 * 60 * 1000;
    })(),
  },

  // Used only when the API key is missing, or Google can't be reached and
  // nothing is cached yet. Leave this empty when there is nothing to show.
  // One object per review. Do not put made-up reviews here.
  // { author: '[Customer name]', rating: 5, text: '[What they wrote]', relativeDate: '[e.g. March 2026]' }
  manualReviews: [],
};
