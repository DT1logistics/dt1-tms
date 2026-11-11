// Load alerts stay yellow. The Loads tile says "need attention".
// Other compliance tiles still say "expiring soon" and can still be red.
// Run: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const ejs = require('ejs');
const tiles = require('../lib/compliance-tiles');

function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function tileHtml(html, title) {
  const marker = `<strong>${title}</strong>`;
  const start = html.indexOf(marker);
  assert.ok(start >= 0, `missing tile ${title}`);
  const anchor = html.lastIndexOf('<a ', start);
  const end = html.indexOf('</a>', start);
  assert.ok(anchor >= 0 && end > anchor, `tile markup for ${title}`);
  return html.slice(anchor, end + 4);
}

function loadLevelRows(html) {
  const rows = [];
  const pattern = /<(?:a|div) class="level-row"[\s\S]*?<\/(?:a|div)>/g;
  let match;
  while ((match = pattern.exec(html))) {
    if (match[0].includes('Load ·')) rows.push(match[0]);
  }
  return rows;
}

function assertLoadLevelsAreNotRed(html, where) {
  const rows = loadLevelRows(html);
  assert.ok(rows.length > 0, `${where} should list load levels`);
  rows.forEach((row) => {
    assert.ok(!row.includes('badge red'), `${where} shows a red load level`);
    assert.ok(row.includes('badge yellow') || row.includes('badge green'), `${where} load level is not yellow or green`);
  });
}

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
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
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

function writeDb(dataDir, fn) {
  const database = new Database(path.join(dataDir, 'dt1.db'));
  try { fn(database); } finally { database.close(); }
}

(async () => {
  await check('Loads tile says need attention and other tiles still say expiring soon', async () => {
    const built = tiles.buildComplianceTiles([
      { level: 'yellow', category: 'Load', name: 'Load #1 (Alex Driver)', detail: 'Missing ticket number and ticket file' },
      { level: 'yellow', category: 'Load', name: 'Load #2 (Alex Driver)', detail: 'Rate not set' },
      { level: 'red', category: 'Equipment', name: 'Truck 2001 registration', detail: 'Expired · 2020-01-15' },
      { level: 'yellow', category: 'Equipment', name: 'Trailer 3001 registration', detail: 'Expiring ≤45 days' },
      { level: 'red', category: 'Driver Document', name: 'Alex Driver — CDL License', detail: 'Missing' },
      { level: 'yellow', category: 'Driver Document', name: 'Alex Driver — Medical Card', detail: 'Expiring ≤45 days' },
      { level: 'red', category: 'Compliance', name: 'FMCSA', detail: 'Missing' },
      { level: 'yellow', category: 'Compliance', name: 'Insurance', detail: 'Expiring ≤45 days' },
      { level: 'red', category: 'Password Reset', name: 'Alex Driver', detail: 'Requested a password reset. Email could not be sent.' }
    ]);
    const loads = built.find((item) => item.title === 'Loads');
    assert.strictEqual(loads.redCount, 0);
    assert.strictEqual(loads.yellowCount, 2);
    assert.strictEqual(loads.yellowLabel, 'need attention');
    assert.strictEqual(loads.accent, 'yellow');
    ['Compliance', 'Driver Documents', 'Equipment', 'Password Reset'].forEach((title) => {
      assert.strictEqual(built.find((item) => item.title === title).yellowLabel, 'expiring soon');
    });

    const html = await ejs.renderFile(
      path.join(__dirname, '../views/partials/compliance-tiles.ejs'),
      { complianceTiles: built }
    );
    const loadsHtml = tileHtml(html, 'Loads');
    assert.match(loadsHtml, /2 need attention/);
    assert.match(loadsHtml, /class="badge yellow"/);
    assert.doesNotMatch(loadsHtml, /expiring soon/);
    assert.doesNotMatch(loadsHtml, /out of compliance/);
    assert.doesNotMatch(loadsHtml, /badge red/);
    assert.match(loadsHtml, /quick quick-warn/);
    assert.doesNotMatch(loadsHtml, /quick-alert/);

    ['Compliance', 'Driver Documents', 'Equipment'].forEach((title) => {
      const tile = tileHtml(html, title);
      assert.match(tile, /1 expiring soon/);
      assert.match(tile, /1 out of compliance/);
      assert.match(tile, /badge red/);
      assert.doesNotMatch(tile, /need attention/);
    });
    const reset = tileHtml(html, 'Password Reset');
    assert.match(reset, /1 out of compliance/);
    assert.match(reset, /badge red/);
    assert.doesNotMatch(reset, /expiring soon/);
    assert.doesNotMatch(reset, /need attention/);
  });

  const adminPassword = 'Load-Alert-Admin-1';
  const driverPassword = 'Driver-Alert-1';
  const token = `yellow-${'t'.repeat(40)}`;
  const soon = isoDaysFromNow(25);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-load-alerts-'));
  new Database(path.join(dataDir, 'dt1.db')).close();
  const srv = await startServer({
    DATA_DIR: dataDir,
    LOGAN_TMS_PASSWORD: adminPassword,
    LOGAN_API_TOKEN: token,
    SESSION_SECRET: 'load-alerts-yellow-test'
  });

  try {
    const admin = {};
    const login = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded' }, {
      method: 'POST', path: '/login', body: form({ email: 'david.dt1@mail.grokbot.com', password: adminPassword })
    });
    assert.strictEqual(login.status, 302);
    remember(admin, login);
    const adminCookie = { Cookie: cookieHeader(admin) };

    writeDb(dataDir, (database) => {
      const driver = database.prepare(`
        INSERT INTO users (email, password, role, name, first_name, last_name, status, must_change_password)
        VALUES ('alex.alerts@example.com', ?, 'driver', 'Alex Driver', 'Alex', 'Driver', 'active', 0)
      `).run(bcrypt.hashSync(driverPassword, 10));
      const driverId = driver.lastInsertRowid;
      database.prepare(`
        INSERT INTO driver_documents (driver_id, doc_type, filename, original_name, expiration_date)
        VALUES (?, 'medical_card', 'med.pdf', 'med.pdf', ?)
      `).run(driverId, soon);
      database.prepare("UPDATE compliance_items SET expiration_date = ? WHERE name = 'Insurance'").run(soon);
      const truck = database.prepare(`
        INSERT INTO equipment (type, number, registration_expiration, maintenance_status, status)
        VALUES ('truck', '2001', '2020-01-15', 'active', 'active')
      `).run();
      database.prepare(`
        INSERT INTO equipment (type, number, registration_expiration, maintenance_status, status)
        VALUES ('trailer', '3001', ?, 'active', 'active')
      `).run(soon);
      database.prepare(`
        INSERT INTO password_reset_requests (user_id, email, status)
        VALUES (?, 'alex.alerts@example.com', 'pending')
      `).run(driverId);
      const customer = database.prepare("INSERT INTO customers (name) VALUES ('Alert Haul')").run();
      const project = database.prepare(`
        INSERT INTO projects (customer_id, project_name, display_name, default_rate, status)
        VALUES (?, 'Yard', 'Alert Haul - Yard', 12, 'active')
      `).run(customer.lastInsertRowid);
      const projectId = project.lastInsertRowid;

      const insert = database.prepare(`
        INSERT INTO loads (
          ticket_number, load_date, driver_id, truck_id, project_id, status,
          review_status, review_notes, missing_info_note, review_decision, review_decision_reason,
          weight_quantity, rate, driver_pay_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'percentage')
      `);
      const addFile = database.prepare(`
        INSERT INTO documents (load_id, filename, original_name) VALUES (?, 'ticket.pdf', 'ticket.pdf')
      `);
      const flagged = insert.run(
        null, '2026-11-01', driverId, null, null, 'approved',
        'flagged_missing_info', 'BOL file', null, null, null,
        null, null
      );
      assert.ok(flagged.lastInsertRowid);
      insert.run(
        null, null, driverId, null, null, 'submitted',
        'none', null, null, 'rejected', 'Duplicate ticket',
        null, null
      );
      const truckOnly = insert.run(
        'T-TRUCK', '2026-11-02', driverId, null, projectId, 'submitted',
        'none', null, null, null, null,
        10, 12
      );
      addFile.run(truckOnly.lastInsertRowid);
      insert.run(
        'T-FILE', '2026-11-03', driverId, truck.lastInsertRowid, projectId, 'approved',
        'none', null, null, null, null,
        10, 12
      );
      const numberMissing = insert.run(
        null, '2026-11-04', driverId, truck.lastInsertRowid, projectId, 'approved',
        'none', null, null, null, null,
        10, 12
      );
      addFile.run(numberMissing.lastInsertRowid);
      const rateMissing = insert.run(
        'T-RATE', '2026-11-05', driverId, truck.lastInsertRowid, projectId, 'approved',
        'none', null, null, null, null,
        10, 0
      );
      addFile.run(rateMissing.lastInsertRowid);
      const completeSubmitted = insert.run(
        'T-SUB', '2026-11-06', driverId, truck.lastInsertRowid, projectId, 'submitted',
        'none', null, null, null, null,
        10, 12
      );
      addFile.run(completeSubmitted.lastInsertRowid);
      insert.run(
        null, null, driverId, null, null, 'draft',
        'none', null, null, null, null,
        null, null
      );
      insert.run(
        null, null, driverId, null, null, 'draft',
        'flagged_missing_info', 'Scale ticket', null, null, null,
        null, null
      );
      const clear = insert.run(
        'T-OK', '2026-11-07', driverId, truck.lastInsertRowid, projectId, 'approved',
        'none', null, null, null, null,
        10, 12
      );
      addFile.run(clear.lastInsertRowid);
    });

    await check('home load alerts are yellow and the Loads tile does not say expiring soon', async () => {
      const home = await request(srv.port, adminCookie, { path: '/' });
      assert.strictEqual(home.status, 200, home.body.slice(0, 400));
      assert.match(home.body, /Load items are yellow when they need attention/);

      const loads = tileHtml(home.body, 'Loads');
      assert.match(loads, /11 need attention/);
      assert.doesNotMatch(loads, /expiring soon/);
      assert.doesNotMatch(loads, /out of compliance/);
      assert.doesNotMatch(loads, /badge red/);
      assert.match(loads, /class="quick quick-warn"/);
      assert.doesNotMatch(loads, /quick-alert/);

      ['Compliance', 'Driver Documents', 'Equipment'].forEach((title) => {
        const tile = tileHtml(home.body, title);
        assert.match(tile, /expiring soon/, title);
        assert.match(tile, /out of compliance/, title);
        assert.match(tile, /badge red/, title);
        assert.doesNotMatch(tile, /need attention/, title);
      });
      const reset = tileHtml(home.body, 'Password Reset');
      assert.match(reset, /out of compliance/);
      assert.match(reset, /badge red/);
      assert.doesNotMatch(reset, /need attention/);
      assert.doesNotMatch(reset, /expiring soon/);
    });

    await check('driver profile and admin driver page keep load levels off red', async () => {
      const driverJar = {};
      const driverLogin = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded' }, {
        method: 'POST', path: '/login', body: form({ email: 'alex.alerts@example.com', password: driverPassword })
      });
      assert.strictEqual(driverLogin.status, 302, driverLogin.headers.location || driverLogin.body.slice(0, 200));
      remember(driverJar, driverLogin);
      const profile = await request(srv.port, { Cookie: cookieHeader(driverJar) }, { path: '/profile' });
      assert.strictEqual(profile.status, 200, profile.body.slice(0, 300));
      assertLoadLevelsAreNotRed(profile.body, 'driver profile');
      assert.match(profile.body, /Missing ticket number and ticket file/);
      assert.match(profile.body, /Rate not set/);

      const lookup = new Database(path.join(dataDir, 'dt1.db'), { readonly: true, fileMustExist: true });
      let driverId;
      try {
        driverId = lookup.prepare("SELECT id FROM users WHERE email = 'alex.alerts@example.com'").get().id;
      } finally {
        lookup.close();
      }
      const adminDriver = await request(srv.port, adminCookie, { path: `/drivers/${driverId}` });
      assert.strictEqual(adminDriver.status, 200, adminDriver.body.slice(0, 300));
      assertLoadLevelsAreNotRed(adminDriver.body, 'admin driver page');
    });

    await check('Logan API does not return a red load alert level', async () => {
      const list = await request(srv.port, { Authorization: `Bearer ${token}` }, { path: '/api/logan/loads?limit=50' });
      assert.strictEqual(list.status, 200, list.body.slice(0, 300));
      const payload = JSON.parse(list.body);
      assert.ok(Array.isArray(payload.loads) && payload.loads.length >= 10);
      payload.loads.forEach((load) => {
        assert.notStrictEqual(load.level, 'red');
        assert.ok(load.level == null || load.level === 'yellow');
        assert.ok(!/expiring soon/i.test(JSON.stringify(load)));
      });
      assert.ok(!/expiring soon/i.test(list.body));
    });
  } finally {
    await stop(srv.child);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
