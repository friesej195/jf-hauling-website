// Ballpark estimate from the pricing table in config.js.
const config = require('../config');

function estimate({ freightType, weightLbs, loadedKm, deadheadKm = 0, notes = '' }) {
  const P = config.pricing;
  const lines = [];
  const add = (label, amount) => { if (amount) lines.push({ label, amount: Math.round(amount * 100) / 100 }); };

  add('Base fee', P.baseFee);
  add(`Distance: ${loadedKm} km × $${P.perKmLoaded}/km`, loadedKm * P.perKmLoaded);
  const dh = Math.max(0, (deadheadKm || 0) - P.deadheadFreeKm);
  if (P.perKmDeadhead && dh) add(`Travel to pickup: ${dh} km × $${P.perKmDeadhead}/km`, dh * P.perKmDeadhead);
  const sur = P.containerSurcharge[freightType] || 0;
  add(freightType === 'general' ? 'Freight handling' : `Container surcharge (${freightType === 'container20' ? '20 ft' : '40 ft'})`, sur);
  if (weightLbs > P.heavyWeightThresholdLbs) {
    const extra = Math.ceil((weightLbs - P.heavyWeightThresholdLbs) / 1000);
    add(`Heavy load: ${extra} × 1,000 lbs over ${P.heavyWeightThresholdLbs.toLocaleString('en-CA')} lbs`, extra * P.heavyWeightPer1000Lbs);
  }
  const n = (notes || '').toLowerCase();
  const special = [];
  for (const [k, v] of Object.entries(P.specialSurcharges)) {
    const re = k === 'hazmat' ? /hazmat|hazardous|dangerous goods|\btdg\b/ : new RegExp(k);
    if (re.test(n)) { special.push(k); add(`Special handling: ${k}`, v); }
  }
  let subtotal = lines.reduce((s, l) => s + l.amount, 0);
  if (P.fuelSurchargePercent) {
    const f = subtotal * P.fuelSurchargePercent / 100;
    add(`Fuel surcharge ${P.fuelSurchargePercent}%`, f);
    subtotal += f;
  }
  let minimumApplied = false;
  if (subtotal < P.minimumCharge) { subtotal = P.minimumCharge; minimumApplied = true; }
  const r10 = (x) => Math.round(x / 10) * 10;
  return {
    lines,
    subtotal: Math.round(subtotal),
    low: r10(subtotal * (1 - P.rangePercent / 100)),
    high: r10(subtotal * (1 + P.rangePercent / 100)),
    minimumApplied,
    special,
    currency: P.currency,
    taxNote: P.taxNote,
    isExample: P.isExample,
  };
}
module.exports = { estimate };
