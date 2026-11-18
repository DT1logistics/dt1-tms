// Fix #5: Finalize All for a Monday–Sunday work week on the admin Settlements
// screen. Active drivers with no loads get a $0.00 settlement. Drivers who still
// have unfinished loads are skipped. Already-finalized rows are not rewritten.
// Run: npm test
const assert = require('assert');
const h = require('./helpers/server');

(async () => {
  const { check, results } = h.makeChecker();
  const adminPassword = 'Finalize-All-Admin-1';
  const readyPassword = 'Finalize-All-Ready-1';
  const nonePassword = 'Finalize-All-None-1';
  const dataDir = h.tempDataDir('dt1-finalize-all-');
  const srv = await h.startServer({
    DATA_DIR: dataDir,
    LOGAN_TMS_PASSWORD: adminPassword,
    LOGAN_API_TOKEN: '',
    SESSION_SECRET: 'finalize-all-test'
  });
  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    const ids = await h.seedBasics(srv.port, dataDir, admin, { driverEmail: 'ready.finalize@example.com' });
    h.setUserPassword(dataDir, 'ready.finalize@example.com', readyPassword);

    async function addDriver(email, first, last) {
      const res = await h.request(srv.port, ids.auth, {
        method: 'POST',
        path: '/drivers',
        body: h.form({ first_name: first, last_name: last, email, phone: '5555550100', pay_percentage: '30' })
      });
      assert.ok(res.status === 200 || res.status === 302, res.body.slice(0, 300));
      return h.readRows(dataDir, 'SELECT id, name FROM users WHERE email = ?', [email])[0];
    }

    const unfinished = await addDriver('unfinished.finalize@example.com', 'Una', 'Finished');
    const noLoads = await addDriver('noloads.finalize@example.com', 'Ned', 'Noloads');
    h.setUserPassword(dataDir, 'noloads.finalize@example.com', nonePassword);
    const inactive = await addDriver('inactive.finalize@example.com', 'Ivy', 'Inactive');
    h.writeDb(dataDir, (database) => {
      database.prepare("UPDATE users SET status = 'inactive' WHERE id = ?").run(inactive.id);
    });

    await h.request(srv.port, ids.auth, {
      method: 'POST', path: '/loads', body: h.form({
        action: 'approve', load_date: '2026-11-10', ticket_number: 'FA-READY',
        project_id: ids.projectId, driver_id: ids.driverId, weight_quantity: '10', rate: '20'
      })
    });
    await h.request(srv.port, ids.auth, {
      method: 'POST', path: '/loads', body: h.form({
        action: 'submit', load_date: '2026-11-11', ticket_number: 'FA-SUB',
        project_id: ids.projectId, driver_id: unfinished.id, weight_quantity: '10', rate: '20'
      })
    });
    await h.request(srv.port, ids.auth, {
      method: 'POST', path: '/loads', body: h.form({
        action: 'draft', load_date: '2026-11-12', ticket_number: 'FA-ASSIGN',
        project_id: ids.projectId, driver_id: unfinished.id, weight_quantity: '10', rate: '20'
      })
    });
    const rejectId = h.readRows(dataDir, "SELECT id FROM loads WHERE ticket_number = 'FA-SUB'")[0].id;
    const rejected = await h.request(srv.port, ids.auth, {
      method: 'POST',
      path: `/loads/${rejectId}/review-decision`,
      body: h.form({ decision: 'rejected', reason: 'Need a clearer ticket' })
    });
    assert.strictEqual(rejected.status, 302);

    // A submitted+accepted load also counts as unfinished (Approved, not yet AFS).
    await h.request(srv.port, ids.auth, {
      method: 'POST', path: '/loads', body: h.form({
        action: 'submit', load_date: '2026-11-13', ticket_number: 'FA-ACCEPT',
        project_id: ids.projectId, driver_id: unfinished.id, weight_quantity: '10', rate: '20'
      })
    });
    const acceptId = h.readRows(dataDir, "SELECT id FROM loads WHERE ticket_number = 'FA-ACCEPT'")[0].id;
    await h.request(srv.port, ids.auth, {
      method: 'POST', path: `/loads/${acceptId}/review-decision`, body: h.form({ decision: 'accepted' })
    });

    const adminCookie = { Cookie: h.cookieHeader(admin) };
    const post = (path, fields) => h.request(srv.port, ids.auth, { method: 'POST', path, body: h.form(fields) });

    await check('Settlements shows Finalize All per week and keeps the per-driver button', async () => {
      const page = await h.request(srv.port, adminCookie, { path: '/settlements' });
      assert.strictEqual(page.status, 200, page.body.slice(0, 300));
      assert.ok(page.body.includes('action="/settlements/finalize-all"'));
      assert.ok(page.body.includes('>Finalize All</button>'));
      assert.ok(page.body.includes("return confirm('Finalize all active drivers for the week of November 9 - November 15?"));
      assert.ok(page.body.includes('>Finalize Weekly Settlement</button>'));
      assert.ok(page.body.includes('action="/settlements/approve-week"'));
      assert.ok(page.body.includes('will be skipped (unfinished loads)'));
      assert.ok(page.body.includes('with no loads will be finalized at $0.00'));
    });

    await check('a driver cannot Finalize All', async () => {
      const driver = (await h.loginAs(srv.port, 'ready.finalize@example.com', readyPassword)).jar;
      const res = await h.request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: h.cookieHeader(driver) }, {
        method: 'POST', path: '/settlements/finalize-all', body: h.form({ week_start: '2026-11-09' })
      });
      assert.strictEqual(res.status, 302);
      assert.ok(!String(res.headers.location || '').includes('saved=finalize-all'));
      assert.strictEqual(h.readRows(dataDir, 'SELECT COUNT(*) AS n FROM driver_settlements')[0].n, 0);
    });

    await check('Finalize All finalizes ready and no-load drivers, skips unfinished, and ignores inactive drivers', async () => {
      const beforeLoads = h.readRows(dataDir, "SELECT id, status, settlement_status, ticket_number FROM loads");
      const res = await post('/settlements/finalize-all', { week_start: '2026-11-11' }); // mid-week date still maps to Mon Nov 9
      assert.strictEqual(res.status, 302, res.body.slice(0, 300));
      assert.ok(String(res.headers.location || '').includes('saved=finalize-all'));
      const page = await h.request(srv.port, adminCookie, { path: res.headers.location });
      assert.strictEqual(page.status, 200, page.body.slice(0, 400));
      assert.ok(page.body.includes('Finalize All for the week of November 9 - November 15'));
      assert.ok(page.body.includes('No loads – $0.00') || page.body.includes('with no loads at $0.00'));
      assert.ok(page.body.includes('skipped'));
      assert.ok(page.body.includes('Una Finished'));
      assert.ok(page.body.includes('Need a clearer ticket') || page.body.includes('Draft – Rejected') || page.body.includes('FA-ASSIGN') || page.body.includes('Assigned') || page.body.includes('Approved') || page.body.includes('FA-ACCEPT'));
      assert.ok(page.body.includes('Draft – Rejected') || page.body.includes('Approved') || page.body.includes('Draft'));
      assert.ok(!page.body.includes('Ivy Inactive'), 'inactive drivers are not included');

      const settlements = h.readRows(dataDir, 'SELECT driver_id, week_start, week_end, status FROM driver_settlements ORDER BY driver_id');
      const byDriver = Object.fromEntries(settlements.map((row) => [String(row.driver_id), row]));
      assert.ok(byDriver[String(ids.driverId)], 'ready driver finalized');
      assert.strictEqual(byDriver[String(ids.driverId)].week_start, '2026-11-09');
      assert.strictEqual(byDriver[String(ids.driverId)].week_end, '2026-11-15');
      assert.strictEqual(byDriver[String(ids.driverId)].status, 'approved');
      assert.ok(byDriver[String(noLoads.id)], 'no-load driver finalized at $0');
      assert.strictEqual(byDriver[String(noLoads.id)].week_start, '2026-11-09');
      assert.ok(!byDriver[String(unfinished.id)], 'unfinished driver was skipped');
      assert.ok(!byDriver[String(inactive.id)], 'inactive driver was not given a $0 settlement');
      assert.strictEqual(settlements.length, 2);

      const readyLoad = h.readRows(dataDir, "SELECT status, settlement_status FROM loads WHERE ticket_number = 'FA-READY'")[0];
      assert.strictEqual(readyLoad.status, 'approved');
      assert.strictEqual(readyLoad.settlement_status, 'approved');
      const afterLoads = h.readRows(dataDir, 'SELECT id, status, settlement_status, ticket_number FROM loads');
      const unfinishedTickets = ['FA-SUB', 'FA-ASSIGN', 'FA-ACCEPT'];
      unfinishedTickets.forEach((ticket) => {
        const before = beforeLoads.find((row) => row.ticket_number === ticket);
        const after = afterLoads.find((row) => row.ticket_number === ticket);
        assert.strictEqual(after.status, before.status, ticket);
        assert.strictEqual(after.settlement_status, before.settlement_status, ticket);
      });

      assert.ok(page.body.includes('No loads – $0.00'));
      const pdf = await h.request(srv.port, adminCookie, { path: `/settlements/pdf?driver_id=${noLoads.id}&week_start=2026-11-09` });
      assert.strictEqual(pdf.status, 200);
      assert.ok(pdf.body.includes('No loads'), pdf.body.slice(0, 200));
      assert.ok(pdf.body.includes('$0.00') || pdf.body.includes('0.00'));

      const none = (await h.loginAs(srv.port, 'noloads.finalize@example.com', nonePassword)).jar;
      const driverPage = await h.request(srv.port, { Cookie: h.cookieHeader(none) }, { path: '/settlements' });
      assert.strictEqual(driverPage.status, 200);
      assert.ok(driverPage.body.includes('No loads – $0.00'));
      assert.ok(driverPage.body.includes('Driver Pay $0.00'));
      const driverPdf = await h.request(srv.port, { Cookie: h.cookieHeader(none) }, { path: '/settlements/pdf?week_start=2026-11-09' });
      assert.strictEqual(driverPdf.status, 200);
      assert.ok(driverPdf.body.includes('No loads'));
    });

    await check('re-running Finalize All is idempotent and does not rewrite existing rows', async () => {
      const before = h.readRows(dataDir, 'SELECT id, driver_id, week_start, approved_at, approved_by, approved_by_name FROM driver_settlements ORDER BY id');
      const res = await post('/settlements/finalize-all', { week_start: '2026-11-09' });
      assert.strictEqual(res.status, 302);
      const page = await h.request(srv.port, adminCookie, { path: res.headers.location });
      assert.ok(page.body.includes('already finalized') && page.body.includes('left unchanged'));
      const after = h.readRows(dataDir, 'SELECT id, driver_id, week_start, approved_at, approved_by, approved_by_name FROM driver_settlements ORDER BY id');
      assert.deepStrictEqual(after, before);
      assert.strictEqual(after.length, 2);
      assert.ok(!h.readRows(dataDir, 'SELECT id FROM driver_settlements WHERE driver_id = ?', [unfinished.id]).length);
    });
  } finally {
    await h.stop(srv.child);
  }
  console.log(`\n${results.length} finalize-all checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
