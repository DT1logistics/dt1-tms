// Item 11 (11/16/2026): yearly load numbers (YYYY-NNNN) for new loads.
// Run: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const loadNumber = require('../lib/load-number');
const h = require('./helpers/server');

function memorySeqDb() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE IF NOT EXISTS loads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_number TEXT,
      load_number TEXT
    );
  `);
  loadNumber.ensureSchema(database);
  return database;
}

(async () => {
  const { check, results } = h.makeChecker();

  await check('format pads to four digits and then simply adds a fifth', () => {
    assert.strictEqual(loadNumber.formatLoadNumber(2026, 1), '2026-0001');
    assert.strictEqual(loadNumber.formatLoadNumber(2026, 12), '2026-0012');
    assert.strictEqual(loadNumber.formatLoadNumber(2026, 999), '2026-0999');
    assert.strictEqual(loadNumber.formatLoadNumber(2026, 9999), '2026-9999');
    assert.strictEqual(loadNumber.formatLoadNumber(2026, 10000), '2026-10000');
    assert.strictEqual(loadNumber.formatLoadNumber(2027, 1), '2027-0001');
    assert.strictEqual(loadNumber.formatLoadNumber(2026, 0), null);
    assert.strictEqual(loadNumber.formatLoadNumber('x', 1), null);
    assert.strictEqual(loadNumber.displayLoadNumber(null), '—');
    assert.strictEqual(loadNumber.displayLoadNumber('  '), '—');
    assert.strictEqual(loadNumber.displayLoadNumber('2026-0001'), '2026-0001');
  });

  await check('the year is the America/New_York calendar year, not the load date', () => {
    const nyEve = new Date('2026-12-31T23:59:00-05:00');
    const newYear = new Date('2027-01-01T00:01:00-05:00');
    assert.strictEqual(loadNumber.easternYear(nyEve), 2026);
    assert.strictEqual(loadNumber.easternYear(newYear), 2027);
    // Same instants in UTC (EST is UTC-5).
    assert.strictEqual(loadNumber.easternYear(new Date('2027-01-01T04:59:00Z')), 2026);
    assert.strictEqual(loadNumber.easternYear(new Date('2027-01-01T05:01:00Z')), 2027);
  });

  await check('year reset: Dec 31 11:59 PM Eastern stays in 2026; Jan 1 12:01 AM Eastern starts 2027-0001', () => {
    const database = memorySeqDb();
    const nyEve = new Date('2026-12-31T23:59:00-05:00');
    const newYear = new Date('2027-01-01T00:01:00-05:00');
    assert.strictEqual(loadNumber.allocateLoadNumber(database, nyEve), '2026-0001');
    assert.strictEqual(loadNumber.allocateLoadNumber(database, nyEve), '2026-0002');
    assert.strictEqual(loadNumber.allocateLoadNumber(database, newYear), '2027-0001');
    assert.strictEqual(loadNumber.allocateLoadNumber(database, nyEve), '2026-0003');
    assert.strictEqual(loadNumber.allocateLoadNumber(database, newYear), '2027-0002');
    const years = database.prepare('SELECT year, last FROM load_number_seq ORDER BY year').all();
    assert.deepStrictEqual(years, [{ year: 2026, last: 3 }, { year: 2027, last: 2 }]);
    database.close();
  });

  await check('sequential allocation never duplicates, including past 9999', () => {
    const database = memorySeqDb();
    const now = new Date('2026-11-16T12:00:00-05:00');
    const seen = new Set();
    database.exec("INSERT INTO load_number_seq (year, last) VALUES (2026, 9997)");
    for (let i = 0; i < 5; i++) {
      const value = loadNumber.allocateLoadNumber(database, now);
      assert.ok(!seen.has(value), value);
      seen.add(value);
    }
    assert.deepStrictEqual([...seen], ['2026-9998', '2026-9999', '2026-10000', '2026-10001', '2026-10002']);
    database.close();
  });

  await check('a unique index allows multiple unnumbered (NULL) loads and rejects a duplicate number', () => {
    const database = memorySeqDb();
    database.exec("INSERT INTO loads (ticket_number) VALUES ('OLD-A'), ('OLD-B')");
    database.exec("INSERT INTO loads (ticket_number, load_number) VALUES ('NEW', '2026-0001')");
    assert.throws(() => {
      database.exec("INSERT INTO loads (ticket_number, load_number) VALUES ('DUP', '2026-0001')");
    }, /UNIQUE/i);
    assert.strictEqual(database.prepare("SELECT COUNT(*) AS n FROM loads WHERE load_number IS NULL").get().n, 2);
    database.close();
  });

  const adminPassword = 'Load-Number-Admin-1';
  const driverPassword = 'Load-Number-Driver-1';
  const dataDir = h.tempDataDir('dt1-load-number-');
  const token = `load-number-${'t'.repeat(24)}`;
  const srv = await h.startServer({
    DATA_DIR: dataDir,
    LOGAN_TMS_PASSWORD: adminPassword,
    LOGAN_API_TOKEN: token,
    SESSION_SECRET: 'load-number-test'
  });
  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    const ids = await h.seedBasics(srv.port, dataDir, admin, { customer: 'Number Haul', project: 'East Pit' });
    h.setUserPassword(dataDir, 'dana.driver@example.com', driverPassword);
    const driver = (await h.loginAs(srv.port, 'dana.driver@example.com', driverPassword)).jar;
    const aAuth = { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: h.cookieHeader(admin) };
    const dAuth = { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: h.cookieHeader(driver) };
    const aGet = (path) => h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path });
    const dGet = (path) => h.request(srv.port, { Cookie: h.cookieHeader(driver) }, { path });
    const post = (path, fields, auth) => h.request(srv.port, auth || aAuth, { method: 'POST', path, body: h.form(fields) });
    const loadFields = (ticket, extra) => Object.assign({
      action: 'submit',
      load_date: '2026-11-16',
      ticket_number: ticket,
      project_id: ids.projectId,
      driver_id: ids.driverId,
      weight_quantity: '20',
      rate: '10'
    }, extra || {});

    // A pre-existing unnumbered row, as if it was entered before this change.
    h.writeDb(dataDir, (database) => {
      database.prepare(`
        INSERT INTO loads (ticket_number, load_date, driver_id, project_id, weight_quantity, rate, status, created_at)
        VALUES ('LEGACY-73', '2026-11-10', ?, ?, 20, 10, 'submitted', '2026-11-10 15:00:00')
      `).run(ids.driverId, ids.projectId);
    });
    const legacy = h.readRows(dataDir, "SELECT * FROM loads WHERE ticket_number = 'LEGACY-73'")[0];
    const legacyKeys = Object.keys(legacy).filter((key) => key !== 'load_number');
    const legacySnapshot = Object.fromEntries(legacyKeys.map((key) => [key, legacy[key]]));

    await check('existing loads stay unnumbered; the first new load is 2026-0001', async () => {
      assert.strictEqual(legacy.load_number, null);
      const res = await post('/loads', loadFields('NEW-1', { action: 'approve' }));
      assert.strictEqual(res.status, 302, res.body.slice(0, 200));
      const created = h.readRows(dataDir, "SELECT * FROM loads WHERE ticket_number = 'NEW-1'")[0];
      assert.strictEqual(created.load_number, '2026-0001');
      const afterLegacy = h.readRows(dataDir, "SELECT * FROM loads WHERE ticket_number = 'LEGACY-73'")[0];
      assert.strictEqual(afterLegacy.load_number, null);
      legacyKeys.forEach((key) => {
        assert.deepStrictEqual(afterLegacy[key], legacySnapshot[key], `legacy.${key}`);
      });
    });

    await check('every creation path gets the next number: admin, driver, Submit & Approve, Logan API', async () => {
      const assigned = await post('/loads', loadFields('ASSIGN-1', { action: 'draft', admin_mode: 'assign' }));
      assert.strictEqual(assigned.status, 302);
      const driverCreate = await post('/loads', {
        action: 'submit',
        load_date: '2026-11-16',
        ticket_number: 'DRV-1',
        project_id: ids.projectId,
        weight_quantity: '18',
        rate: '10'
      }, dAuth);
      assert.strictEqual(driverCreate.status, 302, driverCreate.body.slice(0, 200));
      const approve = await post('/loads', loadFields('APR-1', { action: 'approve' }));
      assert.strictEqual(approve.status, 302);
      const api = await h.request(srv.port, { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, {
        method: 'POST',
        path: '/api/logan/loads',
        body: JSON.stringify({
          action: 'submit',
          load_date: '2026-11-16',
          ticket_number: 'API-1',
          driver_id: ids.driverId,
          project_id: ids.projectId,
          weight_quantity: 16,
          rate: 10
        })
      });
      assert.strictEqual(api.status, 201, api.body);
      const rows = h.readRows(dataDir, "SELECT ticket_number, load_number FROM loads WHERE ticket_number IN ('NEW-1', 'ASSIGN-1', 'DRV-1', 'APR-1', 'API-1') ORDER BY load_number");
      assert.deepStrictEqual(rows.map((row) => [row.ticket_number, row.load_number]), [
        ['NEW-1', '2026-0001'],
        ['ASSIGN-1', '2026-0002'],
        ['DRV-1', '2026-0003'],
        ['APR-1', '2026-0004'],
        ['API-1', '2026-0005']
      ]);
      const body = JSON.parse(api.body);
      assert.strictEqual(body.load.load_number, '2026-0005');
    });

    await check('two loads created at the same moment get different numbers', async () => {
      const posts = await Promise.all([
        post('/loads', loadFields('CONC-A', { action: 'draft' })),
        post('/loads', loadFields('CONC-B', { action: 'draft' }))
      ]);
      posts.forEach((res) => assert.strictEqual(res.status, 302, res.body.slice(0, 200)));
      const rows = h.readRows(dataDir, "SELECT ticket_number, load_number FROM loads WHERE ticket_number IN ('CONC-A', 'CONC-B') ORDER BY load_number");
      assert.strictEqual(rows.length, 2);
      assert.notStrictEqual(rows[0].load_number, rows[1].load_number);
      const nums = rows.map((row) => row.load_number).sort();
      assert.deepStrictEqual(nums, ['2026-0006', '2026-0007']);
    });

    await check('deleting a load does not reuse its number', async () => {
      const doomed = h.readRows(dataDir, "SELECT id, load_number FROM loads WHERE ticket_number = 'CONC-A'")[0];
      assert.strictEqual(doomed.load_number, '2026-0006');
      const res = await post(`/loads/${doomed.id}/delete`, {});
      assert.strictEqual(res.status, 302);
      assert.strictEqual(h.readRows(dataDir, 'SELECT id FROM loads WHERE id = ?', [doomed.id]).length, 0);
      const next = await post('/loads', loadFields('AFTER-DEL', { action: 'draft' }));
      assert.strictEqual(next.status, 302);
      const created = h.readRows(dataDir, "SELECT load_number FROM loads WHERE ticket_number = 'AFTER-DEL'")[0];
      assert.strictEqual(created.load_number, '2026-0008');
      const used = h.readRows(dataDir, "SELECT COUNT(*) AS n FROM loads WHERE load_number = '2026-0006'")[0].n;
      assert.strictEqual(used, 0);
    });

    await check('Loads list shows the number in the table column and on cards, and search filters by it', async () => {
      const list = await aGet('/loads');
      assert.ok(list.body.includes('<th>Load #</th>'));
      // 2026-0002 is an open (draft) load; 2026-0001 is already Approved for Settlement.
      assert.ok(list.body.includes('>2026-0002</strong>'));
      assert.ok(list.body.includes('Load # 2026-0002'));
      assert.ok(list.body.includes('Load # —'), 'legacy unnumbered shows a dash');
      assert.ok(list.body.includes('LEGACY-73'));
      const approved = await aGet('/loads?view=approved');
      assert.ok(approved.body.includes('>2026-0001</strong>'));
      assert.ok(approved.body.includes('Load # 2026-0001'));
      const search = await aGet('/loads?q=2026-0002');
      assert.ok(search.body.includes('2026-0002'));
      assert.ok(!search.body.includes('2026-0003'), 'search is limited to the requested number');
      assert.ok(!search.body.includes('LEGACY-73'));
      const approvedSearch = await aGet('/loads?view=approved&q=2026-0001');
      assert.ok(approvedSearch.body.includes('2026-0001'));
      assert.ok(!approvedSearch.body.includes('2026-0004'), 'approved search is limited to the requested number');
      const miss = await aGet('/loads?q=2026-9999');
      assert.ok(miss.body.includes('No loads match'));
      const review = await aGet(`/loads/${h.readRows(dataDir, "SELECT id FROM loads WHERE load_number = '2026-0001'")[0].id}`);
      assert.ok(review.body.includes('Review Load 2026-0001'));
      assert.ok(review.body.includes('<strong>Load #</strong> 2026-0001'));
      const driverList = await dGet('/loads?q=2026-0003');
      assert.ok(driverList.body.includes('2026-0003'));
      assert.ok(!driverList.body.includes('2026-0007'), 'driver search filters week cards');
    });

    await check('Settlements show the load number; the invoice PDF does not', async () => {
      const approvedId = h.readRows(dataDir, "SELECT id FROM loads WHERE load_number = '2026-0001'")[0].id;
      // NEW-1 was created with action=approve, so it should already be approved.
      const status = h.readRows(dataDir, 'SELECT status FROM loads WHERE id = ?', [approvedId])[0].status;
      assert.strictEqual(status, 'approved');
      const settlements = await aGet('/settlements');
      assert.ok(settlements.body.includes('Load # 2026-0001'));
      const settlePdf = await aGet(`/settlements/pdf?kind=pending&driver_id=${ids.driverId}&week_start=2026-11-16`);
      assert.strictEqual(settlePdf.status, 200, settlePdf.body.slice(0, 200));
      assert.ok(settlePdf.body.includes('2026-0001'), 'driver settlement PDF shows the load number');
      const invoicePdf = await aGet(`/invoices/pdf?customer_id=${ids.customerId}&week_start=2026-11-16`);
      assert.strictEqual(invoicePdf.status, 200, invoicePdf.body.slice(0, 200));
      assert.ok(!invoicePdf.body.includes('2026-0001'), 'customer invoice PDF must not include the load number');
      assert.ok(!invoicePdf.body.includes('Load #'));
      const invoicesPage = await aGet('/invoices');
      assert.ok(!invoicesPage.body.includes('2026-0001'), 'internal Invoices screen skips the load number');
    });

    await check('Logan can look up a load by official number; URLs still use the internal id', async () => {
      const row = h.readRows(dataDir, "SELECT id, load_number FROM loads WHERE load_number = '2026-0005'")[0];
      const api = await h.request(srv.port, { Authorization: `Bearer ${token}` }, { path: '/api/logan/loads/2026-0005' });
      assert.strictEqual(api.status, 200, api.body);
      const body = JSON.parse(api.body);
      assert.strictEqual(body.load.id, row.id);
      assert.strictEqual(body.load.load_number, '2026-0005');
      assert.ok(body.load.link.endsWith(`/loads/${row.id}`));
    });
  } finally {
    await h.stop(srv.child);
  }

  console.log(`\n${results.length} load-number checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
