// Load status labels are display text only.
// draft, submitted, and approved stay the stored values. Settled is approved
// plus an approved driver settlement. Run: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { loadStatusLabel } = require('../lib/load-status');

const LABELS = {
  draft: 'Draft',
  submitted: 'Submitted, pending approval',
  approved: 'Approved for Settlement',
  settled: 'Settled'
};

const results = [];
async function check(name, fn) {
  await fn();
  results.push(name);
  console.log('ok -', name);
}

function request(port, headers, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const body = o.body == null ? null : Buffer.from(o.body);
    const reqHeaders = Object.assign({}, headers || {});
    if (body && !reqHeaders['Content-Length'] && !reqHeaders['content-length']) reqHeaders['Content-Length'] = body.length;
    const req = http.request({
      host: '127.0.0.1', port, method: o.method || 'GET', path: o.path || '/', headers: reqHeaders
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body || undefined);
  });
}

function form(fields) {
  return Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v == null ? '' : v)}`).join('&');
}

function remember(jar, res) {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  list.forEach((line) => {
    const part = String(line).split(';')[0];
    jar[part.split('=')[0]] = part;
  });
}

function cookieHeader(jar) { return Object.values(jar).join('; '); }

function startServer(env) {
  return new Promise((resolve, reject) => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        REDIS_URL: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '',
        TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_FROM_NUMBER: '',
        LOGAN_WEBHOOK_URL: '', LOGAN_WEBHOOK_KEY: '',
        RESET_USER_EMAIL: '', RESET_USER_TEMP_PASSWORD: '',
        PORT: String(port),
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 20000);
    const onData = (chunk) => {
      out += chunk;
      if (out.includes(`running on port ${port}`)) {
        clearTimeout(timer);
        resolve({ child, port, output: () => out });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${out}`)); });
  });
}

function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.removeAllListeners('exit');
    child.on('exit', resolve);
    child.kill('SIGTERM');
  });
}

function readRows(dataDir, sql, params) {
  const database = new Database(path.join(dataDir, 'dt1.db'), { readonly: true, fileMustExist: true });
  try { return database.prepare(sql).all(...(params || [])); } finally { database.close(); }
}

function writeDb(dataDir, fn) {
  const database = new Database(path.join(dataDir, 'dt1.db'));
  try { fn(database); } finally { database.close(); }
}

function badge(status, label) {
  return `class="status ${status}">${label}<`;
}

function assertHasBadge(html, status, label) {
  assert.ok(html.includes(badge(status, label)), `missing ${label} badge`);
}

function assertNoLegacyStatus(html, where) {
  [
    'Approved (Pending Settlement)',
    'Pending Driver Settlement Approval',
    'Pending review',
    'Load approved',
    'pending driver settlement',
    'Included in the approved driver settlement',
    '>Submitted<',
    '>Approved<'
  ].forEach((old) => {
    assert.ok(!html.includes(old), `${where} still shows ${old}`);
  });
}

(async () => {
  await check('the four load status labels', async () => {
    assert.strictEqual(loadStatusLabel('draft', null), LABELS.draft);
    assert.strictEqual(loadStatusLabel('draft', ''), LABELS.draft);
    assert.strictEqual(loadStatusLabel('draft', 'approved'), LABELS.draft);
    assert.strictEqual(loadStatusLabel('submitted', null), LABELS.submitted);
    assert.strictEqual(loadStatusLabel('submitted', ''), LABELS.submitted);
    assert.strictEqual(loadStatusLabel('submitted', 'approved'), LABELS.submitted);
    assert.strictEqual(loadStatusLabel('approved', null), LABELS.approved);
    assert.strictEqual(loadStatusLabel('approved', ''), LABELS.approved);
    assert.strictEqual(loadStatusLabel('approved', 'pending'), LABELS.approved);
    assert.strictEqual(loadStatusLabel('approved', undefined), LABELS.approved);
    assert.strictEqual(loadStatusLabel('approved', 'approved'), LABELS.settled);
    assert.strictEqual(loadStatusLabel('', null), LABELS.draft);
    assert.strictEqual(loadStatusLabel(null, null), LABELS.draft);
  });

  const adminPassword = 'Label-Admin-1';
  const driverPassword = 'Driver-Label-1';
  const token = `label-${'t'.repeat(40)}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-load-labels-'));
  new Database(path.join(dataDir, 'dt1.db')).close();
  const srv = await startServer({
    DATA_DIR: dataDir,
    LOGAN_TMS_PASSWORD: adminPassword,
    LOGAN_API_TOKEN: token,
    SESSION_SECRET: 'load-status-labels-test'
  });
  try {
    const admin = {};
    const login = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded' }, {
      method: 'POST', path: '/login', body: form({ email: 'david.dt1@mail.grokbot.com', password: adminPassword })
    });
    assert.strictEqual(login.status, 302);
    remember(admin, login);
    const auth = { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) };

    const customer = await request(srv.port, auth, { method: 'POST', path: '/customers', body: form({ name: 'Label Haul' }) });
    const customerId = String(customer.headers.location || '').split('/').pop();
    await request(srv.port, auth, {
      method: 'POST',
      path: `/customers/${customerId}/projects`,
      body: form({ project_name: 'Yard', default_rate: '12', status: 'active' })
    });
    const projectId = readRows(dataDir, 'SELECT id FROM projects ORDER BY id DESC LIMIT 1')[0].id;
    const driverRes = await request(srv.port, auth, {
      method: 'POST',
      path: '/drivers',
      body: form({ first_name: 'Riley', last_name: 'Hauler', email: 'riley.labels@example.com', phone: '5555550142', pay_percentage: '30' })
    });
    assert.ok(driverRes.status === 200 || driverRes.status === 302, driverRes.body.slice(0, 300));
    const driverId = readRows(dataDir, "SELECT id FROM users WHERE email = 'riley.labels@example.com'")[0].id;

    writeDb(dataDir, (database) => {
      database.prepare('UPDATE users SET password = ?, must_change_password = 0, temp_password = NULL WHERE id = ?')
        .run(bcrypt.hashSync(driverPassword, 10), driverId);
      const insert = database.prepare(`
        INSERT INTO loads (
          ticket_number, load_date, driver_id, project_id, status, settlement_status,
          review_status, review_notes, review_decision, review_decision_reason, rejection_reason,
          weight_quantity, rate
        ) VALUES (?, '2026-11-10', ?, ?, ?, ?, ?, ?, ?, ?, ?, 10, 12)
      `);
      insert.run('T-DRAFT', driverId, projectId, 'draft', null, 'none', null, 'rejected', 'Missing BOL', 'Fix the ticket');
      insert.run('T-SUB', driverId, projectId, 'submitted', null, 'none', null, null, null, null);
      insert.run('T-FLAG', driverId, projectId, 'submitted', null, 'flagged_missing_info', 'BOL file', null, null, null);
      insert.run('T-APPR', driverId, projectId, 'approved', null, 'none', null, null, null, null);
      insert.run('T-SET', driverId, projectId, 'approved', 'approved', 'none', null, null, null, null);
      insert.run('T-FLOW', driverId, projectId, 'submitted', null, 'none', null, null, null, null);
      database.prepare(`
        INSERT INTO driver_settlements (driver_id, week_start, week_end, status, approved_by_name)
        VALUES (?, '2026-11-09', '2026-11-15', 'approved', 'Label Admin')
      `).run(driverId);
    });

    const idOf = (ticket) => readRows(dataDir, 'SELECT id FROM loads WHERE ticket_number = ?', [ticket])[0].id;
    const adminCookie = { Cookie: cookieHeader(admin) };

    await check('admin Loads list renders all four labels and keeps review badges', async () => {
      const list = await request(srv.port, adminCookie, { path: '/loads' });
      assert.strictEqual(list.status, 200, list.body.slice(0, 400));
      assertHasBadge(list.body, 'draft', LABELS.draft);
      assertHasBadge(list.body, 'submitted', LABELS.submitted);
      assertHasBadge(list.body, 'approved', LABELS.approved);
      assertHasBadge(list.body, 'approved', LABELS.settled);
      assert.ok(list.body.includes('Flagged — missing info'));
      assert.ok(list.body.includes('>Rejected<'));
      assertNoLegacyStatus(list.body, 'loads list');
    });

    await check('flagged Loads view keeps the submitted label and the flag note', async () => {
      const list = await request(srv.port, adminCookie, { path: '/loads?review=flagged' });
      assert.strictEqual(list.status, 200, list.body.slice(0, 400));
      assert.ok(list.body.includes('<strong>T-FLAG</strong>'));
      assert.ok(!list.body.includes('<strong>T-SET</strong>'));
      assertHasBadge(list.body, 'submitted', LABELS.submitted);
      assert.ok(list.body.includes('Flagged — missing info'));
      assert.ok(!list.body.includes(badge('approved', LABELS.settled)));
      assertNoLegacyStatus(list.body, 'flagged loads');
    });

    await check('load page renders each status label', async () => {
      const pages = [
        ['T-DRAFT', 'draft', LABELS.draft],
        ['T-SUB', 'submitted', LABELS.submitted],
        ['T-APPR', 'approved', LABELS.approved],
        ['T-SET', 'approved', LABELS.settled]
      ];
      for (const [ticket, status, label] of pages) {
        const page = await request(srv.port, adminCookie, { path: `/loads/${idOf(ticket)}` });
        assert.strictEqual(page.status, 200, `${ticket} ${page.body.slice(0, 300)}`);
        assertHasBadge(page.body, status, label);
        assertNoLegacyStatus(page.body, ticket);
      }
      const flagged = await request(srv.port, adminCookie, { path: `/loads/${idOf('T-FLAG')}` });
      assertHasBadge(flagged.body, 'submitted', LABELS.submitted);
      assert.ok(flagged.body.includes('Flagged — missing info'));
      assertNoLegacyStatus(flagged.body, 'T-FLAG');
      const submitted = await request(srv.port, adminCookie, { path: `/loads/${idOf('T-SUB')}` });
      assert.ok(submitted.body.includes('>Approve</button>'));
      assert.ok(submitted.body.includes('Reject to Draft'));
    });

    await check('a sent-back draft uses the Draft label on the edit form', async () => {
      const page = await request(srv.port, adminCookie, { path: `/loads/${idOf('T-DRAFT')}/edit` });
      assert.strictEqual(page.status, 200, page.body.slice(0, 300));
      assert.ok(page.body.includes('This load was sent back as Draft.'));
      assert.ok(!page.body.includes('as a draft'));
    });

    const driver = {};
    const driverLogin = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded' }, {
      method: 'POST', path: '/login', body: form({ email: 'riley.labels@example.com', password: driverPassword })
    });
    assert.strictEqual(driverLogin.status, 302, driverLogin.headers.location || driverLogin.body.slice(0, 200));
    assert.ok(!String(driverLogin.headers.location || '').includes('change-password'));
    remember(driver, driverLogin);
    const driverCookie = { Cookie: cookieHeader(driver) };

    await check('driver weekly loads and home use the labels and omit settled loads', async () => {
      for (const pathName of ['/loads', '/']) {
        const page = await request(srv.port, driverCookie, { path: pathName });
        assert.strictEqual(page.status, 200, `${pathName} ${page.body.slice(0, 300)}`);
        assertHasBadge(page.body, 'draft', LABELS.draft);
        assertHasBadge(page.body, 'submitted', LABELS.submitted);
        assertHasBadge(page.body, 'approved', LABELS.approved);
        assert.ok(page.body.includes(`${LABELS.approved} 1`), pathName);
        assert.ok(page.body.includes(`${LABELS.submitted} 3`), pathName);
        assert.ok(page.body.includes(`${LABELS.draft} 1`), pathName);
        assert.ok(!page.body.includes(badge('approved', LABELS.settled)), pathName);
        assert.ok(!page.body.includes('<strong>T-SET</strong>'), pathName);
        assertNoLegacyStatus(page.body, pathName);
      }
    });

    await check('driver profile and admin driver page use the submitted label instead of Pending review', async () => {
      const profile = await request(srv.port, driverCookie, { path: '/profile' });
      assert.strictEqual(profile.status, 200);
      assert.ok(profile.body.includes(LABELS.submitted));
      assert.ok(!profile.body.includes('Pending review'));
      const adminDriver = await request(srv.port, adminCookie, { path: `/drivers/${driverId}` });
      assert.strictEqual(adminDriver.status, 200, adminDriver.body.slice(0, 300));
      assert.ok(adminDriver.body.includes(LABELS.submitted));
      assert.ok(!adminDriver.body.includes('Pending review'));
      assertNoLegacyStatus(adminDriver.body, 'driver profile');
    });

    await check('settlements page labels pending and settled loads', async () => {
      const page = await request(srv.port, adminCookie, { path: '/settlements' });
      assert.strictEqual(page.status, 200, page.body.slice(0, 400));
      assert.ok(page.body.includes('T-APPR'));
      assert.ok(page.body.includes('T-SET'));
      assertHasBadge(page.body, 'approved', LABELS.approved);
      assertHasBadge(page.body, 'approved', LABELS.settled);
      assertNoLegacyStatus(page.body, 'settlements');
      const driverPage = await request(srv.port, driverCookie, { path: '/settlements' });
      assert.strictEqual(driverPage.status, 200);
      assertHasBadge(driverPage.body, 'approved', LABELS.settled);
      assert.ok(!driverPage.body.includes(LABELS.approved));
    });

    await check('Logan API returns the status label and leaves the stored status', async () => {
      const list = await request(srv.port, { Authorization: `Bearer ${token}` }, { path: '/api/logan/loads?limit=50' });
      assert.strictEqual(list.status, 200, list.body.slice(0, 300));
      const loads = JSON.parse(list.body).loads;
      const byTicket = Object.fromEntries(loads.map((row) => [row.ticket_number, row]));
      assert.strictEqual(byTicket['T-DRAFT'].status, 'draft');
      assert.strictEqual(byTicket['T-DRAFT'].status_label, LABELS.draft);
      assert.strictEqual(byTicket['T-SUB'].status, 'submitted');
      assert.strictEqual(byTicket['T-SUB'].status_label, LABELS.submitted);
      assert.strictEqual(byTicket['T-APPR'].status, 'approved');
      assert.strictEqual(byTicket['T-APPR'].status_label, LABELS.approved);
      assert.strictEqual(byTicket['T-SET'].status, 'approved');
      assert.strictEqual(byTicket['T-SET'].status_label, LABELS.settled);
      const one = await request(srv.port, { Authorization: `Bearer ${token}` }, { path: `/api/logan/loads/${idOf('T-SET')}` });
      assert.strictEqual(one.status, 200);
      const load = JSON.parse(one.body).load;
      assert.strictEqual(load.status, 'approved');
      assert.strictEqual(load.status_label, LABELS.settled);
    });

    await check('Approve keeps status approved and the flash uses Approved for Settlement', async () => {
      const flowId = idOf('T-FLOW');
      const approved = await request(srv.port, auth, { method: 'POST', path: `/loads/${flowId}/approve` });
      assert.strictEqual(approved.status, 302);
      assert.ok(String(approved.headers.location || '').includes('saved=approved'));
      const row = readRows(dataDir, 'SELECT status, settlement_status FROM loads WHERE id = ?', [flowId])[0];
      assert.strictEqual(row.status, 'approved');
      assert.ok(row.settlement_status == null || row.settlement_status === '');
      const page = await request(srv.port, adminCookie, { path: approved.headers.location });
      assert.strictEqual(page.status, 200, page.body.slice(0, 300));
      assertHasBadge(page.body, 'approved', LABELS.approved);
      assert.ok(page.body.includes(`${LABELS.approved}`));
      assert.ok(page.body.includes('class="all-clear">Approved for Settlement'));
      const audit = readRows(dataDir, "SELECT detail FROM audit_log WHERE entity_type = 'load' AND entity_id = ? AND action = 'Approved'", [flowId]);
      assert.ok(audit.some((entry) => entry.detail === LABELS.approved));
      assertNoLegacyStatus(page.body, 'approve flash');
    });

    await check('Reject to Draft stores draft and shows Draft', async () => {
      const flowId = idOf('T-FLOW');
      const rejected = await request(srv.port, auth, {
        method: 'POST',
        path: `/loads/${flowId}/reject`,
        body: form({ rejection_reason: 'Need a clearer ticket' })
      });
      assert.strictEqual(rejected.status, 302);
      assert.ok(String(rejected.headers.location || '').includes('saved=rejected'));
      const row = readRows(dataDir, 'SELECT status, settlement_status, rejection_reason FROM loads WHERE id = ?', [flowId])[0];
      assert.strictEqual(row.status, 'draft');
      assert.ok(row.settlement_status == null || row.settlement_status === '');
      assert.strictEqual(row.rejection_reason, 'Need a clearer ticket');
      const page = await request(srv.port, adminCookie, { path: rejected.headers.location });
      assert.strictEqual(page.status, 200, page.body.slice(0, 300));
      assertHasBadge(page.body, 'draft', LABELS.draft);
      assert.ok(page.body.includes('Load sent back to the driver as Draft.'));
      assert.ok(!page.body.includes('>Approve</button>'));
      assertNoLegacyStatus(page.body, 'reject flash');
    });
  } finally {
    await stop(srv.child);
  }

  console.log(`ok - ${results.length} load status label checks`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
