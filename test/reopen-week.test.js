// Reopen week: admin reopens a finalized driver week with a reason, unlocking
// its loads for admin editing, flagging generated invoices as Needs re-sending
// until regenerated with the same number, and showing a pay-change notice on
// re-finalize when driver pay differs. Run: npm test
const assert = require('assert');
const h = require('./helpers/server');

(async () => {
  const { check, results } = h.makeChecker();
  const adminPassword = 'Reopen-Week-Admin-1';
  const driverPassword = 'Reopen-Week-Driver-1';
  const otherPassword = 'Reopen-Week-Other-1';
  const dataDir = h.tempDataDir('dt1-reopen-week-');
  const srv = await h.startServer({
    DATA_DIR: dataDir,
    LOGAN_TMS_PASSWORD: adminPassword,
    LOGAN_API_TOKEN: '',
    SESSION_SECRET: 'reopen-week-test'
  });

  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    const ids = await h.seedBasics(srv.port, dataDir, admin, {
      customer: 'Acme Aggregates',
      project: 'North Pit',
      driverEmail: 'dana.reopen@example.com'
    });
    await h.request(srv.port, ids.auth, {
      method: 'POST',
      path: '/drivers',
      body: h.form({
        first_name: 'Olly', last_name: 'Other', email: 'olly.reopen@example.com',
        phone: '5555550199', pay_percentage: '25'
      })
    });
    const otherId = h.readRows(dataDir, "SELECT id FROM users WHERE email = 'olly.reopen@example.com'")[0].id;
    h.setUserPassword(dataDir, 'dana.reopen@example.com', driverPassword);
    h.setUserPassword(dataDir, 'olly.reopen@example.com', otherPassword);
    const driver = (await h.loginAs(srv.port, 'dana.reopen@example.com', driverPassword)).jar;
    const other = (await h.loginAs(srv.port, 'olly.reopen@example.com', otherPassword)).jar;

    const aGet = (path) => h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path });
    const dGet = (path) => h.request(srv.port, { Cookie: h.cookieHeader(driver) }, { path });
    const post = (path, fields) => h.request(srv.port, ids.auth, { method: 'POST', path, body: h.form(fields) });
    const dPost = (path, fields) => h.request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: h.cookieHeader(driver) }, {
      method: 'POST', path, body: h.form(fields)
    });

    await post('/loads', {
      action: 'approve', load_date: '2026-11-10', ticket_number: 'RW-1',
      project_id: ids.projectId, driver_id: ids.driverId, weight_quantity: '20', rate: '10',
      destination: 'Yard A'
    });
    await post('/loads', {
      action: 'approve', load_date: '2026-11-11', ticket_number: 'RW-2',
      project_id: ids.projectId, driver_id: otherId, weight_quantity: '10', rate: '10',
      destination: 'Yard B'
    });
    const loadId = h.readRows(dataDir, "SELECT id FROM loads WHERE ticket_number = 'RW-1'")[0].id;
    const otherLoadId = h.readRows(dataDir, "SELECT id FROM loads WHERE ticket_number = 'RW-2'")[0].id;

    // Generate invoice first ($200 + $100 = $300 -> DT1-2026-4012)
    const genRes = await post('/invoices/generate', {
      customer_id: ids.customerId, project_id: ids.projectId, week_start: '2026-11-09', include_tickets: '0'
    });
    assert.strictEqual(genRes.status, 302);
    const originalInv = h.readRows(dataDir, 'SELECT * FROM project_invoices WHERE project_id = ?', [ids.projectId])[0];
    assert.ok(originalInv && originalInv.invoice_number, 'invoice number allocated');
    const invoiceNum = originalInv.invoice_number;

    // Finalize both drivers via Finalize All
    const finRes = await post('/settlements/finalize-all', { week_start: '2026-11-09' });
    assert.strictEqual(finRes.status, 302);
    const initialLoadCount = h.readRows(dataDir, 'SELECT COUNT(*) AS n FROM loads')[0].n;
    const initialSettleCount = h.readRows(dataDir, 'SELECT COUNT(*) AS n FROM driver_settlements')[0].n;

    await check('reopen requires admin and a reason, and drivers never see the Reopen week form', async () => {
      const driverPage = await dGet('/settlements');
      assert.strictEqual(driverPage.status, 200);
      assert.ok(!driverPage.body.includes('/settlements/reopen-week'), 'no reopen action for driver');
      assert.ok(!driverPage.body.includes('>Reopen week</button>'), 'no reopen button for driver');
      assert.ok(driverPage.body.includes('Contractor Pay $60.00'));

      const driverAttempt = await dPost('/settlements/reopen-week', {
        driver_id: ids.driverId, week_start: '2026-11-09', reason: 'Driver trying'
      });
      assert.strictEqual(driverAttempt.status, 302);
      assert.strictEqual(
        h.readRows(dataDir, 'SELECT status FROM driver_settlements WHERE driver_id = ? AND week_start = ?', [ids.driverId, '2026-11-09'])[0].status,
        'approved'
      );

      const adminPage = await aGet('/settlements');
      assert.ok(adminPage.body.includes('action="/settlements/reopen-week"'));
      assert.ok(adminPage.body.includes('>Reopen week</button>'));

      const missingReason = await post('/settlements/reopen-week', {
        driver_id: ids.driverId, week_start: '2026-11-09', reason: '   '
      });
      assert.strictEqual(missingReason.status, 302);
      assert.ok(String(missingReason.headers.location || '').includes('error=reopen-reason'));
      const errPage = await aGet(missingReason.headers.location);
      assert.ok(errPage.body.includes('Enter a reason to reopen'));
      assert.strictEqual(
        h.readRows(dataDir, 'SELECT status FROM driver_settlements WHERE driver_id = ? AND week_start = ?', [ids.driverId, '2026-11-09'])[0].status,
        'approved'
      );
      assert.strictEqual(h.readRows(dataDir, 'SELECT settlement_status FROM loads WHERE id = ?', [loadId])[0].settlement_status, 'approved');
    });

    await check('reopening unlocks the driver-week loads, preserves history, keeps Delete blocked, and keeps driver pay hidden while reopened', async () => {
      const beforeApprovedAt = h.readRows(dataDir, 'SELECT approved_at, approved_by_name FROM driver_settlements WHERE driver_id = ?', [ids.driverId])[0];
      const res = await post('/settlements/reopen-week', {
        driver_id: ids.driverId, week_start: '2026-11-09', reason: 'Client corrected rate'
      });
      assert.strictEqual(res.status, 302);
      assert.ok(String(res.headers.location || '').includes('saved=reopened'));

      const row = h.readRows(dataDir, 'SELECT * FROM driver_settlements WHERE driver_id = ? AND week_start = ?', [ids.driverId, '2026-11-09'])[0];
      assert.strictEqual(row.status, 'reopened');
      assert.strictEqual(row.reopened_reason, 'Client corrected rate');
      assert.ok(row.reopened_at && row.reopened_by_name);
      assert.strictEqual(Number(row.prior_driver_pay), 60);
      assert.strictEqual(row.approved_at, beforeApprovedAt.approved_at, 'prior finalize timestamp kept');
      assert.strictEqual(row.approved_by_name, beforeApprovedAt.approved_by_name);

      // Unlocked for Dana, still locked for Olly
      assert.strictEqual(h.readRows(dataDir, 'SELECT status, settlement_status FROM loads WHERE id = ?', [loadId])[0].status, 'approved');
      assert.strictEqual(h.readRows(dataDir, 'SELECT settlement_status FROM loads WHERE id = ?', [loadId])[0].settlement_status, null);
      assert.strictEqual(h.readRows(dataDir, 'SELECT settlement_status FROM loads WHERE id = ?', [otherLoadId])[0].settlement_status, 'approved');

      // Audit log + load history recorded
      const settleAudit = h.readRows(dataDir, "SELECT detail FROM audit_log WHERE action = 'Reopened weekly settlement' AND entity_id = ?", [ids.driverId]);
      assert.strictEqual(settleAudit.length, 1);
      assert.ok(settleAudit[0].detail.includes('Client corrected rate'));
      const loadHistory = h.readRows(dataDir, "SELECT action, detail FROM audit_log WHERE entity_type = 'load' AND entity_id = ? AND action = 'Reopened'", [loadId]);
      assert.strictEqual(loadHistory.length, 1);
      assert.ok(loadHistory[0].detail.includes('Client corrected rate'));
      const detailPage = await aGet(`/loads/${loadId}`);
      assert.strictEqual(detailPage.status, 200);
      assert.ok(detailPage.body.includes('Client corrected rate'), 'reopen reason visible in load history');
      assert.ok(!detailPage.body.includes('>Delete Load</button>'), 'Delete Load remains blocked on Approved for Settlement');

      // Delete attempt blocked on server
      const delRes = await post(`/loads/${loadId}/delete`, {});
      assert.strictEqual(delRes.status, 302);
      assert.strictEqual(h.readRows(dataDir, 'SELECT COUNT(*) AS n FROM loads')[0].n, initialLoadCount);

      // Driver does not see unfinalized pay while reopened
      const driverSettlements = await dGet('/settlements');
      assert.ok(!driverSettlements.body.includes('Contractor Pay $60.00'));
      assert.strictEqual((await dGet('/settlements/pdf?week_start=2026-11-09')).status, 404);
    });

    await check('admin can edit the reopened load, invoice flags Needs re-sending and keeps the same number on regenerate', async () => {
      // Edit rate 10 -> 15 (load total 20*15=300, Dana pay 30% = $90.00, invoice total 300+100=$400.00)
      const editRes = await post(`/loads/${loadId}`, {
        action: 'save',
        load_date: '2026-11-10',
        ticket_number: 'RW-1',
        project_id: ids.projectId,
        driver_id: ids.driverId,
        weight_quantity: '20',
        rate: '15',
        destination: 'Yard A'
      });
      assert.strictEqual(editRes.status, 302);
      assert.ok(!String(editRes.headers.location || '').includes('saved=locked'), 'edit was allowed');
      const edited = h.readRows(dataDir, 'SELECT rate FROM loads WHERE id = ?', [loadId])[0];
      assert.strictEqual(Number(edited.rate), 15);

      const invPage = await aGet('/invoices');
      assert.strictEqual(invPage.status, 200);
      assert.ok(invPage.body.includes('Needs re-sending'), 'invoice shows Needs re-sending');
      assert.ok(invPage.body.includes(`Invoice # ${invoiceNum}`));
      assert.ok(invPage.body.includes('<span>TOTAL</span><span>$400.00</span>'), 'invoice recalculated from corrected load');

      const trackerPage = await aGet('/invoices?tab=tracker');
      assert.ok(trackerPage.body.includes('Needs re-sending'), 'tracker also shows Needs re-sending');

      // Regenerate invoice -> clears Needs re-sending, keeps exact same invoice number
      const regenRes = await post('/invoices/generate', {
        customer_id: ids.customerId, project_id: ids.projectId, week_start: '2026-11-09', include_tickets: '0'
      });
      assert.strictEqual(regenRes.status, 302);
      const afterInv = h.readRows(dataDir, 'SELECT * FROM project_invoices WHERE project_id = ?', [ids.projectId])[0];
      assert.strictEqual(afterInv.invoice_number, invoiceNum, 'same invoice number kept');
      assert.strictEqual(Number(afterInv.needs_resending), 0);
      assert.strictEqual(Number(afterInv.invoiced_amount), 400);
      const invAfter = await aGet('/invoices');
      assert.ok(!invAfter.body.includes('Needs re-sending'), 'Needs re-sending cleared after regenerate');
      assert.ok(invAfter.body.includes(`Invoice # ${invoiceNum}`));
    });

    await check('re-finalize relocks loads, shows pay-change notice when pay differs, and driver sees updated pay', async () => {
      const refinalRes = await post('/settlements/approve-week', {
        driver_id: ids.driverId, week_start: '2026-11-09'
      });
      assert.strictEqual(refinalRes.status, 302);
      assert.strictEqual(h.readRows(dataDir, 'SELECT settlement_status FROM loads WHERE id = ?', [loadId])[0].settlement_status, 'approved');
      assert.strictEqual(h.readRows(dataDir, 'SELECT status FROM driver_settlements WHERE driver_id = ? AND week_start = ?', [ids.driverId, '2026-11-09'])[0].status, 'approved');

      // Notice on redirect AND persistent on reload
      const noticePage = await aGet(refinalRes.headers.location);
      assert.ok(noticePage.body.includes('Contractor pay changed from $60.00 to $90.00 after reopen'));
      const reloadPage = await aGet('/settlements');
      assert.ok(reloadPage.body.includes('Contractor pay changed from $60.00 to $90.00 after reopen'));

      // Driver sees updated pay and PDF, and no other driver's settlement
      const driverPage = await dGet('/settlements');
      assert.ok(driverPage.body.includes('Contractor Pay $90.00'));
      assert.ok(!driverPage.body.includes('Olly Other'));
      const pdf = await dGet('/settlements/pdf?week_start=2026-11-09');
      assert.strictEqual(pdf.status, 200);
      assert.ok(pdf.body.includes('($90.00) Tj'));

      // Load is locked again against edits
      const lockedEdit = await post(`/loads/${loadId}`, {
        action: 'save', load_date: '2026-11-10', ticket_number: 'RW-1',
        project_id: ids.projectId, driver_id: ids.driverId, weight_quantity: '20', rate: '99'
      });
      assert.ok(String(lockedEdit.headers.location || '').includes('saved=locked'));
      assert.strictEqual(Number(h.readRows(dataDir, 'SELECT rate FROM loads WHERE id = ?', [loadId])[0].rate), 15);
    });

    await check('Finalize All also re-finalizes a reopened week and clears pay-change notice if pay did not change on a later reopen', async () => {
      const reopen2 = await post('/settlements/reopen-week', {
        driver_id: ids.driverId, week_start: '2026-11-09', reason: 'Fix destination text'
      });
      assert.strictEqual(reopen2.status, 302);
      assert.strictEqual(Number(h.readRows(dataDir, 'SELECT prior_driver_pay FROM driver_settlements WHERE driver_id = ?', [ids.driverId])[0].prior_driver_pay), 90);

      // Edit destination only, pay stays $90.00
      await post(`/loads/${loadId}`, {
        action: 'save', load_date: '2026-11-10', ticket_number: 'RW-1',
        project_id: ids.projectId, driver_id: ids.driverId, weight_quantity: '20', rate: '15',
        destination: 'Yard C'
      });
      // Invoice should be Needs re-sending again until regenerated
      assert.ok((await aGet('/invoices')).body.includes('Needs re-sending'));

      const faRes = await post('/settlements/finalize-all', { week_start: '2026-11-09' });
      assert.strictEqual(faRes.status, 302);
      const faPage = await aGet(faRes.headers.location);
      assert.ok(!faPage.body.includes('Contractor pay changed from'), 'no pay-change notice when pay stayed $90.00');
      assert.strictEqual(h.readRows(dataDir, 'SELECT settlement_status FROM loads WHERE id = ?', [loadId])[0].settlement_status, 'approved');
      assert.strictEqual(h.readRows(dataDir, 'SELECT status FROM driver_settlements WHERE driver_id = ? AND week_start = ?', [ids.driverId, '2026-11-09'])[0].status, 'approved');

      // No rows deleted
      assert.strictEqual(h.readRows(dataDir, 'SELECT COUNT(*) AS n FROM loads')[0].n, initialLoadCount);
      assert.strictEqual(h.readRows(dataDir, 'SELECT COUNT(*) AS n FROM driver_settlements')[0].n, initialSettleCount);
    });
  } finally {
    await h.stop(srv.child);
  }

  console.log('\n' + results.length + ' reopen-week checks passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
