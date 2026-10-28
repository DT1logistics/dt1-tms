// Run: npm test  (node test/fuel-surcharge.test.js)
const assert = require('assert');
const fuel = require('../lib/fuel-surcharge');

function check(name, fn) { fn(); console.log('ok -', name); }

check('FSC % from weekly diesel rate', () => {
  assert.strictEqual(fuel.fscPercent(6.485), 24.85);
  assert.strictEqual(fuel.fscDecimal(6.485), 0.2485);
  assert.strictEqual(fuel.fscPercent(6.496), 24.96);
  assert.strictEqual(fuel.fscPercent(6.508), 25.08);
  assert.strictEqual(fuel.fscPercent(4.00), 0);
  assert.strictEqual(fuel.fscPercent(3.75), 0);
});

check("Kammy's worked example ($6.485, $12.65/ton, 24.16 wet tons)", () => {
  const r = fuel.loadFuelSurcharge({ percent: fuel.fscPercent(6.485), rate: 12.65, tons: 24.16 });
  assert.strictEqual(r.perTon, 3.143525);
  assert.strictEqual(r.total, 75.95);
  assert.strictEqual(r.baseHauling, 305.62);
  assert.strictEqual(fuel.round(r.baseHauling + r.total, 2), 381.57);
  console.log('   ', { percent: '24.85%', perTon: r.perTon, total: r.total, baseHauling: r.baseHauling, totalInclSurcharge: fuel.round(r.baseHauling + r.total, 2) });
});

check('Current rate $6.496 (24.96%) on same load', () => {
  const r = fuel.loadFuelSurcharge({ percent: fuel.fscPercent(6.496), rate: 12.65, tons: 24.16 });
  assert.strictEqual(r.perTon, 3.15744);
  console.log('    total =', r.total);
});

check('Flat-rate load applies FSC decimal to flat amount', () => {
  const r = fuel.loadFuelSurcharge({ percent: 24.85, rate: 0, tons: 1, isFlat: true, flatAmount: 400 });
  assert.strictEqual(r.flat, true);
  assert.strictEqual(r.total, 99.40);
});

console.log('All fuel surcharge tests passed.');

// Weekly rate lookup: each load uses the rate effective on or before its Load Date.
const history = [
  { id: 1, effective_date: '2026-10-19', central_atlantic_rate: 6.508 },
  { id: 2, effective_date: '2026-10-26', central_atlantic_rate: 6.496 }
];
const base = { history, rate: 12.65, tons: 24.16 };

check('Load dated 2026-10-20 uses week of 2026-10-19 ($6.508, 25.08%)', () => {
  const r = fuel.loadFuelSurchargeForDate({ ...base, loadDate: '2026-10-20' });
  assert.strictEqual(r.pending, false);
  assert.strictEqual(r.dieselRate, 6.508);
  assert.strictEqual(r.percent, 25.08);
  console.log('    ', r.effectiveDate, '$' + r.dieselRate, r.percent + '%', 'perTon', r.perTon, 'total', r.total);
});

check('Load dated 2026-10-26 uses week of 2026-10-26 ($6.496, 24.96%)', () => {
  const r = fuel.loadFuelSurchargeForDate({ ...base, loadDate: '2026-10-26' });
  assert.strictEqual(r.pending, false);
  assert.strictEqual(r.dieselRate, 6.496);
  assert.strictEqual(r.percent, 24.96);
  assert.strictEqual(r.total, 76.28);
  console.log('    ', r.effectiveDate, '$' + r.dieselRate, r.percent + '%', 'perTon', r.perTon, 'total', r.total);
});

check('Load dated 2026-10-25 (Sunday) still uses prior week ($6.508)', () => {
  assert.strictEqual(fuel.loadFuelSurchargeForDate({ ...base, loadDate: '2026-10-25' }).dieselRate, 6.508);
});

check('Load before any fuel rate is Rate pending at $0', () => {
  const r = fuel.loadFuelSurchargeForDate({ ...base, loadDate: '2026-10-12' });
  assert.strictEqual(r.pending, true);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(fuel.loadFuelSurchargeForDate({ ...base, loadDate: '' }).pending, true);
});

check('Example week rate ($6.485) via date lookup gives $75.95', () => {
  const r = fuel.loadFuelSurchargeForDate({ history: [{ id: 9, effective_date: '2026-11-02', central_atlantic_rate: 6.485 }], loadDate: '2026-11-04', rate: 12.65, tons: 24.16 });
  assert.strictEqual(r.total, 75.95);
});

console.log('All weekly-rate tests passed.');
