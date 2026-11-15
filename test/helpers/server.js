// Shared harness for server tests added on 11/15/2026 (load date, pay display, project totals,
// money formatting, review page, delete rules). Starts server.js on a temp DATA_DIR.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

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
    const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], {
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


function tempDataDir(prefix) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Empty database so a leftover repo dt1.db is not copied in by migrateLegacyData.
  new Database(path.join(dataDir, 'dt1.db')).close();
  return dataDir;
}

async function loginAdmin(port, password) {
  const jar = {};
  const login = await request(port, { 'Content-Type': 'application/x-www-form-urlencoded' }, {
    method: 'POST', path: '/login', body: form({ email: 'david.dt1@mail.grokbot.com', password })
  });
  assert.strictEqual(login.status, 302, 'admin login');
  remember(jar, login);
  return jar;
}

async function loginAs(port, email, password) {
  const jar = {};
  const login = await request(port, { 'Content-Type': 'application/x-www-form-urlencoded' }, {
    method: 'POST', path: '/login', body: form({ email, password })
  });
  remember(jar, login);
  return { jar, res: login };
}

// Shipper + project + driver created through the admin UI. Returns ids.
async function seedBasics(port, dataDir, admin, opts) {
  const o = opts || {};
  const auth = { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) };
  const customer = await request(port, auth, { method: 'POST', path: '/customers', body: form({ name: o.customer || 'Test Haul' }) });
  const customerId = String(customer.headers.location || '').split('/').pop();
  await request(port, auth, {
    method: 'POST',
    path: `/customers/${customerId}/projects`,
    body: form(Object.assign({ project_name: o.project || 'River', default_rate: '10', status: 'active' }, o.projectFields || {}))
  });
  const projectId = readRows(dataDir, 'SELECT id FROM projects ORDER BY id DESC LIMIT 1')[0].id;
  const email = o.driverEmail || 'dana.driver@example.com';
  await request(port, auth, {
    method: 'POST',
    path: '/drivers',
    body: form({ first_name: 'Dana', last_name: 'Driver', email, phone: '5555550123', pay_percentage: '30' })
  });
  const driverId = readRows(dataDir, 'SELECT id FROM users WHERE email = ?', [email])[0].id;
  return { auth, customerId, projectId, driverId };
}

function setUserPassword(dataDir, email, password) {
  const bcrypt = require('bcryptjs');
  writeDb(dataDir, (database) => {
    database.prepare('UPDATE users SET password = ?, must_change_password = 0, temp_password = NULL WHERE email = ?')
      .run(bcrypt.hashSync(password, 4), email);
  });
}

function makeChecker() {
  const results = [];
  async function check(name, fn) {
    await fn();
    results.push(name);
    console.log('ok -', name);
  }
  return { check, results };
}

module.exports = {
  request, form, remember, cookieHeader, startServer, stop, readRows, writeDb,
  tempDataDir, loginAdmin, loginAs, seedBasics, setUserPassword, makeChecker
};
