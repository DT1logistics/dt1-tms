// Item 12 (11/16/2026): official customer invoices from the Invoices screen.
// Layout, numbering (including the January 1 reset), billing rules, ticket order,
// and a guarantee that existing load rows are not changed.
// Run: node test/customer-invoice.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const h = require('./helpers/server');
const invoiceNumber = require('../lib/invoice-number');
const customerInvoice = require('../lib/customer-invoice');
const customerInvoicePdf = require('../lib/customer-invoice-pdf');

// 1x1 red JPEG, so ticket-attachment tests do not need a fixture file.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGdAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/AL//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AL//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AL//2Q==',
  'base64'
);

function openTempDb() {
  const dataDir = h.tempDataDir('dt1-invoice-unit-');
  const db = new Database(path.join(dataDir, 'dt1.db'));
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY, customer_id INTEGER, project_name TEXT, display_name TEXT,
      default_rate REAL, invoice_min_qty REAL, invoice_billing_mode TEXT, invoice_billing_seeded INTEGER
    );
    CREATE TABLE loads (
      id INTEGER PRIMARY KEY, ticket_number TEXT, load_date DATE, project_id INTEGER, driver_id INTEGER,
      weight_quantity REAL, rate REAL, has_fuel_surcharge INTEGER, has_drive_time INTEGER, drive_time_amount REAL,
      has_self_load INTEGER, self_load_amount REAL, shipper_detention INTEGER, shipper_detention_amount REAL,
      driver_pay_type TEXT, driver_flat_rate REAL, total_load_pay REAL, destination TEXT, description TEXT,
      status TEXT, load_number TEXT
    );
    CREATE TABLE invoice_weeks (
      id INTEGER PRIMARY KEY, customer_id INTEGER, week_start DATE, week_end DATE,
      invoiced_at DATETIME, invoiced_by INTEGER, invoiced_by_name TEXT, invoiced_amount REAL,
      paid_at DATETIME, paid_by INTEGER, paid_by_name TEXT
    );
    CREATE TABLE invoice_tracker (
      id INTEGER PRIMARY KEY, customer_id INTEGER, project_id INTEGER, week_start DATE,
      amount_received REAL, UNIQUE(customer_id, project_id, week_start)
    );
  `);
  return { dataDir, db };
}

function requestRaw(port, headers, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const body = o.body == null ? null : Buffer.from(o.body);
    const reqHeaders = Object.assign({}, headers || {});
    if (body && !reqHeaders['Content-Length'] && !reqHeaders['content-length']) reqHeaders['Content-Length'] = body.length;
    const req = http.request({
      host: '127.0.0.1', port, method: o.method || 'GET', path: o.path || '/', headers: reqHeaders
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body || undefined);
  });
}

function pdfText(buffer) {
  const raw = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer);
  // SimplePdf escapes "(", ")", and "\" in text strings.
  return raw.replace(/\\([()\\])/g, '$1');
}

(async () => {
  const { check, results } = h.makeChecker();

  await check('invoice numbers: 2026 continues at 4012 and never reuses a number', () => {
    const { db } = openTempDb();
    customerInvoice.ensureSchema(db);
    const first = invoiceNumber.allocateInvoiceNumber(db, { clock: new Date('2026-11-16T18:00:00Z') });
    const second = invoiceNumber.allocateInvoiceNumber(db, { clock: new Date('2026-11-16T18:01:00Z') });
    assert.deepStrictEqual(first, { year: 2026, seq: 4012, number: 'DT1-2026-4012' });
    assert.deepStrictEqual(second, { year: 2026, seq: 4013, number: 'DT1-2026-4013' });
    assert.strictEqual(invoiceNumber.invoiceFileName(first.number, 'West Rock'), 'DT1-2026-4012 - West Rock.pdf');
    db.close();
  });

  await check('invoice numbers reset to DT1-2027-0001 at 12:00 AM Eastern on January 1', () => {
    const { db } = openTempDb();
    customerInvoice.ensureSchema(db);
    // 2026-12-31 23:59 EST = 2027-01-01T04:59:00Z (EST is UTC-5)
    const still2026 = invoiceNumber.allocateInvoiceNumber(db, { clock: new Date('2027-01-01T04:59:00Z') });
    assert.strictEqual(still2026.number, 'DT1-2026-4012');
    const first2027 = invoiceNumber.allocateInvoiceNumber(db, { clock: new Date('2027-01-01T05:00:00Z') });
    assert.deepStrictEqual(first2027, { year: 2027, seq: 1, number: 'DT1-2027-0001' });
    const second2027 = invoiceNumber.allocateInvoiceNumber(db, { clock: new Date('2027-01-01T05:01:00Z') });
    assert.strictEqual(second2027.number, 'DT1-2027-0002');
    db.close();
  });

  await check('King George-style minimum bills max(actual, min qty) and applies FSC to the billed tons', () => {
    const history = [{ id: 1, effective_date: '2026-10-26', central_atlantic_rate: 6.496 }];
    const load = {
      load_date: '2026-10-29', weight_quantity: 20, rate: 7, has_fuel_surcharge: 1,
      invoice_min_qty: 24, invoice_billing_mode: 'actual', destination: 'Mooseneck'
    };
    const line = customerInvoice.invoiceLineAmounts(load, history);
    assert.strictEqual(line.billed.qty, 24);
    assert.ok(line.billed.minApplied);
    assert.strictEqual(line.hauling, 168); // 24 x 7
    assert.strictEqual(line.description, 'Haul to Mooseneck');
    const expectedFsc = require('../lib/fuel-surcharge').loadFuelSurcharge({
      percent: require('../lib/fuel-surcharge').fscPercent(6.496), rate: 7, tons: 24
    }).total;
    assert.strictEqual(line.lineFsc, expectedFsc);
    assert.strictEqual(line.price, customerInvoice.roundMoney(168 + expectedFsc));
    // An actual 26-ton load is not raised.
    const over = customerInvoice.invoiceLineAmounts(Object.assign({}, load, { weight_quantity: 26.34 }), history);
    assert.strictEqual(over.billed.qty, 26.34);
    assert.ok(!over.billed.minApplied);
    assert.strictEqual(over.hauling, customerInvoice.roundMoney(26.34 * 7));
  });

  await check('flat-qty-1 billing uses qty 1 at the project default rate, ignoring the load tons', () => {
    const load = {
      load_date: '2026-11-09', weight_quantity: 10, rate: 99, has_fuel_surcharge: 0,
      invoice_billing_mode: 'flat_qty_1', project_default_rate: 450, destination: 'New Bern'
    };
    const line = customerInvoice.invoiceLineAmounts(load, []);
    assert.strictEqual(line.billed.qty, 1);
    assert.strictEqual(line.billed.rate, 450);
    assert.strictEqual(line.hauling, 450);
    assert.strictEqual(line.lineFsc, 0);
    assert.strictEqual(line.price, 450);
    assert.strictEqual(line.description, 'Haul to New Bern');
  });

  await check('Price = Qty x Rate + Fuel + Self Load + Travel Time, and totals match the line sums', () => {
    const history = [{ id: 1, effective_date: '2026-11-02', central_atlantic_rate: 6.486 }];
    const loads = [
      { load_date: '2026-11-02', weight_quantity: 25.85, rate: 9.26, has_fuel_surcharge: 1, destination: 'Gloucester' },
      { load_date: '2026-11-02', weight_quantity: 24.08, rate: 9.26, has_fuel_surcharge: 1, has_self_load: 1, self_load_amount: 20, has_drive_time: 1, drive_time_amount: 15, destination: 'Gloucester' }
    ];
    const totals = customerInvoice.emptyTotals();
    const lines = loads.map((load) => {
      const line = customerInvoice.invoiceLineAmounts(load, history);
      customerInvoice.addLineToTotals(totals, line);
      const expected = customerInvoice.roundMoney(line.hauling + line.lineFsc + line.selfLoad + line.travelTime);
      assert.strictEqual(line.price, expected);
      return line;
    });
    customerInvoice.finishTotals(totals);
    const sumHauling = customerInvoice.roundMoney(lines.reduce((s, l) => s + l.hauling, 0));
    const sumFuel = customerInvoice.roundMoney(lines.reduce((s, l) => s + l.lineFsc, 0));
    const sumSelf = customerInvoice.roundMoney(lines.reduce((s, l) => s + l.selfLoad, 0));
    const sumTravel = customerInvoice.roundMoney(lines.reduce((s, l) => s + l.travelTime, 0));
    const sumPrice = customerInvoice.roundMoney(lines.reduce((s, l) => s + l.price, 0));
    assert.strictEqual(totals.hauling, sumHauling);
    assert.strictEqual(totals.fuelSurcharge, sumFuel);
    assert.strictEqual(totals.selfLoad, sumSelf);
    assert.strictEqual(totals.travelTime, sumTravel);
    assert.strictEqual(totals.price, sumPrice);
    assert.strictEqual(totals.total, customerInvoice.roundMoney(sumHauling + sumFuel + sumSelf + sumTravel));
  });

  await check('the official PDF layout has Logan\'s fields and never shows driver names, pay, or load numbers', () => {
    const history = [{ id: 1, effective_date: '2026-11-02', central_atlantic_rate: 6.486 }];
    const load = {
      load_date: '2026-11-02', ticket_number: '272674', weight_quantity: 25.85, rate: 9.26,
      has_fuel_surcharge: 1, destination: 'Gloucester', driver_name: 'Dana Driver',
      load_number: '2026-0001', payInfo: { pay: 99.99 }
    };
    const line = Object.assign({}, load, customerInvoice.invoiceLineAmounts(load, history));
    const invoice = {
      number: 'DT1-2026-4012',
      invoiceDate: '2026-11-16',
      customer_name: 'Synagro',
      address_line1: '1681 Tappahannock Blvd',
      address_line2: 'Tappahannock, VA  22560',
      poc_phone: '(804) 761-2054',
      poc_email: 'cahayes@synagro.com',
      terms: 'Net 30',
      project_name: 'West Rock',
      loads: [line],
      totals: customerInvoice.finishTotals((() => {
        const t = customerInvoice.emptyTotals();
        customerInvoice.addLineToTotals(t, line);
        return t;
      })())
    };
    const buf = customerInvoicePdf.buildCustomerInvoicePdf(invoice, {
      settings: customerInvoice.defaultSettings(),
      includeTickets: false
    });
    const text = pdfText(buf);
    assert.ok(text.startsWith('%PDF-1.4'));
    ['DT1 Logistics, LLC', 'P.O. Box 38161', 'Henrico, VA 23231', '(804) 506-0061', 'admin@dt1logistics.com'].forEach((s) => {
      assert.ok(text.includes(s), `missing header ${s}`);
    });
    ['Bill To: Synagro', '1681 Tappahannock Blvd', 'cahayes@synagro.com', '(804) 761-2054'].forEach((s) => {
      assert.ok(text.includes(s), `missing bill-to ${s}`);
    });
    ['Invoice #: DT1-2026-4012', 'Invoice Date: 11/16/2026', 'Terms: Net 30', 'Project: West Rock'].forEach((s) => {
      assert.ok(text.includes(s), `missing field ${s}`);
    });
    ['Date', 'Ticket #', 'Description', 'Qty', 'Rate', 'Fuel Charge', 'Self Load', 'Travel Time', 'Price'].forEach((s) => {
      assert.ok(text.includes(s), `missing column ${s}`);
    });
    assert.ok(text.includes('Haul to Gloucester'));
    assert.ok(text.includes('272674'));
    assert.ok(text.includes('25.850'));
    ['Hauling', 'Fuel Surcharge', 'Travel Time', 'Self Load', 'TOTAL'].forEach((s) => {
      assert.ok(text.includes(s), `missing footer ${s}`);
    });
    assert.ok(text.includes('Phoenix Capital Group'));
    assert.ok(text.includes('P.O. Box 1415'));
    assert.ok(text.includes('Des Moines, IA 50305-1415'));
    assert.ok(!text.includes('Dana Driver'), 'driver name leaked');
    assert.ok(!text.includes('Contractor Pay'), 'driver pay leaked');
    assert.ok(!text.includes('2026-0001'), 'load number leaked');
    assert.ok(!text.includes('99.99'), 'driver pay amount leaked');
  });

  await check('ticket images are attached behind the invoice in line order', () => {
    const lineA = Object.assign({ load_date: '2026-11-13', ticket_number: '273698', weight_quantity: 23.9, rate: 9.26 }, customerInvoice.invoiceLineAmounts({ load_date: '2026-11-13', weight_quantity: 23.9, rate: 9.26, destination: 'Gloucester' }, []));
    const lineB = Object.assign({ load_date: '2026-11-13', ticket_number: '273718', weight_quantity: 25.12, rate: 9.26 }, customerInvoice.invoiceLineAmounts({ load_date: '2026-11-13', weight_quantity: 25.12, rate: 9.26, destination: 'Gloucester' }, []));
    const totals = customerInvoice.emptyTotals();
    [lineA, lineB].forEach((line) => customerInvoice.addLineToTotals(totals, line));
    const invoice = {
      number: 'DT1-2026-4012', invoiceDate: '2026-11-16', customer_name: 'Synagro',
      project_name: 'West Rock', loads: [lineA, lineB], totals: customerInvoice.finishTotals(totals),
      terms: 'Net 30'
    };
    const withTickets = customerInvoicePdf.buildCustomerInvoicePdf(invoice, {
      settings: customerInvoice.defaultSettings(),
      includeTickets: true,
      tickets: [
        { ticket_number: '273698', filename: 'a.jpg', original_name: 'a.jpg', buffer: TINY_JPEG },
        { ticket_number: '273718', filename: 'b.jpg', original_name: 'b.jpg', buffer: TINY_JPEG }
      ]
    });
    const text = pdfText(withTickets);
    const first = text.indexOf('Ticket #: 273698');
    const second = text.indexOf('Ticket #: 273718');
    const invoiceTitle = text.indexOf('Project: West Rock');
    assert.ok(invoiceTitle !== -1 && first !== -1 && second !== -1);
    assert.ok(invoiceTitle < first && first < second, 'tickets follow the invoice in line order');
    const off = customerInvoicePdf.buildCustomerInvoicePdf(invoice, {
      settings: customerInvoice.defaultSettings(), includeTickets: false,
      tickets: [{ ticket_number: '273698', filename: 'a.jpg', buffer: TINY_JPEG }]
    });
    assert.ok(!pdfText(off).includes('Ticket #: 273698'), 'checkbox off leaves tickets off');
  });

  await check('legacy invoice_weeks marks are copied to project_invoices without deleting the original', () => {
    const { db } = openTempDb();
    db.prepare(`INSERT INTO customers (id, name) VALUES (1, 'Synagro')`).run();
    db.prepare(`INSERT INTO projects (id, customer_id, project_name, display_name, default_rate) VALUES (8, 1, 'King George Pad', 'Synagro - King George Pad', 7)`).run();
    db.prepare(`INSERT INTO loads (id, ticket_number, load_date, project_id, weight_quantity, rate, status) VALUES (1, 'LR-1', '2026-11-04', 8, 20, 7, 'approved')`).run();
    db.prepare(`INSERT INTO invoice_weeks (customer_id, week_start, week_end, invoiced_at, invoiced_by_name, invoiced_amount, paid_at, paid_by_name)
      VALUES (1, '2026-11-02', '2026-11-08', '2026-11-10 12:00:00', 'Logan', 190.35, NULL, NULL)`).run();
    db.prepare(`INSERT INTO invoice_tracker (customer_id, project_id, week_start, amount_received) VALUES (1, 8, '2026-11-02', 50)`).run();
    const loadsBefore = db.prepare('SELECT * FROM loads').all();
    customerInvoice.ensureSchema(db);
    const legacy = db.prepare('SELECT * FROM invoice_weeks').all();
    assert.strictEqual(legacy.length, 1);
    assert.strictEqual(Number(legacy[0].invoiced_amount), 190.35);
    const row = db.prepare('SELECT * FROM project_invoices WHERE project_id = 8 AND week_start = ?').get('2026-11-02');
    assert.ok(row);
    assert.ok(row.invoiced_at);
    assert.strictEqual(row.invoiced_by_name, 'Logan');
    assert.strictEqual(Number(row.invoiced_amount), 190.35);
    assert.strictEqual(row.migrated_from_invoice_week, 1);
    assert.ok(!row.invoice_number, 'legacy marks do not get a new official number');
    assert.strictEqual(Number(db.prepare('SELECT amount_received FROM invoice_tracker').get().amount_received), 50);
    const kg = db.prepare('SELECT invoice_min_qty, invoice_billing_mode FROM projects WHERE id = 8').get();
    assert.strictEqual(Number(kg.invoice_min_qty), 24);
    const loadsAfter = db.prepare('SELECT * FROM loads').all();
    assert.deepStrictEqual(loadsAfter, loadsBefore);
    db.close();
  });

  await check('Uber Freight projects are seeded to flat qty 1; later admin changes are not overwritten', () => {
    const { db } = openTempDb();
    db.prepare(`INSERT INTO customers (id, name) VALUES (2, 'Uber Freight')`).run();
    db.prepare(`INSERT INTO projects (id, customer_id, project_name, display_name, default_rate) VALUES (4, 2, 'New Bern', 'Uber Freight - New Bern', 450)`).run();
    customerInvoice.ensureSchema(db);
    assert.strictEqual(db.prepare('SELECT invoice_billing_mode FROM projects WHERE id = 4').get().invoice_billing_mode, 'flat_qty_1');
    db.prepare("UPDATE projects SET invoice_billing_mode = 'actual' WHERE id = 4").run();
    customerInvoice.ensureSchema(db);
    assert.strictEqual(db.prepare('SELECT invoice_billing_mode FROM projects WHERE id = 4').get().invoice_billing_mode, 'actual');
    db.close();
  });

  // --- HTTP integration ---
  const adminPassword = 'Invoice-Gen-Admin-1';
  const dataDir = h.tempDataDir('dt1-invoice-http-');
  const srv = await h.startServer({ DATA_DIR: dataDir, LOGAN_TMS_PASSWORD: adminPassword, LOGAN_API_TOKEN: '', SESSION_SECRET: 'invoice-gen-test' });
  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    const ids = await h.seedBasics(srv.port, dataDir, admin, { customer: 'Synagro', project: 'West Rock' });
    const auth = ids.auth;
    const post = (path, fields) => h.request(srv.port, auth, { method: 'POST', path, body: h.form(fields) });
    const aGet = (path) => h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path });
    const idOf = (ticket) => h.readRows(dataDir, 'SELECT id FROM loads WHERE ticket_number = ?', [ticket])[0].id;

    await post(`/projects/${ids.projectId}`, {
      customer_id: ids.customerId, project_name: 'West Rock', default_rate: '9.26',
      has_fuel_surcharge: '1', invoice_billing_mode: 'actual'
    });

    await post('/customers/' + ids.customerId + '/projects', {
      project_name: 'King George Pad', default_rate: '7', has_fuel_surcharge: '1',
      invoice_billing_mode: 'actual', invoice_min_qty: '24'
    });
    const kgId = h.readRows(dataDir, "SELECT id FROM projects WHERE project_name = 'King George Pad'")[0].id;

    await post('/customers', { name: 'Uber Freight', address_line1: '3880 Technology Ct', address_line2: 'Sandston, VA 23150', poc_email: 'lois@example.com', terms: 'Net 30' });
    const uberId = h.readRows(dataDir, "SELECT id FROM customers WHERE name = 'Uber Freight'")[0].id;
    await post(`/customers/${uberId}/projects`, {
      project_name: 'New Bern', default_rate: '450', invoice_billing_mode: 'flat_qty_1'
    });
    const uberProjectId = h.readRows(dataDir, "SELECT id FROM projects WHERE project_name = 'New Bern'")[0].id;

    async function approveLoad(fields) {
      const res = await post('/loads', Object.assign({
        action: 'approve', load_date: '2026-11-13', project_id: ids.projectId, driver_id: ids.driverId,
        weight_quantity: '20', rate: '9.26', has_fuel_surcharge: '1'
      }, fields));
      assert.strictEqual(res.status, 302, res.body.slice(0, 200));
      return idOf(fields.ticket_number);
    }

    const westA = await approveLoad({ ticket_number: '273698', weight_quantity: '23.9', destination: 'Gloucester', has_fuel_surcharge: '1' });
    const westB = await approveLoad({ ticket_number: '273718', weight_quantity: '25.12', destination: 'Gloucester', has_fuel_surcharge: '1' });
    const kgLoad = await approveLoad({
      ticket_number: 'LR-004751', load_date: '2026-11-04', project_id: kgId,
      weight_quantity: '20', rate: '7', destination: 'Mooseneck', has_fuel_surcharge: '1'
    });
    const uberLoad = await approveLoad({
      ticket_number: 'UF-1001', load_date: '2026-11-09', project_id: uberProjectId,
      weight_quantity: '10', rate: '99', destination: 'New Bern', has_fuel_surcharge: '0'
    });

    h.writeDb(dataDir, (db) => {
      const insert = db.prepare('INSERT INTO documents (load_id, filename, original_name, category, file_blob) VALUES (?, ?, ?, ?, ?)');
      insert.run(westA, 'a.jpg', 'ticket-a.jpg', 'load_document', TINY_JPEG);
      insert.run(westB, 'b.jpg', 'ticket-b.jpg', 'load_document', TINY_JPEG);
    });

    const loadsBefore = h.readRows(dataDir, 'SELECT * FROM loads ORDER BY id');

    await check('Invoices screen lists one card per project-week and can generate the official PDF', async () => {
      const page = await aGet('/invoices');
      assert.strictEqual(page.status, 200);
      assert.ok(page.body.includes('Synagro · West Rock · Week of November 9 - November 15'));
      assert.ok(page.body.includes('Generate Invoice'));
      assert.ok(page.body.includes('Attach ticket images'));
      const res = await post('/invoices/generate', {
        customer_id: ids.customerId, project_id: ids.projectId, week_start: '2026-11-09', include_tickets: '1'
      });
      assert.strictEqual(res.status, 302);
      assert.ok(String(res.headers.location).includes('/invoices/pdf?'));
      const row = h.readRows(dataDir, 'SELECT * FROM project_invoices WHERE project_id = ? AND week_start = ?', [ids.projectId, '2026-11-09'])[0];
      assert.strictEqual(row.invoice_number, 'DT1-2026-4012');
      assert.ok(row.invoiced_at);
      const tracker = h.readRows(dataDir, 'SELECT * FROM invoice_tracker WHERE project_id = ? AND week_start = ?', [ids.projectId, '2026-11-09'])[0];
      assert.strictEqual(tracker.invoice_number, 'DT1-2026-4012');
      assert.ok(tracker.amount_invoiced != null);
    });

    await check('regenerating keeps DT1-2026-4012; undo keeps the number too', async () => {
      const again = await post('/invoices/generate', {
        customer_id: ids.customerId, project_id: ids.projectId, week_start: '2026-11-09', include_tickets: '1'
      });
      assert.strictEqual(again.status, 302);
      let row = h.readRows(dataDir, 'SELECT invoice_number, invoiced_at FROM project_invoices WHERE project_id = ?', [ids.projectId])[0];
      assert.strictEqual(row.invoice_number, 'DT1-2026-4012');
      await post('/invoices/mark', {
        customer_id: ids.customerId, project_id: ids.projectId, week_start: '2026-11-09', mark: 'open'
      });
      row = h.readRows(dataDir, 'SELECT invoice_number, invoiced_at FROM project_invoices WHERE project_id = ?', [ids.projectId])[0];
      assert.strictEqual(row.invoice_number, 'DT1-2026-4012');
      assert.strictEqual(row.invoiced_at, null);
      await post('/invoices/generate', {
        customer_id: ids.customerId, project_id: ids.projectId, week_start: '2026-11-09', include_tickets: '0'
      });
      row = h.readRows(dataDir, 'SELECT invoice_number, invoiced_at FROM project_invoices WHERE project_id = ?', [ids.projectId])[0];
      assert.strictEqual(row.invoice_number, 'DT1-2026-4012');
      assert.ok(row.invoiced_at);
    });

    await check('generated PDF matches the layout, hides driver/load-number/pay, and can include tickets in order', async () => {
      const pdf = await requestRaw(srv.port, { Cookie: h.cookieHeader(admin) }, {
        path: `/invoices/pdf?customer_id=${ids.customerId}&project_id=${ids.projectId}&week_start=2026-11-09&tickets=1`
      });
      assert.strictEqual(pdf.status, 200);
      assert.ok(String(pdf.headers['content-type']).includes('application/pdf'));
      assert.ok(String(pdf.headers['content-disposition']).includes('DT1-2026-4012 - West Rock.pdf'));
      const text = pdfText(pdf.body);
      assert.ok(text.startsWith('%PDF-1.4'));
      assert.ok(text.includes('DT1-2026-4012'));
      assert.ok(text.includes('Project: West Rock'));
      assert.ok(text.includes('Haul to Gloucester'));
      assert.ok(text.includes('Phoenix Capital Group'));
      assert.ok(!text.includes('Dana Driver'));
      assert.ok(!text.includes('Contractor Pay'));
      assert.ok(!text.includes('2026-0001'));
      const first = text.indexOf('Ticket #: 273698');
      const second = text.indexOf('Ticket #: 273718');
      assert.ok(first !== -1 && second !== -1 && first < second);
    });

    await check('King George 24-ton minimum and Uber Freight qty 1 appear on their invoices', async () => {
      const kgPage = await aGet('/invoices');
      assert.ok(kgPage.body.includes('min 24') || kgPage.body.includes('24-unit minimum') || kgPage.body.includes('24-ton') || kgPage.body.includes('minimum quantity'));
      // 20-ton load billed as 24 x $7 = $168 hauling
      assert.ok(kgPage.body.includes('$168.00'), '24-ton minimum hauling');
      const uberPdf = await requestRaw(srv.port, { Cookie: h.cookieHeader(admin) }, {
        path: `/invoices/pdf?customer_id=${uberId}&project_id=${uberProjectId}&week_start=2026-11-09&tickets=0`
      });
      const text = pdfText(uberPdf.body);
      assert.ok(text.includes('Project: New Bern'));
      assert.ok(text.includes('Haul to New Bern'));
      assert.ok(text.includes('(450.00)'), 'billed rate/price 450');
      assert.ok(!text.includes('(99.00)'), 'load rate 99 is not printed');
      assert.ok(!text.includes('(10.000)'), 'actual tons are not printed');
      assert.ok(text.includes('(1)') || text.includes('(1.000)'), 'qty 1 is printed');
      assert.ok(kgLoad && uberLoad);
    });

    await check('existing load rows are unchanged after generating invoices', () => {
      const loadsAfter = h.readRows(dataDir, 'SELECT * FROM loads ORDER BY id');
      assert.deepStrictEqual(loadsAfter, loadsBefore);
    });
  } finally {
    await h.stop(srv.child);
  }

  console.log(`\n${results.length} customer-invoice checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
