// Run: npm test
// Logan load-review webhook, bot API auth, and admin-only reject.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const loganWebhook = require('../lib/logan-webhook');

const results = [];
async function check(name, fn) {
  await fn();
  results.push(name);
  console.log('ok -', name);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(port, headers, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const body = o.body == null ? null : Buffer.from(o.body);
    const reqHeaders = Object.assign({}, headers || {});
    if (body && !reqHeaders['Content-Length'] && !reqHeaders['content-length']) {
      reqHeaders['Content-Length'] = body.length;
    }
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: o.method || 'GET',
      path: o.path || '/',
      headers: reqHeaders
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    req.end(body || undefined);
  });
}

function form(fields) {
  return Object.entries(fields).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value == null ? '' : value)}`).join('&');
}

function remember(jar, res) {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  list.forEach((line) => {
    const part = String(line).split(';')[0];
    jar[part.split('=')[0]] = part;
  });
}

function cookieHeader(jar) {
  return Object.values(jar).join('; ');
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        REDIS_URL: '',
        SMTP_HOST: '',
        SMTP_USER: '',
        SMTP_PASS: '',
        TWILIO_ACCOUNT_SID: '',
        TWILIO_AUTH_TOKEN: '',
        TWILIO_FROM_NUMBER: '',
        PORT: String(port),
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 20000);
    const onData = (d) => {
      out += d;
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
  try {
    return database.prepare(sql).all(...(params || []));
  } finally {
    database.close();
  }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function waitUntil(fn, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error('timed out');
}

(async () => {
  const KEY = `crsr_${'k'.repeat(48)}`;
  const TOKEN = `logan-${'t'.repeat(40)}`;

  await check('webhook payload uses created_via and the public load link', () => {
    const payload = loganWebhook.buildPayload(
      { id: 4, ticket_number: 'T-9', origin: 'Richmond Yard', destination: 'Norfolk Pier' },
      { createdBy: 'Kammy', createdVia: 'api', baseUrl: 'https://tms.example.test/' }
    );
    assert.strictEqual(payload.event, 'load.created');
    assert.strictEqual(payload.load_id, 4);
    assert.strictEqual(payload.load_number, 'T-9');
    assert.strictEqual(payload.created_by, 'Kammy');
    assert.strictEqual(payload.created_via, 'api');
    assert.strictEqual(payload.pickup, 'Richmond Yard');
    assert.strictEqual(payload.delivery, 'Norfolk Pier');
    assert.strictEqual(payload.link, 'https://tms.example.test/loads/4');
  });

  await check('webhook is a no-op when the env vars are unset', async () => {
    const result = await loganWebhook.deliver({}, { event: 'load.created', load_id: 1 }, () => {
      throw new Error('should not log');
    });
    assert.strictEqual(result.skipped, true);
  });

  await check('webhook retries a failure, resolves, and does not log the key', async () => {
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push(req.headers.authorization || '');
      req.resume();
      res.writeHead(500);
      res.end('no');
    });
    const port = await listen(server);
    const logs = [];
    try {
      const result = await loganWebhook.deliver({
        LOGAN_WEBHOOK_URL: `http://127.0.0.1:${port}/hook`,
        LOGAN_WEBHOOK_KEY: KEY,
        LOGAN_WEBHOOK_TIMEOUT_MS: '300',
        LOGAN_WEBHOOK_RETRIES: '2',
        LOGAN_WEBHOOK_RETRY_DELAY_MS: '15'
      }, { event: 'load.created', load_id: 9 }, (message) => logs.push(message));
      assert.strictEqual(result.ok, false);
      assert.strictEqual(hits.length, 3);
      hits.forEach((header) => assert.strictEqual(header, `Bearer ${KEY}`));
      assert.strictEqual(logs.length, 1);
      assert.ok(!logs[0].includes(KEY));
      assert.match(logs[0], /load 9/);
      assert.match(logs[0], /HTTP 500/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const hits = [];
  const slow = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch (err) { body = {}; }
      hits.push({ authorization: req.headers.authorization || '', body });
    });
  });
  const slowPort = await listen(slow);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-logan-'));
  let srv;
  try {
    const adminTemp = 'Admin-Temp-Review-1';
    const adminPass = 'Admin-Chosen-Review-1';
    srv = await startServer({
      DATA_DIR: dataDir,
      APP_BASE_URL: 'https://tms.example.test',
      LOGAN_API_TOKEN: TOKEN,
      LOGAN_WEBHOOK_URL: `http://127.0.0.1:${slowPort}/hook`,
      LOGAN_WEBHOOK_KEY: KEY,
      LOGAN_WEBHOOK_TIMEOUT_MS: '2500',
      LOGAN_WEBHOOK_RETRIES: '1',
      LOGAN_WEBHOOK_RETRY_DELAY_MS: '30',
      RESET_USER_EMAIL: 'admin@dt1logistics.com',
      RESET_USER_TEMP_PASSWORD: adminTemp
    });

    const admin = {};
    await check('admin can sign in after the one-time password reset', async () => {
      const body = form({ email: 'admin@dt1logistics.com', password: adminTemp });
      const res = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded' }, { method: 'POST', path: '/login', body });
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.location, '/change-password');
      remember(admin, res);
      const blocked = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/loads' });
      assert.strictEqual(blocked.status, 302);
      assert.strictEqual(blocked.headers.location, '/change-password');
      const changed = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) }, {
        method: 'POST',
        path: '/change-password',
        body: form({ new_password: adminPass, confirm_password: adminPass })
      });
      assert.strictEqual(changed.status, 302);
      assert.strictEqual(changed.headers.location, '/');
      remember(admin, changed);
      assert.match(cookieHeader(admin), /connect\.sid=/);
    });

    let projectId = 0;
    let driverId = 0;
    let driverPassword = '';
    await check('admin can add a project and a driver used by the load API', async () => {
      const customer = form({ name: 'Acme Haul' });
      const created = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) }, { method: 'POST', path: '/customers', body: customer });
      assert.strictEqual(created.status, 302);
      const customerId = String(created.headers.location || '').split('/').pop();
      const project = form({ project_name: 'River', default_rate: '10', status: 'active' });
      const projectRes = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) }, { method: 'POST', path: `/customers/${customerId}/projects`, body: project });
      assert.strictEqual(projectRes.status, 302);
      projectId = readRows(dataDir, 'SELECT id FROM projects ORDER BY id DESC LIMIT 1')[0].id;

      const driverBody = form({ first_name: 'Pat', last_name: 'Driver', email: 'pat.driver@example.com', phone: '5555550100', pay_percentage: '25' });
      const driverRes = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) }, { method: 'POST', path: '/drivers', body: driverBody });
      assert.strictEqual(driverRes.status, 200);
      const match = driverRes.body.match(/<div class="temp">([^<]+)<\/div>/);
      assert.ok(match, 'temp password rendered');
      driverPassword = match[1];
      driverId = readRows(dataDir, "SELECT id FROM users WHERE email = 'pat.driver@example.com'")[0].id;
    });

    let uiLoadId = 0;
    await check('UI load create returns before a hanging webhook finishes', async () => {
      const body = form({
        action: 'submit',
        driver_id: driverId,
        project_id: projectId,
        ticket_number: 'T-100',
        load_date: '2026-11-03',
        origin: 'Richmond Yard',
        destination: 'Norfolk Pier',
        weight_quantity: '18',
        rate: '12.5'
      });
      const started = Date.now();
      const res = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) }, { method: 'POST', path: '/loads', body });
      const elapsed = Date.now() - started;
      assert.strictEqual(res.status, 302);
      assert.ok(elapsed < 1200, `load create waited ${elapsed}ms on the webhook`);
      uiLoadId = Number(String(res.headers.location || '').match(/\/loads\/(\d+)/)[1]);
      const row = readRows(dataDir, 'SELECT review_status, created_via, ticket_number FROM loads WHERE id = ?', [uiLoadId])[0];
      assert.strictEqual(row.review_status, 'needs_review');
      assert.strictEqual(row.created_via, 'ui');
      assert.strictEqual(row.ticket_number, 'T-100');
    });

    await check('webhook POST carries Authorization: Bearer and the load summary', async () => {
      await waitUntil(() => hits.some((hit) => hit.body && hit.body.load_id === uiLoadId), 2000);
      const hit = hits.find((item) => item.body.load_id === uiLoadId);
      assert.strictEqual(hit.authorization, `Bearer ${KEY}`);
      assert.strictEqual(hit.body.event, 'load.created');
      assert.strictEqual(hit.body.load_number, 'T-100');
      assert.strictEqual(hit.body.created_via, 'ui');
      assert.strictEqual(hit.body.created_by, 'Administrator');
      assert.strictEqual(hit.body.pickup, 'Richmond Yard');
      assert.strictEqual(hit.body.delivery, 'Norfolk Pier');
      assert.strictEqual(hit.body.link, `https://tms.example.test/loads/${uiLoadId}`);
      assert.ok(!srv.output().includes(KEY));
    });

    const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
    await check('API rejects a missing or wrong token and ignores a token in the query', async () => {
      assert.strictEqual((await request(srv.port, {}, { path: '/api/logan/loads' })).status, 401);
      assert.strictEqual((await request(srv.port, { Authorization: 'Bearer' }, { path: '/api/logan/loads' })).status, 401);
      assert.strictEqual((await request(srv.port, { Authorization: `Bearer ${TOKEN}nope` }, { path: '/api/logan/loads' })).status, 401);
      assert.strictEqual((await request(srv.port, {}, { path: `/api/logan/loads?token=${TOKEN}` })).status, 401);
      const ok = await request(srv.port, { Authorization: `Bearer ${TOKEN}` }, { path: '/api/logan/drivers' });
      assert.strictEqual(ok.status, 200);
      const drivers = JSON.parse(ok.body).drivers;
      assert.ok(drivers.some((driver) => driver.id === driverId && driver.name === 'Pat Driver'));
      assert.ok(!ok.body.includes('password'));
    });

    let apiLoadId = 0;
    await check('API creates a load, flags it, and still fires the webhook with created_via api', async () => {
      const started = Date.now();
      const created = await request(srv.port, auth, {
        method: 'POST',
        path: '/api/logan/loads',
        body: JSON.stringify({
          action: 'submit',
          driver_id: driverId,
          project_id: projectId,
          ticket_number: 'E-200',
          load_date: '2026-11-03',
          origin: 'Yard',
          destination: 'Jobsite',
          weight_quantity: 10,
          rate: 9
        })
      });
      assert.ok(Date.now() - started < 1200, 'API create waited on the webhook');
      assert.strictEqual(created.status, 201);
      const load = JSON.parse(created.body).load;
      apiLoadId = load.id;
      assert.strictEqual(load.created_via, 'api');
      assert.strictEqual(load.review_status, 'needs_review');
      assert.strictEqual(load.review_decision, null);
      await waitUntil(() => hits.some((hit) => hit.body && hit.body.load_id === apiLoadId && hit.body.created_via === 'api'), 2000);

      const flagged = await request(srv.port, auth, {
        method: 'POST',
        path: `/api/logan/loads/${apiLoadId}/review`,
        body: JSON.stringify({ review_status: 'flagged_missing_info', review_notes: ['Ticket #', 'BOL file'] })
      });
      assert.strictEqual(flagged.status, 200);
      const flaggedLoad = JSON.parse(flagged.body).load;
      assert.strictEqual(flaggedLoad.review_status, 'flagged_missing_info');
      assert.strictEqual(flaggedLoad.review_notes, 'Ticket #\nBOL file');
      assert.strictEqual(flaggedLoad.review_set_by_name, 'Logan (API)');
      assert.strictEqual(flaggedLoad.review_decision, null);

      const byNumber = await request(srv.port, { Authorization: `Bearer ${TOKEN}` }, { path: '/api/logan/loads/E-200' });
      assert.strictEqual(byNumber.status, 200);
      assert.strictEqual(JSON.parse(byNumber.body).load.id, apiLoadId);
      const list = await request(srv.port, { Authorization: `Bearer ${TOKEN}` }, { path: '/api/logan/loads?flagged=1' });
      assert.strictEqual(list.status, 200);
      assert.ok(JSON.parse(list.body).loads.some((row) => row.id === apiLoadId));

      const audit = readRows(dataDir, "SELECT actor_name, action FROM audit_log WHERE entity_type = 'load' AND entity_id = ? ORDER BY id", [apiLoadId]);
      assert.ok(audit.some((row) => row.actor_name === 'Logan (API)' && row.action === 'Flagged missing info'));
      assert.ok(!srv.output().includes(KEY));
      assert.ok(!srv.output().includes(TOKEN));
    });

    await check('API assigns a hotshot and rejects inactive, sold, and total-loss units', async () => {
      async function addUnit(fields) {
        const res = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) }, {
          method: 'POST',
          path: '/equipment',
          body: form(Object.assign({ plate_state: 'VA', maintenance_status: 'active', status: 'active', inactive_reason: '' }, fields))
        });
        assert.strictEqual(res.status, 302, fields.number + ' ' + res.body.slice(0, 180));
      }
      await addUnit({ type: 'hotshot', number: '1006', year: '2026', make: 'Ford', model: 'F350' });
      await addUnit({ type: 'truck', number: '1003', maintenance_status: 'out_of_service' });
      await addUnit({ type: 'truck', number: '1002', status: 'inactive', inactive_reason: 'total_loss' });
      await addUnit({ type: 'truck', number: '1008', status: 'inactive', inactive_reason: 'sold' });
      await addUnit({ type: 'truck', number: '1009', status: 'inactive' });
      await addUnit({ type: 'trailer', number: 'T-1' });
      const rows = readRows(dataDir, 'SELECT id, number FROM equipment');
      const idOf = (number) => {
        const row = rows.find((item) => item.number === number);
        assert.ok(row, number);
        return row.id;
      };
      async function createWithTruck(truckId) {
        return request(srv.port, auth, {
          method: 'POST',
          path: '/api/logan/loads',
          body: JSON.stringify({
            action: 'draft',
            driver_id: driverId,
            truck_id: truckId,
            destination: 'Yard'
          })
        });
      }
      const hotshot = await createWithTruck(idOf('1006'));
      assert.strictEqual(hotshot.status, 201);
      assert.strictEqual(JSON.parse(hotshot.body).load.truck_id, idOf('1006'));
      assert.strictEqual(JSON.parse(hotshot.body).load.truck_number, '1006');
      const oos = await createWithTruck(idOf('1003'));
      assert.strictEqual(oos.status, 201);
      assert.strictEqual(JSON.parse(oos.body).load.truck_id, idOf('1003'));
      const before = readRows(dataDir, 'SELECT COUNT(*) AS n FROM loads')[0].n;
      for (const number of ['1002', '1008', '1009', 'T-1']) {
        const denied = await createWithTruck(idOf(number));
        assert.strictEqual(denied.status, 400, number + ' ' + denied.body);
        assert.ok(JSON.parse(denied.body).error.includes('hotshot'));
      }
      const unknown = await createWithTruck(999999);
      assert.strictEqual(unknown.status, 400);
      assert.strictEqual(readRows(dataDir, 'SELECT COUNT(*) AS n FROM loads')[0].n, before);
      const open = await request(srv.port, auth, {
        method: 'POST',
        path: '/api/logan/loads',
        body: JSON.stringify({ action: 'draft', driver_id: driverId, destination: 'Yard' })
      });
      assert.strictEqual(open.status, 201);
      assert.strictEqual(JSON.parse(open.body).load.truck_id, null);
    });

    await check('API cannot reject, accept, approve, or delete a load', async () => {
      const before = readRows(dataDir, 'SELECT review_decision, review_status, status FROM loads WHERE id = ?', [apiLoadId])[0];
      for (const pathName of [
        `/api/logan/loads/${apiLoadId}/reject`,
        `/api/logan/loads/${apiLoadId}/accept`,
        `/api/logan/loads/${apiLoadId}/approve`,
        `/api/logan/loads/${apiLoadId}/delete`
      ]) {
        const res = await request(srv.port, auth, { method: 'POST', path: pathName, body: JSON.stringify({ reason: 'no' }) });
        assert.strictEqual(res.status, 403, pathName);
      }
      const sneaky = await request(srv.port, auth, {
        method: 'PATCH',
        path: `/api/logan/loads/${apiLoadId}/review`,
        body: JSON.stringify({ review_status: 'cleared', review_decision: 'rejected', decision: 'rejected', reason: 'nope' })
      });
      assert.strictEqual(sneaky.status, 403);
      const removed = await request(srv.port, auth, { method: 'DELETE', path: `/api/logan/loads/${apiLoadId}` });
      assert.strictEqual(removed.status, 403);
      const users = await request(srv.port, auth, { method: 'POST', path: '/api/logan/users', body: '{}' });
      assert.strictEqual(users.status, 403);
      const equipment = await request(srv.port, auth, { method: 'POST', path: '/api/logan/equipment', body: '{}' });
      assert.strictEqual(equipment.status, 403);
      const after = readRows(dataDir, 'SELECT review_decision, review_status, status FROM loads WHERE id = ?', [apiLoadId])[0];
      assert.strictEqual(after.review_decision, before.review_decision);
      assert.strictEqual(after.review_status, before.review_status);
      assert.strictEqual(after.status, before.status);
      assert.strictEqual(after.review_decision, null);
      assert.strictEqual(after.review_status, 'flagged_missing_info');
    });

    await check('flagged loads show on the admin list and a driver cannot reject', async () => {
      const list = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/loads?review=flagged' });
      assert.strictEqual(list.status, 200);
      assert.ok(list.body.includes('E-200'));
      assert.ok(list.body.includes('Flagged'));
      assert.ok(!list.body.includes('T-100'));

      const detail = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: `/loads/${apiLoadId}` });
      assert.strictEqual(detail.status, 200);
      assert.ok(detail.body.includes('Ticket #'));
      assert.ok(detail.body.includes('BOL file'));
      assert.ok(detail.body.includes('Reject load'));
      assert.ok(detail.body.includes(`/loads/${apiLoadId}/review-decision`));

      const anon = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded' }, {
        method: 'POST',
        path: `/loads/${apiLoadId}/review-decision`,
        body: form({ decision: 'rejected', reason: 'should not stick' })
      });
      assert.strictEqual(anon.status, 302);
      assert.strictEqual(anon.headers.location, '/');

      const legacy = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded' }, {
        method: 'POST',
        path: `/loads/${uiLoadId}/reject`,
        body: form({ rejection_reason: 'no' })
      });
      assert.strictEqual(legacy.status, 302);
      assert.strictEqual(legacy.headers.location, '/');

      const driverJar = {};
      const login = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded' }, {
        method: 'POST',
        path: '/login',
        body: form({ email: 'pat.driver@example.com', password: driverPassword })
      });
      assert.strictEqual(login.status, 302);
      assert.strictEqual(login.headers.location, '/change-password');
      remember(driverJar, login);
      const lockedApi = await request(srv.port, {
        Authorization: `Bearer ${TOKEN}`,
        Cookie: cookieHeader(driverJar)
      }, { path: '/api/logan/loads?flagged=1' });
      assert.strictEqual(lockedApi.status, 200);
      assert.ok(Array.isArray(JSON.parse(lockedApi.body).loads));
      assert.ok(!String(lockedApi.headers.location || '').includes('change-password'));
      const changed = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(driverJar) }, {
        method: 'POST',
        path: '/change-password',
        body: form({ new_password: 'DriverPass123', confirm_password: 'DriverPass123' })
      });
      assert.strictEqual(changed.status, 302);
      assert.strictEqual(changed.headers.location, '/');
      remember(driverJar, changed);

      const denied = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(driverJar) }, {
        method: 'POST',
        path: `/loads/${apiLoadId}/review-decision`,
        body: form({ decision: 'rejected', reason: 'driver should not reject' })
      });
      assert.strictEqual(denied.status, 302);
      assert.strictEqual(denied.headers.location, '/loads');
      const legacyDenied = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(driverJar) }, {
        method: 'POST',
        path: `/loads/${uiLoadId}/reject`,
        body: form({ rejection_reason: 'driver should not reject' })
      });
      assert.strictEqual(legacyDenied.status, 302);
      assert.strictEqual(legacyDenied.headers.location, '/loads');

      const untouched = readRows(dataDir, 'SELECT review_decision, status, rejection_reason FROM loads WHERE id = ?', [apiLoadId])[0];
      assert.strictEqual(untouched.review_decision, null);
      assert.strictEqual(untouched.status, 'submitted');
      const uiRow = readRows(dataDir, 'SELECT status, rejection_reason, review_decision FROM loads WHERE id = ?', [uiLoadId])[0];
      assert.strictEqual(uiRow.status, 'submitted');
      assert.strictEqual(uiRow.rejection_reason, null);
      assert.strictEqual(uiRow.review_decision, null);

      const driverPage = await request(srv.port, { Cookie: cookieHeader(driverJar) }, { path: `/loads/${apiLoadId}` });
      assert.ok(!driverPage.body.includes('Reject load'));
      assert.ok(!driverPage.body.includes('Logan review'));
    });

    await check('only an admin can reject or accept, and the audit records who and when', async () => {
      const missing = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) }, {
        method: 'POST',
        path: `/loads/${apiLoadId}/review-decision`,
        body: form({ decision: 'rejected', reason: '   ' })
      });
      assert.strictEqual(missing.status, 302);
      assert.ok(String(missing.headers.location).includes('need-reason'));
      assert.strictEqual(readRows(dataDir, 'SELECT review_decision FROM loads WHERE id = ?', [apiLoadId])[0].review_decision, null);

      const rejected = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) }, {
        method: 'POST',
        path: `/loads/${apiLoadId}/review-decision`,
        body: form({ decision: 'rejected', reason: 'Duplicate of an emailed load' })
      });
      assert.strictEqual(rejected.status, 302);
      assert.ok(String(rejected.headers.location).includes('review-rejected'));
      const row = readRows(dataDir, 'SELECT review_decision, review_decision_reason, review_decision_by_name, review_decision_at FROM loads WHERE id = ?', [apiLoadId])[0];
      assert.strictEqual(row.review_decision, 'rejected');
      assert.strictEqual(row.review_decision_reason, 'Duplicate of an emailed load');
      assert.strictEqual(row.review_decision_by_name, 'Administrator');
      assert.ok(row.review_decision_at);
      const audit = readRows(dataDir, "SELECT actor_name, action, detail FROM audit_log WHERE entity_type = 'load' AND entity_id = ? AND action = 'Rejected load'", [apiLoadId]);
      assert.strictEqual(audit.length, 1);
      assert.strictEqual(audit[0].actor_name, 'Administrator');
      assert.strictEqual(audit[0].detail, 'Duplicate of an emailed load');

      const page = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: `/loads/${apiLoadId}` });
      assert.ok(page.body.includes('Duplicate of an emailed load'));
      assert.ok(page.body.includes('Rejected'));

      const accepted = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) }, {
        method: 'POST',
        path: `/loads/${uiLoadId}/review-decision`,
        body: form({ decision: 'accepted', reason: 'Looks complete' })
      });
      assert.strictEqual(accepted.status, 302);
      const acceptedRow = readRows(dataDir, 'SELECT review_decision, review_decision_by_name FROM loads WHERE id = ?', [uiLoadId])[0];
      assert.strictEqual(acceptedRow.review_decision, 'accepted');
      assert.strictEqual(acceptedRow.review_decision_by_name, 'Administrator');

      const cleared = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) }, {
        method: 'POST',
        path: `/loads/${apiLoadId}/review`,
        body: form({ review_action: 'clear', review_notes: 'Ticket arrived' })
      });
      assert.strictEqual(cleared.status, 302);
      const clearedRow = readRows(dataDir, 'SELECT review_status, review_notes, review_set_by_name, missing_info_note FROM loads WHERE id = ?', [apiLoadId])[0];
      assert.strictEqual(clearedRow.review_status, 'cleared');
      assert.strictEqual(clearedRow.review_notes, 'Ticket arrived');
      assert.strictEqual(clearedRow.review_set_by_name, 'Administrator');
      assert.strictEqual(clearedRow.missing_info_note, null);
      const filtered = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/loads?review=flagged' });
      assert.ok(filtered.body.includes('No flagged loads.'));
    });
  } finally {
    if (srv) await stop(srv.child);
    await new Promise((resolve) => slow.close(resolve));
  }

  srv = await startServer({
    DATA_DIR: dataDir,
    LOGAN_API_TOKEN: '',
    LOGAN_WEBHOOK_URL: '',
    LOGAN_WEBHOOK_KEY: '',
    RESET_USER_EMAIL: '',
    RESET_USER_TEMP_PASSWORD: ''
  });
  try {
    await check('API is 404 when LOGAN_API_TOKEN is unset, and load create still works', async () => {
      const missing = await request(srv.port, { Authorization: `Bearer ${TOKEN}` }, { path: '/api/logan/loads' });
      assert.strictEqual(missing.status, 404);
      const admin = {};
      const login = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded' }, {
        method: 'POST',
        path: '/login',
        body: form({ email: 'admin@dt1logistics.com', password: 'Admin-Chosen-Review-1' })
      });
      assert.strictEqual(login.status, 302);
      assert.strictEqual(login.headers.location, '/');
      remember(admin, login);
      const projectId = readRows(dataDir, 'SELECT id FROM projects ORDER BY id DESC LIMIT 1')[0].id;
      const driverId = readRows(dataDir, "SELECT id FROM users WHERE email = 'pat.driver@example.com'")[0].id;
      const body = form({
        action: 'draft',
        driver_id: driverId,
        project_id: projectId,
        ticket_number: 'D-1',
        origin: 'A',
        destination: 'B'
      });
      const res = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) }, { method: 'POST', path: '/loads', body });
      assert.strictEqual(res.status, 302);
      assert.ok(!srv.output().includes(KEY));
    });
  } finally {
    await stop(srv.child);
  }

  console.log(`\n${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
