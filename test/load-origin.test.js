// Origin on loads: nullable column, save, Uber Freight defaults, and no defaults otherwise.
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
      res.on('data', (chunk) => chunks.push(chunk));
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
        LOGAN_WEBHOOK_URL: '',
        LOGAN_WEBHOOK_KEY: '',
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
        resolve({ child, port, output: () => out });
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

function writeDb(dataDir, fn) {
  const database = new Database(path.join(dataDir, 'dt1.db'));
  try {
    fn(database);
  } finally {
    database.close();
  }
}

function originBeforeDestination(html, originMark, destinationMark) {
  const originAt = html.indexOf(originMark);
  const destinationAt = html.indexOf(destinationMark);
  assert.ok(originAt >= 0, `missing ${originMark}`);
  assert.ok(destinationAt >= 0, `missing ${destinationMark}`);
  assert.ok(originAt < destinationAt, `${originMark} should come before ${destinationMark}`);
}

(async () => {
  const adminPassword = 'Origin-Admin-1';
  const token = `origin-${'t'.repeat(40)}`;

  await check('an existing loads table gains a nullable origin column and old rows stay put', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-origin-migrate-'));
    writeDb(dataDir, (database) => {
      database.exec(`
        CREATE TABLE loads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ticket_number TEXT,
          load_date DATE,
          driver_id INTEGER,
          truck_id INTEGER,
          project_id INTEGER,
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
        INSERT INTO loads (ticket_number, description, destination, status)
        VALUES ('OLD-1', 'Keep me', 'Norfolk', 'submitted');
      `);
    });
    const srv = await startServer({
      DATA_DIR: dataDir,
      LOGAN_TMS_PASSWORD: adminPassword,
      LOGAN_API_TOKEN: ''
    });
    try {
      const columns = readRows(dataDir, "SELECT name, type, \"notnull\" AS required FROM pragma_table_info('loads') WHERE name = 'origin'");
      assert.strictEqual(columns.length, 1);
      assert.strictEqual(String(columns[0].type).toUpperCase(), 'TEXT');
      assert.strictEqual(columns[0].required, 0);
      const row = readRows(dataDir, 'SELECT ticket_number, description, destination, origin FROM loads WHERE ticket_number = ?', ['OLD-1'])[0];
      assert.strictEqual(row.description, 'Keep me');
      assert.strictEqual(row.destination, 'Norfolk');
      assert.strictEqual(row.origin, null);
    } finally {
      await stop(srv.child);
    }
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-origin-'));
  let srv = await startServer({
    DATA_DIR: dataDir,
    LOGAN_TMS_PASSWORD: adminPassword,
    LOGAN_API_TOKEN: token,
    SESSION_SECRET: 'load-origin-test'
  });
  try {
    const admin = {};
    await check('admin can open the new load form', async () => {
      const login = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded' }, {
        method: 'POST',
        path: '/login',
        body: form({ email: 'david.dt1@mail.grokbot.com', password: adminPassword })
      });
      assert.strictEqual(login.status, 302, login.body.slice(0, 300));
      assert.strictEqual(login.headers.location, '/');
      remember(admin, login);
      const page = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/loads/new' });
      assert.strictEqual(page.status, 200);
      originBeforeDestination(page.body, 'for="origin"', 'for="destination"');
      assert.ok(page.body.includes('name="origin"'));
    });

    async function addCustomer(name) {
      const created = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) }, {
        method: 'POST',
        path: '/customers',
        body: form({ name })
      });
      assert.strictEqual(created.status, 302, created.body.slice(0, 300));
      return String(created.headers.location || '').split('/').pop();
    }

    async function addProject(customerId, projectName) {
      const created = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) }, {
        method: 'POST',
        path: `/customers/${customerId}/projects`,
        body: form({ project_name: projectName, default_rate: '12', status: 'active' })
      });
      assert.strictEqual(created.status, 302, created.body.slice(0, 300));
      return readRows(dataDir, 'SELECT id, project_name FROM projects WHERE customer_id = ? ORDER BY id DESC LIMIT 1', [customerId])[0];
    }

    let uberProject;
    let mixedCaseProject;
    let otherProject;
    let nearMissProject;
    let driverId = 0;
    let driverPassword = '';
    await check('projects exist for Uber Freight and for other shippers', async () => {
      const uberId = await addCustomer('Uber Freight');
      const mixedId = await addCustomer('  uBer FrEiGhT  ');
      const otherId = await addCustomer('Acme Haul');
      const nearId = await addCustomer('Uber Freight LLC');
      uberProject = await addProject(uberId, 'Madison Heights');
      mixedCaseProject = await addProject(mixedId, 'Hopewell');
      otherProject = await addProject(otherId, 'River');
      nearMissProject = await addProject(nearId, 'Skipped');
      assert.strictEqual(uberProject.project_name, 'Madison Heights');
      const formPage = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/loads/new' });
      assert.strictEqual(formPage.status, 200);
      assert.ok(formPage.body.includes('data-customer="Uber Freight"'));
      assert.ok(formPage.body.includes('data-project-name="Madison Heights"'));
      assert.ok(formPage.body.includes('data-customer="Acme Haul"'));

      const driverRes = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) }, {
        method: 'POST',
        path: '/drivers',
        body: form({ first_name: 'Pat', last_name: 'Driver', email: 'pat.origin@example.com', phone: '5555550101' })
      });
      assert.strictEqual(driverRes.status, 200, driverRes.body.slice(0, 400));
      const match = driverRes.body.match(/<div class="temp">([^<]+)<\/div>/);
      assert.ok(match, 'temp password rendered');
      driverPassword = match[1];
      driverId = readRows(dataDir, "SELECT id FROM users WHERE email = 'pat.origin@example.com'")[0].id;
    });

    async function postLoad(fields) {
      const res = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) }, {
        method: 'POST',
        path: '/loads',
        body: form(Object.assign({
          action: 'submit',
          driver_id: driverId,
          load_date: '2026-11-04',
          weight_quantity: '10',
          rate: '12'
        }, fields))
      });
      assert.strictEqual(res.status, 302, res.body.slice(0, 400));
      const id = Number(String(res.headers.location || '').match(/\/loads\/(\d+)/)[1]);
      const row = readRows(dataDir, 'SELECT * FROM loads WHERE id = ?', [id])[0];
      return { id, row, res };
    }

    let savedId = 0;
    await check('saving origin stores it and shows it before destination on list and detail', async () => {
      const saved = await postLoad({
        project_id: otherProject.id,
        ticket_number: 'T-ORIGIN',
        origin: 'Richmond Yard',
        destination: 'Norfolk Pier',
        action: 'approve'
      });
      savedId = saved.id;
      assert.strictEqual(saved.row.origin, 'Richmond Yard');
      assert.strictEqual(saved.row.destination, 'Norfolk Pier');
      assert.notStrictEqual(saved.row.origin, 'Sandston');

      const list = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/loads' });
      assert.strictEqual(list.status, 200);
      originBeforeDestination(list.body, 'Origin: Richmond Yard', 'Destination: Norfolk Pier');
      assert.ok(list.body.includes('Date: 11-04-2026'));
      assert.ok(!list.body.includes('Date: 2026-11-04'));

      const detail = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: `/loads/${savedId}` });
      assert.strictEqual(detail.status, 200);
      originBeforeDestination(detail.body, '<strong>Origin</strong>', '<strong>Destination</strong>');
      originBeforeDestination(detail.body, 'for="edit_origin"', 'for="edit_destination"');
      assert.ok(detail.body.includes('Richmond Yard'));
      assert.ok(detail.body.includes('value="Richmond Yard"'));
      assert.ok(detail.body.includes('11-04-2026'));
      assert.ok(detail.body.includes('value="2026-11-04"'));
      assert.ok(list.body.includes('Trucks:'));
      assert.ok(detail.body.includes('<strong>Trucks</strong>'));

      const invoices = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/settlements' });
      assert.strictEqual(invoices.status, 200);
      originBeforeDestination(invoices.body, '<th>Origin</th>', '<th>Destination</th>');
      assert.ok(invoices.body.includes('Richmond Yard'));
      assert.ok(invoices.body.includes('11-04-2026'));
      assert.ok(invoices.body.includes('>Detention</th>'));
      assert.ok(invoices.body.includes('<span>Detention</span><span>$0.00</span>'));
      assert.ok(invoices.body.includes('<span>TOTAL</span><span>$120.00</span>'));
    });

    await check('load register and forms show Trucks and the shared truck labels', async () => {
      async function addUnit(fields) {
        const res = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) }, {
          method: 'POST',
          path: '/equipment',
          body: form(Object.assign({ plate_state: 'VA', maintenance_status: 'active', status: 'active' }, fields))
        });
        assert.strictEqual(res.status, 302, fields.number + ' ' + res.body.slice(0, 240));
      }
      await addUnit({ type: 'truck', number: '1001', make: 'Kenworth', model: 'T680' });
      await addUnit({ type: 'hotshot', number: '1006', make: 'Ford', model: 'F350' });
      const formPage = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/loads/new' });
      assert.strictEqual(formPage.status, 200);
      assert.ok(formPage.body.includes('<label>Truck</label>'));
      assert.ok(!formPage.body.includes('Truck / Hotshot'));
      assert.ok(formPage.body.includes('Truck #1001'));
      assert.ok(formPage.body.includes('Truck #1006 - Ford F350/Hotshot'));
      assert.ok(!formPage.body.includes('Hotshot 1006'));

      const hotshotId = readRows(dataDir, "SELECT id FROM equipment WHERE number = '1006'")[0].id;
      const created = await postLoad({
        project_id: otherProject.id,
        ticket_number: 'TRUCK-1006',
        origin: 'Yard',
        destination: 'Site',
        truck_id: hotshotId,
        action: 'draft'
      });
      assert.strictEqual(created.row.truck_id, hotshotId);
      const detail = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: `/loads/${created.id}` });
      assert.ok(detail.body.includes('<strong>Trucks</strong>'));
      assert.ok(detail.body.includes('Truck #1006 - Ford F350/Hotshot'));
      const list = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: '/loads' });
      assert.ok(list.body.includes('Trucks: Truck #1006 - Ford F350/Hotshot'));

      const api = await request(srv.port, { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, {
        method: 'POST',
        path: '/api/logan/loads',
        body: JSON.stringify({
          action: 'draft',
          driver_id: driverId,
          project_id: otherProject.id,
          truck_id: hotshotId,
          ticket_number: 'API-TRUCK'
        })
      });
      assert.strictEqual(api.status, 201, api.body);
      const apiLoad = JSON.parse(api.body).load;
      assert.strictEqual(apiLoad.truck_number, '1006');
      assert.strictEqual(apiLoad.truck_id, hotshotId);
      assert.ok(!Object.prototype.hasOwnProperty.call(apiLoad, 'truck_label'));
      assert.ok(!api.body.includes('Ford F350/Hotshot'));
    });

    await check('a new Uber Freight load with blank origin and destination uses Sandston and the project name', async () => {
      const created = await postLoad({
        project_id: uberProject.id,
        ticket_number: 'UF-BLANK',
        origin: '   ',
        destination: ''
      });
      assert.strictEqual(created.row.origin, 'Sandston');
      assert.strictEqual(created.row.destination, 'Madison Heights');
      assert.strictEqual(created.row.description, 'Madison Heights');
      assert.notStrictEqual(created.row.destination, 'Uber Freight - Madison Heights');
    });

    await check('Uber Freight keeps an origin and destination the user entered', async () => {
      const created = await postLoad({
        project_id: uberProject.id,
        ticket_number: 'UF-TYPED',
        origin: 'Richmond Yard',
        destination: 'Custom Pier'
      });
      assert.strictEqual(created.row.origin, 'Richmond Yard');
      assert.strictEqual(created.row.destination, 'Custom Pier');
    });

    await check('Uber Freight matching is case-insensitive and ignores surrounding spaces', async () => {
      const created = await postLoad({
        project_id: mixedCaseProject.id,
        ticket_number: 'UF-CASE',
        origin: '',
        destination: ''
      });
      assert.strictEqual(created.row.origin, 'Sandston');
      assert.strictEqual(created.row.destination, 'Hopewell');
    });

    await check('a non-Uber load gets no origin or destination default', async () => {
      const blank = await postLoad({
        project_id: otherProject.id,
        ticket_number: 'ACME-BLANK',
        origin: '',
        destination: ''
      });
      assert.strictEqual(blank.row.origin, null);
      assert.strictEqual(blank.row.destination, null);

      const typed = await postLoad({
        project_id: otherProject.id,
        ticket_number: 'ACME-ORIGIN',
        origin: 'Yard',
        destination: ''
      });
      assert.strictEqual(typed.row.origin, 'Yard');
      assert.strictEqual(typed.row.destination, null);

      const near = await postLoad({
        project_id: nearMissProject.id,
        ticket_number: 'NEAR',
        origin: '',
        destination: ''
      });
      assert.strictEqual(near.row.origin, null);
      assert.strictEqual(near.row.destination, null);
    });

    let editableId = 0;
    await check('editing an existing Uber Freight load does not apply the defaults', async () => {
      const created = await postLoad({
        project_id: uberProject.id,
        ticket_number: 'UF-EDIT',
        origin: 'Richmond Yard',
        destination: 'Custom Pier',
        action: 'draft'
      });
      editableId = created.id;
      const cleared = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) }, {
        method: 'POST',
        path: `/loads/${editableId}`,
        body: form({
          action: 'save',
          driver_id: driverId,
          project_id: uberProject.id,
          ticket_number: 'UF-EDIT-2',
          load_date: '2026-11-04',
          origin: '',
          destination: '',
          rate: '12'
        })
      });
      assert.strictEqual(cleared.status, 302, cleared.body.slice(0, 300));
      const row = readRows(dataDir, 'SELECT ticket_number, origin, destination FROM loads WHERE id = ?', [editableId])[0];
      assert.strictEqual(row.ticket_number, 'UF-EDIT-2');
      assert.strictEqual(row.origin, null);
      assert.strictEqual(row.destination, null);

      const kept = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) }, {
        method: 'POST',
        path: `/loads/${editableId}`,
        body: form({
          action: 'save',
          driver_id: driverId,
          project_id: uberProject.id,
          ticket_number: 'UF-EDIT-2',
          load_date: '2026-11-04',
          origin: 'Kept Yard',
          destination: 'Kept Pier',
          rate: '12'
        })
      });
      assert.strictEqual(kept.status, 302);
      const after = readRows(dataDir, 'SELECT origin, destination FROM loads WHERE id = ?', [editableId])[0];
      assert.strictEqual(after.origin, 'Kept Yard');
      assert.strictEqual(after.destination, 'Kept Pier');
    });

    await check('driver create and edit forms show Origin just before Destination', async () => {
      const assigned = await postLoad({
        project_id: uberProject.id,
        ticket_number: 'UF-ASSIGN',
        origin: 'Sandston',
        destination: 'Madison Heights',
        action: 'draft'
      });
      const driverJar = {};
      const login = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded' }, {
        method: 'POST',
        path: '/login',
        body: form({ email: 'pat.origin@example.com', password: driverPassword })
      });
      assert.strictEqual(login.status, 302);
      assert.strictEqual(login.headers.location, '/change-password');
      remember(driverJar, login);
      const changed = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(driverJar) }, {
        method: 'POST',
        path: '/change-password',
        body: form({ new_password: 'Driver-Origin-1', confirm_password: 'Driver-Origin-1' })
      });
      assert.strictEqual(changed.status, 302);
      assert.strictEqual(changed.headers.location, '/');
      remember(driverJar, changed);

      const created = await request(srv.port, { Cookie: cookieHeader(driverJar) }, { path: '/loads/new' });
      assert.strictEqual(created.status, 200);
      originBeforeDestination(created.body, 'for="origin"', 'for="destination"');
      const edit = await request(srv.port, { Cookie: cookieHeader(driverJar) }, { path: `/loads/${assigned.id}/edit` });
      assert.strictEqual(edit.status, 200);
      originBeforeDestination(edit.body, 'for="origin"', 'for="destination"');
      assert.ok(edit.body.includes('value="Sandston"'));
      assert.ok(edit.body.includes('value="Madison Heights"'));

      const list = await request(srv.port, { Cookie: cookieHeader(driverJar) }, { path: '/loads' });
      assert.strictEqual(list.status, 200);
      originBeforeDestination(list.body, 'Origin: Sandston', 'Destination: Madison Heights');
    });

    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    await check('Logan API accepts and returns origin without dropping destination', async () => {
      const blank = await request(srv.port, auth, {
        method: 'POST',
        path: '/api/logan/loads',
        body: JSON.stringify({
          action: 'submit',
          driver_id: driverId,
          project_id: uberProject.id,
          ticket_number: 'API-UF',
          load_date: '2026-11-04'
        })
      });
      assert.strictEqual(blank.status, 201, blank.body);
      const blankLoad = JSON.parse(blank.body).load;
      assert.strictEqual(blankLoad.origin, 'Sandston');
      assert.strictEqual(blankLoad.destination, 'Madison Heights');
      assert.strictEqual(blankLoad.load_date, '2026-11-04');
      assert.strictEqual(blankLoad.ticket_number, 'API-UF');
      assert.strictEqual(blankLoad.customer, 'Uber Freight');
      assert.ok(blankLoad.project);

      const typed = await request(srv.port, auth, {
        method: 'POST',
        path: '/api/logan/loads',
        body: JSON.stringify({
          action: 'draft',
          driver_id: driverId,
          project_id: uberProject.id,
          ticket_number: 'API-TYPED',
          origin: 'Richmond Yard',
          destination: 'Jobsite'
        })
      });
      assert.strictEqual(typed.status, 201, typed.body);
      const typedLoad = JSON.parse(typed.body).load;
      assert.strictEqual(typedLoad.origin, 'Richmond Yard');
      assert.strictEqual(typedLoad.destination, 'Jobsite');

      const other = await request(srv.port, auth, {
        method: 'POST',
        path: '/api/logan/loads',
        body: JSON.stringify({
          action: 'draft',
          driver_id: driverId,
          project_id: otherProject.id,
          ticket_number: 'API-ACME'
        })
      });
      assert.strictEqual(other.status, 201, other.body);
      const otherLoad = JSON.parse(other.body).load;
      assert.strictEqual(otherLoad.origin, null);
      assert.strictEqual(otherLoad.destination, null);
      assert.strictEqual(otherLoad.customer, 'Acme Haul');

      const fetched = await request(srv.port, { Authorization: `Bearer ${token}` }, { path: `/api/logan/loads/${blankLoad.id}` });
      assert.strictEqual(fetched.status, 200);
      assert.strictEqual(JSON.parse(fetched.body).load.origin, 'Sandston');
    });
  } finally {
    await stop(srv.child);
  }

  srv = await startServer({
    DATA_DIR: dataDir,
    LOGAN_TMS_PASSWORD: adminPassword,
    LOGAN_API_TOKEN: '',
    SESSION_SECRET: 'load-origin-test'
  });
  try {
    await check('restarting does not rewrite origin on loads that already exist', async () => {
      const before = readRows(dataDir, "SELECT id, origin, destination FROM loads WHERE ticket_number = 'UF-BLANK'")[0];
      assert.strictEqual(before.origin, 'Sandston');
      await stop(srv.child);
      srv = null;
      writeDb(dataDir, (database) => {
        database.prepare('UPDATE loads SET origin = NULL WHERE id = ?').run(before.id);
      });
      srv = await startServer({
        DATA_DIR: dataDir,
        LOGAN_TMS_PASSWORD: adminPassword,
        LOGAN_API_TOKEN: '',
        SESSION_SECRET: 'load-origin-test'
      });
      const after = readRows(dataDir, 'SELECT origin, destination, ticket_number FROM loads WHERE id = ?', [before.id])[0];
      assert.strictEqual(after.ticket_number, 'UF-BLANK');
      assert.strictEqual(after.origin, null);
      assert.strictEqual(after.destination, 'Madison Heights');
    });
  } finally {
    if (srv) await stop(srv.child);
  }

  console.log(`\n${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
