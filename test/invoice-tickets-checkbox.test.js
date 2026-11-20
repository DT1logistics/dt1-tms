// Generate Invoice "Attach ticket images" checkbox. The form posts a hidden 0
// and, when checked, a 1 with the same name, so express.urlencoded({extended:true})
// gives req.body.include_tickets = ['0','1'].
// Run: node test/invoice-tickets-checkbox.test.js
const assert = require('assert');
const http = require('http');
const h = require('./helpers/server');
const formFlag = require('../lib/form-flag');

// 1x1 red JPEG, so ticket-attachment tests do not need a fixture file.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGdAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/AL//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AL//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AL//2Q==',
  'base64'
);

function requestRaw(port, headers, opts) {
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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body || undefined);
  });
}

function pdfText(buffer) {
  const raw = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer);
  return raw.replace(/\\([()\\])/g, '$1');
}

// Same field names as the generate-invoice form, including a repeated include_tickets.
function generateBody(fields, ticketValues) {
  const parts = Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v == null ? '' : v)}`);
  ticketValues.forEach((v) => parts.push(`include_tickets=${encodeURIComponent(v)}`));
  return parts.join('&');
}

(async () => {
  const { check, results } = h.makeChecker();

  await check('helper treats a checked hidden+checkbox pair as on', () => {
    assert.strictEqual(formFlag.isOn(['0', '1']), true);
    assert.strictEqual(formFlag.isOn('0'), false);
    assert.strictEqual(formFlag.isOn(['0']), false);
    assert.strictEqual(formFlag.isOn('on'), true);
    assert.strictEqual(formFlag.isOn('1'), true);
  });

  const adminPassword = 'Invoice-Tickets-Admin-1';
  const dataDir = h.tempDataDir('dt1-invoice-tickets-');
  const srv = await h.startServer({ DATA_DIR: dataDir, LOGAN_TMS_PASSWORD: adminPassword, LOGAN_API_TOKEN: '', SESSION_SECRET: 'invoice-tickets-test' });
  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    // Dummy project first so the invoiced project id is not 1, which would
    // collide with the first load id and hide a load.id overwrite.
    const ids = await h.seedBasics(srv.port, dataDir, admin, { customer: 'Synagro', project: 'Dummy Pad' });
    const auth = ids.auth;
    const post = (path, fields) => h.request(srv.port, auth, { method: 'POST', path, body: h.form(fields) });

    const createdProject = await post(`/customers/${ids.customerId}/projects`, {
      project_name: 'West Rock',
      default_rate: '9.26',
      status: 'active'
    });
    assert.strictEqual(createdProject.status, 302, createdProject.body.slice(0, 200));
    const projectId = h.readRows(dataDir, "SELECT id FROM projects WHERE project_name = 'West Rock'")[0].id;

    const created = await post('/loads', {
      action: 'approve',
      load_date: '2026-11-13',
      project_id: projectId,
      driver_id: ids.driverId,
      ticket_number: '273698',
      weight_quantity: '23.9',
      rate: '9.26',
      destination: 'Gloucester'
    });
    assert.strictEqual(created.status, 302, created.body.slice(0, 200));
    const loadId = h.readRows(dataDir, "SELECT id FROM loads WHERE ticket_number = '273698'")[0].id;
    assert.notStrictEqual(Number(projectId), Number(loadId),
      `test must use a project id (${projectId}) that differs from the load id (${loadId})`);
    h.writeDb(dataDir, (db) => {
      db.prepare('INSERT INTO documents (load_id, filename, original_name, category, file_blob) VALUES (?, ?, ?, ?, ?)')
        .run(loadId, 'a.jpg', 'ticket-a.jpg', 'load_document', TINY_JPEG);
    });

    const weekFields = { customer_id: ids.customerId, project_id: projectId, week_start: '2026-11-09' };

    await check('invoice line id is the load id, not the project id', async () => {
      const page = await h.request(srv.port, auth, { path: '/invoices' });
      assert.strictEqual(page.status, 200, page.body.slice(0, 200));
      assert.ok(
        page.body.includes(`href="/loads/${loadId}"`),
        `expected invoice line link /loads/${loadId}, project id is ${projectId}`
      );
    });

    let checkedPdf;
    await check('checked Attach ticket images redirects with tickets=1 and the PDF has the ticket page', async () => {
      const res = await h.request(srv.port, auth, {
        method: 'POST',
        path: '/invoices/generate',
        body: generateBody(weekFields, ['0', '1'])
      });
      assert.strictEqual(res.status, 302, res.body.slice(0, 200));
      const location = String(res.headers.location || '');
      assert.ok(location.includes('/invoices/pdf?'), location);
      assert.ok(/[?&]tickets=1(?:&|$)/.test(location), `expected tickets=1 in ${location}`);
      const pdf = await requestRaw(srv.port, { Cookie: h.cookieHeader(admin) }, { path: location });
      assert.strictEqual(pdf.status, 200);
      assert.ok(String(pdf.headers['content-type']).includes('application/pdf'));
      const text = pdfText(pdf.body);
      assert.ok(text.startsWith('%PDF-1.4'));
      assert.ok(text.includes('Ticket #: 273698'), 'invoicePdf should attach the raster ticket page');
      checkedPdf = pdf;
    });

    await check('unchecked Attach ticket images redirects with tickets=0 and omits ticket pages', async () => {
      const res = await h.request(srv.port, auth, {
        method: 'POST',
        path: '/invoices/generate',
        body: generateBody(weekFields, ['0'])
      });
      assert.strictEqual(res.status, 302, res.body.slice(0, 200));
      const location = String(res.headers.location || '');
      assert.ok(/[?&]tickets=0(?:&|$)/.test(location), `expected tickets=0 in ${location}`);
      const pdf = await requestRaw(srv.port, { Cookie: h.cookieHeader(admin) }, { path: location });
      assert.strictEqual(pdf.status, 200);
      const text = pdfText(pdf.body);
      assert.ok(text.startsWith('%PDF-1.4'));
      assert.ok(!text.includes('Ticket #: 273698'), 'unchecked box leaves tickets off');
      assert.ok(checkedPdf && checkedPdf.body.length > pdf.body.length,
        `checked PDF (${checkedPdf && checkedPdf.body.length}) should be larger than unchecked (${pdf.body.length})`);
    });
  } finally {
    await h.stop(srv.child);
  }

  console.log(`\n${results.length} invoice-tickets-checkbox checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
