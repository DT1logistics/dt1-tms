// Item 1 (11/15/2026): Load Date is required on every save path, and old undated loads are
// backfilled with their created date (America/New_York). Run: npm test
const assert = require('assert');
const h = require('./helpers/server');
const loadDate = require('../lib/load-date');

(async () => {
  const { check, results } = h.makeChecker();

  await check('isValidLoadDate and easternDateFromTimestamp', async () => {
    assert.strictEqual(loadDate.isValidLoadDate('2026-11-15'), true);
    assert.strictEqual(loadDate.isValidLoadDate(' 2026-11-15 '), true);
    assert.strictEqual(loadDate.isValidLoadDate(''), false);
    assert.strictEqual(loadDate.isValidLoadDate(null), false);
    assert.strictEqual(loadDate.isValidLoadDate('2026-02-30'), false);
    assert.strictEqual(loadDate.isValidLoadDate('11-15-2026'), false);
    // 11:30 PM ET on Nov 13 is 04:30 UTC on Nov 14; the ET calendar day is Nov 13.
    assert.strictEqual(loadDate.easternDateFromTimestamp('2026-11-14 04:30:00'), '2026-11-13');
    assert.strictEqual(loadDate.easternDateFromTimestamp('2026-11-13 14:46:00'), '2026-11-13');
    // Summer (EDT, UTC-4): 03:59 UTC on Jul 2 is 11:59 PM Jul 1 ET.
    assert.strictEqual(loadDate.easternDateFromTimestamp('2026-07-02 03:59:00'), '2026-07-01');
    assert.strictEqual(loadDate.easternDateFromTimestamp(''), '');
    assert.strictEqual(loadDate.easternDateFromTimestamp('garbage'), '');
  });

  const adminPassword = 'Load-Date-Admin-1';
  const driverPassword = 'Load-Date-Driver-1';
  const token = 'x'.repeat(40);
  const dataDir = h.tempDataDir('dt1-load-date-');
  const env = { DATA_DIR: dataDir, LOGAN_TMS_PASSWORD: adminPassword, LOGAN_API_TOKEN: token, SESSION_SECRET: 'load-date-test' };
  let srv = await h.startServer(env);
  let ids;
  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    ids = await h.seedBasics(srv.port, dataDir, admin);
    h.setUserPassword(dataDir, 'dana.driver@example.com', driverPassword);
    const driver = (await h.loginAs(srv.port, 'dana.driver@example.com', driverPassword)).jar;
    const driverAuth = { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: h.cookieHeader(driver) };
    const count = () => h.readRows(dataDir, 'SELECT COUNT(*) AS n FROM loads')[0].n;

    await check('load form and review edit mark Load Date as required', async () => {
      const page = await h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path: '/loads/new' });
      assert.match(page.body, /name="load_date"[^>]*required/);
    });

    await check('admin cannot add a load without a date (draft, submit, approve)', async () => {
      const before = count();
      for (const action of ['draft', 'submit', 'approve']) {
        const res = await h.request(srv.port, ids.auth, {
          method: 'POST', path: '/loads',
          body: h.form({ action, ticket_number: 'NO-DATE-' + action, project_id: ids.projectId, driver_id: ids.driverId, weight_quantity: '1', rate: '10' })
        });
        assert.strictEqual(res.status, 400, action);
        assert.ok(res.body.includes('Load Date is required'), action);
        assert.ok(res.body.includes('NO-DATE-' + action), 'typed values are kept');
      }
      assert.strictEqual(count(), before);
    });

    await check('driver cannot add a load without a date (draft or submit)', async () => {
      const before = count();
      for (const action of ['draft', 'submit']) {
        const res = await h.request(srv.port, driverAuth, {
          method: 'POST', path: '/loads',
          body: h.form({ action, ticket_number: 'DRV-NO-DATE', project_id: ids.projectId, weight_quantity: '1', rate: '10' })
        });
        assert.strictEqual(res.status, 400, action);
        assert.ok(res.body.includes('Load Date is required'));
      }
      assert.strictEqual(count(), before);
    });

    let loadId;
    await check('a load with a date saves, and clearing the date on edit is refused', async () => {
      const res = await h.request(srv.port, ids.auth, {
        method: 'POST', path: '/loads',
        body: h.form({ action: 'draft', load_date: '2026-11-10', ticket_number: 'DATED', project_id: ids.projectId, driver_id: ids.driverId })
      });
      assert.strictEqual(res.status, 302, res.body.slice(0, 300));
      loadId = h.readRows(dataDir, "SELECT id FROM loads WHERE ticket_number = 'DATED'")[0].id;
      const edit = await h.request(srv.port, ids.auth, {
        method: 'POST', path: `/loads/${loadId}`,
        body: h.form({ action: 'save', load_date: '', ticket_number: 'DATED', project_id: ids.projectId, driver_id: ids.driverId })
      });
      assert.strictEqual(edit.status, 400);
      assert.strictEqual(h.readRows(dataDir, 'SELECT load_date FROM loads WHERE id = ?', [loadId])[0].load_date, '2026-11-10');
      const driverEdit = await h.request(srv.port, driverAuth, {
        method: 'POST', path: `/loads/${loadId}`,
        body: h.form({ action: 'submit', load_date: '', ticket_number: 'DATED', project_id: ids.projectId })
      });
      assert.strictEqual(driverEdit.status, 400);
      assert.strictEqual(h.readRows(dataDir, 'SELECT load_date FROM loads WHERE id = ?', [loadId])[0].load_date, '2026-11-10');
    });

    await check('Logan API returns 400 without load_date and 201 with it', async () => {
      const apiAuth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const before = count();
      const missing = await h.request(srv.port, apiAuth, {
        method: 'POST', path: '/api/logan/loads',
        body: JSON.stringify({ action: 'draft', driver_id: ids.driverId, project_id: ids.projectId })
      });
      assert.strictEqual(missing.status, 400);
      assert.match(JSON.parse(missing.body).error, /Load Date is required/);
      assert.strictEqual(count(), before);
      const ok = await h.request(srv.port, apiAuth, {
        method: 'POST', path: '/api/logan/loads',
        body: JSON.stringify({ action: 'draft', load_date: '2026-11-12', driver_id: ids.driverId, project_id: ids.projectId })
      });
      assert.strictEqual(ok.status, 201, ok.body);
    });
  } finally {
    await h.stop(srv.child);
  }

  // Simulate old undated loads, then restart: only the empty dates get the ET created date.
  h.writeDb(dataDir, (database) => {
    const insert = database.prepare(`
      INSERT INTO loads (ticket_number, load_date, project_id, status, created_at)
      VALUES (?, ?, ?, 'submitted', ?)
    `);
    insert.run('OLD-NULL', null, ids.projectId, '2026-11-14 04:30:00');
    insert.run('OLD-BLANK', '  ', ids.projectId, '2026-11-13 14:46:00');
    insert.run('OLD-DATED', '2026-10-01', ids.projectId, '2026-11-13 14:46:00');
  });
  const snapshot = () => h.readRows(dataDir, 'SELECT * FROM loads ORDER BY id');
  const beforeRows = snapshot();
  srv = await h.startServer(env);
  try {
    await check('startup backfill fills only empty load dates with the ET created date', async () => {
      const after = snapshot();
      assert.strictEqual(after.length, beforeRows.length);
      const byTicket = Object.fromEntries(after.map((row) => [row.ticket_number, row]));
      assert.strictEqual(byTicket['OLD-NULL'].load_date, '2026-11-13');
      assert.strictEqual(byTicket['OLD-BLANK'].load_date, '2026-11-13');
      assert.strictEqual(byTicket['OLD-DATED'].load_date, '2026-10-01');
      // Every other column on every load is unchanged.
      beforeRows.forEach((row, i) => {
        const now = after[i];
        Object.keys(row).forEach((key) => {
          if (key === 'load_date' && ['OLD-NULL', 'OLD-BLANK'].includes(row.ticket_number)) return;
          assert.deepStrictEqual(now[key], row[key], `${row.ticket_number}.${key}`);
        });
      });
      const audit = h.readRows(dataDir, "SELECT entity_id, detail FROM audit_log WHERE action = 'Load date backfilled' ORDER BY entity_id");
      assert.deepStrictEqual(audit.map((a) => a.entity_id), [byTicket['OLD-NULL'].id, byTicket['OLD-BLANK'].id]);
      assert.ok(audit[0].detail.includes('2026-11-13'));
      assert.ok(srv.output().includes('Load date backfill: 2 load(s)'));
    });
  } finally {
    await h.stop(srv.child);
  }
  const settled = snapshot();
  srv = await h.startServer(env);
  try {
    await check('a second startup changes nothing', async () => {
      assert.deepStrictEqual(snapshot(), settled);
      assert.strictEqual(h.readRows(dataDir, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'Load date backfilled'")[0].n, 2);
      assert.ok(!srv.output().includes('Load date backfill:'));
    });
  } finally {
    await h.stop(srv.child);
  }

  console.log(`\n${results.length} load-date-required checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
