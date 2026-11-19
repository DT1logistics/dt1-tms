// Fuel / Expense receipt types, weekly admin totals, approve-to-equipment,
// reject, and undo (void auto-created expenses only). Run: npm test
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers/server');
const receiptsLib = require('../lib/receipts');
const equipExpenses = require('../lib/equipment-expenses');

function multipart(fields, file) {
  const boundary = '----dt1FuelReceiptsBoundary';
  const chunks = [];
  Object.entries(fields).forEach(([name, value]) => {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ));
  });
  if (file) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type || 'image/jpeg'}\r\n\r\n`
    ));
    chunks.push(Buffer.from(file.body));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}` };
}

function auth(jar, extra) {
  return Object.assign({ Cookie: h.cookieHeader(jar) }, extra || {});
}

(async () => {
  const { check, results } = h.makeChecker();

  await check('receipt type labels treat missing values as Expense (untyped) and Fuel/Expense stay distinct', () => {
    assert.strictEqual(receiptsLib.receiptTypeLabel(null), 'Expense (untyped)');
    assert.strictEqual(receiptsLib.receiptTypeLabel(''), 'Expense (untyped)');
    assert.strictEqual(receiptsLib.receiptTypeLabel('expense'), 'Expense');
    assert.strictEqual(receiptsLib.receiptTypeLabel('FUEL'), 'Fuel');
    assert.strictEqual(receiptsLib.receiptTypeCategory(null), 'Expense');
    assert.strictEqual(receiptsLib.receiptTypeCategory('fuel'), 'Fuel');
    assert.deepStrictEqual(receiptsLib.parseUploadedReceiptType('fuel'), { value: 'fuel' });
    assert.ok(receiptsLib.parseUploadedReceiptType('').error);
    assert.strictEqual(equipExpenses.normalizeCategory('Fuel'), 'Fuel');
    assert.strictEqual(equipExpenses.normalizeCategory('Expense'), 'Expense');
  });

  await check('unit matching requires exactly one equipment match and never guesses', () => {
    const units = [
      { id: 1, type: 'truck', number: '1002' },
      { id: 2, type: 'truck', number: '1003' },
      { id: 3, type: 'truck', number: '1005' },
      { id: 4, type: 'trailer', number: '1005' }
    ];
    const hit = receiptsLib.matchReceiptLineToEquipment({ equipment_type: 'Truck #1002' }, units);
    assert.strictEqual(hit.kind, 'matched');
    assert.strictEqual(hit.equipment.id, 1);
    const general = receiptsLib.matchReceiptLineToEquipment({
      equipment_type: receiptsLib.GENERAL_RECEIPT_TAG
    }, units);
    assert.strictEqual(general.kind, 'general');
    const empty = receiptsLib.matchReceiptLineToEquipment({ equipment_type: '' }, units);
    assert.strictEqual(empty.kind, 'unmatched');
    const missing = receiptsLib.matchReceiptLineToEquipment({ equipment_type: 'Truck #9999' }, units);
    assert.strictEqual(missing.kind, 'unmatched');
    const many = receiptsLib.matchReceiptLineToEquipment({ equipment_type: 'Unit 1005' }, units);
    assert.strictEqual(many.kind, 'unmatched');
    assert.ok(/more than one/i.test(many.reason));
  });

  await check('weekly summary is Mon–Sun, totaled by type, driver, and unit, with untyped as Expense', () => {
    const weeks = receiptsLib.buildWeeklyReceiptSummary([
      {
        expense_date: '2026-11-16', receipt_type: 'fuel', status: 'pending',
        uploaded_by: 1, uploader_name: 'Dana Driver',
        lines: [{ equipment_type: 'Truck #1002', amount: 80, logged_equipment_type: 'truck', logged_equipment_number: '1002' }]
      },
      {
        expense_date: '2026-11-22', receipt_type: 'expense', status: 'approved',
        uploaded_by: 2, uploader_name: 'Bea Driver',
        lines: [{ equipment_type: 'Truck #1003', amount: 40, logged_equipment_type: 'truck', logged_equipment_number: '1003' }]
      },
      {
        expense_date: '2026-11-16', receipt_type: null, status: 'pending',
        uploaded_by: 1, uploader_name: 'Dana Driver',
        lines: [{ equipment_type: receiptsLib.GENERAL_RECEIPT_TAG, amount: 10, is_general: true }]
      },
      {
        expense_date: '2026-11-23', receipt_type: 'fuel', status: 'pending',
        uploaded_by: 1, uploader_name: 'Dana Driver',
        lines: [{ equipment_type: 'Truck #1002', amount: 5, logged_equipment_type: 'truck', logged_equipment_number: '1002' }]
      },
      {
        expense_date: '2026-11-17', receipt_type: 'fuel', status: 'rejected',
        uploaded_by: 2, uploader_name: 'Bea Driver',
        lines: [{ equipment_type: 'Truck #1003', amount: 999, logged_equipment_type: 'truck', logged_equipment_number: '1003' }]
      }
    ]);
    assert.strictEqual(weeks.length, 2);
    assert.strictEqual(weeks[0].start, '2026-11-23');
    assert.strictEqual(weeks[1].start, '2026-11-16');
    assert.strictEqual(weeks[1].end, '2026-11-22');
    assert.strictEqual(weeks[1].totals.fuel, 80);
    assert.strictEqual(weeks[1].totals.expense, 50);
    assert.strictEqual(weeks[1].totals.total, 130);
    const dana = weeks[1].drivers.find((row) => row.name === 'Dana Driver');
    const bea = weeks[1].drivers.find((row) => row.name === 'Bea Driver');
    assert.strictEqual(dana.totals.fuel, 80);
    assert.strictEqual(dana.totals.expense, 10);
    assert.strictEqual(bea.totals.expense, 40);
    const truck = weeks[1].units.find((row) => /1002/.test(row.name));
    const general = weeks[1].units.find((row) => /General/.test(row.name));
    assert.strictEqual(truck.totals.fuel, 80);
    assert.strictEqual(general.totals.expense, 10);
    assert.strictEqual(weeks[0].totals.fuel, 5);
  });

  const adminPassword = 'Fuel-Receipts-Admin-1';
  const driverAPassword = 'Fuel-Receipts-Driver-A-1';
  const driverBPassword = 'Fuel-Receipts-Driver-B-1';
  const dataDir = h.tempDataDir('dt1-fuel-receipts-');
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  const srv = await h.startServer({
    DATA_DIR: dataDir,
    LOGAN_TMS_PASSWORD: adminPassword,
    LOGAN_API_TOKEN: '',
    SESSION_SECRET: 'fuel-receipts-test'
  });

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
    const driverBId = h.readRows(dataDir, 'SELECT id FROM users WHERE email = ?', ['driver.b@example.com'])[0].id;
    h.setUserPassword(dataDir, 'driver.a@example.com', driverAPassword);
    h.setUserPassword(dataDir, 'driver.b@example.com', driverBPassword);
    const driverA = (await h.loginAs(srv.port, 'driver.a@example.com', driverAPassword)).jar;
    const driverB = (await h.loginAs(srv.port, 'driver.b@example.com', driverBPassword)).jar;
    const adminCookie = auth(admin);
    const driverACookie = auth(driverA);

    let truckA;
    let truckB;
    let fuelId;
    let expenseId;
    let untypedId;
    let unmatchedId;
    let mixedId;
    let ambiguousId;
    let twoLineId;
    let generalOnlyId;
    let manualKeepId;
    h.writeDb(dataDir, (db) => {
      truckA = db.prepare("INSERT INTO equipment (type, number, status) VALUES ('truck', '1002', 'active')").run().lastInsertRowid;
      truckB = db.prepare("INSERT INTO equipment (type, number, status) VALUES ('truck', '1003', 'active')").run().lastInsertRowid;
      db.prepare("INSERT INTO equipment (type, number, status) VALUES ('truck', '1005', 'active')").run();
      db.prepare("INSERT INTO equipment (type, number, status) VALUES ('trailer', '1005', 'active')").run();

      const insertReceipt = db.prepare(`
        INSERT INTO receipts (expense_date, uploaded_by, filename, original_name, status, receipt_type)
        VALUES (?, ?, ?, ?, 'pending', ?)
      `);
      const insertLine = db.prepare(`
        INSERT INTO receipt_lines (receipt_id, equipment_type, description, amount)
        VALUES (?, ?, ?, ?)
      `);

      fuelId = insertReceipt.run('2026-11-16', ids.driverId, null, 'fuel.jpg', 'fuel').lastInsertRowid;
      insertLine.run(fuelId, 'Truck #1002', 'Diesel fill', 80);

      expenseId = insertReceipt.run('2026-11-22', driverBId, null, 'expense.jpg', 'expense').lastInsertRowid;
      insertLine.run(expenseId, 'Truck #1003', 'Shop gloves', 40);

      untypedId = db.prepare(`
        INSERT INTO receipts (expense_date, uploaded_by, filename, original_name, status, receipt_type)
        VALUES ('2026-11-16', ?, NULL, 'old.jpg', 'pending', NULL)
      `).run(ids.driverId).lastInsertRowid;
      insertLine.run(untypedId, receiptsLib.GENERAL_RECEIPT_TAG, 'Paper towels', 10);

      unmatchedId = insertReceipt.run('2026-11-16', ids.driverId, null, 'mystery.jpg', 'expense').lastInsertRowid;
      insertLine.run(unmatchedId, 'Truck #9999', 'Unknown unit', 25);

      mixedId = insertReceipt.run('2026-11-16', ids.driverId, null, 'mixed.jpg', 'fuel').lastInsertRowid;
      insertLine.run(mixedId, 'Truck #1002', 'Matched gallons', 50);
      insertLine.run(mixedId, 'Truck #9999', 'Bad unit', 15);

      ambiguousId = insertReceipt.run('2026-11-16', ids.driverId, null, 'ambiguous.jpg', 'expense').lastInsertRowid;
      insertLine.run(ambiguousId, 'Unit 1005', 'Which one?', 12);

      twoLineId = insertReceipt.run('2026-11-16', ids.driverId, null, 'twoline.jpg', 'fuel').lastInsertRowid;
      insertLine.run(twoLineId, 'Truck #1002', 'Fill A', 20);
      insertLine.run(twoLineId, 'Truck #1002', 'Fill B', 30);

      generalOnlyId = insertReceipt.run('2026-11-16', ids.driverId, null, 'general.jpg', 'expense').lastInsertRowid;
      insertLine.run(generalOnlyId, receiptsLib.GENERAL_RECEIPT_TAG, 'Office supplies', 8);

      manualKeepId = insertReceipt.run('2026-11-16', ids.driverId, null, 'manual.jpg', 'fuel').lastInsertRowid;
      const manualLineId = insertLine.run(manualKeepId, 'Truck #1003', 'Manual line', 18).lastInsertRowid;
      db.prepare(`
        INSERT INTO equipment_expenses (equipment_id, expense_date, category, description, amount, source_receipt_id, source_receipt_line_id, created_via, status)
        VALUES (?, '2026-11-16', 'Repair', 'Already logged by hand', 18, ?, ?, 'manual', 'active')
      `).run(truckB, manualKeepId, manualLineId);
    });

    await check('new receipt form asks the driver to pick Fuel or Expense', async () => {
      const page = await h.request(srv.port, driverACookie, { path: '/receipts/new' });
      assert.strictEqual(page.status, 200, page.body.slice(0, 200));
      assert.ok(page.body.includes('name="receipt_type"') && page.body.includes('value="fuel"'), 'Fuel choice');
      assert.ok(page.body.includes('value="expense"'), 'Expense choice');
    });

    await check('upload stores the chosen type, and a missing type is rejected without writing a receipt', async () => {
      const good = multipart({
        receipt_type: 'fuel',
        expense_date: '2026-11-18',
        'lines[0][equipment_id]': 'other',
        'lines[0][equipment]': 'Truck #1002',
        'lines[0][description]': 'Uploaded fuel',
        'lines[0][amount]': '9.50'
      }, { field: 'receipt_file', name: 'upload-fuel.jpg', body: 'FUEL-BYTES' });
      const posted = await h.request(srv.port, auth(driverA, { 'Content-Type': good.type }), {
        method: 'POST', path: '/receipts', body: good.body
      });
      assert.strictEqual(posted.status, 302, posted.body.slice(0, 200));
      const stored = h.readRows(dataDir, "SELECT * FROM receipts WHERE original_name = 'upload-fuel.jpg'");
      assert.strictEqual(stored.length, 1);
      assert.strictEqual(stored[0].receipt_type, 'fuel');
      assert.strictEqual(Number(stored[0].uploaded_by), Number(ids.driverId));

      const before = h.readRows(dataDir, 'SELECT COUNT(*) AS n FROM receipts')[0].n;
      const bad = multipart({
        expense_date: '2026-11-18',
        'lines[0][equipment_id]': 'other',
        'lines[0][equipment]': 'Truck #1002',
        'lines[0][description]': 'No type',
        'lines[0][amount]': '1.00'
      }, { field: 'receipt_file', name: 'no-type.jpg', body: 'NO-TYPE' });
      const rejected = await h.request(srv.port, auth(driverA, { 'Content-Type': bad.type }), {
        method: 'POST', path: '/receipts', body: bad.body
      });
      assert.strictEqual(rejected.status, 400);
      assert.ok(/fuel or expense/i.test(rejected.body));
      const after = h.readRows(dataDir, 'SELECT COUNT(*) AS n FROM receipts')[0].n;
      assert.strictEqual(after, before);
    });

    await check('drivers see only their own receipts, including untyped as Expense (untyped), and not the weekly summary', async () => {
      const page = await h.request(srv.port, driverACookie, { path: '/receipts' });
      assert.strictEqual(page.status, 200, page.body.slice(0, 200));
      assert.ok(page.body.includes('fuel.jpg'), 'own fuel receipt');
      assert.ok(page.body.includes('Expense (untyped)'), 'untyped default label');
      assert.ok(!page.body.includes('expense.jpg'), 'other driver hidden');
      assert.ok(!page.body.includes('Weekly totals'), 'no admin weekly summary');
      const otherFile = await h.request(srv.port, driverACookie, { path: `/receipts/${expenseId}/file` });
      assert.strictEqual(otherFile.status, 404);
    });

    await check('admin weekly summary totals Fuel and Expense by driver and by truck for the Mon–Sun week', async () => {
      const page = await h.request(srv.port, adminCookie, { path: '/receipts' });
      assert.strictEqual(page.status, 200, page.body.slice(0, 200));
      assert.ok(page.body.includes('Weekly totals'), 'summary heading');
      assert.ok(/Week of November 16/.test(page.body) && /November 22/.test(page.body), 'Mon–Sun range');
      assert.ok(page.body.includes('Dana Driver'), 'by driver');
      assert.ok(page.body.includes('Bea Driver'), 'second driver');
      assert.ok(/#1002/.test(page.body), 'by unit');
      assert.ok(page.body.includes('$80.00'), 'fuel amount');
      assert.ok(page.body.includes('$40.00'), 'expense amount');
      assert.ok(page.body.includes('Expense (untyped)'), 'existing untyped receipt displayed');
    });

    await check('approve posts one equipment expense per matched unit line, skips general, and is idempotent', async () => {
      const first = await h.request(srv.port, adminCookie, { method: 'POST', path: `/receipts/${fuelId}/approve` });
      assert.strictEqual(first.status, 302, first.body.slice(0, 200));
      assert.ok(String(first.headers.location || '').includes('notice='));
      const expenses = h.readRows(dataDir, 'SELECT * FROM equipment_expenses WHERE source_receipt_id = ? ORDER BY id', [fuelId]);
      assert.strictEqual(expenses.length, 1);
      assert.strictEqual(Number(expenses[0].equipment_id), Number(truckA));
      assert.strictEqual(expenses[0].category, 'Fuel');
      assert.strictEqual(Number(expenses[0].amount), 80);
      assert.strictEqual(expenses[0].created_via, 'receipt_approval');
      assert.strictEqual(expenses[0].status, 'active');
      const receipt = h.readRows(dataDir, 'SELECT status, flag FROM receipts WHERE id = ?', [fuelId])[0];
      assert.strictEqual(receipt.status, 'approved');
      assert.ok(!receipt.flag);

      const second = await h.request(srv.port, adminCookie, { method: 'POST', path: `/receipts/${fuelId}/approve` });
      assert.strictEqual(second.status, 302);
      const again = h.readRows(dataDir, 'SELECT * FROM equipment_expenses WHERE source_receipt_id = ?', [fuelId]);
      assert.strictEqual(again.length, 1);

      const two = await h.request(srv.port, adminCookie, { method: 'POST', path: `/receipts/${twoLineId}/approve` });
      assert.strictEqual(two.status, 302);
      const twoRows = h.readRows(dataDir, 'SELECT * FROM equipment_expenses WHERE source_receipt_id = ? ORDER BY id', [twoLineId]);
      assert.strictEqual(twoRows.length, 2);
      assert.deepStrictEqual(twoRows.map((row) => Number(row.amount)).sort((a, b) => a - b), [20, 30]);
      twoRows.forEach((row) => assert.strictEqual(Number(row.equipment_id), Number(truckA)));

      const general = await h.request(srv.port, adminCookie, { method: 'POST', path: `/receipts/${generalOnlyId}/approve` });
      assert.strictEqual(general.status, 302);
      const generalRows = h.readRows(dataDir, 'SELECT * FROM equipment_expenses WHERE source_receipt_id = ?', [generalOnlyId]);
      assert.strictEqual(generalRows.length, 0);
      assert.strictEqual(h.readRows(dataDir, 'SELECT status FROM receipts WHERE id = ?', [generalOnlyId])[0].status, 'approved');
    });

    await check('unmatched or ambiguous unit lines flag the receipt, leave it pending, and create no expenses', async () => {
      const unmatched = await h.request(srv.port, adminCookie, { method: 'POST', path: `/receipts/${unmatchedId}/approve` });
      assert.strictEqual(unmatched.status, 302);
      assert.ok(/log_error=/.test(String(unmatched.headers.location || '')));
      const uRow = h.readRows(dataDir, 'SELECT status, flag FROM receipts WHERE id = ?', [unmatchedId])[0];
      assert.strictEqual(uRow.status, 'pending');
      assert.ok(uRow.flag && /9999/.test(uRow.flag));
      assert.strictEqual(h.readRows(dataDir, 'SELECT * FROM equipment_expenses WHERE source_receipt_id = ?', [unmatchedId]).length, 0);

      const mixed = await h.request(srv.port, adminCookie, { method: 'POST', path: `/receipts/${mixedId}/approve` });
      assert.strictEqual(mixed.status, 302);
      const mRow = h.readRows(dataDir, 'SELECT status, flag FROM receipts WHERE id = ?', [mixedId])[0];
      assert.strictEqual(mRow.status, 'pending');
      assert.ok(mRow.flag);
      assert.strictEqual(h.readRows(dataDir, 'SELECT * FROM equipment_expenses WHERE source_receipt_id = ?', [mixedId]).length, 0);

      const amb = await h.request(srv.port, adminCookie, { method: 'POST', path: `/receipts/${ambiguousId}/approve` });
      assert.strictEqual(amb.status, 302);
      const aRow = h.readRows(dataDir, 'SELECT status, flag FROM receipts WHERE id = ?', [ambiguousId])[0];
      assert.strictEqual(aRow.status, 'pending');
      assert.ok(/more than one/i.test(aRow.flag || ''));
      assert.strictEqual(h.readRows(dataDir, 'SELECT * FROM equipment_expenses WHERE source_receipt_id = ?', [ambiguousId]).length, 0);
    });

    await check('reject records a reason and creates no expenses; undo voids auto-created expenses only and re-approve is idempotent', async () => {
      const rejected = await h.request(srv.port, auth(admin, { 'Content-Type': 'application/x-www-form-urlencoded' }), {
        method: 'POST',
        path: `/receipts/${expenseId}/reject`,
        body: h.form({ rejection_reason: 'Not a valid shop receipt' })
      });
      assert.strictEqual(rejected.status, 302, rejected.body.slice(0, 200));
      const rRow = h.readRows(dataDir, 'SELECT status, rejection_reason FROM receipts WHERE id = ?', [expenseId])[0];
      assert.strictEqual(rRow.status, 'rejected');
      assert.strictEqual(rRow.rejection_reason, 'Not a valid shop receipt');
      assert.strictEqual(h.readRows(dataDir, 'SELECT * FROM equipment_expenses WHERE source_receipt_id = ?', [expenseId]).length, 0);
      const rejectPage = await h.request(srv.port, adminCookie, { path: '/receipts' });
      assert.ok(rejectPage.body.includes('Not a valid shop receipt'));
      assert.ok(!rejectPage.body.includes('$999.00'));

      const beforeManual = h.readRows(dataDir, 'SELECT * FROM equipment_expenses WHERE source_receipt_id = ?', [manualKeepId]);
      assert.strictEqual(beforeManual.length, 1);
      assert.strictEqual(beforeManual[0].status, 'active');
      assert.strictEqual(beforeManual[0].created_via, 'manual');

      const approvedManual = await h.request(srv.port, adminCookie, { method: 'POST', path: `/receipts/${manualKeepId}/approve` });
      assert.strictEqual(approvedManual.status, 302);
      const afterApprove = h.readRows(dataDir, 'SELECT * FROM equipment_expenses WHERE source_receipt_id = ? ORDER BY id', [manualKeepId]);
      assert.strictEqual(afterApprove.length, 1, 'manual row reused; no duplicate');
      assert.strictEqual(afterApprove[0].created_via, 'manual');
      assert.strictEqual(afterApprove[0].status, 'active');
      assert.strictEqual(h.readRows(dataDir, 'SELECT status FROM receipts WHERE id = ?', [manualKeepId])[0].status, 'approved');

      const autoBeforeUndo = h.readRows(dataDir, 'SELECT id, status FROM equipment_expenses WHERE source_receipt_id = ?', [fuelId]);
      assert.strictEqual(autoBeforeUndo.length, 1);
      const undone = await h.request(srv.port, adminCookie, { method: 'POST', path: `/receipts/${fuelId}/undo` });
      assert.strictEqual(undone.status, 302);
      const fuelReceipt = h.readRows(dataDir, 'SELECT status FROM receipts WHERE id = ?', [fuelId])[0];
      assert.strictEqual(fuelReceipt.status, 'pending');
      const voided = h.readRows(dataDir, 'SELECT * FROM equipment_expenses WHERE source_receipt_id = ?', [fuelId]);
      assert.strictEqual(voided.length, 1);
      assert.strictEqual(voided[0].status, 'voided');
      assert.ok(voided[0].voided_at);
      const stillManual = h.readRows(dataDir, 'SELECT * FROM equipment_expenses WHERE source_receipt_id = ?', [manualKeepId])[0];
      assert.strictEqual(stillManual.status, 'active');
      assert.strictEqual(stillManual.description, 'Already logged by hand');

      const reapprove = await h.request(srv.port, adminCookie, { method: 'POST', path: `/receipts/${fuelId}/approve` });
      assert.strictEqual(reapprove.status, 302);
      const restored = h.readRows(dataDir, 'SELECT * FROM equipment_expenses WHERE source_receipt_id = ?', [fuelId]);
      assert.strictEqual(restored.length, 1);
      assert.strictEqual(restored[0].status, 'active');
      assert.strictEqual(Number(restored[0].id), Number(voided[0].id));
      assert.strictEqual(h.readRows(dataDir, 'SELECT status FROM receipts WHERE id = ?', [fuelId])[0].status, 'approved');
    });

    await check('drivers cannot approve, reject, or undo, and Fuel log plus diesel-rate pages stay available', async () => {
      const approve = await h.request(srv.port, driverACookie, { method: 'POST', path: `/receipts/${untypedId}/approve` });
      assert.strictEqual(approve.status, 404);
      const reject = await h.request(srv.port, auth(driverA, { 'Content-Type': 'application/x-www-form-urlencoded' }), {
        method: 'POST', path: `/receipts/${untypedId}/reject`, body: h.form({ rejection_reason: 'nope' })
      });
      assert.strictEqual(reject.status, 404);
      const undo = await h.request(srv.port, driverACookie, { method: 'POST', path: `/receipts/${fuelId}/undo` });
      assert.strictEqual(undo.status, 404);
      assert.strictEqual(h.readRows(dataDir, 'SELECT status FROM receipts WHERE id = ?', [untypedId])[0].status, 'pending');
      assert.strictEqual(h.readRows(dataDir, 'SELECT status FROM receipts WHERE id = ?', [fuelId])[0].status, 'approved');

      const fuel = await h.request(srv.port, adminCookie, { path: '/fuel' });
      assert.strictEqual(fuel.status, 200, fuel.body.slice(0, 200));
      const rate = await h.request(srv.port, adminCookie, { path: '/fuel-rate' });
      assert.strictEqual(rate.status, 200, rate.body.slice(0, 200));
      assert.ok(/diesel|fuel rate|central atlantic/i.test(rate.body), 'diesel rate entry still present');
    });
  } finally {
    await h.stop(srv.child);
  }

  console.log('\n' + results.length + ' checks passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
