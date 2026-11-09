// Percentage-pay drivers receive their profile pay percentage of the stored drive-time fee.
// Detention and self load stay full amounts. Flat/daily-rate loads keep the full drive-time fee.
// Customer invoice Travel Time and Load Total keep the full fee. Approved weeks are recalculated live.
// Run: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

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

function assertOrder(html, markers) {
  let cursor = -1;
  markers.forEach((marker) => {
    const at = html.indexOf(marker, cursor + 1);
    assert.ok(at !== -1, `missing ${marker}`);
    assert.ok(at > cursor, `${marker} is out of order`);
    cursor = at;
  });
}

(async () => {
  const adminPassword = 'Drive-Admin-1';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-drive-pay-'));
  const srv = await startServer({
    DATA_DIR: dataDir,
    LOGAN_TMS_PASSWORD: adminPassword,
    SESSION_SECRET: 'drive-pay-test'
  });
  try {
    const admin = {};
    const login = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded' }, {
      method: 'POST', path: '/login', body: form({ email: 'david.dt1@mail.grokbot.com', password: adminPassword })
    });
    assert.strictEqual(login.status, 302);
    remember(admin, login);
    const auth = { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) };

    const customer = await request(srv.port, auth, { method: 'POST', path: '/customers', body: form({ name: 'Acme Haul' }) });
    const customerId = String(customer.headers.location || '').split('/').pop();
    await request(srv.port, auth, {
      method: 'POST',
      path: `/customers/${customerId}/projects`,
      body: form({ project_name: 'River', default_rate: '10', status: 'active' })
    });
    const projectId = readRows(dataDir, 'SELECT id FROM projects ORDER BY id DESC LIMIT 1')[0].id;
    const driverRes = await request(srv.port, auth, {
      method: 'POST',
      path: '/drivers',
      body: form({ first_name: 'Sam', last_name: 'Driver', email: 'sam.drive@example.com', phone: '5555550177', pay_percentage: '30' })
    });
    assert.strictEqual(driverRes.status, 200, driverRes.body.slice(0, 300));
    const driverId = readRows(dataDir, "SELECT id FROM users WHERE email = 'sam.drive@example.com'")[0].id;
    const temp = driverRes.body.match(/<div class="temp">([^<]+)<\/div>/);
    assert.ok(temp, 'temp password rendered');

    await check('admin and driver submit forms put Drive Time under the rate area and Load Total above the ticket', async () => {
      const adminForm = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/loads/new' });
      assert.strictEqual(adminForm.status, 200);
      assert.ok(!adminForm.body.includes('drive-detention-pair'));
      assert.ok(adminForm.body.includes('id="drive_time_wrap" class="addon-amount"'));
      assert.ok(adminForm.body.includes('id="self_load_wrap" class="addon-amount"'));
      assert.ok(adminForm.body.includes('id="detention_wrap" class="addon-amount"'));
      assert.ok(adminForm.body.includes('(Drive Time × Driver Pay %)'));
      assertOrder(adminForm.body, [
        'id="load_rate"',
        'id="has_self_load"',
        'id="detention"',
        'id="self_load_amount"',
        'id="detention_amount"',
        'id="has_drive_time"',
        'id="drive_time_amount"',
        'id="shipper_detention"',
        'id="load_total"',
        'id="driver_pay_type"',
        'Load Ticket/BOL'
      ]);

      const driverJar = {};
      const driverLogin = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded' }, {
        method: 'POST', path: '/login', body: form({ email: 'sam.drive@example.com', password: temp[1] })
      });
      assert.strictEqual(driverLogin.status, 302);
      remember(driverJar, driverLogin);
      const changed = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(driverJar) }, {
        method: 'POST',
        path: '/change-password',
        body: form({ new_password: 'Driver-Drive-1', confirm_password: 'Driver-Drive-1' })
      });
      assert.strictEqual(changed.status, 302, changed.body.slice(0, 200));
      remember(driverJar, changed);
      const driverForm = await request(srv.port, { Cookie: cookieHeader(driverJar) }, { path: '/loads/new' });
      assert.strictEqual(driverForm.status, 200);
      assert.ok(!driverForm.body.includes('drive-detention-pair'));
      assert.ok(!driverForm.body.includes('shipper_detention'));
      assert.ok(!driverForm.body.includes('name="driver_pay_type"'));
      assertOrder(driverForm.body, [
        'id="load_rate"',
        'id="has_self_load"',
        'id="detention"',
        'id="self_load_amount"',
        'id="detention_amount"',
        'id="has_drive_time"',
        'id="drive_time_amount"',
        'id="load_total"',
        'Load Ticket/BOL'
      ]);
      const between = driverForm.body.slice(driverForm.body.indexOf('id="load_total"'), driverForm.body.indexOf('Load Ticket/BOL'));
      assert.ok(!between.includes('has_drive_time'));
      assert.ok(!between.includes('detention'));
    });

    async function postLoad(fields) {
      return request(srv.port, auth, {
        method: 'POST',
        path: '/loads',
        body: form(Object.assign({
          action: 'approve',
          driver_id: driverId,
          project_id: projectId,
          load_date: '2026-11-05',
          weight_quantity: '10',
          rate: '10'
        }, fields))
      });
    }

    await check('percentage drive time is the driver share while self load, detention, load total, and the invoice stay full', async () => {
      const res = await postLoad({
        ticket_number: 'DRV-PCT',
        has_drive_time: '1',
        drive_time_amount: '15',
        has_self_load: '1',
        self_load_amount: '20',
        detention: '1',
        detention_amount: '25.24'
      });
      assert.strictEqual(res.status, 302, res.body.slice(0, 400));
      const row = readRows(dataDir, 'SELECT id, has_drive_time, drive_time_amount, has_self_load, self_load_amount, detention, detention_amount, driver_pay_type FROM loads WHERE ticket_number = ?', ['DRV-PCT'])[0];
      assert.strictEqual(row.has_drive_time, 1);
      assert.strictEqual(Number(row.drive_time_amount).toFixed(2), '15.00');
      assert.strictEqual(Number(row.self_load_amount).toFixed(2), '20.00');
      assert.strictEqual(Number(row.detention_amount).toFixed(2), '25.24');
      assert.notStrictEqual(row.driver_pay_type, 'flat');

      const detail = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: `/loads/${row.id}` });
      assert.ok(detail.body.includes('<strong>Load Total</strong> $135.00'));
      assert.ok(detail.body.includes('<strong>Driver Pay</strong> $79.74'));
      assert.ok(detail.body.includes('Drive Time $4.50'));
      assert.ok(detail.body.includes('<strong>Drive Time</strong> $15.00'));
      assert.ok(detail.body.includes("Drive Time is the driver's pay percentage of the drive-time fee."));
      assert.ok(!detail.body.includes('Driver Pay</strong> $90.24'));
      assert.ok(!detail.body.includes('Driver Pay</strong> $65.74'));
      const edit = detail.body.slice(detail.body.indexOf('<h2>Edit Load</h2>'));
      assert.ok(!edit.includes('drive-detention-pair'));
      assertOrder(edit, [
        'id="review_rate"',
        'id="has_self_load"',
        'id="review_detention"',
        'id="review_self_amount"',
        'id="review_detention_amount"',
        'id="has_drive_time"',
        'id="review_drive_amount"',
        'id="review_shipper_detention"',
        'id="review_load_total"',
        'id="driver_pay_type"',
        'Add ticket/BOL files'
      ]);

      const driverJar = {};
      const driverLogin = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded' }, {
        method: 'POST', path: '/login', body: form({ email: 'sam.drive@example.com', password: 'Driver-Drive-1' })
      });
      assert.strictEqual(driverLogin.status, 302);
      remember(driverJar, driverLogin);
      const week = await request(srv.port, { Cookie: cookieHeader(driverJar) }, { path: '/loads' });
      assert.strictEqual(week.status, 200);
      assert.ok(week.body.includes('Driver Pay $79.74'), week.body.slice(week.body.indexOf('Driver Pay'), 80));
      assert.ok(week.body.includes('Drive Time $4.50'));
      assert.ok(week.body.includes('Load Total: $135.00'));
      assert.ok(week.body.includes('Drive Time: $15.00'));

      const pending = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/settlements' });
      assert.strictEqual(pending.status, 200);
      assert.ok(pending.body.includes('Driver Pay $79.74'));
      assert.ok(pending.body.includes('<span>Travel Time</span><span>$15.00</span>'));
      assert.ok(pending.body.includes('<span>Self Load</span><span>$20.00</span>'));
      assert.ok(pending.body.includes('<span>TOTAL</span><span>$135.00</span>'));
      assert.ok(pending.body.includes('<span>Detention</span><span>$0.00</span>'));
      assert.ok(!pending.body.includes('Drive Time $15.00'));
      assert.ok(!pending.body.includes('$4.50</span>'));

      const approved = await request(srv.port, auth, {
        method: 'POST',
        path: '/settlements/approve-week',
        body: form({ driver_id: driverId, week_start: '2026-11-02' })
      });
      assert.strictEqual(approved.status, 302, approved.body.slice(0, 200));
      const settled = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/settlements' });
      assert.ok(settled.body.includes('Drive Time $4.50'));
      assert.ok(settled.body.includes('Self Load $20.00'));
      assert.ok(settled.body.includes('Detention $25.24'));
      assert.ok(settled.body.includes('Driver Pay $79.74'));
      assert.ok(!settled.body.includes('Drive Time $15.00'));
      assert.ok(!settled.body.includes('Drive Time $15.00 ×'));
      assert.ok(settled.body.includes('<span>Travel Time</span><span>$15.00</span>'));
      assert.ok(settled.body.includes('<span>TOTAL</span><span>$135.00</span>'));
    });

    await check('a flat daily-rate load keeps the full drive-time fee in driver pay and on an approved week', async () => {
      const res = await postLoad({
        ticket_number: 'DRV-FLAT',
        load_date: '2026-11-12',
        driver_pay_type: 'flat',
        driver_flat_rate: '80',
        has_drive_time: '1',
        drive_time_amount: '15'
      });
      assert.strictEqual(res.status, 302, res.body.slice(0, 400));
      const row = readRows(dataDir, 'SELECT id, driver_pay_type, driver_flat_rate, drive_time_amount FROM loads WHERE ticket_number = ?', ['DRV-FLAT'])[0];
      assert.strictEqual(row.driver_pay_type, 'flat');
      assert.strictEqual(Number(row.drive_time_amount).toFixed(2), '15.00');
      const detail = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: `/loads/${row.id}` });
      assert.ok(detail.body.includes('<strong>Load Total</strong> $115.00'));
      assert.ok(detail.body.includes('<strong>Driver Pay</strong> $95.00'));
      assert.ok(detail.body.includes('Drive Time $15.00'));
      assert.ok(detail.body.includes('Drive Time, Self Load, and Detention are added in full.'));
      assert.ok(!detail.body.includes('Driver Pay</strong> $84.50'));

      const pending = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/settlements' });
      assert.ok(pending.body.includes('Driver Pay $95.00'));
      const approved = await request(srv.port, auth, {
        method: 'POST',
        path: '/settlements/approve-week',
        body: form({ driver_id: driverId, week_start: '2026-11-09' })
      });
      assert.strictEqual(approved.status, 302, approved.body.slice(0, 200));
      const settled = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/settlements' });
      assert.ok(settled.body.includes('Drive Time $4.50'));
      assert.ok(settled.body.includes('Driver Pay $79.74'));
      assert.ok(settled.body.includes('Drive Time $15.00'));
      assert.ok(settled.body.includes('Driver Pay $95.00'));
      assert.ok(settled.body.includes('<span>Travel Time</span><span>$30.00</span>'));
    });
  } finally {
    await stop(srv.child);
  }

  console.log(`\n${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
