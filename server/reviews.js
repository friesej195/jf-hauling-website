// Google reviews for /reviews and the home-page teaser.
// The Places API key stays on the server. Review text is kept in memory
// for a few hours only — Google's terms do not allow saving it.
const fs = require('fs');
const path = require('path');
const config = require('../config');

const DEFAULT_REVIEW_URL = 'https://g.page/r/CepCdhSKdQuJEAE/review';
const DEFAULT_MAPS_URL = 'https://www.google.com/maps/place/?q=place_id:ChIJcfVgYgpvKYgR-J2PWA1BUD4';
const FIELD_MASK = 'id,displayName,rating,userRatingCount,reviews,googleMapsUri,googleMapsLinks';
const POLICY_URL = 'https://support.google.com/contributionpolicy/answer/7422880';
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2.6l2.55 5.43 5.95.74-4.4 4.1 1.16 5.83L12 16.9l-5.26 2.8 1.16-5.83-4.4-4.1 5.95-.74z"/></svg>';

const memory = new Map();
const inflight = new Map();
let manualShapeWarned = false;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function httpsUrl(value, fallback) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:') return fallback;
    url.username = '';
    url.password = '';
    return url.href;
  } catch (err) {
    return fallback;
  }
}

function clampRating(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  return Math.round(n * 10) / 10;
}

function average(reviews) {
  if (!reviews.length) return null;
  const sum = reviews.reduce((total, review) => total + review.rating, 0);
  return Math.round((sum / reviews.length) * 10) / 10;
}

function validTime(value) {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s) || Number.isNaN(Date.parse(s))) return '';
  return s.slice(0, 40);
}

function formatRating(n) {
  return (Math.round(Number(n) * 10) / 10).toFixed(1);
}

function emptyData() {
  return { source: 'empty', rating: null, reviewCount: 0, reviews: [], reviewsUrl: '', mapsUrl: '' };
}

function hasReviews(data) {
  return data.reviews.length > 0 || data.reviewCount > 0;
}

function normalizeManual(item) {
  if (!item || typeof item !== 'object') return null;
  const author = String(item.author || item.name || '').trim().slice(0, 120);
  const text = String(item.text || item.review || '').trim().slice(0, 8000);
  const rating = clampRating(item.rating);
  if (!author || !text || rating == null) return null;
  return {
    author,
    authorUrl: httpsUrl(item.authorUrl || item.authorUri || '', ''),
    authorPhoto: httpsUrl(item.authorPhoto || item.photo || '', ''),
    rating,
    text,
    originalText: '',
    translated: false,
    relativeDate: String(item.relativeDate || item.date || '').trim().slice(0, 80),
    publishTime: validTime(item.publishTime),
    googleMapsUri: httpsUrl(item.googleMapsUri || '', ''),
    flagUrl: '',
  };
}

function fromManual(list) {
  if (list != null && !Array.isArray(list)) {
    if (!manualShapeWarned) {
      manualShapeWarned = true;
      console.error('[reviews] manualReviews in config.js must be an array');
    }
  }
  const reviews = (Array.isArray(list) ? list : []).map(normalizeManual).filter(Boolean);
  if (!reviews.length) return emptyData();
  return {
    source: 'manual',
    rating: average(reviews),
    reviewCount: reviews.length,
    reviews,
    reviewsUrl: '',
    mapsUrl: '',
  };
}

function normalizeApiReview(review) {
  if (!review || typeof review !== 'object') return null;
  const authorAttr = review.authorAttribution || {};
  const text = review.text && review.text.text ? String(review.text.text).trim() : '';
  const original = review.originalText && review.originalText.text ? String(review.originalText.text).trim() : '';
  const author = String(authorAttr.displayName || '').trim();
  const rating = clampRating(review.rating);
  if (!author && !text && !original && rating == null) return null;
  const translated = Boolean(original && text && original !== text);
  return {
    author: (author || 'Google user').slice(0, 120),
    authorUrl: httpsUrl(authorAttr.uri, ''),
    authorPhoto: httpsUrl(authorAttr.photoUri, ''),
    rating,
    text: (text || original).slice(0, 8000),
    originalText: translated ? original.slice(0, 8000) : '',
    translated,
    relativeDate: String(review.relativePublishTimeDescription || '').trim().slice(0, 80),
    publishTime: validTime(review.publishTime),
    googleMapsUri: httpsUrl(review.googleMapsUri, ''),
    flagUrl: httpsUrl(review.flagContentUri, ''),
  };
}

function fromPlaces(body) {
  const payload = body && typeof body === 'object' ? body : {};
  const reviews = (Array.isArray(payload.reviews) ? payload.reviews : []).slice(0, 5).map(normalizeApiReview).filter(Boolean);
  const reported = Number(payload.userRatingCount);
  const reviewCount = Number.isFinite(reported) && reported > 0 ? reported : reviews.length;
  let rating = Number(payload.rating);
  if (!(rating > 0)) rating = average(reviews.filter((review) => review.rating != null));
  else rating = Math.round(rating * 10) / 10;
  if (!reviews.length && !(reviewCount > 0)) return emptyData();
  const links = payload.googleMapsLinks || {};
  return {
    source: 'google',
    rating: rating > 0 ? rating : null,
    reviewCount,
    reviews,
    reviewsUrl: httpsUrl(links.reviewsUri, ''),
    mapsUrl: httpsUrl(payload.googleMapsUri, ''),
  };
}

function fromFixture(json) {
  const reviews = (Array.isArray(json && json.reviews) ? json.reviews : []).map((item) => {
    const base = normalizeManual(item);
    if (!base) return null;
    const original = String(item.originalText || '').trim();
    const translated = Boolean(item.translated && original && original !== base.text);
    return Object.assign(base, {
      originalText: translated ? original.slice(0, 8000) : '',
      translated,
      googleMapsUri: httpsUrl(item.googleMapsUri, ''),
    });
  }).filter(Boolean);
  const reported = Number(json && json.reviewCount);
  const reviewCount = Number.isFinite(reported) && reported > 0 ? reported : reviews.length;
  let rating = Number(json && json.rating);
  if (!(rating > 0)) rating = average(reviews);
  else rating = Math.round(rating * 10) / 10;
  if (!reviews.length && !(reviewCount > 0)) return emptyData();
  return {
    source: 'google',
    rating: rating > 0 ? rating : null,
    reviewCount,
    reviews,
    reviewsUrl: httpsUrl(json.reviewsUrl, ''),
    mapsUrl: httpsUrl(json.mapsUrl, ''),
  };
}

function readFixture() {
  if (process.env.NODE_ENV === 'production') return null;
  if (process.env.REVIEWS_FIXTURE_ENABLE !== '1') return null;
  const rel = process.env.REVIEWS_FIXTURE;
  if (!rel) return null;
  const root = path.resolve(__dirname, '..');
  const full = path.resolve(root, rel);
  const inside = path.relative(root, full);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  try {
    return fromFixture(JSON.parse(fs.readFileSync(full, 'utf8')));
  } catch (err) {
    console.error('[reviews] Could not read REVIEWS_FIXTURE');
    return null;
  }
}

async function fetchPlaces(google, fetchImpl) {
  const placeId = String(google.placeId || '').trim();
  if (!placeId) throw new Error('Google place ID is missing');
  const url = new URL('https://places.googleapis.com/v1/places/' + encodeURIComponent(placeId));
  if (google.language) url.searchParams.set('languageCode', google.language);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: ctrl.signal,
      headers: {
        'X-Goog-Api-Key': google.apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
        Accept: 'application/json',
        'User-Agent': 'JFHaulingWebsite/1.0',
      },
    });
    if (res.status >= 300 && res.status < 400) throw new Error('Google Places lookup was redirected');
    if (!res.ok) throw new Error('Google Places lookup failed (' + res.status + ')');
    return await res.json();
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('Google Places lookup timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function cacheKey(google) {
  return String(google.placeId || '') + '|' + String(google.language || '');
}

async function load(opts = {}) {
  const fixture = readFixture();
  if (fixture) return fixture;

  const google = opts.google || config.google;
  const manual = opts.manualReviews !== undefined ? opts.manualReviews : config.manualReviews;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const now = opts.now || Date.now();
  const ttl = google.cacheMs || config.google.cacheMs;

  if (!google.apiKey) return fromManual(manual);

  const key = cacheKey(google);
  const hit = memory.get(key);
  if (hit && now - hit.at < ttl) return hit.data;

  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    try {
      const data = fromPlaces(await fetchPlaces(google, fetchImpl));
      memory.set(key, { at: now, data });
      return data;
    } catch (err) {
      console.error('[reviews]', err && err.message ? err.message : 'Google Places lookup failed');
      if (hit) return hit.data;
      return fromManual(manual);
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}

function present(data, google) {
  const reviewUrl = httpsUrl(google.reviewUrl, DEFAULT_REVIEW_URL);
  const seeAllUrl = httpsUrl(data.reviewsUrl, '') || httpsUrl(data.mapsUrl, '') || httpsUrl(google.mapsUrl, DEFAULT_MAPS_URL);
  return Object.assign({}, data, { reviewUrl, seeAllUrl });
}

function stars(rating) {
  const value = Math.max(0, Math.min(5, Number(rating) || 0));
  let html = `<span class="stars" role="img" aria-label="${esc(formatRating(value) + ' out of 5 stars')}">`;
  for (let i = 1; i <= 5; i++) {
    const fill = Math.max(0, Math.min(1, value - (i - 1)));
    const pct = Math.round(fill * 1000) / 10;
    html += `<span class="star" aria-hidden="true"><span class="star-bg">${STAR}</span><span class="star-fg" style="width:${pct}%">${STAR}</span></span>`;
  }
  return html + '</span>';
}

function countLabel(data) {
  const n = data.reviewCount || data.reviews.length;
  const noun = n === 1 ? 'review' : 'reviews';
  const shown = Number(n).toLocaleString('en-CA');
  return data.source === 'google' ? `${shown} Google ${noun}` : `${shown} ${noun}`;
}

function scoreBlock(data) {
  const count = `<div class="reviews-count">${esc(countLabel(data))}</div>`;
  if (!(data.rating > 0)) return `<div class="reviews-score"><div class="reviews-score-meta">${count}</div></div>`;
  return `<div class="reviews-score"><div class="reviews-score-num">${esc(formatRating(data.rating))}</div><div class="reviews-score-meta">${stars(data.rating)}${count}</div></div>`;
}

function external(href, className, label) {
  const cls = className ? ` class="${className}"` : '';
  return `<a${cls} href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}<span class="sr-only"> (opens in a new tab)</span></a>`;
}

function actionLinks(data) {
  return `<div class="reviews-actions">${external(data.reviewUrl, 'btn btn-primary btn-lg', 'Leave us a Google review')}${external(data.seeAllUrl, 'reviews-seeall', 'See all reviews on Google')}</div>`;
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  const letters = (parts[0] ? parts[0][0] : '') + (parts[1] ? parts[1][0] : '');
  return (letters || '?').toUpperCase();
}

function whenLabel(review) {
  if (review.relativeDate) return review.relativeDate;
  if (!review.publishTime) return '';
  const date = new Date(review.publishTime);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'America/Toronto' });
}

function avatar(review) {
  const photo = review.authorPhoto
    ? `<img src="${esc(review.authorPhoto)}" alt="" width="48" height="48" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">`
    : '';
  return `<span class="review-avatar"><span class="review-initials" aria-hidden="true">${esc(initials(review.author))}</span>${photo}</span>`;
}

function who(review) {
  const when = whenLabel(review);
  const time = when
    ? (review.publishTime ? `<time datetime="${esc(review.publishTime)}">${esc(when)}</time>` : esc(when))
    : '';
  const inner = `${avatar(review)}<span class="review-meta"><span class="review-author">${esc(review.author)}</span>${review.rating ? stars(review.rating) : ''}${time ? `<span class="review-when">${time}</span>` : ''}</span>`;
  if (!review.authorUrl) return `<div class="review-who">${inner}</div>`;
  return external(review.authorUrl, 'review-who', inner);
}

function reviewLinks(review) {
  const links = [];
  if (review.googleMapsUri) links.push(external(review.googleMapsUri, '', 'View on Google Maps'));
  if (review.flagUrl) links.push(external(review.flagUrl, 'review-report', 'Report this review'));
  return links.length ? `<div class="review-links">${links.join('')}</div>` : '';
}

function reviewItem(review, index) {
  const text = review.text ? `<p class="review-text">${esc(review.text)}</p>` : '';
  const note = review.translated ? '<p class="review-translated-note">Translated by Google.</p>' : '';
  const original = review.translated && review.originalText
    ? `<details class="review-translated"><summary>Show original</summary><p>${esc(review.originalText)}</p></details>`
    : '';
  return `<li class="review" id="review-${index + 1}">${who(review)}${text}${note}${original}${reviewLinks(review)}</li>`;
}

function attribution() {
  return '<p class="reviews-credit">Reviews from <span class="GMP-attribution" translate="no">Google Maps</span></p>';
}

function renderMain(data) {
  if (!hasReviews(data)) {
    return `<div class="reviews-empty" data-reviews-source="empty">${actionLinks(data)}</div>`;
  }
  const notes = data.source === 'google'
    ? `<div class="reviews-notes"><p>Google returns up to five reviews, ordered by relevance. They are shown here in that order. Google doesn't verify reviews, and it removes content that breaks ${external(POLICY_URL, '', 'its policies')}.</p></div>`
    : '';
  const list = data.reviews.length
    ? `<ol class="reviews-list" aria-label="${data.source === 'google' ? 'Google reviews' : 'Reviews'}">${data.reviews.map(reviewItem).join('')}</ol>`
    : '';
  const credit = data.source === 'google' ? attribution() : '';
  return `<div class="reviews-panel" data-reviews-source="${esc(data.source)}"><div class="reviews-panel-head"><div class="reviews-score-wrap">${scoreBlock(data)}${credit}</div>${actionLinks(data)}</div>${notes}${list}</div>`;
}

function excerpt(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max);
  const cut = slice.lastIndexOf(' ');
  return ((cut > 80 ? slice.slice(0, cut) : slice).trim()) + '…';
}

function renderTeaser(data) {
  if (!hasReviews(data)) return '';
  const quotes = data.reviews.filter((review) => review.text).slice(0, 2).map((review) => {
    const index = data.reviews.indexOf(review) + 1;
    const when = whenLabel(review);
    return `<article class="review-quote"><div class="review-quote-top">${review.rating ? stars(review.rating) : ''}${when ? `<span class="review-when">${esc(when)}</span>` : ''}</div><blockquote>${esc(excerpt(review.text, 220))}</blockquote><footer><span class="review-author">${esc(review.author)}</span> · <a href="/reviews#review-${index}">Read review</a></footer></article>`;
  }).join('');
  const leave = external(data.reviewUrl, 'btn btn-outline', 'Leave us a Google review');
  const credit = data.source === 'google' ? attribution() : '';
  return `<section class="block reviews-teaser" data-reviews-source="${esc(data.source)}" aria-labelledby="reviews-teaser-title"><div class="container"><div class="reviews-teaser-bar"><div><span class="eyebrow">Reviews</span><h2 id="reviews-teaser-title">What customers say</h2></div><div class="reviews-score-wrap">${scoreBlock(data)}${credit}</div></div>${quotes ? `<div class="review-quotes">${quotes}</div>` : ''}<div class="reviews-actions"><a class="btn btn-dark" href="/reviews">Read the reviews</a>${leave}</div></div></section>`;
}

function renderLead(data, business) {
  if (!hasReviews(data)) return '';
  return `<p>What customers say about hauling with ${esc(business.name)}.</p>`;
}

function apply(html, data, opts = {}) {
  const google = opts.google || config.google;
  const business = opts.business || config.business;
  const view = present(data, google);
  return String(html)
    .split('{{REVIEWS_LEAD}}').join(renderLead(view, business))
    .split('{{REVIEWS_MAIN}}').join(renderMain(view))
    .split('{{REVIEWS_TEASER}}').join(renderTeaser(view));
}

function resetForTests() {
  memory.clear();
  inflight.clear();
  manualShapeWarned = false;
}

module.exports = { load, apply, resetForTests, httpsUrl, emptyData, fromManual };
