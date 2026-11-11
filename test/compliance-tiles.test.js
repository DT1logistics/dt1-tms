// Dashboard compliance tiles: red and yellow counts follow the existing alert levels.
// Run: npm test
const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const tiles = require('../lib/compliance-tiles');

function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    console.log('ok -', name);
  });
}

function tileHtml(html, title) {
  const marker = `<strong>${title}</strong>`;
  const start = html.indexOf(marker);
  assert.ok(start >= 0, `missing tile ${title}`);
  const anchor = html.lastIndexOf('<a ', start);
  const end = html.indexOf('</a>', start);
  assert.ok(anchor >= 0 && end > anchor, `tile markup for ${title}`);
  return html.slice(anchor, end + 4);
}

const sample = [
  { level: 'red', category: 'Equipment', name: 'Truck 2001 registration', detail: 'Expired · 2020-01-15' },
  { level: 'red', category: 'Equipment', name: 'Truck 2002 inspection', detail: 'Expired · 2020-06-01' },
  { level: 'yellow', category: 'Equipment', name: 'Trailer 3001 registration', detail: 'Expiring ≤45 days · 2026-12-06' },
  { level: 'green', category: 'Equipment', name: 'Truck 2001 inspection', detail: 'Active · 2027-06-01' },
  { level: 'yellow', category: 'Driver Document', name: 'Alex Driver — Medical Card', detail: 'Expiring ≤45 days · 2026-12-06' },
  { level: 'red', category: 'Load', name: 'Load #4 (Alex Driver)', detail: 'Missing ticket number and ticket file' },
  { level: 'yellow', category: 'Load', name: 'Load #5 (Alex Driver)', detail: 'Pending review' },
  { level: 'red', category: 'Password Reset', name: 'Alex Driver', detail: 'Requested a password reset. Email could not be sent.' }
];

const checks = [];

function queued(name, fn) {
  checks.push(() => check(name, fn));
}

queued('counts red and yellow alerts separately and ignores other levels', () => {
  const built = tiles.buildComplianceTiles(sample);
  const equipment = built.find((item) => item.title === 'Equipment');
  const documents = built.find((item) => item.title === 'Driver Documents');
  const compliance = built.find((item) => item.title === 'Compliance');
  const loads = built.find((item) => item.title === 'Loads');
  const reset = built.find((item) => item.title === 'Password Reset');

  assert.strictEqual(equipment.redCount, 2);
  assert.strictEqual(equipment.yellowCount, 1);
  assert.strictEqual(documents.redCount, 0);
  assert.strictEqual(documents.yellowCount, 1);
  assert.strictEqual(compliance.redCount, 0);
  assert.strictEqual(compliance.yellowCount, 0);
  assert.strictEqual(loads.redCount, 1);
  assert.strictEqual(loads.yellowCount, 1);
  assert.strictEqual(reset.redCount, 1);
  assert.strictEqual(reset.yellowCount, 0);
});

queued('tile accent is red only when the red count is greater than zero', () => {
  const built = tiles.buildComplianceTiles(sample);
  const byTitle = Object.fromEntries(built.map((item) => [item.title, item]));

  assert.strictEqual(byTitle.Equipment.accent, 'red');
  assert.strictEqual(byTitle.Equipment.red, true);
  assert.strictEqual(byTitle.Equipment.className, 'quick quick-alert');

  assert.strictEqual(byTitle['Driver Documents'].accent, 'yellow');
  assert.strictEqual(byTitle['Driver Documents'].red, false);
  assert.strictEqual(byTitle['Driver Documents'].className, 'quick quick-warn');
  assert.ok(!byTitle['Driver Documents'].className.includes('quick-alert'));

  assert.strictEqual(byTitle.Compliance.accent, 'neutral');
  assert.strictEqual(byTitle.Compliance.red, false);
  assert.strictEqual(byTitle.Compliance.className, 'quick');

  assert.strictEqual(byTitle.Loads.accent, 'red');
  assert.strictEqual(byTitle['Password Reset'].accent, 'red');
});

queued('a yellow-only category never uses the red accent', () => {
  const built = tiles.buildComplianceTiles([
    { level: 'yellow', category: 'Equipment', name: 'Trailer 3001 registration', detail: 'Expiring ≤45 days · 2026-12-06' },
    { level: 'yellow', category: 'Driver Document', name: 'Alex Driver — CDL License', detail: 'Expiring ≤45 days · 2026-12-06' },
    { level: 'yellow', category: 'Compliance', name: 'Insurance', detail: 'Expiring ≤45 days · 2026-12-06' }
  ]);
  built.filter((item) => item.yellowCount > 0).forEach((item) => {
    assert.strictEqual(item.redCount, 0);
    assert.strictEqual(item.accent, 'yellow');
    assert.strictEqual(item.red, false);
    assert.strictEqual(item.className, 'quick quick-warn');
  });
});

queued('maps existing categories and keeps an unknown flagged category', () => {
  const built = tiles.buildComplianceTiles([
    { level: 'red', category: 'Shop', name: 'General', detail: 'Missing invoice' }
  ]);
  assert.deepStrictEqual(built.map((item) => item.title), [
    'Compliance',
    'Driver Documents',
    'Equipment',
    'Loads',
    'Password Reset',
    'Shop'
  ]);
  assert.strictEqual(built.find((item) => item.title === 'Compliance').href, '/compliance');
  assert.strictEqual(built.find((item) => item.title === 'Driver Documents').href, '/drivers?compliance=attention');
  assert.strictEqual(built.find((item) => item.title === 'Equipment').href, '/equipment?compliance=attention');
  assert.strictEqual(built.find((item) => item.title === 'Loads').href, '/loads');
  const shop = built.find((item) => item.title === 'Shop');
  assert.strictEqual(shop.redCount, 1);
  assert.strictEqual(shop.accent, 'red');
});

queued('alerts the collector did not emit are not counted', () => {
  const built = tiles.buildComplianceTiles([
    { level: 'red', category: 'Equipment', name: 'Truck 2002 inspection', detail: 'Expired · 2020-06-01' }
  ]);
  const equipment = built.find((item) => item.title === 'Equipment');
  assert.strictEqual(equipment.redCount, 1);
  assert.ok(!built.some((item) => /1001|1005/.test(`${item.title} ${item.category}`)));
});

queued('rendered badges hide a zero count and stay neutral when both counts are zero', () => {
  return ejs.renderFile(
    path.join(__dirname, '../views/partials/compliance-tiles.ejs'),
    { complianceTiles: tiles.buildComplianceTiles(sample) }
  ).then((html) => {
    const equipment = tileHtml(html, 'Equipment');
    const documents = tileHtml(html, 'Driver Documents');
    const compliance = tileHtml(html, 'Compliance');

    assert.match(equipment, /class="quick quick-alert"/);
    assert.match(equipment, /class="badge red"/);
    assert.match(equipment, /2 out of compliance/);
    assert.match(equipment, /class="badge yellow"/);
    assert.match(equipment, /1 expiring soon/);

    assert.match(documents, /class="quick quick-warn"/);
    assert.doesNotMatch(documents, /quick-alert/);
    assert.doesNotMatch(documents, /out of compliance/);
    assert.match(documents, /1 expiring soon/);
    assert.doesNotMatch(documents, /class="badge red"/);

    assert.match(compliance, /class="quick"/);
    assert.doesNotMatch(compliance, /quick-alert|quick-warn/);
    assert.match(compliance, />All clear</);
    assert.doesNotMatch(compliance, /badge/);
  });
});

checks.reduce((chain, run) => chain.then(run), Promise.resolve()).catch((err) => {
  console.error(err);
  process.exit(1);
});
