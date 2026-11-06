// Detention is added in full to driver pay and is not part of the percentage or the shipper invoice.
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

function writeDb(dataDir, fn) {
  const database = new Database(path.join(dataDir, 'dt1.db'));
  try { fn(database); } finally { database.close(); }
}

(async () => {
  const adminPassword = 'Detention-Admin-1';
  const token = `detention-${'t'.repeat(32)}`;

  await check('existing loads gain detention default false and a null amount', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-detention-migrate-'));
    writeDb(dataDir, (database) => {
      database.exec(`
        CREATE TABLE loads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ticket_number TEXT,
          load_date DATE,
          driver_id INTEGER,
          description TEXT,
          destination TEXT,
          weight_quantity REAL,
          rate REAL DEFAULT 0,
          status TEXT DEFAULT 'draft',
          submitted_by INTEGER,
          approved_by INTEGER,
          approved_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO loads (ticket_number, rate, weight_quantity, status) VALUES ('OLD-DET', 10, 2, 'submitted');
      `);
    });
    const srv = await startServer({ DATA_DIR: dataDir, LOGAN_TMS_PASSWORD: adminPassword, LOGAN_API_TOKEN: '' });
    try {
      const cols = readRows(dataDir, 'SELECT name, "notnull" AS required, dflt_value FROM pragma_table_info(\'loads\') WHERE name IN (\'detention\', \'detention_amount\')');
      const detention = cols.find((col) => col.name === 'detention');
      const amount = cols.find((col) => col.name === 'detention_amount');
      assert.ok(detention);
      assert.strictEqual(detention.required, 0);
      assert.ok(String(detention.dflt_value).includes('0'));
      assert.ok(amount);
      assert.strictEqual(amount.dflt_value, null);
      const row = readRows(dataDir, 'SELECT ticket_number, rate, detention, detention_amount FROM loads WHERE ticket_number = ?', ['OLD-DET'])[0];
      assert.strictEqual(row.rate, 10);
      assert.strictEqual(row.detention, 0);
      assert.strictEqual(row.detention_amount, null);
    } finally {
      await stop(srv.child);
    }
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-detention-'));
  const srv = await startServer({
    DATA_DIR: dataDir,
    LOGAN_TMS_PASSWORD: adminPassword,
    LOGAN_API_TOKEN: token,
    SESSION_SECRET: 'detention-test'
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
      body: form({ first_name: 'Sam', last_name: 'Driver', email: 'sam.detention@example.com', phone: '5555550199', pay_percentage: '30' })
    });
    assert.strictEqual(driverRes.status, 200, driverRes.body.slice(0, 300));
    const driverId = readRows(dataDir, "SELECT id, pay_percentage FROM users WHERE email = 'sam.detention@example.com'")[0].id;
    assert.strictEqual(readRows(dataDir, 'SELECT pay_percentage FROM users WHERE id = ?', [driverId])[0].pay_percentage, 30);

    const newForm = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/loads/new' });
    assert.ok(newForm.body.includes('name="detention"'));
    assert.ok(newForm.body.includes('Detention Amount ($)'));
    assert.ok(newForm.body.includes('id="detention_wrap"'));
    assert.ok(newForm.body.includes('display:none'));

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

    await check('a checked detention amount is stored to two decimals and added in full to driver pay', async () => {
      const res = await postLoad({ ticket_number: 'DET-1', detention: '1', detention_amount: '25.239' });
      assert.strictEqual(res.status, 302, res.body.slice(0, 400));
      const row = readRows(dataDir, "SELECT id, detention, detention_amount, rate, weight_quantity FROM loads WHERE ticket_number = 'DET-1'")[0];
      assert.strictEqual(row.detention, 1);
      assert.strictEqual(Number(row.detention_amount).toFixed(2), '25.24');
      const detail = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: `/loads/${row.id}` });
      assert.ok(detail.body.includes('Detention'));
      assert.ok(detail.body.includes('$25.24'));
      assert.ok(detail.body.includes('Driver Pay'));
      assert.ok(detail.body.includes('$55.24'));
      assert.ok(detail.body.includes('Load Total'));
      assert.ok(detail.body.includes('$100.00'));
      const audit = readRows(dataDir, "SELECT actor_name, action, detail FROM audit_log WHERE entity_type = 'load' AND entity_id = ? AND action = 'Set detention'", [row.id]);
      assert.strictEqual(audit.length, 1);
      assert.strictEqual(audit[0].actor_name, 'Logan (Operations Manager)');
      assert.strictEqual(audit[0].detail, 'Detention $25.24');
      const list = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/loads' });
      assert.ok(list.body.includes('Detention: $25.24'));
      assert.ok(list.body.includes('Driver Pay: $55.24'));
    });

    await check('an unchecked detention box stores no amount and does not change percentage pay', async () => {
      const res = await postLoad({ action: 'draft', ticket_number: 'DET-OFF', detention_amount: '40' });
      assert.strictEqual(res.status, 302, res.body.slice(0, 300));
      const row = readRows(dataDir, "SELECT id, detention, detention_amount FROM loads WHERE ticket_number = 'DET-OFF'")[0];
      assert.strictEqual(row.detention, 0);
      assert.strictEqual(row.detention_amount, null);
      const detail = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: `/loads/${row.id}` });
      assert.ok(detail.body.includes('<strong>Detention</strong> No'));
      assert.ok(!detail.body.includes('$40.00'));
    });

    await check('a negative detention amount is rejected and unchecking clears a saved amount', async () => {
      const before = readRows(dataDir, 'SELECT COUNT(*) AS n FROM loads')[0].n;
      const denied = await postLoad({ ticket_number: 'DET-NEG', detention: '1', detention_amount: '-1' });
      assert.strictEqual(denied.status, 400);
      assert.ok(denied.body.includes('Detention amount must be 0.00 or more.'));
      assert.strictEqual(readRows(dataDir, 'SELECT COUNT(*) AS n FROM loads')[0].n, before);

      const created = await postLoad({ action: 'draft', ticket_number: 'DET-CLEAR', detention: '1', detention_amount: '15.50' });
      assert.strictEqual(created.status, 302);
      const id = readRows(dataDir, "SELECT id FROM loads WHERE ticket_number = 'DET-CLEAR'")[0].id;
      const cleared = await request(srv.port, auth, {
        method: 'POST',
        path: `/loads/${id}`,
        body: form({
          action: 'save',
          driver_id: driverId,
          project_id: projectId,
          load_date: '2026-11-05',
          weight_quantity: '10',
          rate: '10',
          detention_amount: '15.50'
        })
      });
      assert.strictEqual(cleared.status, 302, cleared.body.slice(0, 300));
      const row = readRows(dataDir, 'SELECT detention, detention_amount FROM loads WHERE id = ?', [id])[0];
      assert.strictEqual(row.detention, 0);
      assert.strictEqual(row.detention_amount, null);
      const audit = readRows(dataDir, "SELECT action, detail FROM audit_log WHERE entity_id = ? AND action = 'Changed detention'", [id]);
      assert.strictEqual(audit.length, 1);
      assert.strictEqual(audit[0].detail, 'Detention cleared');
    });

    await check('settlement driver pay includes detention once and the shipper invoice does not', async () => {
      const page = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/settlements' });
      assert.strictEqual(page.status, 200);
      assert.ok(page.body.includes('Driver Pay $55.24'), page.body.slice(page.body.indexOf('Driver Pay'), 80));
      assert.ok(page.body.includes('Detention $25.24'));
      assert.ok(!page.body.includes('Driver Pay $80.48'));
      assert.ok(page.body.includes('TOTAL'));
      assert.ok(page.body.includes('$100.00'));
      assert.ok(!page.body.includes('<th>Detention</th>'));
    });

    const apiAuth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    await check('Logan API accepts and returns detention without renaming other fields', async () => {
      const created = await request(srv.port, apiAuth, {
        method: 'POST',
        path: '/api/logan/loads',
        body: JSON.stringify({
          action: 'submit',
          driver_id: driverId,
          project_id: projectId,
          ticket_number: 'API-DET',
          load_date: '2026-11-05',
          weight_quantity: 10,
          rate: 10,
          detention: true,
          detention_amount: 12.5,
          origin: 'Yard'
        })
      });
      assert.strictEqual(created.status, 201, created.body);
      const load = JSON.parse(created.body).load;
      assert.strictEqual(load.detention, true);
      assert.strictEqual(load.detention_amount, 12.5);
      assert.strictEqual(load.origin, 'Yard');
      assert.strictEqual(load.rate, 10);
      assert.strictEqual(load.destination, null);

      const off = await request(srv.port, apiAuth, {
        method: 'POST',
        path: '/api/logan/loads',
        body: JSON.stringify({
          action: 'draft',
          driver_id: driverId,
          project_id: projectId,
          ticket_number: 'API-OFF',
          detention: false,
          detention_amount: 99
        })
      });
      assert.strictEqual(off.status, 201, off.body);
      const plain = JSON.parse(off.body).load;
      assert.strictEqual(plain.detention, false);
      assert.strictEqual(plain.detention_amount, null);

      const bad = await request(srv.port, apiAuth, {
        method: 'POST',
        path: '/api/logan/loads',
        body: JSON.stringify({ action: 'draft', driver_id: driverId, detention: true, detention_amount: -2 })
      });
      assert.strictEqual(bad.status, 400);
      assert.ok(JSON.parse(bad.body).error.includes('Detention'));
    });
  } finally {
    await stop(srv.child);
  }

  console.log(`\n${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
