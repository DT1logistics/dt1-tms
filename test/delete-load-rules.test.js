// Item 9 (11/15/2026): Delete Load is only available while a load is still on the Load screen
// (Draft or Submitted). Once it is Approved for Settlement (or Settled) the button is gone and
// the server refuses. Delete stays a permanent erase (Kammy's decision, for duplicates), with an
// "Are you sure? This cannot be undone" confirmation and an audit entry that survives the delete.
// Run: npm test
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers/server');

(async () => {
  const { check, results } = h.makeChecker();
  const adminPassword = 'Delete-Rules-Admin-1';
  const driverPassword = 'Delete-Rules-Driver-1';
  const dataDir = h.tempDataDir('dt1-delete-rules-');
  const srv = await h.startServer({ DATA_DIR: dataDir, LOGAN_TMS_PASSWORD: adminPassword, LOGAN_API_TOKEN: '', SESSION_SECRET: 'delete-rules-test' });
  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    const ids = await h.seedBasics(srv.port, dataDir, admin);
    h.setUserPassword(dataDir, 'dana.driver@example.com', driverPassword);
    const driver = (await h.loginAs(srv.port, 'dana.driver@example.com', driverPassword)).jar;
    const count = (id) => h.readRows(dataDir, 'SELECT COUNT(*) AS n FROM loads WHERE id = ?', [id])[0].n;
    async function create(ticket, action) {
      await h.request(srv.port, ids.auth, { method: 'POST', path: '/loads', body: h.form({
        action, load_date: '2026-11-10', ticket_number: ticket, project_id: ids.projectId, driver_id: ids.driverId, weight_quantity: '1', rate: '10'
      }) });
      return h.readRows(dataDir, 'SELECT id FROM loads WHERE ticket_number = ?', [ticket])[0].id;
    }
    const page = (id) => h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path: `/loads/${id}` });
    const del = (jar, id) => h.request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: h.cookieHeader(jar) }, { method: 'POST', path: `/loads/${id}/delete`, body: '' });

    await check('Draft and Submitted loads show Delete Load with the "Are you sure? This cannot be undone" confirmation', async () => {
      for (const action of ['draft', 'submit']) {
        const id = await create('SHOW-' + action, action);
        const p = await page(id);
        assert.ok(p.body.includes('>Delete Load</button>'), action);
        assert.ok(p.body.includes("confirm('Are you sure? This cannot be undone."), action);
      }
    });

    await check('a duplicate Submitted load is permanently erased, and the deletion is logged', async () => {
      const id = await create('DUP-1', 'submit');
      h.writeDb(dataDir, (db) => {
        db.prepare("INSERT INTO documents (load_id, filename, original_name, category) VALUES (?, 'dup-ticket.pdf', 'dup.pdf', 'load_document')").run(id);
      });
      fs.writeFileSync(path.join(dataDir, 'uploads', 'dup-ticket.pdf'), 'pdf');
      const res = await del(admin, id);
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.location, '/loads?deleted=1');
      assert.strictEqual(count(id), 0);
      assert.strictEqual(h.readRows(dataDir, 'SELECT COUNT(*) AS n FROM documents WHERE load_id = ?', [id])[0].n, 0);
      assert.ok(!fs.existsSync(path.join(dataDir, 'uploads', 'dup-ticket.pdf')));
      const audit = h.readRows(dataDir, "SELECT actor_name, action, detail, created_at FROM audit_log WHERE entity_type = 'load' AND entity_id = ? AND action = 'Deleted load (permanent)'", [id]);
      assert.strictEqual(audit.length, 1);
      assert.strictEqual(audit[0].actor_name, 'Logan (Operations Manager)');
      assert.ok(audit[0].detail.includes(`Load #${id}`) && audit[0].detail.includes('ticket DUP-1') && audit[0].detail.includes('1 ticket file'));
      assert.ok(audit[0].created_at);
      assert.ok(srv.output().includes(`Load deleted (permanent) by Logan (Operations Manager)`));
    });

    await check('Approved for Settlement loads hide Delete Load and the server refuses to delete', async () => {
      const id = await create('APPROVED', 'approve');
      const p = await page(id);
      assert.ok(!p.body.includes('>Delete Load</button>'));
      assert.ok(!p.body.includes(`/loads/${id}/delete`));
      assert.ok(p.body.includes('Delete Load is not available after a load is Approved for Settlement.'));
      const res = await del(admin, id);
      assert.strictEqual(res.status, 302);
      assert.ok(String(res.headers.location).includes('delete-blocked'));
      assert.strictEqual(count(id), 1);
      const blocked = await page(id);
      assert.ok(blocked.body.includes('cannot be deleted'));
    });

    await check('Settled loads cannot be deleted either', async () => {
      const id = await create('SETTLED', 'approve');
      const res = await h.request(srv.port, ids.auth, { method: 'POST', path: '/settlements/approve-week', body: h.form({ driver_id: ids.driverId, week_start: '2026-11-09' }) });
      assert.strictEqual(res.status, 302);
      assert.strictEqual(h.readRows(dataDir, 'SELECT settlement_status FROM loads WHERE id = ?', [id])[0].settlement_status, 'approved');
      await del(admin, id);
      assert.strictEqual(count(id), 1);
    });

    await check('drivers cannot delete', async () => {
      const id = await create('DRV-DEL', 'draft');
      const res = await del(driver, id);
      assert.strictEqual(res.status, 302);
      assert.strictEqual(count(id), 1);
    });
  } finally {
    await h.stop(srv.child);
  }
  console.log(`\n${results.length} delete-load-rules checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
