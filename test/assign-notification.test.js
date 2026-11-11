// Assignment texts are per load. Unchecked boxes must not log or show a notice,
// and one load must never render another load's message.
// Run: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const STALE_BODY = 'DT1 Logistics has assigned you a new Load (#7 for 10-02-2026 — Uber Freight - Salem). LOAD7-SALEM-MARKER';
const STALE_SMS = 'Logged (Tap Open Text Message below to send from phone)';
const FLASH_TEXT = 'STALE-FLASH-LOAD-7 from the previous session';
const QUERY_TEXT = 'LOAD7-FROM-QUERY';

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

function sessionSid(jar) {
  const raw = String(jar['connect.sid'] || '');
  const encoded = raw.startsWith('connect.sid=') ? raw.slice('connect.sid='.length) : raw;
  const value = decodeURIComponent(encoded);
  const unsigned = value.startsWith('s:') ? value.slice(2) : value;
  const dot = unsigned.lastIndexOf('.');
  return dot === -1 ? unsigned : unsigned.slice(0, dot);
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        REDIS_URL: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '',
        TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_FROM_NUMBER: '',
        SMS_GATEWAY_DOMAIN: '',
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

function openDb(dataDir) {
  const database = new Database(path.join(dataDir, 'dt1.db'));
  database.pragma('busy_timeout = 5000');
  return database;
}

function readRows(dataDir, sql, params) {
  const database = new Database(path.join(dataDir, 'dt1.db'), { readonly: true, fileMustExist: true });
  try { return database.prepare(sql).all(...(params || [])); } finally { database.close(); }
}

function writeDb(dataDir, fn) {
  const database = openDb(dataDir);
  try { fn(database); } finally { database.close(); }
}

function smsPreview(body) {
  const match = String(body || '').match(/id="assigned-sms-text">([\s\S]*?)<\/pre>/);
  if (!match) return '';
  return match[1]
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function assertNoAssignmentNotice(page, label) {
  const where = label || 'page';
  assert.ok(!page.body.includes('Text message notification triggered'), where);
  assert.ok(!page.body.includes('id="assigned-sms-card"'), where);
  assert.ok(!page.body.includes('Open Text Message'), where);
  assert.ok(!page.body.includes('Text (SMS) Status'), where);
  assert.ok(!page.body.includes('Email Status'), where);
  assert.ok(!page.body.includes(STALE_BODY), where);
  assert.ok(!page.body.includes('LOAD7-SALEM-MARKER'), where);
  assert.ok(!page.body.includes('Uber Freight - Salem'), where);
  assert.ok(!page.body.includes(STALE_SMS), where);
  assert.ok(!page.body.includes('Could not send'), where);
  assert.ok(!page.body.includes(FLASH_TEXT), where);
  assert.ok(!page.body.includes(QUERY_TEXT), where);
  assert.strictEqual(smsPreview(page.body), '');
}

(async () => {
  const adminPassword = 'Assign-Notice-1';

  await check('an existing communications log gains a load id without rewriting old rows', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-assign-migrate-'));
    writeDb(dataDir, (database) => {
      database.exec(`
        CREATE TABLE communications_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          driver_id INTEGER,
          driver_name TEXT,
          subject TEXT,
          message_body TEXT,
          email_status TEXT,
          sms_status TEXT
        );
        INSERT INTO communications_log (driver_id, driver_name, subject, message_body, email_status, sms_status)
        VALUES (1, 'Franklin', 'DT1 Logistics has assigned you a new Load', '${STALE_BODY.replace(/'/g, "''")}', 'Could not send', '${STALE_SMS.replace(/'/g, "''")}');
      `);
    });
    const srv = await startServer({ DATA_DIR: dataDir, LOGAN_TMS_PASSWORD: adminPassword, LOGAN_API_TOKEN: '' });
    try {
      const names = readRows(dataDir, "SELECT name FROM pragma_table_info('communications_log')").map((col) => col.name);
      assert.ok(names.includes('load_id'));
      const row = readRows(dataDir, 'SELECT load_id, message_body, sms_status, email_status FROM communications_log')[0];
      assert.strictEqual(row.load_id, null);
      assert.ok(row.message_body.includes('LOAD7-SALEM-MARKER'));
      assert.strictEqual(row.sms_status, STALE_SMS);
      assert.strictEqual(row.email_status, 'Could not send');
    } finally {
      await stop(srv.child);
    }
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-assign-notice-'));
  const srv = await startServer({
    DATA_DIR: dataDir,
    LOGAN_TMS_PASSWORD: adminPassword,
    LOGAN_API_TOKEN: '',
    SESSION_SECRET: 'assign-notice-test'
  });
  try {
    const admin = {};
    const login = await request(srv.port, { 'Content-Type': 'application/x-www-form-urlencoded' }, {
      method: 'POST', path: '/login', body: form({ email: 'david.dt1@mail.grokbot.com', password: adminPassword })
    });
    assert.strictEqual(login.status, 302, login.body.slice(0, 200));
    remember(admin, login);
    const auth = { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(admin) };

    const shipper = await request(srv.port, auth, { method: 'POST', path: '/shippers', body: form({ name: 'Uber Freight' }) });
    assert.strictEqual(shipper.status, 302, shipper.body.slice(0, 200));
    const shipperId = String(shipper.headers.location || '').split('/').pop();
    const projectRes = await request(srv.port, auth, {
      method: 'POST',
      path: `/shippers/${shipperId}/projects`,
      body: form({ project_name: 'Roanoke', default_rate: '12', status: 'active' })
    });
    assert.strictEqual(projectRes.status, 302, projectRes.body.slice(0, 200));
    const projectId = readRows(dataDir, 'SELECT id, display_name FROM projects ORDER BY id DESC LIMIT 1')[0];
    assert.strictEqual(projectId.display_name, 'Uber Freight - Roanoke');

    const driverRes = await request(srv.port, auth, {
      method: 'POST',
      path: '/drivers',
      body: form({ first_name: 'Franklin', last_name: 'Hayes', email: 'franklin.assign@example.com', phone: '5555550147' })
    });
    assert.strictEqual(driverRes.status, 200, driverRes.body.slice(0, 300));
    const driver = readRows(dataDir, "SELECT id, name FROM users WHERE email = 'franklin.assign@example.com'")[0];
    assert.ok(driver.name.includes('Franklin'));

    writeDb(dataDir, (database) => {
      database.prepare(`
        INSERT INTO communications_log (
          driver_id, driver_name, driver_email, driver_phone, channels, subject, message_body,
          email_status, sms_status, sent_by_name, load_id
        ) VALUES (?, 'Franklin Hayes', 'franklin.assign@example.com', '5555550147', 'Email + Text (Assigned Load)',
          'DT1 Logistics has assigned you a new Load', ?, 'Could not send', ?, 'Logan', NULL)
      `).run(driver.id, STALE_BODY, STALE_SMS);
    });

    function assignmentLogs(loadId) {
      if (loadId == null) {
        return readRows(dataDir, "SELECT id, load_id, message_body, sms_status, email_status FROM communications_log WHERE subject = 'DT1 Logistics has assigned you a new Load' ORDER BY id");
      }
      return readRows(dataDir, 'SELECT id, load_id, message_body, sms_status, email_status FROM communications_log WHERE load_id = ? ORDER BY id', [loadId]);
    }
    function notifyAudits(loadId) {
      return readRows(dataDir, "SELECT id FROM audit_log WHERE action = 'Sent load assignment notification' AND entity_id = ?", [loadId]);
    }

    async function postLoad(pathName, fields) {
      const res = await request(srv.port, auth, { method: 'POST', path: pathName, body: form(fields) });
      remember(admin, res);
      return res;
    }

    async function openLoad(id, query) {
      const page = await request(srv.port, { Cookie: cookieHeader(admin) }, { path: `/loads/${id}${query || ''}` });
      remember(admin, page);
      return page;
    }

    function plantFlash(loadId) {
      const sid = sessionSid(admin);
      writeDb(dataDir, (database) => {
        const row = database.prepare('SELECT sess FROM sessions WHERE sid = ?').get(sid);
        assert.ok(row, `session ${sid} missing`);
        const sess = JSON.parse(row.sess);
        sess.assignedLoadNotice = {
          loadId,
          smsText: FLASH_TEXT,
          smsStatus: STALE_SMS,
          emailStatus: 'Could not send',
          smsHref: 'sms:+15555550147?&body=STALE-FLASH-LOAD-7',
          mailto: 'mailto:franklin.assign@example.com?body=STALE-FLASH-LOAD-7'
        };
        database.prepare('UPDATE sessions SET sess = ? WHERE sid = ?').run(JSON.stringify(sess), sid);
      });
    }

    const draftBase = {
      admin_mode: 'assign',
      action: 'draft',
      driver_id: driver.id,
      project_id: projectId.id,
      ticket_number: 'UF-6896714021',
      load_date: '2026-11-11',
      origin: 'Sandston',
      destination: 'Roanoke',
      weight_quantity: '10',
      rate: '12'
    };

    let draftId = 0;
    await check('creating an assigned draft with both boxes unchecked does not log or show a notification', async () => {
      const before = assignmentLogs().length;
      const res = await postLoad('/loads', draftBase);
      assert.strictEqual(res.status, 302, res.body.slice(0, 300));
      assert.ok(String(res.headers.location || '').includes('saved=assigned'));
      draftId = Number(String(res.headers.location).match(/\/loads\/(\d+)/)[1]);
      const page = await openLoad(draftId, '?saved=assigned');
      assert.strictEqual(page.status, 200);
      assert.ok(page.body.includes('Load assigned to'));
      assert.ok(page.body.includes('Franklin'));
      assert.ok(page.body.includes('saved to their Drafts.'));
      assertNoAssignmentNotice(page, 'unchecked create');
      assert.strictEqual(assignmentLogs().length, before);
      assert.strictEqual(assignmentLogs(draftId).length, 0);
      assert.strictEqual(notifyAudits(draftId).length, 0);
      const stored = readRows(dataDir, 'SELECT id, ticket_number, load_date, entry_mode, status FROM loads WHERE id = ?', [draftId])[0];
      assert.strictEqual(stored.ticket_number, 'UF-6896714021');
      assert.strictEqual(stored.entry_mode, 'assigned');
      assert.strictEqual(stored.status, 'draft');
    });

    await check('a stale flash, query param, or another load\'s log cannot render on the new draft', async () => {
      plantFlash(draftId);
      const page = await openLoad(draftId, `?saved=assigned&smsText=${encodeURIComponent(QUERY_TEXT)}&notice=${encodeURIComponent(STALE_BODY)}`);
      assert.strictEqual(page.status, 200);
      assertNoAssignmentNotice(page, 'stale flash on new draft');
      assert.ok(page.body.includes('UF-6896714021'));
      assert.ok(page.body.includes('11-11-2026'));
    });

    await check('editing that draft with both boxes unchecked still logs and shows nothing', async () => {
      const before = assignmentLogs().length;
      const res = await postLoad(`/loads/${draftId}`, draftBase);
      assert.strictEqual(res.status, 302, res.body.slice(0, 300));
      assert.ok(!String(res.headers.location || '').includes('saved=assigned'), res.headers.location);
      const page = await openLoad(draftId, '?saved=edited');
      assert.strictEqual(page.status, 200);
      assert.ok(page.body.includes('Load saved.'));
      assertNoAssignmentNotice(page, 'unchecked draft edit');
      assert.strictEqual(assignmentLogs().length, before);
      assert.strictEqual(notifyAudits(draftId).length, 0);

      const saved = await postLoad(`/loads/${draftId}`, Object.assign({}, draftBase, { action: 'save' }));
      assert.strictEqual(saved.status, 302, saved.body.slice(0, 300));
      const again = await openLoad(draftId);
      assertNoAssignmentNotice(again, 'unchecked save of assigned draft');
      assert.strictEqual(assignmentLogs().length, before);
    });

    let textedId = 0;
    await check('a checked SMS on create is stored and shown for that load only', async () => {
      const res = await postLoad('/loads', {
        admin_mode: 'assign',
        action: 'draft',
        driver_id: driver.id,
        project_id: projectId.id,
        ticket_number: 'UF-TEXT-12',
        load_date: '2026-11-12',
        origin: 'Lynchburg',
        destination: 'Danville',
        weight_quantity: '8',
        rate: '12',
        send_assign_sms: '1',
        assign_sms_message: STALE_BODY
      });
      assert.strictEqual(res.status, 302, res.body.slice(0, 300));
      textedId = Number(String(res.headers.location).match(/\/loads\/(\d+)/)[1]);
      assert.notStrictEqual(textedId, draftId);
      const rows = assignmentLogs(textedId);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].load_id, textedId);
      assert.ok(rows[0].message_body.includes(`#${textedId} for 11-12-2026`), rows[0].message_body);
      assert.ok(rows[0].message_body.includes('Uber Freight - Roanoke'), rows[0].message_body);
      assert.ok(rows[0].message_body.includes('Lynchburg'), rows[0].message_body);
      assert.ok(rows[0].message_body.includes('Danville'), rows[0].message_body);
      assert.ok(!rows[0].message_body.includes('LOAD7-SALEM-MARKER'), rows[0].message_body);
      assert.ok(!rows[0].message_body.includes('#7'), rows[0].message_body);
      assert.ok(!rows[0].message_body.includes('10-02-2026'), rows[0].message_body);
      assert.ok(!rows[0].message_body.includes('Salem'), rows[0].message_body);
      assert.ok(!rows[0].message_body.includes(`#${draftId} for`), rows[0].message_body);
      assert.strictEqual(rows[0].sms_status, STALE_SMS);
      assert.strictEqual(rows[0].email_status, 'Not selected');
      assert.strictEqual(notifyAudits(textedId).length, 1);

      const page = await openLoad(textedId, '?saved=assigned');
      assert.strictEqual(page.status, 200);
      assert.ok(page.body.includes('Text message notification triggered'));
      assert.ok(page.body.includes('id="assigned-sms-card"'));
      assert.ok(page.body.includes('Open Text Message (SMS)'));
      assert.ok(!page.body.includes('Email Status'));
      assert.ok(!page.body.includes('Could not send'));
      const preview = smsPreview(page.body);
      assert.ok(preview.includes(`#${textedId} for 11-12-2026`), preview);
      assert.ok(preview.includes('Uber Freight - Roanoke'), preview);
      assert.ok(preview.includes('Lynchburg'), preview);
      assert.ok(!preview.includes('LOAD7-SALEM-MARKER'), preview);
      assert.ok(!preview.includes('Salem'), preview);
      assert.ok(!preview.includes('11-11-2026'), preview);
      assert.ok(!preview.includes('Sandston'), preview);

      plantFlash(textedId);
      const flashed = await openLoad(textedId, `?saved=assigned&smsText=${encodeURIComponent(QUERY_TEXT)}`);
      const flashedPreview = smsPreview(flashed.body);
      assert.ok(flashedPreview.includes(`#${textedId} for 11-12-2026`), flashedPreview);
      assert.ok(!flashed.body.includes(FLASH_TEXT));
      assert.ok(!flashed.body.includes(QUERY_TEXT));

      const other = await openLoad(draftId, '?saved=assigned');
      assertNoAssignmentNotice(other, 'prior text on a different load');
      assert.ok(!other.body.includes(`#${textedId} for`));
      assert.ok(!other.body.includes('11-12-2026'));
      assert.ok(!other.body.includes('Lynchburg'));
      assert.ok(!other.body.includes('UF-TEXT-12'));
    });

    await check('a checked SMS on edit uses the load being saved', async () => {
      const res = await postLoad(`/loads/${draftId}`, Object.assign({}, draftBase, {
        send_assign_sms: '1',
        assign_sms_message: STALE_BODY
      }));
      assert.strictEqual(res.status, 302, res.body.slice(0, 300));
      assert.ok(String(res.headers.location || '').includes('saved=assigned'));
      const rows = assignmentLogs(draftId);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].load_id, draftId);
      assert.ok(rows[0].message_body.includes(`#${draftId} for 11-11-2026`), rows[0].message_body);
      assert.ok(rows[0].message_body.includes('Uber Freight - Roanoke'), rows[0].message_body);
      assert.ok(rows[0].message_body.includes('Sandston'), rows[0].message_body);
      assert.ok(!rows[0].message_body.includes('UF-6896714021'), rows[0].message_body);
      assert.ok(!rows[0].message_body.includes('LOAD7-SALEM-MARKER'), rows[0].message_body);
      assert.ok(!rows[0].message_body.includes(`#${textedId} for`), rows[0].message_body);
      assert.ok(!rows[0].message_body.includes('11-12-2026'), rows[0].message_body);
      assert.ok(!rows[0].message_body.includes('Lynchburg'), rows[0].message_body);
      assert.strictEqual(rows[0].email_status, 'Not selected');

      const page = await openLoad(draftId, '?saved=assigned');
      const preview = smsPreview(page.body);
      assert.ok(page.body.includes('Text message notification triggered'));
      assert.ok(preview.includes(`#${draftId} for 11-11-2026`), preview);
      assert.ok(preview.includes('Uber Freight - Roanoke'), preview);
      assert.ok(preview.includes('Sandston'), preview);
      assert.ok(!preview.includes('LOAD7-SALEM-MARKER'), preview);
      assert.ok(!preview.includes(`#${textedId}`), preview);
      assert.ok(!preview.includes('11-12-2026'), preview);

      const other = await openLoad(textedId);
      const otherPreview = smsPreview(other.body);
      assert.ok(otherPreview.includes(`#${textedId} for 11-12-2026`), otherPreview);
      assert.ok(!otherPreview.includes(`#${draftId} for`), otherPreview);
      assert.ok(!otherPreview.includes('11-11-2026'), otherPreview);
      assert.ok(!otherPreview.includes('Sandston'), otherPreview);
      assert.ok(!other.body.includes('LOAD7-SALEM-MARKER'));
    });

    await check('a non-draft create or edit does not log or show an assignment notification', async () => {
      const before = assignmentLogs().length;
      const created = await postLoad('/loads', {
        admin_mode: 'enter',
        action: 'submit',
        driver_id: driver.id,
        project_id: projectId.id,
        ticket_number: 'UF-ENTERED',
        load_date: '2026-11-13',
        origin: 'Yard',
        destination: 'Site',
        weight_quantity: '4',
        rate: '12',
        send_assign_sms: '1',
        send_assign_email: '1',
        assign_sms_message: STALE_BODY
      });
      assert.strictEqual(created.status, 302, created.body.slice(0, 300));
      assert.ok(!String(created.headers.location || '').includes('saved=assigned'), created.headers.location);
      const enteredId = Number(String(created.headers.location).match(/\/loads\/(\d+)/)[1]);
      const createdPage = await openLoad(enteredId, '?saved=assigned');
      assertNoAssignmentNotice(createdPage, 'non-draft create');
      assert.ok(!createdPage.body.includes('Text message notification triggered'));
      assert.strictEqual(assignmentLogs(enteredId).length, 0);
      assert.strictEqual(notifyAudits(enteredId).length, 0);
      const entered = readRows(dataDir, 'SELECT status, entry_mode FROM loads WHERE id = ?', [enteredId])[0];
      assert.strictEqual(entered.status, 'submitted');
      assert.strictEqual(entered.entry_mode, 'entered');

      const edited = await postLoad(`/loads/${enteredId}`, {
        action: 'save',
        driver_id: driver.id,
        project_id: projectId.id,
        ticket_number: 'UF-ENTERED',
        load_date: '2026-11-13',
        origin: 'Yard',
        destination: 'Site',
        weight_quantity: '4',
        rate: '12',
        send_assign_sms: '1',
        send_assign_email: '1'
      });
      assert.strictEqual(edited.status, 302, edited.body.slice(0, 300));
      const editedPage = await openLoad(enteredId, '?saved=edited');
      assert.ok(editedPage.body.includes('Load saved.'));
      assertNoAssignmentNotice(editedPage, 'non-draft edit');
      assert.strictEqual(assignmentLogs().length, before + 0);
      assert.strictEqual(assignmentLogs(enteredId).length, 0);

      const quietDraft = await openLoad(draftId);
      assert.ok(smsPreview(quietDraft.body).includes(`#${draftId} for 11-11-2026`));
      assert.ok(!quietDraft.body.includes('LOAD7-SALEM-MARKER'));
      const quietText = await openLoad(textedId);
      assert.ok(smsPreview(quietText.body).includes(`#${textedId} for 11-12-2026`));
      assert.ok(!quietText.body.includes(`#${draftId} for`));
    });

    assert.ok(!srv.output().includes('api.twilio.com'));
  } finally {
    await stop(srv.child);
  }

  console.log(`\n${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
