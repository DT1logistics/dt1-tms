// Run: npm test  (node test/logan-fuel-rate.test.js)
// Token-protected weekly fuel-rate endpoint for Logan's Tuesday EIA post.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const fuel = require('../lib/fuel-surcharge');
const loganApi = require('../lib/logan-api');

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
    if (body && !reqHeaders['Content-Length'] && !reqHeaders['content-length']) {
      reqHeaders['Content-Length'] = body.length;
    }
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: o.method || 'GET',
      path: o.path || '/api/logan/fuel-rate',
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

function jsonRequest(port, token, opts) {
  const o = opts || {};
  const headers = { Authorization: `Bearer ${token}` };
  if (o.body != null) headers['Content-Type'] = 'application/json';
  return request(port, headers, {
    method: o.method || (o.body != null ? 'POST' : 'GET'),
    path: o.path || '/api/logan/fuel-rate',
    body: o.body != null ? JSON.stringify(o.body) : null
  });
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

function openDb(dataDir) {
  return new Database(path.join(dataDir, 'dt1.db'), { readonly: true, fileMustExist: true });
}

function readRows(dataDir, sql, params) {
  const database = openDb(dataDir);
  try {
    return database.prepare(sql).all(...(params || []));
  } finally {
    database.close();
  }
}

(async () => {
  const TOKEN = `logan-${'t'.repeat(40)}`;

  await check('FSC % for $6.309 effective 2026-11-16 is 23.09', () => {
    assert.strictEqual(fuel.fscPercent(6.309), 23.09);
    assert.strictEqual(fuel.fscDecimal(6.309), 0.2309);
  });

  await check('effective_date must be a real YYYY-MM-DD calendar date', () => {
    assert.strictEqual(loganApi.isIsoDate('2026-11-16'), '2026-11-16');
    assert.strictEqual(loganApi.isIsoDate('2026-11-31'), null);
    assert.strictEqual(loganApi.isIsoDate('11/16/2026'), null);
    assert.strictEqual(loganApi.isIsoDate(''), null);
  });

  await check('diesel price accepts the admin field and Logan aliases', () => {
    assert.strictEqual(loganApi.parseDieselRate({ central_atlantic_rate: 6.309 }), 6.309);
    assert.strictEqual(loganApi.parseDieselRate({ diesel_price: '6.309' }), 6.309);
    assert.strictEqual(loganApi.parseDieselRate({ diesel_rate: 6.309 }), 6.309);
    assert.strictEqual(loganApi.parseDieselRate({ rate: '6.309' }), 6.309);
    assert.strictEqual(loganApi.parseDieselRate({}), null);
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-fuel-rate-'));
  let srv;
  try {
    srv = await startServer({
      DATA_DIR: dataDir,
      LOGAN_API_TOKEN: TOKEN,
      SMTP_HOST: '',
      LOGAN_WEBHOOK_URL: '',
      LOGAN_WEBHOOK_KEY: ''
    });

    const loadsBefore = readRows(dataDir, 'SELECT * FROM loads ORDER BY id');

    await check('GET /api/logan/fuel-rate is 401 without a valid bearer token', async () => {
      assert.strictEqual((await request(srv.port, {}, { path: '/api/logan/fuel-rate' })).status, 401);
      assert.strictEqual((await request(srv.port, { Authorization: 'Bearer' }, { path: '/api/logan/fuel-rate' })).status, 401);
      assert.strictEqual((await request(srv.port, { Authorization: `Bearer ${TOKEN}nope` }, { path: '/api/logan/fuel-rate' })).status, 401);
      assert.strictEqual((await request(srv.port, {}, { path: `/api/logan/fuel-rate?token=${TOKEN}` })).status, 401);
    });

    await check('GET /api/logan/fuel-rate returns the current seeded rate', async () => {
      const res = await jsonRequest(srv.port, TOKEN, { method: 'GET' });
      assert.strictEqual(res.status, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.fuel_rate);
      assert.strictEqual(body.fuel_rate.effective_date, '2026-10-19');
      assert.strictEqual(body.fuel_rate.central_atlantic_rate, 6.508);
      assert.strictEqual(body.fuel_rate.surcharge_percent, 25.08);
    });

    await check('POST rejects a missing or invalid effective date', async () => {
      const missing = await jsonRequest(srv.port, TOKEN, { body: { central_atlantic_rate: 6.309 } });
      assert.strictEqual(missing.status, 400);
      assert.match(JSON.parse(missing.body).error, /effective_date/);
      const bad = await jsonRequest(srv.port, TOKEN, { body: { effective_date: '2026-11-31', central_atlantic_rate: 6.309 } });
      assert.strictEqual(bad.status, 400);
    });

    await check('POST rejects a missing, zero, or out-of-range diesel price', async () => {
      const missing = await jsonRequest(srv.port, TOKEN, { body: { effective_date: '2026-11-16' } });
      assert.strictEqual(missing.status, 400);
      assert.match(JSON.parse(missing.body).error, /central_atlantic_rate/);
      const zero = await jsonRequest(srv.port, TOKEN, { body: { effective_date: '2026-11-16', central_atlantic_rate: 0 } });
      assert.strictEqual(zero.status, 400);
      const high = await jsonRequest(srv.port, TOKEN, { body: { effective_date: '2026-11-16', central_atlantic_rate: 20.001 } });
      assert.strictEqual(high.status, 400);
    });

    let createdId;
    await check('POST $6.309 effective 2026-11-16 saves the rate and returns 23.09% FSC', async () => {
      const res = await jsonRequest(srv.port, TOKEN, {
        body: { effective_date: '2026-11-16', central_atlantic_rate: 6.309 }
      });
      assert.strictEqual(res.status, 201);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.created, true);
      assert.strictEqual(body.updated, false);
      assert.strictEqual(body.fuel_rate.effective_date, '2026-11-16');
      assert.strictEqual(body.fuel_rate.central_atlantic_rate, 6.309);
      assert.strictEqual(body.fuel_rate.surcharge_percent, 23.09);
      assert.strictEqual(body.fuel_rate.base_rate, 4);
      assert.strictEqual(body.fuel_rate.updated_by, 'Logan (API)');
      createdId = body.fuel_rate.id;
      const rows = readRows(dataDir, 'SELECT * FROM fuel_rates WHERE effective_date = ?', ['2026-11-16']);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].central_atlantic_rate, 6.309);
      assert.strictEqual(Number(rows[0].surcharge_percent), 23.09);
    });

    await check('POST of the same effective date updates that row and does not insert another', async () => {
      const beforeCount = readRows(dataDir, 'SELECT id FROM fuel_rates').length;
      const res = await jsonRequest(srv.port, TOKEN, {
        body: { effective_date: '2026-11-16', diesel_price: 6.309 }
      });
      assert.strictEqual(res.status, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.created, false);
      assert.strictEqual(body.updated, true);
      assert.strictEqual(body.fuel_rate.id, createdId);
      assert.strictEqual(body.fuel_rate.surcharge_percent, 23.09);
      assert.strictEqual(readRows(dataDir, 'SELECT id FROM fuel_rates').length, beforeCount);
      assert.strictEqual(readRows(dataDir, 'SELECT id FROM fuel_rates WHERE effective_date = ?', ['2026-11-16']).length, 1);
    });

    await check('GET returns the newly posted current rate', async () => {
      const res = await jsonRequest(srv.port, TOKEN, { method: 'GET' });
      assert.strictEqual(res.status, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.fuel_rate.effective_date, '2026-11-16');
      assert.strictEqual(body.fuel_rate.central_atlantic_rate, 6.309);
      assert.strictEqual(body.fuel_rate.surcharge_percent, 23.09);
    });

    await check('an audit row is written for the fuel-rate save', async () => {
      const audit = readRows(dataDir, `
        SELECT actor_name, action, entity_type, entity_id, detail
        FROM audit_log
        WHERE entity_type = 'fuel_rate'
        ORDER BY id DESC
      `);
      assert.ok(audit.length >= 1);
      assert.strictEqual(audit[0].actor_name, 'Logan (API)');
      assert.strictEqual(audit[0].action, 'Updated fuel rate');
      assert.strictEqual(audit[0].entity_id, createdId);
      assert.strictEqual(audit[0].detail, '$6.309 effective 2026-11-16');
    });

    await check('posting a fuel rate does not change existing load rows', async () => {
      const loadsAfter = readRows(dataDir, 'SELECT * FROM loads ORDER BY id');
      assert.deepStrictEqual(loadsAfter, loadsBefore);
    });

    await check('the 2026-10-19 seed rate is left in place', async () => {
      const seed = readRows(dataDir, "SELECT * FROM fuel_rates WHERE effective_date = '2026-10-19'");
      assert.strictEqual(seed.length, 1);
      assert.strictEqual(seed[0].central_atlantic_rate, 6.508);
    });
  } finally {
    if (srv) await stop(srv.child);
  }

  let missing;
  try {
    missing = await startServer({
      DATA_DIR: dataDir,
      LOGAN_API_TOKEN: '',
      SMTP_HOST: '',
      LOGAN_WEBHOOK_URL: '',
      LOGAN_WEBHOOK_KEY: ''
    });
    await check('fuel-rate routes are 404 when LOGAN_API_TOKEN is unset', async () => {
      const get = await request(missing.port, { Authorization: `Bearer ${TOKEN}` }, { method: 'GET', path: '/api/logan/fuel-rate' });
      assert.strictEqual(get.status, 404);
      const post = await request(missing.port, {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      }, {
        method: 'POST',
        path: '/api/logan/fuel-rate',
        body: JSON.stringify({ effective_date: '2026-11-16', central_atlantic_rate: 6.309 })
      });
      assert.strictEqual(post.status, 404);
    });
  } finally {
    if (missing) await stop(missing.child);
  }

  console.log(`\n${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
