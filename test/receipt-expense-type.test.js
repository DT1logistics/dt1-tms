// Per-line expense type (Fuel, Parts, Maintenance, Other) on receipt uploads.
// Run: npm test
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers/server');
const receiptsLib = require('../lib/receipts');

function multipart(fields, file) {
  const boundary = '----dt1ExpenseTypeBoundary';
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

function lineFields(overrides) {
  return Object.assign({
    receipt_type: 'expense',
    expense_date: '2026-11-18',
    'lines[0][equipment_id]': 'other',
    'lines[0][equipment]': 'Truck #1002',
    'lines[0][expense_type]': 'Parts',
    'lines[0][description]': 'Filter kit',
    'lines[0][amount]': '42.00'
  }, overrides);
}

(async () => {
  const { check, results } = h.makeChecker();

  await check('line expense type accepts Fuel, Parts, Maintenance, or Other and falls back for NULL', () => {
    assert.deepStrictEqual(receiptsLib.parseLineExpenseType('Fuel'), { value: 'Fuel' });
    assert.deepStrictEqual(receiptsLib.parseLineExpenseType('parts'), { value: 'Parts' });
    assert.deepStrictEqual(receiptsLib.parseLineExpenseType('Maintenance'), { value: 'Maintenance' });
    assert.deepStrictEqual(receiptsLib.parseLineExpenseType('Other'), { value: 'Other' });
    assert.ok(receiptsLib.parseLineExpenseType('').error);
    assert.ok(receiptsLib.parseLineExpenseType('Repair').error);
    assert.strictEqual(receiptsLib.parseLineExpenseType('', { required: false }).value, null);
    assert.strictEqual(receiptsLib.expenseCategoryForLine({ expense_type: 'Parts' }, { receipt_type: 'fuel' }), 'Parts');
    assert.strictEqual(receiptsLib.expenseCategoryForLine({ expense_type: null }, { receipt_type: 'fuel' }), 'Fuel');
    assert.strictEqual(receiptsLib.expenseCategoryForLine({ expense_type: null }, { receipt_type: 'expense' }), 'Expense');
    assert.strictEqual(receiptsLib.expenseCategoryForLine({}, { receipt_type: null }), 'Expense');
  });

  const adminPassword = 'Expense-Type-Admin-1';
  const driverAPassword = 'Expense-Type-Driver-A-1';
  const driverBPassword = 'Expense-Type-Driver-B-1';
  const dataDir = h.tempDataDir('dt1-expense-type-');
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  const srv = await h.startServer({
    DATA_DIR: dataDir,
    LOGAN_TMS_PASSWORD: adminPassword,
    LOGAN_API_TOKEN: '',
    SESSION_SECRET: 'expense-type-test'
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
    h.setUserPassword(dataDir, 'driver.a@example.com', driverAPassword);
    h.setUserPassword(dataDir, 'driver.b@example.com', driverBPassword);
    const driverA = (await h.loginAs(srv.port, 'driver.a@example.com', driverAPassword)).jar;
    const driverB = (await h.loginAs(srv.port, 'driver.b@example.com', driverBPassword)).jar;
    const adminCookie = auth(admin);
    const driverACookie = auth(driverA);
    const driverBCookie = auth(driverB);

    let truckA;
    h.writeDb(dataDir, (db) => {
      truckA = db.prepare("INSERT INTO equipment (type, number, status) VALUES ('truck', '1002', 'active')").run().lastInsertRowid;
    });

    await check('new receipt form has a required Expense type dropdown on the first line and on addLine()', async () => {
      const page = await h.request(srv.port, driverACookie, { path: '/receipts/new' });
      assert.strictEqual(page.status, 200, page.body.slice(0, 200));
      assert.ok(page.body.includes('name="receipt_type"') && page.body.includes('value="fuel"'), 'receipt_type radios kept');
      assert.ok(page.body.includes('value="expense"'), 'Expense receipt type kept');
      assert.ok(/<label>\s*Expense type\s*<\/label>/.test(page.body), 'Expense type label');
      assert.ok(page.body.includes('name="lines[0][expense_type]"'), 'first line field name');
      assert.ok(page.body.includes('Select a type…'), 'placeholder');
      ['Fuel', 'Parts', 'Maintenance', 'Other'].forEach((type) => {
        assert.ok(page.body.includes(`value="${type}"`), type + ' option');
      });
      assert.ok(page.body.includes('name="lines[${lineCount}][expense_type]"'), 'addLine includes expense type');
    });

    await check('new uploads require a valid line expense type and reject missing or invalid values', async () => {
      const before = h.readRows(dataDir, 'SELECT COUNT(*) AS n FROM receipts')[0].n;
      const missing = multipart(lineFields({ 'lines[0][expense_type]': '', 'lines[0][description]': 'No expense type' }), {
        field: 'receipt_file', name: 'missing-type.jpg', body: 'MISSING'
      });
      const missingRes = await h.request(srv.port, auth(driverA, { 'Content-Type': missing.type }), {
        method: 'POST', path: '/receipts', body: missing.body
      });
      assert.strictEqual(missingRes.status, 400);
      assert.ok(/expense type/i.test(missingRes.body), missingRes.body.slice(0, 300));

      const invalid = multipart(lineFields({ 'lines[0][expense_type]': 'Repair', 'lines[0][description]': 'Bad type' }), {
        field: 'receipt_file', name: 'bad-type.jpg', body: 'BAD'
      });
      const invalidRes = await h.request(srv.port, auth(driverA, { 'Content-Type': invalid.type }), {
        method: 'POST', path: '/receipts', body: invalid.body
      });
      assert.strictEqual(invalidRes.status, 400);
      assert.ok(/Fuel, Parts, Maintenance, or Other/i.test(invalidRes.body), invalidRes.body.slice(0, 300));
      const after = h.readRows(dataDir, 'SELECT COUNT(*) AS n FROM receipts')[0].n;
      assert.strictEqual(after, before);
    });

    await check('a saved expense type persists and is shown on the driver and admin receipt views only', async () => {
      const posted = multipart(lineFields(), {
        field: 'receipt_file', name: 'parts-filter.jpg', body: 'PARTS'
      });
      const res = await h.request(srv.port, auth(driverA, { 'Content-Type': posted.type }), {
        method: 'POST', path: '/receipts', body: posted.body
      });
      assert.strictEqual(res.status, 302, res.body.slice(0, 200));
      const stored = h.readRows(dataDir, "SELECT r.id, rl.expense_type, rl.description FROM receipts r JOIN receipt_lines rl ON rl.receipt_id = r.id WHERE r.original_name = 'parts-filter.jpg'");
      assert.strictEqual(stored.length, 1);
      assert.strictEqual(stored[0].expense_type, 'Parts');
      assert.strictEqual(stored[0].description, 'Filter kit');

      const driverPage = await h.request(srv.port, driverACookie, { path: '/receipts' });
      assert.strictEqual(driverPage.status, 200, driverPage.body.slice(0, 200));
      assert.ok(driverPage.body.includes('Filter kit'), 'own line visible');
      assert.ok(driverPage.body.includes('Parts'), 'expense type visible to uploader');
      const other = await h.request(srv.port, driverBCookie, { path: '/receipts' });
      assert.strictEqual(other.status, 200);
      assert.ok(!other.body.includes('parts-filter.jpg'), 'other driver does not see the receipt file');
      assert.ok(!other.body.includes('Filter kit'), 'other driver does not see the line');
      const adminPage = await h.request(srv.port, adminCookie, { path: '/receipts' });
      assert.strictEqual(adminPage.status, 200);
      assert.ok(adminPage.body.includes('Filter kit') && adminPage.body.includes('Parts'), 'admin sees the line type');
    });

    await check('approval uses the line expense type as the equipment category, and NULL lines fall back to receipt type', async () => {
      const partsId = h.readRows(dataDir, "SELECT id FROM receipts WHERE original_name = 'parts-filter.jpg'")[0].id;
      const approved = await h.request(srv.port, adminCookie, { method: 'POST', path: `/receipts/${partsId}/approve` });
      assert.strictEqual(approved.status, 302, approved.body.slice(0, 200));
      const partsExpense = h.readRows(dataDir, 'SELECT * FROM equipment_expenses WHERE source_receipt_id = ?', [partsId]);
      assert.strictEqual(partsExpense.length, 1);
      assert.strictEqual(partsExpense[0].category, 'Parts');
      assert.strictEqual(Number(partsExpense[0].equipment_id), Number(truckA));
      assert.strictEqual(Number(partsExpense[0].amount), 42);

      let legacyId;
      h.writeDb(dataDir, (db) => {
        legacyId = db.prepare(`
          INSERT INTO receipts (expense_date, uploaded_by, filename, original_name, status, receipt_type)
          VALUES ('2026-11-16', ?, NULL, 'legacy-fuel.jpg', 'pending', 'fuel')
        `).run(ids.driverId).lastInsertRowid;
        db.prepare(`
          INSERT INTO receipt_lines (receipt_id, equipment_type, description, amount, expense_type)
          VALUES (?, 'Truck #1002', 'Old diesel fill', 80, NULL)
        `).run(legacyId);
      });
      const legacyApprove = await h.request(srv.port, adminCookie, { method: 'POST', path: `/receipts/${legacyId}/approve` });
      assert.strictEqual(legacyApprove.status, 302, legacyApprove.body.slice(0, 200));
      const legacyExpense = h.readRows(dataDir, 'SELECT * FROM equipment_expenses WHERE source_receipt_id = ?', [legacyId]);
      assert.strictEqual(legacyExpense.length, 1);
      assert.strictEqual(legacyExpense[0].category, 'Fuel');
      assert.strictEqual(Number(legacyExpense[0].amount), 80);
      const legacyLine = h.readRows(dataDir, 'SELECT expense_type FROM receipt_lines WHERE receipt_id = ?', [legacyId])[0];
      assert.strictEqual(legacyLine.expense_type, null);
    });
  } finally {
    await h.stop(srv.child);
  }

  console.log('\n' + results.length + ' checks passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
