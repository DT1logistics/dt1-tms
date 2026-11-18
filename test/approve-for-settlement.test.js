// Fix #3: Approve for Settlement is available on every project, including Uber Freight,
// when a load is submitted or Accepted (review_decision = 'accepted'), including
// accepted assigned drafts. Already-approved, settled, rejected, and plain unreviewed
// drafts stay blocked. Run: npm test
const assert = require('assert');
const h = require('./helpers/server');
const { canApproveForSettlement } = require('../lib/load-status');

const AFS_BUTTON = />Approve for Settlement<\/button>/;

function insertLoad(dataDir, fields) {
  const columns = Object.keys(fields);
  h.writeDb(dataDir, (database) => {
    database.prepare(
      `INSERT INTO loads (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    ).run(...columns.map((key) => fields[key]));
  });
  return h.readRows(dataDir, 'SELECT id FROM loads WHERE ticket_number = ?', [fields.ticket_number])[0].id;
}

(async () => {
  const { check, results } = h.makeChecker();

  await check('canApproveForSettlement allows submitted or accepted, and blocks the rest', async () => {
    assert.strictEqual(canApproveForSettlement({ status: 'submitted' }), true);
    assert.strictEqual(canApproveForSettlement({ status: 'submitted', review_decision: 'accepted' }), true);
    assert.strictEqual(canApproveForSettlement({ status: 'draft', review_decision: 'accepted' }), true);
    assert.strictEqual(canApproveForSettlement({ status: 'draft' }), false);
    assert.strictEqual(canApproveForSettlement({ status: 'draft', review_decision: 'rejected' }), false);
    assert.strictEqual(canApproveForSettlement({ status: 'draft', rejection_reason: 'Fix the ticket' }), false);
    assert.strictEqual(canApproveForSettlement({ status: 'submitted', review_decision: 'rejected' }), false);
    assert.strictEqual(canApproveForSettlement({ status: 'approved' }), false);
    assert.strictEqual(canApproveForSettlement({ status: 'approved', review_decision: 'accepted' }), false);
    assert.strictEqual(canApproveForSettlement({ status: 'submitted', settlement_status: 'approved' }), false);
    assert.strictEqual(canApproveForSettlement({ status: 'approved', settlement_status: 'approved' }), false);
    assert.strictEqual(canApproveForSettlement(null), false);
  });

  const adminPassword = 'Approve-Settle-Admin-1';
  const dataDir = h.tempDataDir('dt1-approve-settle-');
  const srv = await h.startServer({
    DATA_DIR: dataDir,
    LOGAN_TMS_PASSWORD: adminPassword,
    LOGAN_API_TOKEN: '',
    SESSION_SECRET: 'approve-for-settlement-test'
  });
  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    const ids = await h.seedBasics(srv.port, dataDir, admin);
    const ufCustomer = await h.request(srv.port, ids.auth, { method: 'POST', path: '/customers', body: h.form({ name: 'Uber Freight' }) });
    const ufCustomerId = String(ufCustomer.headers.location || '').split('/').pop();
    await h.request(srv.port, ids.auth, {
      method: 'POST',
      path: `/customers/${ufCustomerId}/projects`,
      body: h.form({ project_name: 'Madison Heights', default_rate: '12', status: 'active', billing_mode: 'flat_qty_1' })
    });
    const ufProjectId = h.readRows(dataDir, 'SELECT id FROM projects ORDER BY id DESC LIMIT 1')[0].id;
    assert.notStrictEqual(ufProjectId, ids.projectId);
    const adminCookie = { Cookie: h.cookieHeader(admin) };

    const ufDraftId = insertLoad(dataDir, {
      ticket_number: 'T-UF-6',
      load_date: '2026-11-10',
      driver_id: ids.driverId,
      project_id: ufProjectId,
      status: 'draft',
      entry_mode: 'assigned',
      review_decision: 'accepted',
      weight_quantity: 10,
      rate: 12
    });
    const acceptedSubId = insertLoad(dataDir, {
      ticket_number: 'T-43',
      load_date: '2026-11-10',
      driver_id: ids.driverId,
      project_id: ids.projectId,
      status: 'submitted',
      review_decision: 'accepted',
      weight_quantity: 10,
      rate: 12
    });
    const plainDraftId = insertLoad(dataDir, {
      ticket_number: 'T-PLAIN',
      load_date: '2026-11-10',
      driver_id: ids.driverId,
      project_id: ids.projectId,
      status: 'draft',
      weight_quantity: 10,
      rate: 12
    });
    const rejectedId = insertLoad(dataDir, {
      ticket_number: 'T-REJ',
      load_date: '2026-11-10',
      driver_id: ids.driverId,
      project_id: ids.projectId,
      status: 'draft',
      review_decision: 'rejected',
      rejection_reason: 'Fix the ticket',
      weight_quantity: 10,
      rate: 12
    });
    const approvedId = insertLoad(dataDir, {
      ticket_number: 'T-APPR',
      load_date: '2026-11-10',
      driver_id: ids.driverId,
      project_id: ids.projectId,
      status: 'approved',
      weight_quantity: 10,
      rate: 12
    });
    const settledId = insertLoad(dataDir, {
      ticket_number: 'T-SET',
      load_date: '2026-11-10',
      driver_id: ids.driverId,
      project_id: ids.projectId,
      status: 'approved',
      settlement_status: 'approved',
      weight_quantity: 10,
      rate: 12
    });
    const reassignId = insertLoad(dataDir, {
      ticket_number: 'T-UF-44',
      load_date: '2026-11-10',
      driver_id: ids.driverId,
      project_id: ufProjectId,
      status: 'draft',
      entry_mode: 'assigned',
      review_decision: 'accepted',
      review_decision_by_name: 'Label Admin',
      weight_quantity: 10,
      rate: 12
    });
    const rejectAcceptId = insertLoad(dataDir, {
      ticket_number: 'T-ACC-REJ',
      load_date: '2026-11-10',
      driver_id: ids.driverId,
      project_id: ids.projectId,
      status: 'submitted',
      review_decision: 'accepted',
      weight_quantity: 10,
      rate: 12
    });

    async function postApprove(id) {
      return h.request(srv.port, ids.auth, { method: 'POST', path: `/loads/${id}/approve`, body: '' });
    }

    await check('Uber Freight accepted draft shows Approve for Settlement and can be approved', async () => {
      const before = await h.request(srv.port, adminCookie, { path: `/loads/${ufDraftId}` });
      assert.strictEqual(before.status, 200, before.body.slice(0, 300));
      assert.match(before.body, AFS_BUTTON);
      const res = await postApprove(ufDraftId);
      assert.strictEqual(res.status, 302);
      assert.ok(String(res.headers.location || '').includes('saved=approved'));
      const row = h.readRows(dataDir, 'SELECT status, settlement_status, review_decision FROM loads WHERE id = ?', [ufDraftId])[0];
      assert.strictEqual(row.status, 'approved');
      assert.ok(row.settlement_status == null || row.settlement_status === '');
      assert.strictEqual(row.review_decision, 'accepted');
      const after = await h.request(srv.port, adminCookie, { path: `/loads/${ufDraftId}` });
      assert.ok(!AFS_BUTTON.test(after.body), 'button hides after Approve for Settlement');
      assert.ok(after.body.includes('Approved for Settlement'));
    });

    await check('submitted+accepted load shows Approve for Settlement and can be approved', async () => {
      const before = await h.request(srv.port, adminCookie, { path: `/loads/${acceptedSubId}` });
      assert.strictEqual(before.status, 200, before.body.slice(0, 300));
      assert.match(before.body, AFS_BUTTON);
      const res = await postApprove(acceptedSubId);
      assert.strictEqual(res.status, 302);
      assert.ok(String(res.headers.location || '').includes('saved=approved'));
      const row = h.readRows(dataDir, 'SELECT status, review_decision FROM loads WHERE id = ?', [acceptedSubId])[0];
      assert.strictEqual(row.status, 'approved');
      assert.strictEqual(row.review_decision, 'accepted');
      const after = await h.request(srv.port, adminCookie, { path: `/loads/${acceptedSubId}` });
      assert.ok(!AFS_BUTTON.test(after.body));
    });

    await check('Approve for Settlement is blocked on already-approved, settled, rejected, and plain drafts', async () => {
      for (const [id, ticket, expectedStatus, expectedSettlement] of [
        [approvedId, 'T-APPR', 'approved', null],
        [settledId, 'T-SET', 'approved', 'approved'],
        [rejectedId, 'T-REJ', 'draft', null],
        [plainDraftId, 'T-PLAIN', 'draft', null]
      ]) {
        const page = await h.request(srv.port, adminCookie, { path: `/loads/${id}` });
        assert.strictEqual(page.status, 200, `${ticket} ${page.body.slice(0, 300)}`);
        assert.ok(!AFS_BUTTON.test(page.body), `${ticket} should not show Approve for Settlement`);
        const res = await postApprove(id);
        assert.strictEqual(res.status, 302, ticket);
        assert.ok(!String(res.headers.location || '').includes('saved=approved'), ticket);
        const row = h.readRows(dataDir, 'SELECT status, settlement_status FROM loads WHERE id = ?', [id])[0];
        assert.strictEqual(row.status, expectedStatus, ticket);
        assert.strictEqual(row.settlement_status == null ? null : row.settlement_status, expectedSettlement, ticket);
      }
    });

    await check('rejecting an accepted load clears the Accept mark going forward', async () => {
      const res = await h.request(srv.port, ids.auth, {
        method: 'POST',
        path: `/loads/${rejectAcceptId}/review-decision`,
        body: h.form({ decision: 'rejected', reason: 'Need a clearer ticket' })
      });
      assert.strictEqual(res.status, 302);
      const row = h.readRows(dataDir, 'SELECT status, review_decision, rejection_reason FROM loads WHERE id = ?', [rejectAcceptId])[0];
      assert.strictEqual(row.status, 'draft');
      assert.strictEqual(row.review_decision, 'rejected');
      assert.strictEqual(row.rejection_reason, 'Need a clearer ticket');
      const page = await h.request(srv.port, adminCookie, { path: `/loads/${rejectAcceptId}` });
      assert.ok(!AFS_BUTTON.test(page.body));
      assert.ok(page.body.includes('Draft – Rejected'));
    });

    await check('reassigning an accepted draft back to the driver clears the stale Accept mark', async () => {
      const before = h.readRows(dataDir, 'SELECT review_decision, status FROM loads WHERE id = ?', [reassignId])[0];
      assert.strictEqual(before.review_decision, 'accepted');
      assert.strictEqual(before.status, 'draft');
      const res = await h.request(srv.port, ids.auth, {
        method: 'POST',
        path: `/loads/${reassignId}`,
        body: h.form({
          admin_mode: 'assign',
          action: 'draft',
          driver_id: ids.driverId,
          project_id: ufProjectId,
          ticket_number: 'T-UF-44',
          load_date: '2026-11-10',
          weight_quantity: '10',
          rate: '12'
        })
      });
      assert.strictEqual(res.status, 302, res.body.slice(0, 300));
      const row = h.readRows(dataDir, 'SELECT status, entry_mode, review_decision FROM loads WHERE id = ?', [reassignId])[0];
      assert.strictEqual(row.status, 'draft');
      assert.strictEqual(row.entry_mode, 'assigned');
      assert.ok(row.review_decision == null || row.review_decision === '');
      const page = await h.request(srv.port, adminCookie, { path: `/loads/${reassignId}` });
      assert.ok(page.body.includes('>Draft<') || page.body.includes('Draft</span>'));
      assert.ok(!page.body.includes('class="status approved">Approved<'), 'reassigned draft is not still Approved');
      assert.ok(!AFS_BUTTON.test(page.body), 'plain reassigned draft cannot be approved for settlement');
    });
  } finally {
    await h.stop(srv.child);
  }

  console.log(`\n${results.length} approve-for-settlement checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
