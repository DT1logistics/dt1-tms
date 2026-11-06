// Display formatter for load dates. Run: npm test
const assert = require('assert');
const { formatLoadDate } = require('../lib/load-date');

function localCalendar(isoInstant) {
  const instant = new Date(isoInstant);
  const month = String(instant.getMonth() + 1).padStart(2, '0');
  const day = String(instant.getDate()).padStart(2, '0');
  return `${month}-${day}-${instant.getFullYear()}`;
}

assert.strictEqual(formatLoadDate('2026-11-05'), '11-05-2026');
assert.strictEqual(formatLoadDate('2026-01-09'), '01-09-2026');
assert.strictEqual(formatLoadDate('  2026-11-05  '), '11-05-2026');
assert.strictEqual(formatLoadDate('2026-11-05T00:00:00.000Z'), '11-05-2026');
assert.strictEqual(formatLoadDate('2026-11-05 00:00:00'), '11-05-2026');
assert.strictEqual(formatLoadDate('2024-02-29'), '02-29-2024');

assert.strictEqual(formatLoadDate(''), '');
assert.strictEqual(formatLoadDate('   '), '');
assert.strictEqual(formatLoadDate(null), '');
assert.strictEqual(formatLoadDate(undefined), '');
assert.strictEqual(formatLoadDate('2026-02-30'), '');
assert.strictEqual(formatLoadDate('2026-11-5'), '');
assert.strictEqual(formatLoadDate('11-05-2026'), '');

// A UTC midnight instant is the previous local evening in timezones behind UTC.
// The formatter keeps the calendar date written on the load.
const utcMidnight = '2026-11-05T00:00:00.000Z';
assert.strictEqual(formatLoadDate(utcMidnight), '11-05-2026');
const local = localCalendar(utcMidnight);
if (local !== '11-05-2026') assert.notStrictEqual(formatLoadDate(utcMidnight), local);

console.log('ok - formatLoadDate');
