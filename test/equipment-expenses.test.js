// Run: npm test  (node test/equipment-expenses.test.js)
const assert = require('assert');
const ex = require('../lib/equipment-expenses');

function check(name, fn) { fn(); console.log('ok -', name); }

const items = [
  { id: 1, equipment_id: 1, expense_date: '2026-01-15', amount: 100.10 },
  { id: 2, equipment_id: 1, expense_date: '2026-01-20', amount: 0.20 },
  { id: 3, equipment_id: 1, expense_date: '2026-03-02', amount: 1250.55 },
  { id: 4, equipment_id: 1, expense_date: '2025-12-30', amount: 499.99 },
  { id: 5, equipment_id: 2, expense_date: '2026-10-05', amount: 89.5 },
  { id: 6, equipment_id: 1, expense_date: '2026-03-02', amount: 10 }
];

check('Month totals, newest month first, cents-exact', () => {
  const s = ex.summarize(items.filter((i) => i.equipment_id === 1), 2026);
  assert.deepStrictEqual(s.months.map((m) => [m.key, m.label, m.total, m.count]), [
    ['2026-03', 'March 2026', 1260.55, 2],
    ['2026-01', 'January 2026', 100.30, 2],
    ['2025-12', 'December 2025', 499.99, 1]
  ]);
  assert.strictEqual(0.1 + 0.2 === 0.3, false); // float trap the cents math avoids
  assert.strictEqual(s.months[1].total, 100.3);
});

check('YTD 2026 excludes prior year; all-time includes it', () => {
  const s = ex.summarize(items.filter((i) => i.equipment_id === 1), 2026);
  assert.strictEqual(s.ytdTotal, 1360.85);
  assert.strictEqual(s.allTimeTotal, 1860.84);
  assert.strictEqual(s.count, 5);
});

check('Running YTD total accumulates in date order (ties by id), null outside year', () => {
  const s = ex.summarize(items.filter((i) => i.equipment_id === 1), 2026);
  const byId = {};
  s.months.forEach((m) => m.items.forEach((i) => { byId[i.id] = i.ytdRunning; }));
  assert.deepStrictEqual(byId, { 1: 100.1, 2: 100.3, 3: 1350.85, 6: 1360.85, 4: null });
  // newest first within a month
  assert.deepStrictEqual(s.months[0].items.map((i) => i.id), [6, 3]);
});

check('Undated rows go last and count only toward all-time', () => {
  const s = ex.summarize([{ id: 9, expense_date: null, amount: 5 }, { id: 10, expense_date: '2026-02-01', amount: 1 }], 2026);
  assert.deepStrictEqual(s.months.map((m) => m.key), ['2026-02', 'undated']);
  assert.strictEqual(s.ytdTotal, 1);
  assert.strictEqual(s.allTimeTotal, 6);
});

check('Empty log', () => {
  const s = ex.summarize([], 2026);
  assert.deepStrictEqual([s.months.length, s.ytdTotal, s.allTimeTotal], [0, 0, 0]);
});

check('Per-unit totals for the Equipment list', () => {
  assert.deepStrictEqual(ex.totalsByEquipment(items, 2026), {
    1: { ytd: 1360.85, allTime: 1860.84, count: 5 },
    2: { ytd: 89.5, allTime: 89.5, count: 1 }
  });
});

check('Input validation: description and date required, category whitelist, odometer optional', () => {
  let r = ex.parseExpenseInput({ expense_date: '2026-10-30', category: 'tires', vendor: ' Joe\'s ', description: ' 2 steer tires ', amount: '$1,234.567', odometer: '' });
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.value, { expense_date: '2026-10-30', category: 'Tires', vendor: "Joe's", description: '2 steer tires', amount: 1234.57, odometer: null });
  r = ex.parseExpenseInput({ expense_date: '2026-02-30', category: 'Bogus', description: '', amount: '', odometer: '12,345' });
  assert.deepStrictEqual(r.errors, ['Description is required.', 'A valid date is required.', 'Amount is required.']);
  assert.strictEqual(r.value.category, 'Other');
  assert.strictEqual(r.value.odometer, 12345);
  assert.ok(ex.parseExpenseInput({ expense_date: '2026-01-01', description: 'x', amount: '-5' }).errors.includes('Amount cannot be negative.'));
});

check('Receipt tag matching to a unit number', () => {
  assert.ok(ex.receiptTagMatches('Truck #1002', '#1002'));
  assert.ok(ex.receiptTagMatches('trk 1002 - brakes', '1002'));
  assert.ok(ex.receiptTagMatches('Trailer T-12', 'T-12'));
  assert.ok(!ex.receiptTagMatches('Truck #10021', '1002'));
  assert.ok(!ex.receiptTagMatches('', '1002'));
  assert.ok(!ex.receiptTagMatches('Truck 5', ''));
});

console.log('All equipment expense tests passed.');
