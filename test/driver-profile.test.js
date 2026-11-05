// A driver profile with assigned equipment used to 500 because the query result
// was stored in a variable named `equipment`, which hid ./lib/equipment.
// Run: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const equipment = require('../lib/equipment');

function formBody(fields) {
  return new URLSearchParams(fields).toString();
}

function httpCall(port, opts) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: opts.method || 'GET',
      path: opts.path,
      headers: opts.headers || {}
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.setTimeout(10000, () => req.destroy(new Error(`timeout ${opts.method || 'GET'} ${opts.path}`)));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function cookieHeader(res) {
  const raw = res.headers['set-cookie'] || [];
  return raw.map((item) => item.split(';')[0]).join('; ');
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
        RESET_USER_EMAIL: '',
        RESET_USER_TEMP_PASSWORD: '',
        PORT: String(port),
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not start:\n${out}`));
    }, 20000);
    const onData = (chunk) => {
      out += chunk;
      if (out.includes(`running on port ${port}`)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        child.removeAllListeners('exit');
        resolve({ child, port, log: () => out });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}:\n${out}`));
    });
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null) return resolve();
    child.removeAllListeners('exit');
    child.on('exit', resolve);
    child.kill('SIGTERM');
  });
}

function seedDrivers(dataDir) {
  const db = new Database(path.join(dataDir, 'dt1.db'));
  const insertDriver = db.prepare(`
    INSERT INTO users (email, password, role, name, first_name, middle_initial, last_name, status)
    VALUES (?, 'not-a-login', 'driver', ?, ?, ?, ?, 'active')
  `);
  const assigned = insertDriver.run(
    'devonne.nelson@example.com', 'Devonne W Nelson', 'Devonne', 'W', 'Nelson'
  );
  const unassigned = insertDriver.run(
    'unassigned.driver@example.com', 'Unassigned Driver', 'Unassigned', '', 'Driver'
  );
  const insertUnit = db.prepare(`
    INSERT INTO equipment (type, number, description, status, maintenance_status)
    VALUES (?, ?, ?, 'active', 'active')
  `);
  const truck = insertUnit.run('truck', '441', 'Cascadia');
  const hotshot = insertUnit.run('hotshot', '1006', 'Ford F350');
  const insertLoad = db.prepare(`
    INSERT INTO loads (ticket_number, driver_id, truck_id, status, load_date)
    VALUES (?, ?, ?, 'approved', '2026-11-01')
  `);
  insertLoad.run('T-441', assigned.lastInsertRowid, truck.lastInsertRowid);
  insertLoad.run('T-1006', assigned.lastInsertRowid, hotshot.lastInsertRowid);
  db.close();
  return {
    assignedId: assigned.lastInsertRowid,
    unassignedId: unassigned.lastInsertRowid
  };
}

async function main() {
  assert.strictEqual(equipment.equipmentTypeLabel('truck'), 'Truck');
  assert.strictEqual(equipment.equipmentTypeLabel('trailer'), 'Trailer');
  assert.strictEqual(equipment.equipmentTypeLabel('hotshot'), 'Hotshot');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-driver-profile-'));
  const password = 'Driver-Profile-Test-1';
  const env = {
    DATA_DIR: dataDir,
    LOGAN_TMS_PASSWORD: password,
    SESSION_SECRET: 'driver-profile-test-secret'
  };
  let server = null;
  try {
    const bootstrap = await startServer(env);
    await stopServer(bootstrap.child);
    const ids = seedDrivers(dataDir);
    server = await startServer(env);
    const login = await httpCall(server.port, {
      method: 'POST',
      path: '/login',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ email: 'david.dt1@mail.grokbot.com', password })
    });
    assert.strictEqual(login.status, 302, login.body);
    assert.strictEqual(login.headers.location, '/');
    const cookie = cookieHeader(login);
    assert.ok(cookie.includes('connect.sid'));

    const list = await httpCall(server.port, { path: '/drivers', headers: { Cookie: cookie } });
    assert.strictEqual(list.status, 200, list.body.slice(0, 500));
    assert.ok(list.body.includes('Devonne W Nelson'));
    assert.ok(list.body.includes('Unassigned Driver'));

    const profile = await httpCall(server.port, {
      path: `/drivers/${ids.assignedId}`,
      headers: { Cookie: cookie }
    });
    assert.strictEqual(profile.status, 200, profile.body.slice(0, 800));
    assert.ok(profile.body.includes('Devonne W Nelson'));
    assert.ok(profile.body.includes('Truck 441'), 'truck label missing from driver profile');
    assert.ok(profile.body.includes('Hotshot 1006'), 'hotshot label missing from driver profile');
    assert.ok(!profile.body.includes('Truck 1006'), 'hotshot was labeled as a truck');
    assert.ok(profile.body.includes('Equipment'));

    const empty = await httpCall(server.port, {
      path: `/drivers/${ids.unassignedId}`,
      headers: { Cookie: cookie }
    });
    assert.strictEqual(empty.status, 200, empty.body.slice(0, 800));
    assert.ok(empty.body.includes('Unassigned Driver'));
    assert.ok(empty.body.includes('CDL License'));
    assert.ok(!empty.body.includes('Hotshot 1006'));
    assert.ok(!empty.body.includes('Truck 441'));
  } finally {
    if (server) await stopServer(server.child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log('ok - driver profile renders assigned truck and hotshot labels');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
