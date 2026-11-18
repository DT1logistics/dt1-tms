// Receipt and file privacy: drivers see only their own receipts and cannot open
// another driver's receipt or load ticket, including by the old /uploads path.
// Admins see all. Receipts with no uploader are admin-only. Run: npm test
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers/server');

(async () => {
  const { check, results } = h.makeChecker();
  const adminPassword = 'Receipt-Privacy-Admin-1';
  const driverAPassword = 'Receipt-Privacy-Driver-A-1';
  const driverBPassword = 'Receipt-Privacy-Driver-B-1';
  const dataDir = h.tempDataDir('dt1-receipt-privacy-');
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  const srv = await h.startServer({
    DATA_DIR: dataDir,
    LOGAN_TMS_PASSWORD: adminPassword,
    LOGAN_API_TOKEN: '',
    SESSION_SECRET: 'receipt-privacy-test'
  });

  function auth(jar) {
    return { Cookie: h.cookieHeader(jar) };
  }

  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    const ids = await h.seedBasics(srv.port, dataDir, admin, { driverEmail: 'driver.a@example.com' });
    await h.request(srv.port, ids.auth, {
      method: 'POST',
      path: '/drivers',
      body: h.form({
        first_name: 'Bea', last_name: 'Driver', email: 'driver.b@example.com',
        phone: '5555550456', pay_percentage: '30'
      })
    });
    const driverBId = h.readRows(dataDir, "SELECT id FROM users WHERE email = ?", ['driver.b@example.com'])[0].id;
    h.setUserPassword(dataDir, 'driver.a@example.com', driverAPassword);
    h.setUserPassword(dataDir, 'driver.b@example.com', driverBPassword);
    const driverA = (await h.loginAs(srv.port, 'driver.a@example.com', driverAPassword)).jar;
    const driverB = (await h.loginAs(srv.port, 'driver.b@example.com', driverBPassword)).jar;
    assert.ok(h.cookieHeader(driverA), 'driver A logged in');
    assert.ok(h.cookieHeader(driverB), 'driver B logged in');

    fs.writeFileSync(path.join(uploadDir, 'a-receipt.jpg'), 'RECEIPT-A');
    fs.writeFileSync(path.join(uploadDir, 'b-receipt.jpg'), 'RECEIPT-B');
    fs.writeFileSync(path.join(uploadDir, 'orphan-receipt.jpg'), 'RECEIPT-ORPHAN');
    fs.writeFileSync(path.join(uploadDir, 'b-ticket.pdf'), 'TICKET-B');

    let receiptAId;
    let receiptBId;
    let orphanId;
    let loadBId;
    let ticketBId;
    h.writeDb(dataDir, (db) => {
      receiptAId = db.prepare(
        "INSERT INTO receipts (expense_date, uploaded_by, filename, original_name, status) VALUES ('2026-11-10', ?, 'a-receipt.jpg', 'alpha-receipt.jpg', 'pending')"
      ).run(ids.driverId).lastInsertRowid;
      receiptBId = db.prepare(
        "INSERT INTO receipts (expense_date, uploaded_by, filename, original_name, status) VALUES ('2026-11-11', ?, 'b-receipt.jpg', 'bravo-receipt.jpg', 'pending')"
      ).run(driverBId).lastInsertRowid;
      orphanId = db.prepare(
        "INSERT INTO receipts (expense_date, uploaded_by, filename, original_name, status) VALUES ('2026-11-12', NULL, 'orphan-receipt.jpg', 'orphan-receipt.jpg', 'pending')"
      ).run().lastInsertRowid;
      loadBId = db.prepare(
        "INSERT INTO loads (ticket_number, load_date, driver_id, project_id, weight_quantity, rate, status) VALUES ('T-B', '2026-11-10', ?, ?, 1, 10, 'submitted')"
      ).run(driverBId, ids.projectId).lastInsertRowid;
      ticketBId = db.prepare(
        "INSERT INTO documents (load_id, filename, original_name, category) VALUES (?, 'b-ticket.pdf', 'bravo-ticket.pdf', 'load_document')"
      ).run(loadBId).lastInsertRowid;
    });

    await check('a driver sees only their own receipts on /receipts, not another driver\'s or an unassigned receipt', async () => {
      const page = await h.request(srv.port, auth(driverA), { path: '/receipts' });
      assert.strictEqual(page.status, 200, page.body.slice(0, 200));
      assert.ok(page.body.includes('alpha-receipt.jpg'), 'own receipt listed');
      assert.ok(page.body.includes(`/receipts/${receiptAId}/file`), 'own file uses the checked route');
      assert.ok(!page.body.includes('bravo-receipt.jpg'), 'other driver receipt hidden');
      assert.ok(!page.body.includes('orphan-receipt.jpg'), 'no-uploader receipt hidden from driver');
      assert.ok(!page.body.includes(`/receipts/${receiptBId}/file`));
      assert.ok(!page.body.includes('/uploads/'), 'list does not link to /uploads');
    });

    await check('an admin sees every receipt on /receipts', async () => {
      const page = await h.request(srv.port, auth(admin), { path: '/receipts' });
      assert.strictEqual(page.status, 200, page.body.slice(0, 200));
      assert.ok(page.body.includes('alpha-receipt.jpg'));
      assert.ok(page.body.includes('bravo-receipt.jpg'));
      assert.ok(page.body.includes('orphan-receipt.jpg'));
      assert.ok(page.body.includes(`/receipts/${receiptAId}/file`));
      assert.ok(page.body.includes(`/receipts/${receiptBId}/file`));
      assert.ok(page.body.includes(`/receipts/${orphanId}/file`));
      assert.ok(!page.body.includes('/uploads/a-receipt') && !page.body.includes('/uploads/b-receipt'));
    });

    await check('the uploader can open their own receipt file on the new route', async () => {
      const file = await h.request(srv.port, auth(driverA), { path: `/receipts/${receiptAId}/file` });
      assert.strictEqual(file.status, 200, file.body.slice(0, 200));
      assert.ok(file.body.includes('RECEIPT-A'));
      const listed = await h.request(srv.port, auth(driverA), { path: `/uploads/a-receipt.jpg` });
      assert.strictEqual(listed.status, 200, listed.body.slice(0, 200));
      assert.ok(listed.body.includes('RECEIPT-A'));
    });

    await check('a driver gets 404 on another driver\'s receipt file (new route and /uploads)', async () => {
      const byId = await h.request(srv.port, auth(driverA), { path: `/receipts/${receiptBId}/file` });
      assert.strictEqual(byId.status, 404);
      assert.ok(byId.body.includes('Not found'));
      assert.ok(!byId.body.includes('RECEIPT-B'));
      const byUploads = await h.request(srv.port, auth(driverA), { path: '/uploads/b-receipt.jpg' });
      assert.strictEqual(byUploads.status, 404);
      assert.ok(byUploads.body.includes('Not found'));
      assert.ok(!byUploads.body.includes('RECEIPT-B'));
      const page = await h.request(srv.port, auth(driverA), { path: `/receipts/${receiptBId}` });
      assert.strictEqual(page.status, 404);
    });

    await check('a driver gets 404 on a receipt with no uploader; an admin can open it', async () => {
      const denied = await h.request(srv.port, auth(driverA), { path: `/receipts/${orphanId}/file` });
      assert.strictEqual(denied.status, 404);
      assert.ok(!denied.body.includes('RECEIPT-ORPHAN'));
      const uploadsDenied = await h.request(srv.port, auth(driverA), { path: '/uploads/orphan-receipt.jpg' });
      assert.strictEqual(uploadsDenied.status, 404);
      const allowed = await h.request(srv.port, auth(admin), { path: `/receipts/${orphanId}/file` });
      assert.strictEqual(allowed.status, 200);
      assert.ok(allowed.body.includes('RECEIPT-ORPHAN'));
    });

    await check('an admin can open any receipt file', async () => {
      const a = await h.request(srv.port, auth(admin), { path: `/receipts/${receiptAId}/file` });
      const b = await h.request(srv.port, auth(admin), { path: `/receipts/${receiptBId}/file` });
      assert.strictEqual(a.status, 200);
      assert.strictEqual(b.status, 200);
      assert.ok(a.body.includes('RECEIPT-A'));
      assert.ok(b.body.includes('RECEIPT-B'));
    });

    await check('a driver gets 404 on another driver\'s load ticket (official route and /uploads)', async () => {
      const official = await h.request(srv.port, auth(driverA), { path: `/loads/${loadBId}/files/${ticketBId}` });
      assert.strictEqual(official.status, 404);
      assert.ok(official.body.includes('Not found'));
      assert.ok(!official.body.includes('TICKET-B'));
      const byUploads = await h.request(srv.port, auth(driverA), { path: '/uploads/b-ticket.pdf' });
      assert.strictEqual(byUploads.status, 404);
      assert.ok(!byUploads.body.includes('TICKET-B'));
    });

    await check('the assigned driver and an admin can open that load ticket', async () => {
      const owner = await h.request(srv.port, auth(driverB), { path: `/loads/${loadBId}/files/${ticketBId}` });
      assert.strictEqual(owner.status, 200, owner.body.slice(0, 200));
      assert.ok(owner.body.includes('TICKET-B'));
      const adminFile = await h.request(srv.port, auth(admin), { path: `/loads/${loadBId}/files/${ticketBId}` });
      assert.strictEqual(adminFile.status, 200);
      assert.ok(adminFile.body.includes('TICKET-B'));
      const adminUploads = await h.request(srv.port, auth(admin), { path: '/uploads/b-ticket.pdf' });
      assert.strictEqual(adminUploads.status, 200);
      assert.ok(adminUploads.body.includes('TICKET-B'));
    });
  } finally {
    await h.stop(srv.child);
  }

  console.log(`ok - ${results.length} receipt privacy checks`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
