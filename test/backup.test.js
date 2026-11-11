// Run: npm test  (node test/backup.test.js)
// Unit checks for the backup helpers, plus an end-to-end check of GET /admin/backup auth
// against a real server started on a temporary DATA_DIR.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const backup = require('../lib/backup');
const dataStore = require('../lib/data-store');

const results = [];
async function check(name, fn) { await fn(); results.push(name); console.log('ok -', name); }

function request(port, headers, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: o.method || 'GET', path: o.path || '/admin/backup', headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(o.body || undefined);
  });
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const childEnv = { ...process.env, REDIS_URL: '', SMTP_HOST: '', PORT: String(port), ...(env || {}) };
    // Parent shells must not turn snapshot writes on. Callers opt in by passing the flag.
    if (!env || !Object.prototype.hasOwnProperty.call(env, 'REDIS_SQLITE_SNAPSHOT')) {
      delete childEnv.REDIS_SQLITE_SNAPSHOT;
    }
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 20000);
    const onData = (d) => {
      out += d;
      if (out.includes(`running on port ${port}`)) { clearTimeout(timer); resolve({ child, port, log: () => out }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${out}`)); });
  });
}

function readRespCommand(buffer) {
  if (buffer.length < 4 || buffer[0] !== 42) return null;
  const headerEnd = buffer.indexOf('\r\n');
  if (headerEnd < 0) return null;
  const count = Number(buffer.subarray(1, headerEnd).toString());
  if (!Number.isInteger(count) || count < 1) return null;
  let offset = headerEnd + 2;
  const args = [];
  for (let i = 0; i < count; i += 1) {
    if (offset >= buffer.length || buffer[offset] !== 36) return null;
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd < 0) return null;
    const length = Number(buffer.subarray(offset + 1, lineEnd).toString());
    if (!Number.isInteger(length) || length < 0) return null;
    const start = lineEnd + 2;
    if (buffer.length < start + length + 2) return null;
    args.push(buffer.subarray(start, start + length));
    offset = start + length + 2;
  }
  return { consumed: offset, args };
}

function startFakeRedis() {
  return new Promise((resolve, reject) => {
    const commands = [];
    let connections = 0;
    const sockets = new Set();
    const server = net.createServer((socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (true) {
          const parsed = readRespCommand(buf);
          if (!parsed) break;
          buf = buf.subarray(parsed.consumed);
          const name = parsed.args[0].toString();
          commands.push(name);
          socket.write(name === 'GET' ? '$-1\r\n' : '+OK\r\n');
        }
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        commands,
        connectionCount: () => connections,
        close() {
          sockets.forEach((socket) => socket.destroy());
          return new Promise((done) => server.close(() => done()));
        }
      });
    });
  });
}

function waitFor(fn, timeoutMs) {
  const limit = timeoutMs || 4000;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ok = false;
      try { ok = fn(); } catch (err) { reject(err); return; }
      if (ok) { resolve(); return; }
      if (Date.now() - start > limit) { reject(new Error('timed out waiting for redis command')); return; }
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function postLogin(port) {
  const body = 'email=nobody%40example.com&password=nope';
  return request(port, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body)
  }, { method: 'POST', path: '/login', body });
}

function stop(child) {
  return new Promise((resolve) => { child.removeAllListeners('exit'); child.on('exit', resolve); child.kill('SIGTERM'); });
}

(async () => {
  const TOKEN = 'test-token-' + 'x'.repeat(40);

  await check('tokenMatches: exact match only, constant-time, rejects short/unset tokens', () => {
    assert.strictEqual(backup.tokenMatches(TOKEN, TOKEN), true);
    assert.strictEqual(backup.tokenMatches(TOKEN + 'y', TOKEN), false);
    assert.strictEqual(backup.tokenMatches('', TOKEN), false);
    assert.strictEqual(backup.tokenMatches(undefined, TOKEN), false);
    assert.strictEqual(backup.tokenMatches('short', 'short'), false);
    assert.strictEqual(backup.backupEnabled(undefined), false);
    assert.strictEqual(backup.backupEnabled('x'.repeat(31)), false);
    assert.strictEqual(backup.backupEnabled('x'.repeat(32)), true);
  });

  await check('buildZip/readZip round-trip (deflated + stored entries, CRC checked)', () => {
    const big = Buffer.from('DT1 '.repeat(5000));
    const rnd = require('crypto').randomBytes(2048);
    const zip = backup.buildZip([{ name: 'a.txt', data: big }, { name: 'uploads/r.bin', data: rnd }]);
    const files = backup.readZip(zip);
    assert.deepStrictEqual(files.map((f) => f.name), ['a.txt', 'uploads/r.bin']);
    assert.ok(files[0].data.equals(big));
    assert.ok(files[1].data.equals(rnd));
  });

  await check('migrateLegacyData copies old db + uploads once and never overwrites', () => {
    const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-legacy-'));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-data-'));
    fs.writeFileSync(path.join(legacy, 'dt1.db'), 'OLD');
    fs.mkdirSync(path.join(legacy, 'uploads'));
    fs.writeFileSync(path.join(legacy, 'uploads', 'r1.pdf'), 'R1');
    fs.writeFileSync(path.join(legacy, 'uploads', '.gitkeep'), '');
    let r = dataStore.migrateLegacyData({ dataDir: target, legacyDir: legacy, dbName: 'dt1.db', uploadsName: 'uploads' });
    assert.deepStrictEqual(r, { database: true, uploads: 1 });
    fs.writeFileSync(path.join(target, 'dt1.db'), 'NEW');
    r = dataStore.migrateLegacyData({ dataDir: target, legacyDir: legacy, dbName: 'dt1.db', uploadsName: 'uploads' });
    assert.deepStrictEqual(r, { database: false, uploads: 0 });
    assert.strictEqual(fs.readFileSync(path.join(target, 'dt1.db'), 'utf8'), 'NEW');
    assert.strictEqual(dataStore.resolveDataDir({}, legacy), path.resolve(legacy));
    assert.strictEqual(dataStore.resolveDataDir({ DATA_DIR: target }, legacy), path.resolve(target));
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-srv-'));
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'uploads', 'ticket-1.pdf'), '%PDF-1.4 test');

  const PW = 'test-login-pw-123';
  let srv = await startServer({ DATA_DIR: dataDir, BACKUP_TOKEN: TOKEN, LOGAN_TMS_PASSWORD: PW });
  let cookie = '';
  try {
    await check('server keeps dt1.db inside DATA_DIR', () => {
      assert.ok(fs.existsSync(path.join(dataDir, 'dt1.db')));
    });
    await check('GET /admin/backup: 401 with no token, wrong token, or token in query only', async () => {
      assert.strictEqual((await request(srv.port)).status, 401);
      assert.strictEqual((await request(srv.port, { 'X-Backup-Token': 'nope' })).status, 401);
      assert.strictEqual((await request(srv.port, { Authorization: `Bearer ${TOKEN}x` })).status, 401);
      assert.strictEqual((await request(srv.port, {}, { path: `/admin/backup?token=${TOKEN}` })).status, 401);
    });
    await check('GET /admin/backup: 200 zip with SQLite snapshot, uploads, manifest (sessions stripped)', async () => {
      for (const headers of [{ 'X-Backup-Token': TOKEN }, { Authorization: `Bearer ${TOKEN}` }]) {
        const res = await request(srv.port, headers);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers['content-type'], 'application/zip');
        assert.match(res.headers['content-disposition'], /dt1-tms-backup-\d{4}-\d{2}-\d{2}\.zip/);
        const files = backup.readZip(res.body);
        const names = files.map((f) => f.name);
        assert.ok(names.includes('dt1.db') && names.includes('uploads/ticket-1.pdf') && names.includes('manifest.json'));
        const dbFile = files.find((f) => f.name === 'dt1.db').data;
        assert.strictEqual(dbFile.subarray(0, 15).toString(), 'SQLite format 3');
        const tmp = path.join(dataDir, 'check.db');
        fs.writeFileSync(tmp, dbFile);
        const copy = new Database(tmp, { readonly: true });
        assert.ok(copy.prepare('SELECT COUNT(*) AS n FROM users').get().n >= 1);
        assert.strictEqual(copy.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
        copy.close();
        fs.unlinkSync(tmp);
      }
    });
    await check('login creates a session row in SQLite', async () => {
      const body = `email=${encodeURIComponent('david.dt1@mail.grokbot.com')}&password=${encodeURIComponent(PW)}`;
      const res = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }, { method: 'POST', path: '/login', body });
      assert.strictEqual(res.status, 302);
      cookie = String(res.headers['set-cookie'] || '').split(';')[0];
      assert.match(cookie, /^connect\.sid=/);
    });
  } finally {
    await stop(srv.child);
  }

  srv = await startServer({ DATA_DIR: dataDir, BACKUP_TOKEN: '' });
  try {
    await check('session survives a server restart (no forced logout)', async () => {
      const res = await request(srv.port, { Cookie: cookie }, { path: '/equipment' });
      assert.strictEqual(res.status, 200);
      const anon = await request(srv.port, {}, { path: '/equipment' });
      assert.strictEqual(anon.status, 302);
    });
    await check('GET /admin/backup: 404 when BACKUP_TOKEN is not configured', async () => {
      assert.strictEqual((await request(srv.port, { 'X-Backup-Token': TOKEN })).status, 404);
    });
  } finally {
    await stop(srv.child);
  }

  await check('Redis SQLite snapshot writes stay off by default, including shutdown', async () => {
    const redis = await startFakeRedis();
    const cases = [{}, { REDIS_SQLITE_SNAPSHOT: '0' }, { REDIS_SQLITE_SNAPSHOT: 'false' }, { REDIS_SQLITE_SNAPSHOT: '' }];
    try {
      for (const extra of cases) {
        const started = await startServer({
          DATA_DIR: dataDir,
          REDIS_URL: `redis://127.0.0.1:${redis.port}`,
          ...extra
        });
        try {
          const res = await postLogin(started.port);
          assert.strictEqual(res.status, 200);
          const log = started.log();
          assert.ok(!log.includes('Saved SQLite snapshot to Redis'));
          assert.ok(!log.includes('SQLite snapshot failed'));
          assert.ok(!log.includes('Shutdown snapshot failed'));
          assert.ok(!log.includes('Initial Redis snapshot skipped'));
          assert.ok(!log.includes('Restored SQLite snapshot from Redis'));
          assert.ok(!log.includes('No Redis snapshot yet'));
        } finally {
          await stop(started.child);
        }
        assert.strictEqual(redis.connectionCount(), 0);
        assert.deepStrictEqual(redis.commands, []);
      }
    } finally {
      await redis.close();
    }
  });

  await check('REDIS_SQLITE_SNAPSHOT=1 writes on boot, after a mutation, and on shutdown', async () => {
    const redis = await startFakeRedis();
    const started = await startServer({
      DATA_DIR: dataDir,
      REDIS_URL: `redis://127.0.0.1:${redis.port}`,
      REDIS_SQLITE_SNAPSHOT: '1'
    });
    try {
      assert.deepStrictEqual(redis.commands, ['SET']);
      assert.ok(started.log().includes('Saved SQLite snapshot to Redis'));
      assert.ok(!started.log().includes('No Redis snapshot yet'));
      const res = await postLogin(started.port);
      assert.strictEqual(res.status, 200);
      await waitFor(() => redis.commands.length >= 2);
      assert.deepStrictEqual(redis.commands, ['SET', 'SET']);
    } finally {
      await stop(started.child);
      await redis.close();
    }
    assert.deepStrictEqual(redis.commands, ['SET', 'SET', 'SET']);
  });

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-empty-'));
  const restoreRedis = await startFakeRedis();
  try {
    await check('missing dt1.db still restores from Redis when snapshot writes are off', async () => {
      const started = await startServer({
        DATA_DIR: emptyDir,
        REDIS_URL: `redis://127.0.0.1:${restoreRedis.port}`
      });
      try {
        assert.deepStrictEqual(restoreRedis.commands, ['GET']);
        const log = started.log();
        assert.ok(log.includes('No Redis snapshot yet'));
        assert.ok(!log.includes('Restored SQLite snapshot from Redis'));
        assert.ok(!log.includes('Saved SQLite snapshot to Redis'));
        const res = await postLogin(started.port);
        assert.strictEqual(res.status, 200);
      } finally {
        await stop(started.child);
      }
      assert.deepStrictEqual(restoreRedis.commands, ['GET']);
      const created = fs.readFileSync(path.join(emptyDir, 'dt1.db'));
      assert.strictEqual(created.subarray(0, 15).toString(), 'SQLite format 3');
    });
  } finally {
    await restoreRedis.close();
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }

  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`${results.length} backup checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
