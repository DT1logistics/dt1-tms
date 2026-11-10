// Admin Loads page (including Flagged) lists by load date, newest first.
// Undated loads (NULL or blank) come last. Run: npm test
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

function writeDb(dataDir, fn) {
  const database = new Database(path.join(dataDir, 'dt1.db'));
  try { fn(database); } finally { database.close(); }
}

function ticketOrder(html, tickets) {
  return tickets.map((ticket) => {
    const idx = html.indexOf(`<strong>${ticket}</strong>`);
    assert.ok(idx !== -1, `expected ticket ${ticket} in the list`);
    return idx;
  });
}

function assertListedInOrder(html, tickets) {
  const positions = ticketOrder(html, tickets);
  for (let i = 1; i < tickets.length; i++) {
    assert.ok(
      positions[i - 1] < positions[i],
      `expected ${tickets[i - 1]} before ${tickets[i]}`
    );
  }
}

(async () => {
  const adminPassword = 'Loads-Sort-Admin-1';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-loads-sort-'));
  // Start from an empty database so a leftover repo dt1.db is not copied in by migrateLegacyData.
  new Database(path.join(dataDir, 'dt1.db')).close();
  const srv = await startServer({
    DATA_DIR: dataDir,
    LOGAN_TMS_PASSWORD: adminPassword,
    LOGAN_API_TOKEN: '',
    SESSION_SECRET: 'loads-sort-test'
  });
  try {
    const admin = {};
    const login = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded' }, {
      method: 'POST', path: '/login', body: form({ email: 'david.dt1@mail.grokbot.com', password: adminPassword })
    });
    assert.strictEqual(login.status, 302);
    remember(admin, login);
    const auth = { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) };

    const customer = await request(srv.port, auth, { method: 'POST', path: '/customers', body: form({ name: 'Sort Haul' }) });
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
      body: form({ first_name: 'Sam', last_name: 'Sorter', email: 'sam.sort@example.com', phone: '5555550199', pay_percentage: '30' })
    });
    assert.ok(driverRes.status === 200 || driverRes.status === 302, driverRes.body.slice(0, 300));
    const driverId = readRows(dataDir, "SELECT id FROM users WHERE email = 'sam.sort@example.com'")[0].id;

    // Entered in the opposite order of load date, including a blank and a null date,
    // plus two loads on the same date so the id tie-breaker can be checked.
    writeDb(dataDir, (database) => {
      const insert = database.prepare(`
        INSERT INTO loads (ticket_number, load_date, project_id, status, review_status, created_at)
        VALUES (?, ?, ?, 'submitted', ?, ?)
      `);
      insert.run('SORT-NEW', '2026-11-10', projectId, 'flagged_missing_info', '2026-11-01 10:00:00');
      insert.run('SORT-OLD', '2026-11-01', projectId, 'flagged_missing_info', '2026-11-02 10:00:00');
      insert.run('SORT-SAME-A', '2026-11-05', projectId, 'none', '2026-11-03 10:00:00');
      insert.run('SORT-SAME-B', '2026-11-05', projectId, 'none', '2026-11-04 10:00:00');
      insert.run('SORT-NULL', null, projectId, 'flagged_missing_info', '2026-11-05 10:00:00');
      insert.run('SORT-BLANK', '', projectId, 'none', '2026-11-06 10:00:00');
    });

    const stored = readRows(dataDir, `
      SELECT ticket_number, load_date FROM loads
      WHERE ticket_number LIKE 'SORT-%'
      ORDER BY id
    `);
    const byTicket = Object.fromEntries(stored.map((row) => [row.ticket_number, row.load_date]));
    assert.strictEqual(byTicket['SORT-NEW'], '2026-11-10');
    assert.strictEqual(byTicket['SORT-OLD'], '2026-11-01');
    assert.strictEqual(byTicket['SORT-SAME-A'], '2026-11-05');
    assert.ok(byTicket['SORT-NEW'] === '2026-11-10', 'load_date should stay YYYY-MM-DD so it sorts as text');

    const expectedAll = ['SORT-NEW', 'SORT-SAME-B', 'SORT-SAME-A', 'SORT-OLD', 'SORT-BLANK', 'SORT-NULL'];

    await check('admin Loads page lists by load date, newest first, with undated last', async () => {
      const list = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/loads' });
      assert.strictEqual(list.status, 200, list.body.slice(0, 400));
      assertListedInOrder(list.body, expectedAll);
    });

    await check('flagged Loads filter uses the same load-date order', async () => {
      const list = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/loads?review=flagged' });
      assert.strictEqual(list.status, 200, list.body.slice(0, 400));
      assertListedInOrder(list.body, ['SORT-NEW', 'SORT-OLD', 'SORT-NULL']);
      assert.ok(!list.body.includes('<strong>SORT-SAME-A</strong>'));
      assert.ok(!list.body.includes('<strong>SORT-BLANK</strong>'));
    });

    await check('a new load is stored as YYYY-MM-DD and sorts by that date, not entry time', async () => {
      const res = await request(srv.port, auth, {
        method: 'POST',
        path: '/loads',
        body: form({
          action: 'draft',
          ticket_number: 'SORT-FORM',
          project_id: projectId,
          driver_id: driverId,
          load_date: '2026-11-08',
          weight_quantity: '10',
          rate: '10'
        })
      });
      assert.strictEqual(res.status, 302, res.body.slice(0, 400));
      const row = readRows(dataDir, "SELECT load_date FROM loads WHERE ticket_number = 'SORT-FORM'")[0];
      assert.strictEqual(row.load_date, '2026-11-08');
      const list = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/loads' });
      assertListedInOrder(list.body, ['SORT-NEW', 'SORT-FORM', 'SORT-SAME-B', 'SORT-SAME-A', 'SORT-OLD', 'SORT-BLANK', 'SORT-NULL']);
    });
  } finally {
    await stop(srv.child);
  }

  console.log(`ok - ${results.length} loads-sort checks`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
