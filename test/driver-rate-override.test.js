// Item 10 (11/15/2026): on wet tonnage + rate loads the project's default rate pre-fills the Load Rate,
// the driver may override it, the admin may revise it after submit, and once approved the load's own
// rate flows to the driver settlement and the invoice. The project default never changes.
// Run: npm test
const assert = require('assert');
const h = require('./helpers/server');

(async () => {
  const { check, results } = h.makeChecker();
  const adminPassword = 'Rate-Override-Admin-1';
  const driverPassword = 'Rate-Override-Driver-1';
  const dataDir = h.tempDataDir('dt1-rate-override-');
  const srv = await h.startServer({ DATA_DIR: dataDir, LOGAN_TMS_PASSWORD: adminPassword, LOGAN_API_TOKEN: '', SESSION_SECRET: 'rate-override-test' });
  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    const ids = await h.seedBasics(srv.port, dataDir, admin);
    h.setUserPassword(dataDir, 'dana.driver@example.com', driverPassword);
    const driver = (await h.loginAs(srv.port, 'dana.driver@example.com', driverPassword)).jar;
    const dAuth = { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: h.cookieHeader(driver) };
    const row = (ticket) => h.readRows(dataDir, 'SELECT * FROM loads WHERE ticket_number = ?', [ticket])[0];
    const audit = (id, action) => h.readRows(dataDir, "SELECT * FROM audit_log WHERE entity_type = 'load' AND entity_id = ? AND action = ?", [id, action]);

    await check('the driver load form pre-fills the project default and lets the driver edit the rate', async () => {
      const page = await h.request(srv.port, { Cookie: h.cookieHeader(driver) }, { path: '/loads/new' });
      assert.strictEqual(page.status, 200);
      const input = page.body.match(/<input[^>]*name="rate"[^>]*>/)[0];
      assert.ok(!/readonly/.test(input), input);
      assert.ok(page.body.includes('data-rate="10"'));
      assert.ok(page.body.includes('id="rate_default_hint"'));
    });

    let loadId;
    await check('a driver override is saved on the load and logged; the project default is unchanged', async () => {
      const res = await h.request(srv.port, dAuth, { method: 'POST', path: '/loads', body: h.form({
        action: 'submit', load_date: '2026-11-10', ticket_number: 'RATE-1', project_id: ids.projectId, weight_quantity: '20', rate: '12.50'
      }) });
      assert.strictEqual(res.status, 302);
      const load = row('RATE-1');
      loadId = load.id;
      assert.strictEqual(Number(load.rate), 12.5);
      assert.strictEqual(load.status, 'submitted');
      const entries = audit(load.id, 'Rate override');
      assert.strictEqual(entries.length, 1);
      assert.ok(entries[0].detail.includes('$12.50') && entries[0].detail.includes('project default $10.00'), entries[0].detail);
      assert.strictEqual(Number(h.readRows(dataDir, 'SELECT default_rate FROM projects WHERE id = ?', [ids.projectId])[0].default_rate), 10);
    });

    await check('the admin revises the rate after submit, and the revision is logged', async () => {
      const res = await h.request(srv.port, ids.auth, { method: 'POST', path: `/loads/${loadId}`, body: h.form({
        action: 'save', load_date: '2026-11-10', ticket_number: 'RATE-1', project_id: ids.projectId, driver_id: ids.driverId, weight_quantity: '20', rate: '13'
      }) });
      assert.strictEqual(res.status, 302);
      assert.strictEqual(Number(row('RATE-1').rate), 13);
      const entries = audit(loadId, 'Rate revised');
      assert.strictEqual(entries.length, 1);
      assert.ok(entries[0].detail.includes('$12.50') && entries[0].detail.includes('$13.00'), entries[0].detail);
    });

    await check('once approved, the load rate flows to the driver settlement and the invoice', async () => {
      await h.request(srv.port, ids.auth, { method: 'POST', path: `/loads/${loadId}/approve`, body: '' });
      assert.strictEqual(row('RATE-1').status, 'approved');
      const settlements = await h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path: '/settlements' });
      // 30% of 20 x $13.00 = $78.00
      assert.ok(settlements.body.includes('Contractor Pay $78.00'), 'settlement uses the load rate');
      const invoices = await h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path: '/invoices' });
      assert.strictEqual(invoices.status, 200);
      assert.ok(invoices.body.includes('$260.00'), 'invoice hauling 20 x $13.00');
      assert.strictEqual(Number(h.readRows(dataDir, 'SELECT default_rate FROM projects WHERE id = ?', [ids.projectId])[0].default_rate), 10);
    });

    await check('drivers cannot change the rate on flat / daily-rate loads', async () => {
      h.writeDb(dataDir, (db) => db.prepare("UPDATE projects SET default_driver_pay_type = 'flat', default_driver_flat_rate = 200 WHERE id = ?").run(ids.projectId));
      await h.request(srv.port, dAuth, { method: 'POST', path: '/loads', body: h.form({
        action: 'draft', load_date: '2026-11-11', ticket_number: 'FLAT-1', project_id: ids.projectId, weight_quantity: '1', rate: '99'
      }) });
      const load = row('FLAT-1');
      assert.strictEqual(load.driver_pay_type, 'flat');
      assert.strictEqual(Number(load.rate), 10);
      assert.strictEqual(audit(load.id, 'Rate override').length, 0);
      const page = await h.request(srv.port, { Cookie: h.cookieHeader(driver) }, { path: `/loads/${load.id}/edit` });
      assert.ok(/<input[^>]*name="rate"[^>]*readonly/.test(page.body));
      h.writeDb(dataDir, (db) => db.prepare("UPDATE projects SET default_driver_pay_type = 'percentage' WHERE id = ?").run(ids.projectId));
    });
  } finally {
    await h.stop(srv.child);
  }
  console.log(`\n${results.length} driver-rate-override checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
