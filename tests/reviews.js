// Reviews page behaviour. No Google key and no running server required.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const reviews = require('../server/reviews');

let pass = 0;
let fail = 0;
const ok = (cond, message) => {
  if (cond) { pass++; console.log('  ✔', message); }
  else { fail++; console.log('  ✘', message); }
};
const forbidden = /be the first|first review|one of our first/i;
const shell = '<h1>Reviews</h1>{{REVIEWS_LEAD}}<main>{{REVIEWS_MAIN}}</main>{{REVIEWS_TEASER}}';
const google = {
  apiKey: '',
  placeId: 'ChIJcfVgYgpvKYgR-J2PWA1BUD4',
  reviewUrl: 'https://g.page/r/CepCdhSKdQuJEAE/review',
  mapsUrl: 'https://www.google.com/maps/place/?q=place_id:ChIJcfVgYgpvKYgR-J2PWA1BUD4',
  language: 'en',
  cacheMs: 60 * 60 * 1000,
};
const KEY = 'places-key-do-not-leak';

function render(data, opts) {
  return reviews.apply(shell, data, Object.assign({ google, business: { name: 'JF Hauling' } }, opts));
}

function placesBody(extra) {
  return Object.assign({
    rating: 4.2,
    userRatingCount: 2594,
    googleMapsUri: 'https://maps.google.com/?cid=1',
    googleMapsLinks: { reviewsUri: 'https://maps.google.com/reviews-list' },
    reviews: [
      {
        rating: 5,
        relativePublishTimeDescription: 'a month ago',
        publishTime: '2026-10-02T15:01:23Z',
        text: { text: 'Careful with the container.', languageCode: 'en' },
        originalText: { text: 'Careful with the container.', languageCode: 'en' },
        authorAttribution: {
          displayName: 'Alex Rivera',
          uri: 'https://www.google.com/maps/contrib/1',
          photoUri: 'https://lh3.googleusercontent.com/a/sample=s64',
        },
        googleMapsUri: 'https://www.google.com/maps/reviews/one',
        flagContentUri: 'https://www.google.com/maps/flag/one',
      },
      {
        rating: 4,
        relativePublishTimeDescription: '2 months ago',
        text: { text: 'Translated line.', languageCode: 'en' },
        originalText: { text: 'Ligne originale.', languageCode: 'fr' },
        authorAttribution: { displayName: 'Marie L.' },
      },
    ],
  }, extra);
}

(async () => {
  reviews.resetForTests();
  if (!process.env.GOOGLE_PLACE_ID) ok(config.google.placeId === 'ChIJcfVgYgpvKYgR-J2PWA1BUD4', 'place ID defaults to the Fordwich listing');
  if (!process.env.GOOGLE_REVIEW_URL) ok(config.google.reviewUrl === google.reviewUrl, 'review link defaults to the g.page URL');
  ok(Array.isArray(config.manualReviews) && config.manualReviews.length === 0, 'shipped manual review list is empty');
  ok(config.google.cacheMs >= 3600000 && config.google.cacheMs <= 12 * 3600000, 'memory cache is between 1 and 12 hours');

  const page = fs.readFileSync(path.join(__dirname, '../public/reviews.html'), 'utf8');
  ok(page.includes('<h1>Reviews</h1>') && page.includes('{{REVIEWS_MAIN}}'), 'reviews template has the heading and the content slot');
  ok(!forbidden.test(page) && !forbidden.test(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8')), 'page templates have no first-review copy');

  const empty = await reviews.load({ google, manualReviews: [] });
  const emptyHtml = render(empty);
  ok(empty.source === 'empty', 'no key and no manual reviews is an empty result');
  ok(emptyHtml.includes('>Leave us a Google review<') && emptyHtml.includes('href="' + google.reviewUrl + '"'), 'empty page has the review button');
  ok(emptyHtml.includes('>See all reviews on Google<') && emptyHtml.includes(google.mapsUrl), 'empty page has the see-all link');
  ok(emptyHtml.includes('data-reviews-source="empty"'), 'empty page is marked empty');
  ok(!emptyHtml.includes('{{') && !emptyHtml.includes('reviews-teaser') && !emptyHtml.includes('<h2'), 'empty result has no teaser, extra heading, or leftover tokens');
  ok(!forbidden.test(emptyHtml) && !/GMP-attribution/.test(emptyHtml), 'empty page has no first-review copy and no Google Maps credit');
  ok(!emptyHtml.includes(KEY), 'empty page does not contain an API key');

  const manual = await reviews.load({
    google,
    manualReviews: [
      { author: '<script>alert(1)</script>', rating: 5, text: 'Quotes "and" & ampersands.', relativeDate: 'March 2026', authorUrl: 'javascript:alert(1)' },
      { author: 'Skipped', rating: 5 },
      { author: 'Pat Example', rating: 4, text: 'On time.', relativeDate: 'last week', googleMapsUri: 'https://example.com/pat-review' },
    ],
  });
  const manualHtml = render(manual);
  ok(manual.source === 'manual' && manual.reviewCount === 2 && manual.rating === 4.5, 'invalid manual rows are dropped and the average is calculated');
  ok(manualHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !manualHtml.includes('<script>'), 'manual names are escaped');
  ok(!/href="javascript:/.test(manualHtml), 'javascript links are dropped');
  ok(manualHtml.includes('Pat Example') && manualHtml.includes('March 2026') && manualHtml.includes('https://example.com/pat-review'), 'manual review shows the name, date, and review link');
  ok(manualHtml.includes('2 reviews') && !/Google reviews/.test(manualHtml) && !/GMP-attribution/.test(manualHtml), 'hand-entered reviews are not credited as live Google Maps content');
  ok(manualHtml.includes('reviews-teaser') && manualHtml.includes('What customers say'), 'home teaser is shown for hand-entered reviews');
  ok(!forbidden.test(manualHtml), 'manual page has no first-review copy');

  let calls = 0;
  let lastUrl = '';
  let lastInit = null;
  const fetchImpl = async (url, init) => {
    calls++;
    lastUrl = String(url);
    lastInit = init;
    return { ok: true, status: 200, json: async () => placesBody() };
  };
  const liveGoogle = Object.assign({}, google, { apiKey: KEY, cacheMs: 5000 });
  const live = await reviews.load({ google: liveGoogle, manualReviews: [{ author: 'Should Not Show', rating: 5, text: 'Hidden because Google answered.', relativeDate: 'today' }], fetchImpl, now: 1000 });
  const liveHtml = render(live);
  ok(calls === 1 && lastInit.headers['X-Goog-Api-Key'] === KEY && lastInit.headers['X-Goog-FieldMask'] === 'id,displayName,rating,userRatingCount,reviews,googleMapsUri,googleMapsLinks', 'Places request sends the key as a header and asks only for review fields');
  ok(lastUrl.startsWith('https://places.googleapis.com/v1/places/' + encodeURIComponent(google.placeId)) && lastUrl.includes('languageCode=en') && !lastUrl.includes(KEY), 'Places request uses the place ID and does not put the key in the URL');
  ok(live.source === 'google' && live.rating === 4.2 && live.reviewCount === 2594 && live.reviews.length === 2, 'uses the Google rating and total count, not just the rows returned');
  ok(!liveHtml.includes('Should Not Show') && !liveHtml.includes(KEY), 'a successful Google response replaces the manual list and hides the key');
  ok(liveHtml.includes('Alex Rivera') && liveHtml.includes('a month ago') && liveHtml.includes('Careful with the container.'), 'review shows the name, relative date, and text');
  ok(liveHtml.includes('https://www.google.com/maps/contrib/1') && liveHtml.includes('https://lh3.googleusercontent.com/a/sample=s64'), 'author name links to the profile and the photo is shown');
  ok(liveHtml.includes('https://www.google.com/maps/reviews/one') && liveHtml.includes('View on Google Maps'), 'each review links to Google Maps');
  ok(liveHtml.includes('https://www.google.com/maps/flag/one') && liveHtml.includes('Report this review'), 'a report link is included when Google sends one');
  ok(liveHtml.includes('2,594 Google reviews') && liveHtml.includes('>4.2<'), 'overall rating and review count are shown');
  ok(liveHtml.includes('translate="no">Google Maps</span>') && liveHtml.includes('class="GMP-attribution"'), 'Google Maps credit uses the required text treatment');
  ok(liveHtml.includes('ordered by relevance') && liveHtml.includes('https://support.google.com/contributionpolicy/answer/7422880'), 'order and review-policy notes are shown');
  ok(liveHtml.includes('Translated by Google.') && liveHtml.includes('Ligne originale.'), 'translated reviews keep the original text');
  ok(liveHtml.includes('https://maps.google.com/reviews-list'), 'see-all link prefers the reviews link from Google');
  ok(liveHtml.includes('What customers say about hauling with JF Hauling.') && liveHtml.includes('reviews-teaser'), 'home teaser and lead are shown when Google has reviews');
  ok(!forbidden.test(liveHtml), 'live page has no first-review copy');
  const indexAlex = liveHtml.indexOf('Alex Rivera');
  const indexMarie = liveHtml.indexOf('Marie L.');
  ok(indexAlex !== -1 && indexAlex < indexMarie, 'reviews stay in the order Google returned');

  await reviews.load({ google: liveGoogle, fetchImpl, now: 2000, manualReviews: [] });
  ok(calls === 1, 'a second visit inside the cache window does not call Google');
  await reviews.load({ google: liveGoogle, fetchImpl, now: 7000, manualReviews: [] });
  ok(calls === 2, 'an expired cache loads from Google again');

  const many = placesBody({
    reviews: ['A', 'B', 'C', 'D', 'E', 'F'].map((name, i) => ({
      rating: i + 1 > 5 ? 5 : i + 1,
      text: { text: 'Row ' + name },
      authorAttribution: { displayName: 'Person ' + name },
    })),
  });
  reviews.resetForTests();
  calls = 0;
  const capped = await reviews.load({
    google: Object.assign({}, liveGoogle, { placeId: 'other-place' }),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => many }),
    now: 1,
    manualReviews: [],
  });
  ok(capped.reviews.length === 5 && capped.reviews[0].author === 'Person A' && capped.reviews[4].author === 'Person E', 'only the five reviews Google allows are kept, in order');

  reviews.resetForTests();
  let down = false;
  const flaky = async () => {
    if (down) throw new Error('network down');
    return { ok: true, status: 200, json: async () => placesBody() };
  };
  const cachedGoogle = Object.assign({}, liveGoogle, { placeId: 'stale-place', cacheMs: 1000 });
  await reviews.load({ google: cachedGoogle, fetchImpl: flaky, now: 1000, manualReviews: [] });
  down = true;
  const stale = await reviews.load({ google: cachedGoogle, fetchImpl: flaky, now: 5000, manualReviews: [{ author: 'Fallback Person', rating: 5, text: 'Used only with nothing cached.', relativeDate: 'today' }] });
  ok(stale.source === 'google' && stale.reviews[0].author === 'Alex Rivera', 'a failed refresh keeps the last Google result');

  reviews.resetForTests();
  const failed = await reviews.load({
    google: Object.assign({}, liveGoogle, { placeId: 'failed-place' }),
    fetchImpl: async () => { throw new Error('nope'); },
    now: 1,
    manualReviews: [{ author: 'Fallback Person', rating: 5, text: 'Used when Google cannot be reached.', relativeDate: 'today' }],
  });
  ok(failed.source === 'manual' && failed.reviews[0].author === 'Fallback Person', 'a failed lookup with nothing cached uses the manual list');

  reviews.resetForTests();
  const none = await reviews.load({
    google: Object.assign({}, liveGoogle, { placeId: 'empty-place' }),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ reviews: [], userRatingCount: 0 }) }),
    now: 1,
    manualReviews: [{ author: 'Fallback Person', rating: 5, text: 'Should stay hidden when Google reports none.', relativeDate: 'today' }],
  });
  const noneHtml = render(none);
  ok(none.source === 'empty' && noneHtml.includes('data-reviews-source="empty"') && !noneHtml.includes('Fallback Person'), 'a live empty listing stays empty instead of mixing in the manual list');
  ok(!forbidden.test(noneHtml), 'live empty page has no first-review copy');

  reviews.resetForTests();
  const counted = await reviews.load({
    google: Object.assign({}, liveGoogle, { placeId: 'count-only' }),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ rating: 5, userRatingCount: 1, reviews: [] }) }),
    now: 1,
    manualReviews: [],
  });
  const countedHtml = render(counted);
  ok(counted.reviewCount === 1 && countedHtml.includes('1 Google review') && !countedHtml.includes('1 Google reviews'), 'a single Google review is singular');
  ok(countedHtml.includes('reviews-teaser') && !countedHtml.includes('data-reviews-source="empty"'), 'a rating with no review text still counts as reviews');

  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    REVIEWS_FIXTURE_ENABLE: process.env.REVIEWS_FIXTURE_ENABLE,
    REVIEWS_FIXTURE: process.env.REVIEWS_FIXTURE,
  };
  try {
    process.env.NODE_ENV = 'production';
    process.env.REVIEWS_FIXTURE_ENABLE = '1';
    process.env.REVIEWS_FIXTURE = 'tests/fixtures/sample-reviews.json';
    const hidden = await reviews.load({ google, manualReviews: [] });
    ok(hidden.source === 'empty', 'sample fixture is ignored in production');

    process.env.NODE_ENV = 'development';
    process.env.REVIEWS_FIXTURE = '../package.json';
    const escaped = await reviews.load({ google, manualReviews: [] });
    ok(escaped.source === 'empty', 'fixture path outside the project is ignored');

    process.env.REVIEWS_FIXTURE = 'tests/fixtures/sample-reviews.json';
    let fetched = false;
    const sample = await reviews.load({
      google: Object.assign({}, google, { apiKey: KEY }),
      manualReviews: [],
      fetchImpl: async () => { fetched = true; throw new Error('should not fetch'); },
    });
    const sampleHtml = render(sample);
    ok(!fetched && sample.source === 'google' && sample.reviews.length === 3 && /SAMPLE REVIEW — not a real customer/.test(sample.reviews[0].text), 'local fixture supplies clearly fake sample reviews');
    ok(sampleHtml.includes('Sample Customer A') && sampleHtml.includes('style="width:70%"') && sampleHtml.includes('Show original'), 'sample page shows a partial star and the original text');
  } finally {
    if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.NODE_ENV;
    if (saved.REVIEWS_FIXTURE_ENABLE === undefined) delete process.env.REVIEWS_FIXTURE_ENABLE;
    else process.env.REVIEWS_FIXTURE_ENABLE = saved.REVIEWS_FIXTURE_ENABLE;
    if (saved.REVIEWS_FIXTURE === undefined) delete process.env.REVIEWS_FIXTURE;
    else process.env.REVIEWS_FIXTURE = saved.REVIEWS_FIXTURE;
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
