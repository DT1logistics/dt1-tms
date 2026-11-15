// Item 6 (11/15/2026): drivers may edit a load while it is Draft or Submitted, up until admin approval.
// After approval only the admin may edit, every change is logged in the load history, and the edits
// flow to the settlement and the invoice. Once the driver's weekly settlement is finalized the load is
// locked: no edits, no reject, no delete (enforced on the server). Rejecting a finalized load no
// longer clears its settlement.
// Run: npm test
const assert = require('assert');
const h = require('./helpers/server');

(async () => {
  const { check, results } = h.makeChecker();
  const adminPassword = 'Edit-Lock-Admin-1';
  const driverPassword = 'Edit-Lock-Driver-1';
  const dataDir = h.tempDataDir('dt1-edit-lock-');
  const srv = await h.startServer({ DATA_DIR: dataDir, LOGAN_TMS_PASSWORD: adminPassword, LOGAN_API_TOKEN: '', SESSION_SECRET: 'edit-lock-test' });
  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    const ids = await h.seedBasics(srv.port, dataDir, admin);
    h.setUserPassword(dataDir, 'dana.driver@example.com', driverPassword);
    const driver = (await h.loginAs(srv.port, 'dana.driver@example.com', driverPassword)).jar;
    const dAuth = { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: h.cookieHeader(driver) };
    const aGet = (path) => h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path });
    const dGet = (path) => h.request(srv.port, { Cookie: h.cookieHeader(driver) }, { path });
    const load = (id) => h.readRows(dataDir, 'SELECT * FROM loads WHERE id = ?', [id])[0];
    const audit = (id, action) => h.readRows(dataDir, "SELECT * FROM audit_log WHERE entity_type = 'load' AND entity_id = ? AND action = ? ORDER BY id", [id, action]);
    const base = { load_date: '2026-11-10', project_id: ids.projectId, weight_quantity: '20', rate: '10' };
    async function driverSubmit(ticket) {
      await h.request(srv.port, dAuth, { method: 'POST', path: '/loads', body: h.form(Object.assign({ action: 'submit', ticket_number: ticket }, base)) });
      return h.readRows(dataDir, 'SELECT id FROM loads WHERE ticket_number = ?', [ticket])[0].id;
    }
    const adminSave = (id, fields) => h.request(srv.port, ids.auth, { method: 'POST', path: `/loads/${id}`, body: h.form(Object.assign({ action: 'save', driver_id: ids.driverId }, base, fields)) });

    let id;
    await check('a driver can edit a Submitted load; it stays Submitted and the edit is logged', async () => {
      id = await driverSubmit('LOCK-1');
      const card = await dGet('/loads');
      assert.ok(card.body.includes(`href="/loads/${id}/edit">Edit</a>`));
      const form = await dGet(`/loads/${id}/edit`);
      assert.strictEqual(form.status, 200);
      assert.ok(form.body.includes('>Save Changes</button>'));
      const res = await h.request(srv.port, dAuth, { method: 'POST', path: `/loads/${id}`, body: h.form(Object.assign({ action: 'submit', ticket_number: 'LOCK-1', origin: 'Quarry B' }, base, { weight_quantity: '22' })) });
      assert.strictEqual(res.status, 302);
      const row = load(id);
      assert.strictEqual(row.status, 'submitted');
      assert.strictEqual(Number(row.weight_quantity), 22);
      assert.strictEqual(row.origin, 'Quarry B');
      assert.ok(audit(id, 'Edited').some((e) => /Driver edited the submitted load/.test(e.detail)));
    });

    await check('after approval the driver cannot edit (no link, server refuses)', async () => {
      await h.request(srv.port, ids.auth, { method: 'POST', path: `/loads/${id}/approve`, body: '' });
      assert.strictEqual(load(id).status, 'approved');
      const page = await dGet(`/loads/${id}`);
      assert.ok(!page.body.includes(`/loads/${id}/edit`));
      const edit = await dGet(`/loads/${id}/edit`);
      assert.strictEqual(edit.status, 302);
      const res = await h.request(srv.port, dAuth, { method: 'POST', path: `/loads/${id}`, body: h.form(Object.assign({ action: 'submit', ticket_number: 'HACK' }, base, { weight_quantity: '99' })) });
      assert.strictEqual(res.status, 302);
      const row = load(id);
      assert.strictEqual(row.ticket_number, 'LOCK-1');
      assert.strictEqual(Number(row.weight_quantity), 22);
      assert.strictEqual(row.status, 'approved');
    });

    await check('the admin edits an approved load; every change is in the history and flows to the settlement', async () => {
      const page = await aGet(`/loads/${id}`);
      assert.ok(page.body.includes('id="review_edit_form"'));
      assert.ok(page.body.includes('edit-after-approval-note'));
      assert.ok(!page.body.includes('name="remove_tickets"'), 'ticket files cannot be removed after approval');
      const res = await adminSave(id, { ticket_number: 'LOCK-1A', weight_quantity: '25', rate: '12', origin: 'Quarry B' });
      assert.strictEqual(res.status, 302);
      const row = load(id);
      assert.strictEqual(row.status, 'approved');
      assert.strictEqual(row.ticket_number, 'LOCK-1A');
      const entries = audit(id, 'Edited after approval');
      assert.strictEqual(entries.length, 1);
      const detail = entries[0].detail;
      assert.ok(detail.includes('Ticket #: LOCK-1 → LOCK-1A'), detail);
      assert.ok(detail.includes('Qty/Wet Ton: 22 → 25'), detail);
      assert.ok(detail.includes('Load Rate: $10.00 → $12.00'), detail);
      assert.ok(!detail.includes('Origin'), detail);
      assert.strictEqual(entries[0].actor_name, 'Logan (Operations Manager)');
      assert.ok(entries[0].created_at);
      const history = await aGet(`/loads/${id}`);
      assert.ok(history.body.includes('Edited after approval by Logan (Operations Manager)'));
      // 30% of 25 x $12 = $90.00
      const settlements = await aGet('/settlements');
      assert.ok(settlements.body.includes('Driver Pay $90.00'));
    });

    await check('finalizing the week locks the load: no edit, no reject, no delete (server enforced)', async () => {
      const fin = await h.request(srv.port, ids.auth, { method: 'POST', path: '/settlements/approve-week', body: h.form({ driver_id: ids.driverId, week_start: '2026-11-09' }) });
      assert.strictEqual(fin.status, 302);
      assert.strictEqual(load(id).settlement_status, 'approved');
      const page = await aGet(`/loads/${id}`);
      assert.ok(page.body.includes('load-locked'));
      assert.ok(!page.body.includes('id="review_edit_form"'));
      assert.ok(!page.body.includes('value="rejected"'));
      assert.ok(!page.body.includes('>Delete Load</button>'));
      const before = load(id);
      const edit = await adminSave(id, { ticket_number: 'CHANGED', rate: '50' });
      assert.ok(String(edit.headers.location).includes('saved=locked'));
      const r1 = await h.request(srv.port, ids.auth, { method: 'POST', path: `/loads/${id}/review-decision`, body: h.form({ decision: 'rejected', reason: 'oops' }) });
      assert.ok(String(r1.headers.location).includes('saved=locked'));
      const r2 = await h.request(srv.port, ids.auth, { method: 'POST', path: `/loads/${id}/reject`, body: h.form({ rejection_reason: 'oops' }) });
      assert.ok(String(r2.headers.location).includes('saved=locked'));
      await h.request(srv.port, ids.auth, { method: 'POST', path: `/loads/${id}/delete`, body: '' });
      const after = load(id);
      assert.deepStrictEqual(after, before, 'the finalized load is unchanged');
      assert.strictEqual(after.settlement_status, 'approved', 'reject no longer clears a finalized settlement');
      assert.strictEqual(after.status, 'approved');
      const editPage = await aGet(`/loads/${id}/edit`);
      assert.strictEqual(editPage.status, 302);
      assert.ok(String(editPage.headers.location).includes('saved=locked'));
    });

    await check('an approved load cannot be moved into an already-finalized driver week', async () => {
      h.writeDb(dataDir, (db) => db.prepare("INSERT INTO loads (ticket_number, load_date, driver_id, project_id, weight_quantity, rate, status) VALUES ('MOVE-1', '2026-11-17', ?, ?, 5, 10, 'approved')").run(ids.driverId, ids.projectId));
      const moveId = h.readRows(dataDir, "SELECT id FROM loads WHERE ticket_number = 'MOVE-1'")[0].id;
      const res = await adminSave(moveId, { ticket_number: 'MOVE-1', load_date: '2026-11-12', weight_quantity: '5' });
      assert.strictEqual(res.status, 400);
      assert.ok(res.body.includes('already finalized'));
      assert.strictEqual(load(moveId).load_date, '2026-11-17');
    });
  } finally {
    await h.stop(srv.child);
  }
  console.log(`\n${results.length} load-edit-locking checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
