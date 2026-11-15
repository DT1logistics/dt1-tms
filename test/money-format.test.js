// Item 4 (11/15/2026): money shows a "$" and two decimals everywhere: displays read
// "$1,234.50", and money inputs get a "$" prefix and are shown as 210.00. Fuel $/gal keeps
// three decimals; Qty, Pay % and odometer are not money. Run: npm test
const assert = require('assert');
const h = require('./helpers/server');
const money = require('../lib/money-input');
const loadPay = require('../lib/load-pay');

(async () => {
  const { check, results } = h.makeChecker();

  await check('usd() formats with $, thousands separators and two decimals', async () => {
    assert.strictEqual(money.usd(0), '$0.00');
    assert.strictEqual(money.usd(null), '$0.00');
    assert.strictEqual(money.usd(undefined), '$0.00');
    assert.strictEqual(money.usd('abc'), '$0.00');
    assert.strictEqual(money.usd(210), '$210.00');
    assert.strictEqual(money.usd(209.99), '$209.99');
    assert.strictEqual(money.usd(1234.5), '$1,234.50');
    assert.strictEqual(money.usd(-5), '-$5.00');
    assert.strictEqual(money.usd(-0.001), '$0.00');
    assert.strictEqual(loadPay.usd(1234.5), '$1,234.50');
  });

  await check('twoDecimals() keeps blanks and shows two decimals', async () => {
    assert.strictEqual(money.twoDecimals('210'), '210.00');
    assert.strictEqual(money.twoDecimals('209.9'), '209.90');
    assert.strictEqual(money.twoDecimals(''), '');
    assert.strictEqual(money.twoDecimals('  '), '');
  });

  const adminPassword = 'Money-Admin-1';
  const dataDir = h.tempDataDir('dt1-money-');
  const srv = await h.startServer({ DATA_DIR: dataDir, LOGAN_TMS_PASSWORD: adminPassword, LOGAN_API_TOKEN: '', SESSION_SECRET: 'money-test' });
  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    const ids = await h.seedBasics(srv.port, dataDir, admin, { projectFields: {
      default_rate: '1234.5', default_driver_pay_type: 'flat', default_driver_flat_rate: '210'
    } });
    const get = (p) => h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path: p });
    await h.request(srv.port, ids.auth, { method: 'POST', path: '/loads', body: h.form({
      action: 'draft', load_date: '2026-11-10', ticket_number: 'MONEY', project_id: ids.projectId, driver_id: ids.driverId
    }) });
    const loadId = h.readRows(dataDir, "SELECT id FROM loads WHERE ticket_number = 'MONEY'")[0].id;

    await check('money inputs on the load form carry data-money; Driver Flat / Daily Rate shows 210.00', async () => {
      const page = await get(`/loads/${loadId}/edit`);
      for (const name of ['rate', 'driver_flat_rate', 'drive_time_amount', 'self_load_amount', 'detention_amount', 'shipper_detention_amount', 'total_load_pay']) {
        assert.match(page.body, new RegExp(`<input data-money="1"[^>]*name="${name}"`), name);
      }
      assert.match(page.body, /name="driver_flat_rate"[^>]*value="210.00"/);
      assert.ok(!/<input data-money[^>]*name="weight_quantity"/.test(page.body), 'Qty is not money');
      assert.ok(page.body.includes('<script src="/js/money-input.js"></script>'));
      const js = await get('/js/money-input.js');
      assert.strictEqual(js.status, 200);
      assert.ok(js.body.includes('money-prefix'));
    });

    await check('review page, project form and shipper page money inputs carry data-money', async () => {
      const review = await get(`/loads/${loadId}`);
      assert.match(review.body, /<input data-money="1"[^>]*name="driver_flat_rate"[^>]*value="210.00"/);
      const project = await get(`/projects/${ids.projectId}/edit`);
      for (const name of ['default_rate', 'default_driver_flat_rate', 'default_total_load_pay', 'default_drive_time_amount']) {
        assert.match(project.body, new RegExp(`<input data-money="1"[^>]*name="${name}"`), name);
      }
      const shipper = await get(`/shippers/${ids.customerId}`);
      assert.match(shipper.body, /<input data-money="1"[^>]*name="default_rate"/);
      const fuel = await get('/fuel-rate');
      assert.ok(!/<input data-money[^>]*name="central_atlantic_rate"/.test(fuel.body), 'fuel $/gal keeps 3 decimals');
    });

    await check('displays use $ with thousands separators and two decimals', async () => {
      const list = await get('/loads');
      assert.ok(list.body.includes('Rate: $1,234.50'), 'load card rate');
      const review = await get(`/loads/${loadId}`);
      assert.ok(review.body.includes('<strong>Rate</strong> $1,234.50'));
      assert.ok(review.body.includes('Flat Daily Rate: $210.00'));
      const projects = await get('/projects');
      assert.ok(projects.body.includes('$1,234.50'));
      assert.ok(projects.body.includes('Flat / Daily Rate $210.00'));
    });
  } finally {
    await h.stop(srv.child);
  }
  console.log(`\n${results.length} money-format checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
