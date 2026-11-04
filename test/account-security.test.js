const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const security = require('../lib/account-security');

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log('ok -', name));
}

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT,
      name TEXT,
      must_change_password INTEGER DEFAULT 0,
      temp_password TEXT,
      status TEXT DEFAULT 'active'
    );
  `);
  security.ensureAuthTables(db);
  return db;
}

function addUser(db, email, password, extras) {
  const hash = bcrypt.hashSync(password, 10);
  const row = Object.assign({ mustChange: 0, temp: null, name: 'Test User' }, extras);
  const result = db.prepare(`
    INSERT INTO users (email, password, name, role, must_change_password, temp_password)
    VALUES (?, ?, ?, 'admin', ?, ?)
  `).run(email, hash, row.name, row.mustChange, row.temp);
  return result.lastInsertRowid;
}

const tasks = [];

tasks.push(check('unknown and known emails get the same response and the password stays', async () => {
  const db = freshDb();
  const id = addUser(db, 'logan@example.com', 'current-secret');
  const before = db.prepare('SELECT password, must_change_password, temp_password FROM users WHERE id = ?').get(id);
  let sends = 0;
  const known = await security.requestPasswordReset({
    db,
    email: 'logan@example.com',
    ip: '10.0.0.1',
    now: 1_000,
    sendLink: async () => {
      sends += 1;
      return { sent: true };
    }
  });
  const unknown = await security.requestPasswordReset({
    db,
    email: 'nobody@example.com',
    ip: '10.0.0.2',
    now: 1_000,
    sendLink: async () => {
      throw new Error('should not send');
    }
  });
  assert.strictEqual(known.message, security.GENERIC_MESSAGE);
  assert.strictEqual(unknown.message, security.GENERIC_MESSAGE);
  assert.strictEqual(known.limited, false);
  assert.strictEqual(unknown.limited, false);
  assert.strictEqual(sends, 1);
  const after = db.prepare('SELECT password, must_change_password, temp_password FROM users WHERE id = ?').get(id);
  assert.deepStrictEqual(after, before);
}));

tasks.push(check('a failed email deletes the token and does not change the account', async () => {
  const db = freshDb();
  const id = addUser(db, 'locked@example.com', 'still-the-same');
  const before = db.prepare('SELECT password, must_change_password, temp_password FROM users WHERE id = ?').get(id);
  const result = await security.requestPasswordReset({
    db,
    email: 'locked@example.com',
    ip: '10.1.0.1',
    now: 2_000,
    sendLink: async () => {
      throw new Error('Invalid login: 535 5.7.8 authentication failed');
    }
  });
  assert.strictEqual(result.message, security.GENERIC_MESSAGE);
  assert.strictEqual(result.emailFailed, true);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM password_reset_tokens').get().n, 0);
  assert.deepStrictEqual(db.prepare('SELECT password, must_change_password, temp_password FROM users WHERE id = ?').get(id), before);
}));

tasks.push(check('reset token is stored hashed, expires, and works only once', async () => {
  const db = freshDb();
  const id = addUser(db, 'reset@example.com', 'old-password', { mustChange: 1, temp: 'visible-temp' });
  let captured = '';
  const now = 10_000;
  await security.requestPasswordReset({
    db,
    email: 'reset@example.com',
    ip: '10.2.0.1',
    now,
    sendLink: async ({ token }) => {
      captured = token;
      return { sent: true };
    }
  });
  const stored = db.prepare('SELECT token_hash, expires_at FROM password_reset_tokens').get();
  assert.ok(captured);
  assert.notStrictEqual(stored.token_hash, captured);
  assert.strictEqual(stored.token_hash, security.hashToken(captured));
  assert.ok(!JSON.stringify(stored).includes(captured));
  assert.strictEqual(stored.expires_at, now + security.RESET_TTL_MS);
  assert.strictEqual(db.prepare('SELECT password FROM users WHERE id = ?').get(id).password.startsWith('$2'), true);
  const oldHash = db.prepare('SELECT password FROM users WHERE id = ?').get(id).password;

  const expired = security.consumePasswordReset({
    db,
    token: captured,
    password: 'brand-new-1',
    now: now + security.RESET_TTL_MS
  });
  assert.strictEqual(expired.ok, false);
  assert.strictEqual(db.prepare('SELECT password FROM users WHERE id = ?').get(id).password, oldHash);

  const saved = security.consumePasswordReset({
    db,
    token: captured,
    password: 'brand-new-1',
    now: now + 1000
  });
  assert.strictEqual(saved.ok, true);
  const updated = db.prepare('SELECT password, must_change_password, temp_password FROM users WHERE id = ?').get(id);
  assert.ok(bcrypt.compareSync('brand-new-1', updated.password));
  assert.strictEqual(updated.must_change_password, 0);
  assert.strictEqual(updated.temp_password, null);

  const again = security.consumePasswordReset({
    db,
    token: captured,
    password: 'another-pass',
    now: now + 2000
  });
  assert.strictEqual(again.ok, false);
  assert.ok(bcrypt.compareSync('brand-new-1', db.prepare('SELECT password FROM users WHERE id = ?').get(id).password));
}));

tasks.push(check('rate limit message is the same for known and unknown emails', async () => {
  const db = freshDb();
  addUser(db, 'known@example.com', 'pw-known-1');
  const now = 50_000;
  for (let i = 0; i < security.MAX_ATTEMPTS_PER_EMAIL; i += 1) {
    const result = await security.requestPasswordReset({
      db,
      email: 'known@example.com',
      ip: `10.3.0.${i}`,
      now,
      sendLink: async () => ({ sent: true })
    });
    assert.strictEqual(result.limited, false);
  }
  let knownSends = 0;
  const known = await security.requestPasswordReset({
    db,
    email: 'known@example.com',
    ip: '10.3.1.1',
    now,
    sendLink: async () => {
      knownSends += 1;
      return { sent: true };
    }
  });
  for (let i = 0; i < security.MAX_ATTEMPTS_PER_EMAIL; i += 1) {
    await security.requestPasswordReset({
      db,
      email: 'missing@example.com',
      ip: `10.3.2.${i}`,
      now,
      sendLink: async () => {
        throw new Error('should not send');
      }
    });
  }
  const missing = await security.requestPasswordReset({
    db,
    email: 'missing@example.com',
    ip: '10.3.3.1',
    now,
    sendLink: async () => {
      throw new Error('should not send');
    }
  });
  assert.strictEqual(known.limited, true);
  assert.strictEqual(missing.limited, true);
  assert.strictEqual(known.message, security.RATE_LIMIT_MESSAGE);
  assert.strictEqual(missing.message, security.RATE_LIMIT_MESSAGE);
  assert.strictEqual(knownSends, 0);
}));

tasks.push(check('seed passwords are not the old hardcoded defaults', () => {
  const forbidden = ['changeme123', 'LoganDT1Ops2026!'];
  const generated = security.initialPassword('');
  assert.strictEqual(generated.mustChange, true);
  assert.strictEqual(generated.source, 'random');
  assert.ok(generated.password.length >= 8);
  forbidden.forEach((value) => assert.notStrictEqual(generated.password, value));
  const fromEnv = security.initialPassword('from-the-environment');
  assert.strictEqual(fromEnv.mustChange, false);
  assert.strictEqual(fromEnv.password, 'from-the-environment');
  assert.strictEqual(fromEnv.source, 'env');
}));

tasks.push(check('temporary driver passwords are sealed instead of stored in plaintext', () => {
  const db = freshDb();
  const plain = 'TempDriver1';
  const id = addUser(db, 'driver@example.com', plain, { mustChange: 1, temp: plain });
  assert.strictEqual(security.revealableTempPassword(plain), plain);
  const hash = db.prepare('SELECT password FROM users WHERE id = ?').get(id).password;
  security.setUserPassword(db, id, plain, true, 1);
  const row = db.prepare('SELECT password, must_change_password, temp_password FROM users WHERE id = ?').get(id);
  assert.strictEqual(row.must_change_password, 1);
  assert.ok(security.tempPasswordIsSealed(row.temp_password));
  assert.strictEqual(security.revealableTempPassword(row.temp_password), '');
  assert.ok(!row.temp_password.includes(plain));
  assert.ok(bcrypt.compareSync(plain, row.password));
  assert.notStrictEqual(row.password, hash);
}));

tasks.push(check('bootstrap always forces a password change and applies once per value', () => {
  const db = freshDb();
  const id = addUser(db, 'admin@dt1logistics.com', 'old-admin-password', { mustChange: 0 });
  const missing = security.applyBootstrapReset({
    db,
    email: 'missing@dt1logistics.com',
    tempPassword: 'throwaway-missing-1',
    now: 100
  });
  assert.strictEqual(missing.applied, false);
  assert.strictEqual(missing.reason, 'missing');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM app_meta').get().n, 0);

  const first = security.applyBootstrapReset({
    db,
    email: 'Admin@dt1logistics.com',
    tempPassword: 'throwaway-value-1',
    now: 200
  });
  assert.strictEqual(first.applied, true);
  let row = db.prepare('SELECT password, must_change_password, temp_password FROM users WHERE id = ?').get(id);
  assert.strictEqual(row.must_change_password, 1);
  assert.ok(bcrypt.compareSync('throwaway-value-1', row.password));
  assert.ok(security.tempPasswordIsSealed(row.temp_password));
  assert.ok(!JSON.stringify(row).includes('throwaway-value-1'));

  security.setUserPassword(db, id, 'chosen-after-login', false, 300);
  const second = security.applyBootstrapReset({
    db,
    email: 'admin@dt1logistics.com',
    tempPassword: 'throwaway-value-1',
    now: 400
  });
  assert.strictEqual(second.applied, false);
  assert.strictEqual(second.reason, 'already');
  row = db.prepare('SELECT password, must_change_password FROM users WHERE id = ?').get(id);
  assert.ok(bcrypt.compareSync('chosen-after-login', row.password));
  assert.strictEqual(row.must_change_password, 0);

  const third = security.applyBootstrapReset({
    db,
    email: 'admin@dt1logistics.com',
    tempPassword: 'throwaway-value-2',
    now: 500
  });
  assert.strictEqual(third.applied, true);
  row = db.prepare('SELECT password, must_change_password FROM users WHERE id = ?').get(id);
  assert.strictEqual(row.must_change_password, 1);
  assert.ok(bcrypt.compareSync('throwaway-value-2', row.password));

  const spacedId = addUser(db, 'spaced@example.com', 'old-spaced');
  const padded = security.applyBootstrapReset({
    db,
    email: 'spaced@example.com',
    tempPassword: '  spaced-throwaway  \n',
    now: 600
  });
  assert.strictEqual(padded.applied, true);
  const spaced = db.prepare('SELECT password, must_change_password FROM users WHERE id = ?').get(spacedId);
  assert.strictEqual(spaced.must_change_password, 1);
  assert.ok(bcrypt.compareSync('spaced-throwaway', spaced.password));
}));

tasks.push(check('source no longer contains the old default passwords', () => {
  const forbidden = ['changeme123', 'LoganDT1Ops2026!'];
  ['server.js', 'README.md'].forEach((name) => {
    const text = fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
    forbidden.forEach((value) => assert.ok(!text.includes(value), `${name} still contains a hardcoded password`));
  });
  const change = fs.readFileSync(path.join(__dirname, '..', 'views', 'change-password.ejs'), 'utf8');
  const reset = fs.readFileSync(path.join(__dirname, '..', 'views', 'reset-password.ejs'), 'utf8');
  [change, reset].forEach((text) => {
    assert.ok(text.includes('autocomplete="new-password"'));
    assert.ok(text.includes('type="password"'));
    assert.ok(text.includes('name="new_password"'));
    assert.ok(text.includes('name="confirm_password"'));
    assert.ok(text.includes('autocomplete="username"'));
  });
}));

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
        LOGAN_TMS_PASSWORD: '',
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
    child.removeAllListeners('exit');
    child.on('exit', resolve);
    child.kill('SIGTERM');
  });
}

async function exerciseHttp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-auth-'));
  const tempPassword = 'Throwaway-Http-Test-1';
  const baseEnv = {
    DATA_DIR: dataDir,
    RESET_USER_EMAIL: 'logan.dt1@mail.grokbot.com',
    RESET_USER_TEMP_PASSWORD: tempPassword
  };
  const first = await startServer(baseEnv);
  try {
    const log = first.log();
    assert.ok(log.includes('One-time password reset applied'));
    assert.ok(!log.includes(tempPassword));
    const db = new Database(path.join(dataDir, 'dt1.db'), { readonly: true });
    const logan = db.prepare("SELECT * FROM users WHERE email = 'david.dt1@mail.grokbot.com'").get();
    db.close();
    assert.ok(logan);
    assert.strictEqual(logan.must_change_password, 1);
    assert.ok(bcrypt.compareSync(tempPassword, logan.password));
    assert.ok(String(logan.temp_password).startsWith('h1:'));
    assert.ok(!String(logan.temp_password).includes(tempPassword));

    const login = await httpCall(first.port, {
      method: 'POST',
      path: '/login',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ email: 'logan.dt1@mail.grokbot.com', password: tempPassword })
    });
    assert.strictEqual(login.status, 302);
    assert.strictEqual(login.headers.location, '/change-password');
    const cookie = cookieHeader(login);
    assert.ok(cookie.includes('connect.sid'));

    const blocked = await httpCall(first.port, { path: '/users', headers: { Cookie: cookie } });
    assert.strictEqual(blocked.status, 302);
    assert.strictEqual(blocked.headers.location, '/change-password');

    const form = await httpCall(first.port, { path: '/change-password', headers: { Cookie: cookie } });
    assert.strictEqual(form.status, 200);
    assert.ok(form.body.includes('autocomplete="new-password"'));
    assert.ok(form.body.includes('type="password"'));
    assert.ok(form.body.includes('name="new_password"'));
    assert.ok(form.body.includes('name="confirm_password"'));
    assert.ok(form.body.includes('autocomplete="username"'));

    const changed = await httpCall(first.port, {
      method: 'POST',
      path: '/change-password',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: formBody({
        username: 'logan.dt1@mail.grokbot.com',
        new_password: 'Chosen-After-Login-1',
        confirm_password: 'Chosen-After-Login-1'
      })
    });
    assert.strictEqual(changed.status, 302);
    assert.strictEqual(changed.headers.location, '/');
    const authed = cookieHeader(changed) || cookie;

    const users = await httpCall(first.port, { path: '/users', headers: { Cookie: authed } });
    assert.strictEqual(users.status, 200);
    assert.ok(users.body.includes('kammy@dt1logistics.com'));
    assert.ok(users.body.includes('admin@dt1logistics.com'));

    const live = new Database(path.join(dataDir, 'dt1.db'), { readonly: true });
    const kammy = live.prepare("SELECT id FROM users WHERE email = 'kammy@dt1logistics.com'").get();
    live.close();
    const kammyTemp = 'KammyTemp99';
    const setTemp = await httpCall(first.port, {
      method: 'POST',
      path: `/users/${kammy.id}/temp-password`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: authed },
      body: formBody({ temp_password: kammyTemp })
    });
    assert.strictEqual(setTemp.status, 302);
    assert.strictEqual(setTemp.headers.location, '/users');
    const shown = await httpCall(first.port, { path: '/users', headers: { Cookie: authed } });
    assert.ok(shown.body.includes(kammyTemp));
    const hidden = await httpCall(first.port, { path: '/users', headers: { Cookie: authed } });
    assert.ok(!hidden.body.includes(kammyTemp));

    const after = new Database(path.join(dataDir, 'dt1.db'), { readonly: true });
    const kammyRow = after.prepare('SELECT password, must_change_password, temp_password FROM users WHERE id = ?').get(kammy.id);
    const audit = after.prepare("SELECT detail FROM audit_log WHERE action = 'Set temporary password' AND entity_id = ?").get(kammy.id);
    const loganHash = after.prepare("SELECT password, must_change_password FROM users WHERE email = 'david.dt1@mail.grokbot.com'").get();
    after.close();
    assert.strictEqual(kammyRow.must_change_password, 1);
    assert.ok(bcrypt.compareSync(kammyTemp, kammyRow.password));
    assert.ok(String(kammyRow.temp_password).startsWith('h1:'));
    assert.ok(audit && audit.detail.includes('kammy@dt1logistics.com'));
    assert.ok(!audit.detail.includes(kammyTemp));
    assert.strictEqual(loganHash.must_change_password, 0);
    assert.ok(bcrypt.compareSync('Chosen-After-Login-1', loganHash.password));

    const created = await httpCall(first.port, {
      method: 'POST',
      path: '/drivers',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: authed },
      body: formBody({
        first_name: 'Ada',
        last_name: 'Driver',
        email: 'ada.driver@example.com',
        phone: '5555550100'
      })
    });
    assert.strictEqual(created.status, 200);
    const shownTemp = (created.body.match(/<div class="temp">([^<]+)<\/div>/) || [])[1];
    assert.ok(shownTemp && shownTemp.length >= 8);
    const driverDb = new Database(path.join(dataDir, 'dt1.db'), { readonly: true });
    const driver = driverDb.prepare("SELECT password, temp_password, must_change_password FROM users WHERE email = 'ada.driver@example.com'").get();
    driverDb.close();
    assert.strictEqual(driver.must_change_password, 1);
    assert.ok(String(driver.temp_password).startsWith('h1:'));
    assert.ok(!driver.temp_password.includes(shownTemp));
    assert.ok(bcrypt.compareSync(shownTemp, driver.password));

    const known = await httpCall(first.port, {
      method: 'POST',
      path: '/forgot-password',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ email: 'david.dt1@mail.grokbot.com' })
    });
    const unknown = await httpCall(first.port, {
      method: 'POST',
      path: '/forgot-password',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ email: 'nobody@example.com' })
    });
    assert.strictEqual(known.status, 200);
    assert.strictEqual(unknown.status, 200);
    assert.strictEqual(known.body, unknown.body);
    assert.ok(known.body.includes('If an account exists for that email'));
    const unchanged = new Database(path.join(dataDir, 'dt1.db'), { readonly: true });
    const still = unchanged.prepare("SELECT password, must_change_password FROM users WHERE email = 'david.dt1@mail.grokbot.com'").get();
    const tokens = unchanged.prepare('SELECT COUNT(*) AS n FROM password_reset_tokens').get().n;
    unchanged.close();
    assert.strictEqual(still.password, loganHash.password);
    assert.strictEqual(still.must_change_password, 0);
    assert.strictEqual(tokens, 0);

    const badLink = await httpCall(first.port, { path: '/reset-password/not-a-real-token' });
    assert.strictEqual(badLink.status, 200);
    assert.ok(badLink.body.includes('invalid or has expired'));

    const equipment = await httpCall(first.port, { path: '/equipment', headers: { Cookie: authed } });
    assert.strictEqual(equipment.status, 200);
    assert.ok(equipment.body.includes('Number, VIN, or plate'));
  } finally {
    await stopServer(first.child);
  }

  const second = await startServer(baseEnv);
  try {
    const log = second.log();
    assert.ok(!log.includes('One-time password reset applied'));
    assert.ok(!log.includes(tempPassword));
    const db = new Database(path.join(dataDir, 'dt1.db'), { readonly: true });
    const logan = db.prepare("SELECT password, must_change_password FROM users WHERE email = 'david.dt1@mail.grokbot.com'").get();
    db.close();
    assert.strictEqual(logan.must_change_password, 0);
    assert.ok(bcrypt.compareSync('Chosen-After-Login-1', logan.password));
  } finally {
    await stopServer(second.child);
  }
  console.log('ok - http: bootstrap, forced change, admin temp password, hashed driver temp, generic reset');
}

Promise.all(tasks).then(() => exerciseHttp()).then(() => {
  console.log('All account security tests passed.');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
