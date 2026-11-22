// Item 3 (11/15/2026): projects carry Driver Load Pay and Total Load Pay (flat amounts).
// New loads copy them; admins can edit per load; invoices use Total Load Pay with no fuel
// surcharge; blank totals keep the old Qty x Rate math; drivers never see or set the total.
// Run: npm test
const assert = require('assert');
const h = require('./helpers/server');

(async () => {
  const { check, results } = h.makeChecker();
  const adminPassword = 'Total-Pay-Admin-1';
  const driverPassword = 'Total-Pay-Driver-1';
  const dataDir = h.tempDataDir('dt1-total-pay-');
  const srv = await h.startServer({ DATA_DIR: dataDir, LOGAN_TMS_PASSWORD: adminPassword, LOGAN_API_TOKEN: '', SESSION_SECRET: 'total-pay-test' });
  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    const ids = await h.seedBasics(srv.port, dataDir, admin, { customer: 'Uber Freight', project: 'Virginia Beach', projectFields: {
      default_rate: '210', default_driver_pay_type: 'flat', default_driver_flat_rate: '210', has_fuel_surcharge: '1'
    } });
    const projectRow = () => h.readRows(dataDir, 'SELECT * FROM projects WHERE id = ?', [ids.projectId])[0];
    const loadRow = (ticket) => h.readRows(dataDir, 'SELECT * FROM loads WHERE ticket_number = ?', [ticket])[0];
    h.setUserPassword(dataDir, 'dana.driver@example.com', driverPassword);
    const driver = (await h.loginAs(srv.port, 'dana.driver@example.com', driverPassword)).jar;

    await check('a project without a Total Load Pay stores NULL (nothing changes until it is entered)', async () => {
      const row = projectRow();
      assert.strictEqual(row.default_total_load_pay, null);
      assert.strictEqual(row.default_driver_flat_rate, 210);
    });

    // A load created before the project total is set keeps NULL forever (no copy onto existing loads).
    await h.request(srv.port, ids.auth, { method: 'POST', path: '/loads', body: h.form({
      action: 'approve', load_date: '2026-11-10', ticket_number: 'BEFORE', project_id: ids.projectId, driver_id: ids.driverId, has_fuel_surcharge: '1'
    }) });

    await check('the project form saves Driver Load Pay and Total Load Pay', async () => {
      const edit = await h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path: `/projects/${ids.projectId}/edit` });
      assert.ok(edit.body.includes('Contractor Load Pay ($)'));
      assert.ok(edit.body.includes('name="default_total_load_pay"'));
      const res = await h.request(srv.port, ids.auth, { method: 'POST', path: `/projects/${ids.projectId}`, body: h.form({
        customer_id: ids.customerId, project_name: 'Virginia Beach', default_rate: '210', default_driver_pay_type: 'flat',
        default_driver_flat_rate: '210', default_total_load_pay: '$1,300.5', has_fuel_surcharge: '1', status: 'active'
      }) });
      assert.strictEqual(res.status, 302);
      assert.strictEqual(projectRow().default_total_load_pay, 1300.5);
      assert.strictEqual(loadRow('BEFORE').total_load_pay, null, 'existing loads are not changed');
      const list = await h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path: '/projects' });
      assert.ok(list.body.includes('Total Load Pay: $1300.50') || list.body.includes('Total Load Pay: $1,300.50'));
    });

    await check('the inline Add Project form on the shipper page saves both amounts', async () => {
      await h.request(srv.port, ids.auth, { method: 'POST', path: `/shippers/${ids.customerId}/projects`, body: h.form({
        project_name: 'Roanoke', default_rate: '292.50', default_driver_pay_type: 'flat', default_driver_flat_rate: '292.50', default_total_load_pay: '400'
      }) });
      const row = h.readRows(dataDir, "SELECT * FROM projects WHERE project_name = 'Roanoke'")[0];
      assert.strictEqual(row.default_total_load_pay, 400);
      assert.strictEqual(row.default_driver_flat_rate, 292.5);
      assert.strictEqual(row.default_driver_pay_type, 'flat');
    });

    await check('new loads copy the project Total Load Pay; an admin can override or clear it', async () => {
      await h.request(srv.port, ids.auth, { method: 'POST', path: '/loads', body: h.form({
        action: 'approve', load_date: '2026-11-10', ticket_number: 'COPY', project_id: ids.projectId, driver_id: ids.driverId, has_fuel_surcharge: '1'
      }) });
      assert.strictEqual(loadRow('COPY').total_load_pay, 1300.5);
      assert.strictEqual(loadRow('COPY').driver_flat_rate, 210);
      await h.request(srv.port, ids.auth, { method: 'POST', path: '/loads', body: h.form({
        action: 'approve', load_date: '2026-11-10', ticket_number: 'OVERRIDE', project_id: ids.projectId, driver_id: ids.driverId, total_load_pay: '1250.00'
      }) });
      assert.strictEqual(loadRow('OVERRIDE').total_load_pay, 1250);
      const id = loadRow('OVERRIDE').id;
      await h.request(srv.port, ids.auth, { method: 'POST', path: `/loads/${id}`, body: h.form({
        action: 'save', load_date: '2026-11-10', ticket_number: 'OVERRIDE', project_id: ids.projectId, driver_id: ids.driverId, total_load_pay: '1275.25'
      }) });
      assert.strictEqual(loadRow('OVERRIDE').total_load_pay, 1275.25);
      const page = await h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path: `/loads/${id}` });
      assert.ok(page.body.includes('name="total_load_pay"'));
      assert.ok(page.body.includes('data-total-load-pay="1300.5"'));
    });

    await check('weekly invoice uses Total Load Pay with no fuel surcharge; blank totals keep Qty x Rate', async () => {
      const page = await h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path: '/invoices' });
      assert.strictEqual(page.status, 200);
      const html = page.body;
      // COPY 1300.50 + OVERRIDE 1275.25 + BEFORE (qty 1 x rate 210 = 210, with FSC at 25.08% = 52.67)
      assert.ok(html.includes('in Total Load Pay'));
      assert.match(html, /Hauling<\/span><span>\$\s*2,?785\.75/);
      assert.match(html, /Fuel Surcharge \(25\.08%\)<\/span><span>\$\s*52\.67/);
    });

    await check('drivers cannot set Total Load Pay and never see it', async () => {
      await h.request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: h.cookieHeader(driver) }, { method: 'POST', path: '/loads', body: h.form({
        action: 'draft', load_date: '2026-11-11', ticket_number: 'DRV', project_id: ids.projectId, total_load_pay: '9999'
      }) });
      assert.strictEqual(loadRow('DRV').total_load_pay, 1300.5, 'copied from the project, not the driver post');
      const id = loadRow('DRV').id;
      await h.request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: h.cookieHeader(driver) }, { method: 'POST', path: `/loads/${id}`, body: h.form({
        action: 'draft', load_date: '2026-11-11', ticket_number: 'DRV', project_id: ids.projectId, total_load_pay: '1'
      }) });
      assert.strictEqual(loadRow('DRV').total_load_pay, 1300.5);
      for (const pathName of ['/loads', `/loads/${id}`, `/loads/${id}/edit`, '/loads/new']) {
        const page = await h.request(srv.port, { Cookie: h.cookieHeader(driver) }, { path: pathName });
        assert.strictEqual(page.status, 200, pathName);
        assert.ok(!page.body.includes('1300.5') && !page.body.includes('1,300.50'), pathName + ' leaks Total Load Pay');
        assert.ok(!page.body.includes('name="total_load_pay"'), pathName + ' shows the Total Load Pay input');
        assert.ok(!page.body.includes('data-total-load-pay="'), pathName + ' carries the project Total Load Pay');
        assert.ok(!page.body.replace(/<script[\s\S]*?<\/script>/g, '').includes('Total Load Pay (invoiced)'), pathName + ' shows the admin total line');
      }
    });
  } finally {
    await h.stop(srv.child);
  }
  console.log(`\n${results.length} project-total-load-pay checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
