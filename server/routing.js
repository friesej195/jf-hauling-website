// Distance estimation using free OpenStreetMap services:
//   Nominatim (geocoding) + OSRM public demo server (driving distance).
// Both are rate-limited community services: we throttle to ~1 request/second,
// cache results, and fail gracefully (the assistant then asks for approx km).
const config = require('../config');
const R = config.routing;

const cache = new Map();
let chain = Promise.resolve();
let last = 0;

function throttled(fn) {
  const p = chain.then(async () => {
    const wait = Math.max(0, last + 1100 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fn();
  });
  chain = p.catch(() => {});
  return p;
}

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), R.timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': R.userAgent, Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function geocode(q) {
  const key = q.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const tryQ = async (query) => {
    const url = `${R.nominatimUrl}/search?format=jsonv2&limit=1&countrycodes=${encodeURIComponent(R.countryCodes)}&q=${encodeURIComponent(query)}`;
    const j = await throttled(() => getJson(url));
    return j && j[0] ? { lat: +j[0].lat, lon: +j[0].lon, label: j[0].display_name } : null;
  };
  let r = await tryQ(q);
  if (!r && !/ontario|\bon\b/i.test(q)) r = await tryQ(`${q}, Ontario`);
  if (r) cache.set(key, r);
  return r;
}

async function drivingKm(a, b) {
  const url = `${R.osrmUrl}/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`;
  const j = await getJson(url);
  if (!j || j.code !== 'Ok' || !j.routes || !j.routes[0]) throw new Error('no route');
  return j.routes[0].distance / 1000;
}

/** Returns {loadedKm, deadheadKm, pickupLabel, deliveryLabel, source} or null on failure. */
async function estimateDistance(pickup, delivery) {
  if (!R.enabled) return null;
  try {
    const a = await geocode(pickup);
    const b = a && (await geocode(delivery));
    if (!a || !b) return null;
    const loadedKm = await drivingKm(a, b);
    let deadheadKm = 0;
    try {
      deadheadKm = await drivingKm({ lat: config.business.baseLat, lon: config.business.baseLon }, a);
    } catch { deadheadKm = 0; }
    return {
      loadedKm: Math.round(loadedKm),
      deadheadKm: Math.round(deadheadKm),
      pickupLabel: a.label,
      deliveryLabel: b.label,
      source: 'OpenStreetMap (Nominatim + OSRM)',
    };
  } catch (e) {
    console.warn('[routing] failed:', e.message);
    return null;
  }
}
module.exports = { estimateDistance };
