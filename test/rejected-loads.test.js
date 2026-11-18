// Fix #4: rejected loads are surfaced on the driver's Home and Loads screens.
// The driver sees only their own Draft – Rejected loads, with the reason and
// a link to edit and resubmit. Rejection history is kept; resubmit clears the
// current review_decision so the load leaves the section. Run: npm test
const assert = require('assert');
const h = require('./helpers/server');
const { isRejectedDraft, loadStatusLabel } = require('../lib/load-status');

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

  await check('isRejectedDraft matches current Draft – Rejected loads only', async () => {
    assert.strictEqual(isRejectedDraft({ status: 'draft', review_decision: 'rejected' }), true);
    assert.strictEqual(isRejectedDraft({ status: 'draft', rejection_reason: 'Fix the ticket' }), true);
    assert.strictEqual(isRejectedDraft({ status: 'draft', rejected_at: '2026-11-16T12:00:00Z' }), true);
    assert.strictEqual(isRejectedDraft({ status: 'submitted', review_decision: 'rejected', rejection_reason: 'old' }), false);
    assert.strictEqual(isRejectedDraft({ status: 'submitted', rejection_reason: 'old' }), false);
    assert.strictEqual(isRejectedDraft({ status: 'draft' }), false);
    assert.strictEqual(isRejectedDraft({ status: 'draft', review_decision: 'accepted', rejection_reason: 'old' }), false);
    assert.strictEqual(loadStatusLabel('submitted', null, { rejection_reason: 'old' }), 'Submitted – Pending Approval');
  });

  const adminPassword = 'Rejected-Loads-Admin-1';
  const driverPassword = 'Rejected-Loads-Driver-1';
  const otherPassword = 'Rejected-Loads-Other-1';
  const dataDir = h.tempDataDir('dt1-rejected-loads-');
  const srv = await h.startServer({
    DATA_DIR: dataDir,
    LOGAN_TMS_PASSWORD: adminPassword,
    LOGAN_API_TOKEN: '',
    SESSION_SECRET: 'rejected-loads-test'
  });
  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    const ids = await h.seedBasics(srv.port, dataDir, admin, { driverEmail: 'riley.rejected@example.com' });
    h.setUserPassword(dataDir, 'riley.rejected@example.com', driverPassword);
    await h.request(srv.port, ids.auth, {
      method: 'POST',
      path: '/drivers',
      body: h.form({ first_name: 'Other', last_name: 'Driver', email: 'other.rejected@example.com', phone: '5555550199', pay_percentage: '30' })
    });
    const otherId = h.readRows(dataDir, "SELECT id FROM users WHERE email = 'other.rejected@example.com'")[0].id;
    h.setUserPassword(dataDir, 'other.rejected@example.com', otherPassword);

    const ufCustomer = await h.request(srv.port, ids.auth, { method: 'POST', path: '/customers', body: h.form({ name: 'Uber Freight' }) });
    const ufCustomerId = String(ufCustomer.headers.location || '').split('/').pop();
    await h.request(srv.port, ids.auth, {
      method: 'POST',
      path: `/customers/${ufCustomerId}/projects`,
      body: h.form({ project_name: 'Madison Heights', default_rate: '12', status: 'active' })
    });
    const ufProjectId = h.readRows(dataDir, 'SELECT id FROM projects ORDER BY id DESC LIMIT 1')[0].id;

    const mineId = insertLoad(dataDir, {
      ticket_number: 'T-REJ-MINE',
      load_date: '2026-11-10',
      driver_id: ids.driverId,
      project_id: ids.projectId,
      status: 'draft',
      review_decision: 'rejected',
      rejection_reason: 'Ticket photo is blurry',
      rejected_at: '2026-11-16 15:30:00',
      weight_quantity: 10,
      rate: 12
    });
    const ufId = insertLoad(dataDir, {
      ticket_number: 'T-REJ-UF',
      load_date: '2026-11-11',
      driver_id: ids.driverId,
      project_id: ufProjectId,
      status: 'draft',
      entry_mode: 'assigned',
      review_decision: 'rejected',
      rejection_reason: 'Need a clearer BOL',
      rejected_at: '2026-11-16 16:00:00',
      weight_quantity: 10,
      rate: 12
    });
    const resubmitId = insertLoad(dataDir, {
      ticket_number: 'T-REJ-RESUB',
      load_date: '2026-11-12',
      driver_id: ids.driverId,
      project_id: ids.projectId,
      status: 'draft',
      review_decision: 'rejected',
      review_decision_reason: 'Wrong project',
      rejection_reason: 'Wrong project',
      rejected_at: '2026-11-16 17:00:00',
      rejected_by_name: 'Logan (Operations Manager)',
      weight_quantity: 10,
      rate: 12
    });
    const otherLoadId = insertLoad(dataDir, {
      ticket_number: 'T-REJ-OTHER',
      load_date: '2026-11-10',
      driver_id: otherId,
      project_id: ids.projectId,
      status: 'draft',
      review_decision: 'rejected',
      rejection_reason: 'Other driver only',
      rejected_at: '2026-11-16 18:00:00',
      weight_quantity: 10,
      rate: 12
    });
    insertLoad(dataDir, {
      ticket_number: 'T-PLAIN',
      load_date: '2026-11-10',
      driver_id: ids.driverId,
      project_id: ids.projectId,
      status: 'draft',
      weight_quantity: 10,
      rate: 12
    });

    const driver = (await h.loginAs(srv.port, 'riley.rejected@example.com', driverPassword)).jar;
    const driverCookie = { Cookie: h.cookieHeader(driver) };
    const other = (await h.loginAs(srv.port, 'other.rejected@example.com', otherPassword)).jar;
    const otherCookie = { Cookie: h.cookieHeader(other) };
    const adminCookie = { Cookie: h.cookieHeader(admin) };

    await check('driver Home and Loads show a Rejected section for their loads only', async () => {
      for (const pathName of ['/', '/loads']) {
        const page = await h.request(srv.port, driverCookie, { path: pathName });
        assert.strictEqual(page.status, 200, `${pathName} ${page.body.slice(0, 300)}`);
        assert.ok(page.body.includes('id="rejected-loads-banner"'), pathName);
        assert.ok(page.body.includes('Rejected – needs your attention'), pathName);
        assert.ok(page.body.includes('Draft – Rejected'), pathName);
        assert.ok(page.body.includes('Ticket photo is blurry'), pathName);
        assert.ok(page.body.includes('Need a clearer BOL'), pathName);
        assert.ok(page.body.includes('Wrong project'), pathName);
        assert.ok(page.body.includes(`data-rejected-load="${mineId}"`), pathName);
        assert.ok(page.body.includes(`data-rejected-load="${ufId}"`), pathName);
        assert.ok(page.body.includes(`/loads/${mineId}/edit`), pathName);
        assert.ok(page.body.includes(`/loads/${ufId}/edit`), pathName);
        assert.ok(page.body.includes('Open and resubmit'), pathName);
        assert.ok(page.body.includes('Madison Heights'), pathName);
        assert.ok(!page.body.includes('Other driver only'), pathName);
        assert.ok(!page.body.includes('T-REJ-OTHER'), pathName);
        assert.ok(page.body.includes('class="badge red nav-badge">3<'), `${pathName} nav badge`);
      }
    });

    await check('another driver only sees their own rejected load and badge count', async () => {
      const page = await h.request(srv.port, otherCookie, { path: '/loads' });
      assert.strictEqual(page.status, 200);
      assert.ok(page.body.includes('Other driver only'));
      assert.ok(page.body.includes('T-REJ-OTHER') || page.body.includes(`/loads/${otherLoadId}/edit`));
      assert.ok(!page.body.includes('Ticket photo is blurry'));
      assert.ok(!page.body.includes('Need a clearer BOL'));
      assert.ok(page.body.includes('class="badge red nav-badge">1<'));
    });

    await check('an admin reject without a reason is refused, and a draft reject saves the reason', async () => {
      await h.request(srv.port, ids.auth, { method: 'POST', path: '/loads', body: h.form({
        action: 'submit', load_date: '2026-11-13', ticket_number: 'T-NEED-REASON', project_id: ids.projectId, driver_id: ids.driverId, weight_quantity: '1', rate: '10'
      }) });
      const needId = h.readRows(dataDir, "SELECT id FROM loads WHERE ticket_number = 'T-NEED-REASON'")[0].id;
      const missingDecision = await h.request(srv.port, ids.auth, {
        method: 'POST', path: `/loads/${needId}/review-decision`, body: h.form({ decision: 'rejected', reason: '   ' })
      });
      assert.ok(String(missingDecision.headers.location || '').includes('need-reason'));
      const missingReject = await h.request(srv.port, ids.auth, {
        method: 'POST', path: `/loads/${needId}/reject`, body: h.form({ rejection_reason: '' })
      });
      assert.ok(String(missingReject.headers.location || '').includes('need-reason'));
      const still = h.readRows(dataDir, 'SELECT status, review_decision, rejection_reason FROM loads WHERE id = ?', [needId])[0];
      assert.strictEqual(still.status, 'submitted');
      assert.ok(!still.review_decision);
      assert.ok(!still.rejection_reason);

      const form = await h.request(srv.port, adminCookie, { path: `/loads/${needId}` });
      assert.ok(form.body.includes('Reason (required to reject)'));
      assert.ok(form.body.includes('A rejection reason is required.'));

      await h.request(srv.port, ids.auth, { method: 'POST', path: '/loads', body: h.form({
        action: 'draft', load_date: '2026-11-13', ticket_number: 'T-DRAFT-REJ', project_id: ids.projectId, driver_id: ids.driverId, weight_quantity: '1', rate: '10'
      }) });
      const draftId = h.readRows(dataDir, "SELECT id FROM loads WHERE ticket_number = 'T-DRAFT-REJ'")[0].id;
      const rejected = await h.request(srv.port, ids.auth, {
        method: 'POST', path: `/loads/${draftId}/review-decision`, body: h.form({ decision: 'rejected', reason: 'Missing ticket file' })
      });
      assert.strictEqual(rejected.status, 302);
      const row = h.readRows(dataDir, 'SELECT status, review_decision, rejection_reason, rejected_at FROM loads WHERE id = ?', [draftId])[0];
      assert.strictEqual(row.status, 'draft');
      assert.strictEqual(row.review_decision, 'rejected');
      assert.strictEqual(row.rejection_reason, 'Missing ticket file');
      assert.ok(row.rejected_at);
    });

    await check('resubmitting leaves the rejected section and keeps the rejection history', async () => {
      const beforePage = await h.request(srv.port, driverCookie, { path: '/loads' });
      assert.ok(beforePage.body.includes('Wrong project'));
      const res = await h.request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: h.cookieHeader(driver) }, {
        method: 'POST',
        path: `/loads/${resubmitId}`,
        body: h.form({
          action: 'submit',
          load_date: '2026-11-12',
          ticket_number: 'T-REJ-RESUB',
          project_id: ids.projectId,
          weight_quantity: '10',
          rate: '12'
        })
      });
      assert.strictEqual(res.status, 302, res.body.slice(0, 300));
      const row = h.readRows(dataDir, 'SELECT status, review_decision, rejection_reason, rejected_at, rejected_by_name FROM loads WHERE id = ?', [resubmitId])[0];
      assert.strictEqual(row.status, 'submitted');
      assert.ok(row.review_decision == null || row.review_decision === '');
      assert.strictEqual(row.rejection_reason, 'Wrong project');
      assert.ok(row.rejected_at);
      assert.strictEqual(row.rejected_by_name, 'Logan (Operations Manager)');
      const after = await h.request(srv.port, driverCookie, { path: '/loads' });
      assert.ok(after.body.includes('id="rejected-loads-banner"'), 'rejected section remains for the other rejected loads');
      assert.ok(!after.body.includes(`data-rejected-load="${resubmitId}"`), 'resubmitted load left the rejected section');
      assert.ok(after.body.includes(`data-rejected-load="${mineId}"`));
      assert.ok(after.body.includes(`data-rejected-load="${ufId}"`));
      assert.ok(after.body.includes('Ticket photo is blurry'));
      assert.ok(after.body.includes('Missing ticket file'));
      assert.ok(after.body.includes('Submitted – Pending Approval'));
      assert.ok(after.body.includes('class="badge red nav-badge">3<'), 'badge is remaining current rejections only');
    });
  } finally {
    await h.stop(srv.child);
  }

  console.log(`\n${results.length} rejected-loads checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
