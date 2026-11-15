// Item 8 (11/15/2026): the Review Load page keeps the "Accept or reject" box and Delete Load;
// the duplicate second box ("Reject to Draft") is gone. "Reject load" now also does what
// Reject to Draft did: a Submitted or Approved load goes back to the driver as Draft with the
// reason, approval and settlement marks cleared. Run: npm test
const assert = require('assert');
const h = require('./helpers/server');

(async () => {
  const { check, results } = h.makeChecker();
  const adminPassword = 'Reject-Cleanup-Admin-1';
  const driverPassword = 'Reject-Cleanup-Driver-1';
  const dataDir = h.tempDataDir('dt1-reject-cleanup-');
  const srv = await h.startServer({ DATA_DIR: dataDir, LOGAN_TMS_PASSWORD: adminPassword, LOGAN_API_TOKEN: '', SESSION_SECRET: 'reject-cleanup-test' });
  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    const ids = await h.seedBasics(srv.port, dataDir, admin);
    h.setUserPassword(dataDir, 'dana.driver@example.com', driverPassword);
    const driver = (await h.loginAs(srv.port, 'dana.driver@example.com', driverPassword)).jar;
    const row = (id) => h.readRows(dataDir, 'SELECT * FROM loads WHERE id = ?', [id])[0];
    async function create(ticket, action) {
      await h.request(srv.port, ids.auth, { method: 'POST', path: '/loads', body: h.form({
        action, load_date: '2026-11-10', ticket_number: ticket, project_id: ids.projectId, driver_id: ids.driverId, weight_quantity: '1', rate: '10'
      }) });
      return h.readRows(dataDir, 'SELECT id FROM loads WHERE ticket_number = ?', [ticket])[0].id;
    }
    const reject = (id, reason) => h.request(srv.port, ids.auth, { method: 'POST', path: `/loads/${id}/review-decision`, body: h.form({ decision: 'rejected', reason }) });

    await check('Review Load page: one Accept or reject box plus Delete Load, no Reject to Draft box', async () => {
      for (const action of ['submit', 'approve']) {
        const id = await create('PAGE-' + action, action);
        const page = await h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path: `/loads/${id}` });
        assert.ok(page.body.includes('<h2>Accept or reject</h2>'));
        assert.ok(page.body.includes('>Reject load</button>'));
        assert.ok(page.body.includes('>Accept load</button>'));
        assert.ok(!page.body.includes('Reject to Draft'));
        assert.ok(!page.body.includes(`action="/loads/${id}/reject"`));
        assert.ok(!page.body.includes('name="rejection_reason"'));
        if (action === 'submit') assert.ok(page.body.includes('>Delete Load</button>'));
      }
    });

    await check('Reject load on a Submitted load sends it back to the driver as Draft with the reason', async () => {
      const id = await create('REJ-SUB', 'submit');
      const res = await reject(id, 'Ticket photo is blurry');
      assert.strictEqual(res.status, 302);
      assert.ok(String(res.headers.location).includes('saved=review-rejected'));
      const r = row(id);
      assert.strictEqual(r.status, 'draft');
      assert.strictEqual(r.rejection_reason, 'Ticket photo is blurry');
      assert.strictEqual(r.review_decision, 'rejected');
      assert.strictEqual(r.review_decision_reason, 'Ticket photo is blurry');
      assert.strictEqual(r.rejected_by_name, 'Logan (Operations Manager)');
      assert.ok(r.rejected_at);
      const audit = h.readRows(dataDir, "SELECT action, detail FROM audit_log WHERE entity_type = 'load' AND entity_id = ? ORDER BY id", [id]);
      assert.ok(audit.some((a) => a.action === 'Rejected load' && a.detail === 'Ticket photo is blurry'));
      assert.ok(audit.some((a) => a.action === 'Rejected' && a.detail === 'Sent back to draft: Ticket photo is blurry'));
      const flash = await h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path: res.headers.location });
      assert.ok(flash.body.includes('It was sent back to the driver as Draft.'));
      // The driver sees it in Drafts with the reason and can fix it.
      const driverPage = await h.request(srv.port, { Cookie: h.cookieHeader(driver) }, { path: `/loads/${id}/edit` });
      assert.strictEqual(driverPage.status, 200);
      assert.ok(driverPage.body.includes('Ticket photo is blurry'));
    });

    await check('Reject load on an Approved for Settlement load clears approval and settlement marks', async () => {
      const id = await create('REJ-APP', 'approve');
      assert.strictEqual(row(id).status, 'approved');
      assert.ok(row(id).approved_by_name);
      await reject(id, 'Wrong project');
      const r = row(id);
      assert.strictEqual(r.status, 'draft');
      assert.strictEqual(r.approved_by, null);
      assert.strictEqual(r.approved_by_name, null);
      assert.strictEqual(r.approved_at, null);
      assert.strictEqual(r.settlement_status, null);
      assert.strictEqual(r.rejection_reason, 'Wrong project');
    });

    await check('a reason is still required, and Accept does not change status', async () => {
      const id = await create('REJ-NOREASON', 'submit');
      const res = await reject(id, '  ');
      assert.ok(String(res.headers.location).includes('need-reason'));
      assert.strictEqual(row(id).status, 'submitted');
      await h.request(srv.port, ids.auth, { method: 'POST', path: `/loads/${id}/review-decision`, body: h.form({ decision: 'accepted' }) });
      assert.strictEqual(row(id).status, 'submitted');
      assert.strictEqual(row(id).review_decision, 'accepted');
    });

    await check('rejecting a Draft only records the decision (nothing to send back)', async () => {
      const id = await create('REJ-DRAFT', 'draft');
      await reject(id, 'Not needed');
      const r = row(id);
      assert.strictEqual(r.status, 'draft');
      assert.strictEqual(r.review_decision, 'rejected');
      assert.strictEqual(r.rejection_reason, null);
    });
  } finally {
    await h.stop(srv.child);
  }
  console.log(`\n${results.length} review-reject-cleanup checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
