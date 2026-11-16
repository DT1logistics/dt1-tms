// Item 5 (11/15/2026): separate Settlements and Invoices screens.
// Approve for Settlement moves a load off the main Loads screen (hidden, record kept). It then shows on
// Settlements under driver + Monday-Sunday work week (by Load Date) and on Invoices under project +
// work week. Invoices: Generate / Paid / Invoiced per project week and an Invoice Tracker (work week, client,
// project, official number, amount invoiced, editable amount received). Official PDF per project week.
// The admin finalizes a driver's week; drivers see only their own pay, and only for finalized weeks.
// Run: npm test
const assert = require('assert');
const h = require('./helpers/server');

function assertBefore(text, first, second, label) {
  const a = text.indexOf(first);
  const b = text.indexOf(second);
  assert.ok(a !== -1, `${label}: missing ${first}`);
  assert.ok(b !== -1, `${label}: missing ${second}`);
  assert.ok(a < b, `${label}: ${first} should come before ${second}`);
}

(async () => {
  const { check, results } = h.makeChecker();
  const adminPassword = 'Settle-Invoice-Admin-1';
  const driverPassword = 'Settle-Invoice-Driver-1';
  const dataDir = h.tempDataDir('dt1-settle-invoice-');
  const srv = await h.startServer({ DATA_DIR: dataDir, LOGAN_TMS_PASSWORD: adminPassword, LOGAN_API_TOKEN: '', SESSION_SECRET: 'settle-invoice-test' });
  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    const ids = await h.seedBasics(srv.port, dataDir, admin, { customer: 'Acme Aggregates', project: 'North Pit' });
    h.setUserPassword(dataDir, 'dana.driver@example.com', driverPassword);
    const driver = (await h.loginAs(srv.port, 'dana.driver@example.com', driverPassword)).jar;
    // A second driver, to prove drivers only see their own settlements.
    await h.request(srv.port, ids.auth, { method: 'POST', path: '/drivers', body: h.form({ first_name: 'Olly', last_name: 'Other', email: 'olly@example.com', phone: '5555550199', pay_percentage: '25' }) });
    const otherId = h.readRows(dataDir, "SELECT id FROM users WHERE email = 'olly@example.com'")[0].id;
    const aGet = (path) => h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path });
    const dGet = (path) => h.request(srv.port, { Cookie: h.cookieHeader(driver) }, { path });
    const post = (path, fields) => h.request(srv.port, ids.auth, { method: 'POST', path, body: h.form(fields) });
    const idOf = (ticket) => h.readRows(dataDir, 'SELECT id FROM loads WHERE ticket_number = ?', [ticket])[0].id;
    async function adminLoad(ticket, date, action, driverId, extra) {
      const res = await post('/loads', Object.assign({ action, load_date: date, ticket_number: ticket, project_id: ids.projectId, driver_id: driverId || ids.driverId, weight_quantity: '20', rate: '10' }, extra || {}));
      assert.strictEqual(res.status, 302, res.body.slice(0, 200));
      return idOf(ticket);
    }
    // Week of Nov 9-15: two loads for Dana (one submitted then approved) + one for Olly. Week of Nov 16-22: one for Dana.
    const subId = await adminLoad('W1-A', '2026-11-10', 'submit');
    const w1b = await adminLoad('W1-B', '2026-11-12', 'approve', null, { total_load_pay: '300' });
    await adminLoad('W1-OTHER', '2026-11-11', 'approve', otherId);
    const w2 = await adminLoad('W2-A', '2026-11-17', 'approve');
    const countBefore = h.readRows(dataDir, 'SELECT COUNT(*) AS n FROM loads')[0].n;

    await check('Approve for Settlement moves the load off the main Loads screen; the record is kept', async () => {
      let list = await aGet('/loads');
      assert.ok(list.body.includes('<strong>W1-A</strong>'));
      const res = await h.request(srv.port, ids.auth, { method: 'POST', path: `/loads/${subId}/approve`, body: '' });
      assert.strictEqual(res.status, 302);
      list = await aGet('/loads');
      ['W1-A', 'W1-B', 'W2-A', 'W1-OTHER'].forEach((t) => assert.ok(!list.body.includes(`<strong>${t}</strong>`), t));
      assert.ok(list.body.includes('Approved for Settlement / Settled (4)'));
      const approved = await aGet('/loads?view=approved');
      ['W1-A', 'W1-B', 'W2-A', 'W1-OTHER'].forEach((t) => assert.ok(approved.body.includes(`<strong>${t}</strong>`), t));
      assert.strictEqual(h.readRows(dataDir, 'SELECT COUNT(*) AS n FROM loads')[0].n, countBefore);
      const detail = await aGet(`/loads/${subId}`);
      assert.strictEqual(detail.status, 200);
    });

    await check('Settlements: one card per driver + Mon-Sun week, Driver Pay first then Total Load Pay', async () => {
      const page = await aGet('/settlements');
      assert.strictEqual(page.status, 200);
      assert.ok(page.body.includes('Driver Settlement - Week of November 9 - November 15'));
      assert.ok(page.body.includes('Driver Settlement - Week of November 16 - November 22'));
      assert.strictEqual(page.body.split('Finalize Weekly Settlement</button>').length - 1, 3, 'Dana wk1, Olly wk1, Dana wk2');
      // Dana week 1: 30% of 200 + 30% of 200 = $120.00; Total Load Pay 200 + 300 = $500.00
      assertBefore(page.body, 'Driver Pay $120.00', 'Total Load Pay (invoiced) $500.00', 'Dana week 1');
      assert.ok(!page.body.includes('Weekly Shipper Invoices'), 'invoices moved to their own screen');
      const nav = await aGet('/');
      assert.ok(nav.body.includes('href="/invoices">Invoices</a>'));
    });

    await check('Invoices: grouped by project + work week with one official invoice per project-week', async () => {
      const page = await aGet('/invoices');
      assert.strictEqual(page.status, 200);
      assert.ok(page.body.includes('Acme Aggregates · North Pit · Week of November 9 - November 15'));
      assert.ok(page.body.includes('Acme Aggregates · North Pit · Week of November 16 - November 22'));
      assert.ok(page.body.includes('Project: North Pit'));
      assert.ok(!page.body.includes('Project: Acme Aggregates - North Pit'), 'invoice uses the project name, not the display name');
      // Week 1: 200 + 300 (Total Load Pay) + 200 (Olly) = $700.00. Week 2: $200.00.
      assert.ok(page.body.includes('<span>TOTAL</span><span>$700.00</span>'));
      assert.ok(page.body.includes('<span>TOTAL</span><span>$200.00</span>'));
      assertBefore(page.body, 'Driver Pay (not billed)', '<span>Hauling</span>', 'invoice totals');
      assert.strictEqual(page.body.split('>Not invoiced</span>').length - 1, 2);
      assert.ok(page.body.includes('Generate Invoice'));
    });

    await check('Invoices: mark Invoiced, Paid, and undo, per project week (logged)', async () => {
      const key = { customer_id: ids.customerId, project_id: ids.projectId, week_start: '2026-11-09' };
      let res = await post('/invoices/mark', Object.assign({ mark: 'invoiced' }, key));
      assert.strictEqual(res.status, 302);
      let row = h.readRows(dataDir, 'SELECT * FROM project_invoices WHERE customer_id = ? AND project_id = ? AND week_start = ?', [ids.customerId, ids.projectId, '2026-11-09'])[0];
      assert.ok(row.invoiced_at);
      assert.strictEqual(Number(row.invoiced_amount), 700);
      assert.strictEqual(row.invoice_number, 'DT1-2026-4012');
      assert.strictEqual(h.readRows(dataDir, 'SELECT COUNT(*) AS n FROM invoice_weeks')[0].n, 0, 'legacy invoice_weeks stays untouched');
      let page = await aGet('/invoices?status=invoiced');
      assert.ok(page.body.includes('Week of November 9 - November 15'));
      assert.ok(!page.body.includes('Week of November 16 - November 22'));
      assert.ok(page.body.includes('Invoice # DT1-2026-4012'));
      res = await post('/invoices/mark', Object.assign({ mark: 'paid' }, key));
      row = h.readRows(dataDir, 'SELECT * FROM project_invoices WHERE customer_id = ? AND project_id = ? AND week_start = ?', [ids.customerId, ids.projectId, '2026-11-09'])[0];
      assert.ok(row.paid_at && row.paid_by_name);
      page = await aGet('/invoices?status=paid');
      assert.ok(page.body.includes('>Paid</span>'));
      await post('/invoices/mark', Object.assign({ mark: 'unpaid' }, key));
      row = h.readRows(dataDir, 'SELECT * FROM project_invoices WHERE customer_id = ? AND project_id = ? AND week_start = ?', [ids.customerId, ids.projectId, '2026-11-09'])[0];
      assert.strictEqual(row.paid_at, null);
      assert.ok(row.invoiced_at, 'still invoiced');
      assert.strictEqual(row.invoice_number, 'DT1-2026-4012', 'number kept');
      const audit = h.readRows(dataDir, "SELECT detail FROM audit_log WHERE action = 'Invoice status' ORDER BY id");
      assert.deepStrictEqual(audit.map((a) => a.detail.split(': ').pop()), ['Marked Invoiced ($700.00)', 'Marked Paid', 'Paid mark removed']);
    });

    await check('Invoice Tracker: work week, client, project, amount invoiced and editable amount received', async () => {
      let page = await aGet('/invoices?tab=tracker');
      assert.strictEqual(page.status, 200);
      assert.ok(page.body.includes('<th>Work Week</th>') && page.body.includes('<th>Client</th>') && page.body.includes('<th>Project</th>'));
      assert.ok(page.body.includes('Amount Invoiced') && page.body.includes('Amount Received'));
      assert.ok(page.body.includes('DT1-2026-4012'));
      const res = await post('/invoices/received', { customer_id: ids.customerId, project_id: ids.projectId, week_start: '2026-11-09', amount_received: '650.5' });
      assert.strictEqual(res.status, 302);
      page = await aGet('/invoices?tab=tracker');
      assert.ok(page.body.includes('value="650.50"'));
      assert.ok(page.body.includes('$49.50'), 'balance 700 - 650.50');
      const bad = await post('/invoices/received', { customer_id: ids.customerId, project_id: ids.projectId, week_start: '2026-11-09', amount_received: 'abc' });
      assert.ok(String(bad.headers.location).includes('bad-amount'));
      assert.strictEqual(Number(h.readRows(dataDir, 'SELECT amount_received FROM invoice_tracker')[0].amount_received), 650.5);
    });

    await check('an admin edit of an approved load flows to the invoice and flags a changed invoiced total', async () => {
      await post(`/loads/${w1b}`, { action: 'save', load_date: '2026-11-12', ticket_number: 'W1-B', project_id: ids.projectId, driver_id: ids.driverId, weight_quantity: '20', rate: '10', total_load_pay: '350' });
      const page = await aGet('/invoices');
      assert.ok(page.body.includes('<span>TOTAL</span><span>$750.00</span>'));
      assert.ok(page.body.includes('The total changed after this invoice was marked Invoiced (was $700.00, now $750.00)'));
    });

    await check('PDFs: driver weekly settlement and customer weekly invoice', async () => {
      const pending = await aGet(`/settlements/pdf?kind=pending&driver_id=${ids.driverId}&week_start=2026-11-09`);
      assert.strictEqual(pending.status, 200);
      assert.strictEqual(pending.headers['content-type'], 'application/pdf');
      assert.ok(pending.body.startsWith('%PDF-1.4'));
      assert.ok(pending.body.includes('(Driver: Dana Driver) Tj'));
      assert.ok(pending.body.includes('NOT FINALIZED'));
      assert.ok(pending.body.includes('($120.00) Tj'));
      assert.ok(!pending.body.includes('Total Load Pay'), 'driver settlement PDF has no customer amounts');
      const invoice = await aGet(`/invoices/pdf?customer_id=${ids.customerId}&project_id=${ids.projectId}&week_start=2026-11-09`);
      assert.strictEqual(invoice.status, 200);
      assert.ok(invoice.body.startsWith('%PDF-1.4'));
      assert.ok(invoice.body.includes('(Acme Aggregates) Tj') || invoice.body.includes('Bill To: Acme Aggregates'));
      assert.ok(invoice.body.includes('DT1-2026-4012'));
      assert.ok(invoice.body.includes('(Project: North Pit) Tj'));
      assert.ok(invoice.body.includes('750.00') || invoice.body.includes('($750.00)'));
      assert.ok(!invoice.body.includes('Driver Pay'), 'customer invoice PDF does not show driver pay');
      assert.ok(!invoice.body.includes('Dana Driver'), 'customer invoice PDF does not show driver names');
      assert.strictEqual((await aGet(`/invoices/pdf?customer_id=${ids.customerId}&week_start=2026-11-09`)).status, 404, 'project_id required');
      assert.strictEqual((await aGet(`/invoices/pdf?customer_id=${ids.customerId}&project_id=${ids.projectId}&week_start=2026-11-10`)).status, 404, 'not a Monday');
      assert.strictEqual((await aGet(`/settlements/pdf?driver_id=${ids.driverId}&week_start=2026-11-09`)).status, 404, 'not finalized yet');
    });

    await check('drivers see no pay before the week is finalized, and never invoices', async () => {
      const loads = await dGet('/loads');
      assert.ok(loads.body.includes('W1-A'));
      assert.ok(!loads.body.includes('Driver Pay'), 'no driver pay on the Loads screen before finalize');
      const detail = await dGet(`/loads/${subId}`);
      const visible = detail.body.replace(/<script[\s\S]*?<\/script>/g, '');
      assert.ok(!visible.includes('Driver Pay'), 'no driver pay on the load before finalize');
      const settlements = await dGet('/settlements');
      assert.ok(settlements.body.includes('No finalized weekly settlements yet.'));
      assert.ok(!settlements.body.includes('$60.00'));
      const inv = await dGet('/invoices');
      assert.strictEqual(inv.status, 302);
      assert.strictEqual((await dGet(`/invoices/pdf?customer_id=${ids.customerId}&week_start=2026-11-09`)).status, 404);
      assert.strictEqual((await dGet(`/settlements/pdf?kind=pending&driver_id=${ids.driverId}&week_start=2026-11-09`)).status, 404);
      const r = await h.request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: h.cookieHeader(driver) }, { method: 'POST', path: '/invoices/mark', body: h.form({ customer_id: ids.customerId, week_start: '2026-11-16', mark: 'paid' }) });
      assert.strictEqual(r.status, 302);
      assert.strictEqual(h.readRows(dataDir, "SELECT COUNT(*) AS n FROM invoice_weeks WHERE week_start = '2026-11-16'")[0].n, 0);
      assert.strictEqual(h.readRows(dataDir, "SELECT COUNT(*) AS n FROM project_invoices WHERE week_start = '2026-11-16'")[0].n, 0);
    });

    await check('finalizing a driver week: driver sees only their own finalized pay and can download its PDF', async () => {
      const res = await post('/settlements/approve-week', { driver_id: ids.driverId, week_start: '2026-11-09' });
      assert.strictEqual(res.status, 302);
      assert.ok(h.readRows(dataDir, "SELECT action FROM audit_log WHERE action = 'Finalized weekly settlement'").length === 1);
      assert.strictEqual(h.readRows(dataDir, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'Settled' AND entity_type = 'load'")[0].n, 2);
      const settlements = await dGet('/settlements');
      assert.ok(settlements.body.includes('Driver Settlement - Week of November 9 - November 15'));
      // 30% of 200 + 30% of 200 = $120.00 (Total Load Pay does not change driver pay)
      assert.ok(settlements.body.includes('Driver Pay $120.00'));
      assert.ok(!settlements.body.includes('Total Load Pay'), 'drivers never see Total Load Pay');
      assert.ok(!settlements.body.includes('November 16 - November 22'), 'week 2 not finalized');
      assert.ok(!settlements.body.includes('W1-OTHER'), 'not another driver');
      const detail = await dGet(`/loads/${subId}`);
      assert.ok(detail.body.replace(/<script[\s\S]*?<\/script>/g, '').includes('<strong>Driver Pay</strong> $60.00'));
      const pdf = await dGet(`/settlements/pdf?driver_id=${otherId}&week_start=2026-11-09`);
      assert.strictEqual(pdf.status, 200);
      assert.ok(pdf.body.includes('(Driver: Dana Driver) Tj'), 'driver_id is ignored for drivers: always their own');
      assert.ok(pdf.body.includes('Status: Finalized'));
      const week2 = await dGet('/settlements/pdf?week_start=2026-11-16');
      assert.strictEqual(week2.status, 404);
      const adminPage = await aGet('/settlements');
      assert.strictEqual(adminPage.body.split('Finalize Weekly Settlement</button>').length - 1, 2);
      assert.ok(adminPage.body.includes(`/settlements/pdf?driver_id=${ids.driverId}&amp;week_start=2026-11-09`) || adminPage.body.includes(`/settlements/pdf?driver_id=${ids.driverId}&week_start=2026-11-09`));
      assert.ok(w2);
    });
  } finally {
    await h.stop(srv.child);
  }
  console.log(`\n${results.length} settlements-invoices checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
