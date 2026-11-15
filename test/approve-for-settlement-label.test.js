// Item 7 (11/15/2026): the Review Load button that approves a submitted load for settlement
// reads "Approve for Settlement". The New Load form's approve button reads
// "Submit & Approve for Settlement" (11/15/2026, with items 5/6/10). Run: npm test
const assert = require('assert');
const h = require('./helpers/server');

(async () => {
  const { check, results } = h.makeChecker();
  const adminPassword = 'Approve-Label-Admin-1';
  const dataDir = h.tempDataDir('dt1-approve-label-');
  const srv = await h.startServer({ DATA_DIR: dataDir, LOGAN_TMS_PASSWORD: adminPassword, LOGAN_API_TOKEN: '', SESSION_SECRET: 'approve-label-test' });
  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    const ids = await h.seedBasics(srv.port, dataDir, admin);
    await h.request(srv.port, ids.auth, { method: 'POST', path: '/loads', body: h.form({
      action: 'submit', load_date: '2026-11-10', ticket_number: 'APPROVE-ME', project_id: ids.projectId, driver_id: ids.driverId, weight_quantity: '1', rate: '10'
    }) });
    const id = h.readRows(dataDir, "SELECT id FROM loads WHERE ticket_number = 'APPROVE-ME'")[0].id;
    await check('submitted load shows "Approve for Settlement", and it approves the load', async () => {
      const page = await h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path: `/loads/${id}` });
      assert.match(page.body, /<form method="POST" action="\/loads\/\d+\/approve">\s*<button class="approve" type="submit">Approve for Settlement<\/button>/);
      assert.ok(!/>Approve<\/button>/.test(page.body));
      const res = await h.request(srv.port, ids.auth, { method: 'POST', path: `/loads/${id}/approve`, body: '' });
      assert.strictEqual(res.status, 302);
      assert.strictEqual(h.readRows(dataDir, 'SELECT status FROM loads WHERE id = ?', [id])[0].status, 'approved');
      const after = await h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path: `/loads/${id}` });
      assert.ok(!after.body.includes('>Approve for Settlement</button>'), 'button only shows on submitted loads');
    });
    await check('New Load form: the approve button reads "Submit & Approve for Settlement"', async () => {
      const page = await h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path: '/loads/new' });
      assert.strictEqual(page.status, 200);
      assert.ok(page.body.includes('<button type="submit" name="action" value="approve" data-admin-mode="enter">Submit &amp; Approve for Settlement</button>'));
      assert.ok(!page.body.includes('Submit &amp; Approve Load'));
      const res = await h.request(srv.port, ids.auth, { method: 'POST', path: '/loads', body: h.form({
        action: 'approve', load_date: '2026-11-11', ticket_number: 'NEW-APPROVE', project_id: ids.projectId, driver_id: ids.driverId, weight_quantity: '1', rate: '10'
      }) });
      assert.strictEqual(res.status, 302);
      assert.strictEqual(h.readRows(dataDir, "SELECT status FROM loads WHERE ticket_number = 'NEW-APPROVE'")[0].status, 'approved');
    });
  } finally {
    await h.stop(srv.child);
  }
  console.log(`\n${results.length} approve-for-settlement-label checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
