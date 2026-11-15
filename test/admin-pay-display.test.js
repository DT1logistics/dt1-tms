// Item 2 (11/15/2026): on every admin screen that shows load pay, Driver Pay comes first and
// "Total Load Pay (invoiced)" is under it, at every status. Drivers' screens are unchanged and
// never show the admin total. Also checks that the inline page scripts still parse. Run: npm test
const assert = require('assert');
const h = require('./helpers/server');
const loadPay = require('../lib/load-pay');

function assertBefore(html, first, second, label) {
  const a = html.indexOf(first);
  const b = html.indexOf(second);
  assert.ok(a !== -1, `${label}: missing "${first}"`);
  assert.ok(b !== -1, `${label}: missing "${second}"`);
  assert.ok(a < b, `${label}: "${first}" should be above "${second}"`);
}

function assertScriptsParse(html, label) {
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  let n = 0;
  while ((m = re.exec(html))) {
    n += 1;
    try {
      // eslint-disable-next-line no-new-func
      new Function(m[1]);
    } catch (err) {
      throw new Error(`${label}: inline script ${n} does not parse: ${err.message}`);
    }
  }
}

(async () => {
  const { check, results } = h.makeChecker();

  await check('client driverPay mirrors the server formula', async () => {
    assert.strictEqual(loadPay.driverPay({ isFlat: true, flatRate: 210, drive: 25, self: 20, detention: 10, pct: 30 }), 265);
    assert.strictEqual(loadPay.driverPay({ isFlat: false, qty: 20, rate: 10, drive: 50, self: 20, detention: 0, pct: 30 }), 60 + 15 + 20);
  });

  const adminPassword = 'Pay-Display-Admin-1';
  const driverPassword = 'Pay-Display-Driver-1';
  const dataDir = h.tempDataDir('dt1-pay-display-');
  const srv = await h.startServer({ DATA_DIR: dataDir, LOGAN_TMS_PASSWORD: adminPassword, LOGAN_API_TOKEN: '', SESSION_SECRET: 'pay-display-test' });
  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    const ids = await h.seedBasics(srv.port, dataDir, admin, { projectFields: { default_rate: '10' } });
    h.setUserPassword(dataDir, 'dana.driver@example.com', driverPassword);
    const driver = (await h.loginAs(srv.port, 'dana.driver@example.com', driverPassword)).jar;
    const adminGet = (p) => h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path: p });
    const loadId = (ticket) => h.readRows(dataDir, 'SELECT id FROM loads WHERE ticket_number = ?', [ticket])[0].id;

    // Draft (assigned), submitted, and approved loads: 20 tons x $10 at 30% = $60.00 driver pay, $200.00 total.
    for (const [ticket, action] of [['PAY-DRAFT', 'draft'], ['PAY-SUB', 'submit'], ['PAY-APP', 'approve']]) {
      const res = await h.request(srv.port, ids.auth, { method: 'POST', path: '/loads', body: h.form({
        action, load_date: '2026-11-10', ticket_number: ticket, project_id: ids.projectId, driver_id: ids.driverId,
        weight_quantity: '20', rate: '10'
      }) });
      assert.strictEqual(res.status, 302, ticket + ' ' + res.body.slice(0, 200));
    }

    await check('admin Loads list: Driver Pay above Total Load Pay (invoiced) at every status', async () => {
      // Item 5: approved loads are listed under ?view=approved instead of the main Loads screen.
      const page = { body: (await adminGet('/loads')).body + (await adminGet('/loads?view=approved')).body };
      ['PAY-DRAFT', 'PAY-SUB', 'PAY-APP'].forEach((ticket) => {
        const start = page.body.indexOf(`<strong>${ticket}</strong>`);
        assert.ok(start !== -1, ticket);
        const card = page.body.slice(start, page.body.indexOf('</p>', start));
        assertBefore(card, 'Driver Pay: $60.00', 'Total Load Pay (invoiced): $200.00', ticket);
        assert.ok(!card.includes('Load Total:'), ticket + ' still says Load Total');
      });
    });

    await check('admin review page: Driver Pay above Total Load Pay (invoiced), summary and live edit totals', async () => {
      for (const ticket of ['PAY-DRAFT', 'PAY-SUB', 'PAY-APP']) {
        const page = await adminGet(`/loads/${loadId(ticket)}`);
        assertBefore(page.body, '<strong>Driver Pay</strong> $60.00', '<strong>Total Load Pay (invoiced)</strong> $200.00', ticket);
        assertBefore(page.body, 'id="review_driver_pay"', 'id="review_load_total"', ticket + ' edit panel');
        assert.match(page.body, /data-pay-pct="30"/);
        assertScriptsParse(page.body, `/loads/${loadId(ticket)}`);
      }
    });

    await check('admin load form: live Driver Pay above Total Load Pay (invoiced)', async () => {
      for (const p of ['/loads/new', `/loads/${loadId('PAY-DRAFT')}/edit`]) {
        const page = await adminGet(p);
        assertBefore(page.body, 'id="driver_pay_total"', 'id="load_total"', p);
        assert.ok(page.body.includes('Total Load Pay (invoiced): $0.00'));
        assert.ok(page.body.includes('/js/load-pay.js'));
        assertScriptsParse(page.body, p);
      }
      const js = await adminGet('/js/load-pay.js');
      assert.strictEqual(js.status, 200);
      assert.ok(js.body.includes('DT1LoadPay'));
    });

    await check('Settlements: pending driver week shows Total Load Pay under Driver Pay; invoice shows Driver Pay', async () => {
      // Item 5: the weekly invoice moved from /settlements to /invoices.
      const page = { body: (await adminGet('/settlements')).body + (await adminGet('/invoices')).body };
      assertBefore(page.body, 'Driver Pay $60.00', 'Total Load Pay (invoiced) $200.00', 'pending week');
      assertBefore(page.body, 'Driver Pay (not billed)', '<span>Hauling</span>', 'invoice totals');
      assert.match(page.body, /<th class="num"[^>]*>Driver Pay<\/th>\s*<th class="num">Price<\/th>/);
    });

    await check('driver screens are unchanged: Load Total, no admin total line', async () => {
      for (const p of ['/loads', `/loads/${loadId('PAY-DRAFT')}`, `/loads/${loadId('PAY-DRAFT')}/edit`, '/', '/settlements']) {
        const page = await h.request(srv.port, { Cookie: h.cookieHeader(driver) }, { path: p });
        assert.strictEqual(page.status, 200, p);
        const visible = page.body.replace(/<script[\s\S]*?<\/script>/g, '');
        assert.ok(!visible.includes('Total Load Pay (invoiced)'), p);
        assert.ok(!visible.includes('id="driver_pay_total"'), p);
        assertScriptsParse(page.body, 'driver ' + p);
      }
      const list = await h.request(srv.port, { Cookie: h.cookieHeader(driver) }, { path: '/loads' });
      assert.ok(list.body.includes('Load Total: $200.00'));
    });
  } finally {
    await h.stop(srv.child);
  }
  console.log(`\n${results.length} admin-pay-display checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
