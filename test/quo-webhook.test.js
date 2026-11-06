// Run: npm test
// Quo inbound text relay: signature, event filter, and the Logan forward.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const quoWebhook = require('../lib/quo-webhook');

const results = [];
async function check(name, fn) {
  await fn();
  results.push(name);
  console.log('ok -', name);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const secretBytes = Buffer.from('0123456789abcdef0123456789abcdef');
const SECRET = `whsec_${secretBytes.toString('base64')}`;
const LOGAN_KEY = `crsr_${'q'.repeat(40)}`;
const PHONE = '+18042592256';
const TEXT = 'Need a truck at the yard 9f3c';

function signStandard(raw, fields) {
  const id = fields.id;
  const timestamp = String(fields.timestamp);
  const mac = crypto.createHmac('sha256', secretBytes).update(`${id}.${timestamp}.${raw}`).digest('base64');
  const bogus = crypto.createHmac('sha256', Buffer.from('other-key')).update('nope').digest('base64');
  return {
    'Content-Type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${bogus} v1,${mac}`
  };
}

function signLegacy(raw, timestampMs) {
  const stamp = String(timestampMs);
  const mac = crypto.createHmac('sha256', secretBytes).update(`${stamp}.${raw}`).digest('base64');
  return {
    'Content-Type': 'application/json',
    'openphone-signature': `hmac;1;${stamp};${mac}`
  };
}

function currentEvent(fields) {
  return {
    id: fields.id,
    apiVersion: '2026-03-30',
    createdAt: fields.createdAt || '2026-04-13T12:00:00.000Z',
    type: fields.type || 'message.received',
    data: {
      resource: {
        id: fields.messageId,
        direction: 'incoming',
        text: fields.text,
        createdAt: fields.createdAt || '2026-04-13T12:00:00.000Z'
      },
      context: {
        senderIdentifier: fields.from,
        recipientIdentifiers: [fields.to],
        conversationId: fields.conversationId
      }
    }
  };
}

function handlerEnv(extra) {
  return Object.assign({
    QUO_WEBHOOK_SECRET: SECRET,
    LOGAN_QUO_WEBHOOK_URL: 'http://127.0.0.1:9/logan',
    LOGAN_QUO_WEBHOOK_KEY: LOGAN_KEY,
    QUO_DT1_PHONE_NUMBER: PHONE
  }, extra || {});
}

function invoke(handler, headers, raw) {
  return new Promise((resolve) => {
    const req = {
      headers,
      body: Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    };
    const res = {
      statusCode: 200,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.headersSent = true;
        resolve({ status: this.statusCode, body: payload });
        return this;
      }
    };
    handler(req, res);
  });
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function request(port, headers, raw) {
  return new Promise((resolve, reject) => {
    const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/webhooks/quo/message-received',
      headers: Object.assign({ 'Content-Length': body.length }, headers)
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
    req.end(body);
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: Object.assign({}, process.env, {
        REDIS_URL: '',
        SMTP_HOST: '',
        SMTP_USER: '',
        SMTP_PASS: '',
        TWILIO_ACCOUNT_SID: '',
        TWILIO_AUTH_TOKEN: '',
        TWILIO_FROM_NUMBER: '',
        PORT: String(port)
      }, env),
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

async function waitUntil(fn, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error('timed out');
}

(async () => {
  assert.strictEqual(quoWebhook.MAX_AGE_MS, 5 * 60 * 1000);
  assert.strictEqual(quoWebhook.DEDUPE_MS, 10 * 60 * 1000);
  assert.strictEqual(quoWebhook.ROUTE, '/webhooks/quo/message-received');

  await check('signature accepts a timestamp 5 minutes old and rejects 5 minutes plus one second', () => {
    const now = 1700000000000;
    const raw = Buffer.from('{"type":"message.received"}');
    const fresh = String(Math.floor(now / 1000) - 300);
    const stale = String(Math.floor(now / 1000) - 301);
    const ok = quoWebhook.verifyRequest({
      raw,
      headers: signStandard(raw, { id: 'msg_fresh', timestamp: fresh }),
      secret: SECRET,
      now
    });
    const old = quoWebhook.verifyRequest({
      raw,
      headers: signStandard(raw, { id: 'msg_stale', timestamp: stale }),
      secret: SECRET,
      now
    });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(old.ok, false);
    assert.strictEqual(old.reason, 'stale');
  });

  await check('legacy openphone-signature uses the millisecond timestamp and the raw body', () => {
    const now = Date.now();
    const raw = Buffer.from('{"type":"message.received","data":{"object":{"id":"MS1","body":"hi"}}}');
    const headers = signLegacy(raw, now);
    const verdict = quoWebhook.verifyRequest({ raw, headers, secret: SECRET, now });
    assert.strictEqual(verdict.ok, true);
    const stale = quoWebhook.verifyRequest({
      raw,
      headers: signLegacy(raw, now - (6 * 60 * 1000)),
      secret: SECRET,
      now
    });
    assert.strictEqual(stale.ok, false);
    assert.strictEqual(stale.reason, 'stale');
    const changed = Buffer.from(raw.toString('utf8').replace('hi', 'yo'));
    const mismatch = quoWebhook.verifyRequest({ raw: changed, headers, secret: SECRET, now });
    assert.strictEqual(mismatch.ok, false);
  });

  await check('missing secret, url, or key returns 503 and does not forward', async () => {
    const raw = Buffer.from('{"type":"message.received","body":"secret text"}');
    const cases = [
      { QUO_WEBHOOK_SECRET: '', expect: 'QUO_WEBHOOK_SECRET is unset' },
      { LOGAN_QUO_WEBHOOK_URL: '', expect: 'LOGAN_QUO_WEBHOOK_URL is unset' },
      { LOGAN_QUO_WEBHOOK_KEY: '', expect: 'LOGAN_QUO_WEBHOOK_KEY is unset' }
    ];
    for (const item of cases) {
      const posts = [];
      const logs = [];
      const handler = quoWebhook.createHandler({
        env: handlerEnv(item),
        seen: new Map(),
        post: async () => {
          posts.push('sent');
          return { ok: true };
        },
        log: (level, message) => logs.push(message)
      });
      const res = await invoke(handler, { 'content-type': 'application/json' }, raw);
      assert.strictEqual(res.status, 503);
      assert.strictEqual(posts.length, 0);
      assert.ok(logs.some((line) => line.includes(item.expect)));
      assert.ok(!logs.join('\n').includes('secret text'));
      assert.ok(!logs.join('\n').includes(SECRET));
      assert.ok(!logs.join('\n').includes(LOGAN_KEY));
    }
  });

  await check('handler forwards a valid message.received with the routine key and ignores the rest', async () => {
    const posts = [];
    const logs = [];
    let now = 1700000000000;
    const handler = quoWebhook.createHandler({
      env: handlerEnv(),
      seen: new Map(),
      now: () => now,
      post: async (url, key, body) => {
        posts.push({ url, key, body });
        return { ok: true };
      },
      log: (level, message) => logs.push(message)
    });
    const raw = Buffer.from(`${JSON.stringify(currentEvent({
      id: 'EV1',
      messageId: 'AC1',
      text: TEXT,
      from: '+15550001111',
      to: PHONE,
      conversationId: 'CN1'
    }), null, 2)}\n`);
    const headers = signStandard(raw, { id: 'msg_1', timestamp: Math.floor(now / 1000) });
    const sent = await invoke(handler, headers, raw);
    assert.strictEqual(sent.status, 200);
    await settle();
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].url, 'http://127.0.0.1:9/logan');
    assert.strictEqual(posts[0].key, LOGAN_KEY);
    assert.deepStrictEqual(posts[0].body, {
      source: 'quo',
      line: PHONE,
      from: '+15550001111',
      to: PHONE,
      body: TEXT,
      receivedAt: '2026-04-13T12:00:00.000Z',
      conversationId: 'CN1',
      messageId: 'AC1'
    });

    const again = await invoke(handler, headers, raw);
    assert.strictEqual(again.status, 200);
    await settle();
    assert.strictEqual(posts.length, 1);

    now += quoWebhook.DEDUPE_MS + 1;
    const later = await invoke(handler, signStandard(raw, { id: 'msg_1b', timestamp: Math.floor(now / 1000) }), raw);
    assert.strictEqual(later.status, 200);
    await settle();
    assert.strictEqual(posts.length, 2);

    const other = Buffer.from(JSON.stringify(currentEvent({
      id: 'EV-call',
      messageId: 'CA1',
      text: 'call',
      from: '+15550001111',
      to: PHONE,
      conversationId: 'CN1',
      type: 'call.completed'
    })));
    const ignored = await invoke(handler, signStandard(other, { id: 'msg_call', timestamp: Math.floor(now / 1000) }), other);
    assert.strictEqual(ignored.status, 200);
    await settle();
    assert.strictEqual(posts.length, 2);

    const elsewhere = Buffer.from(JSON.stringify(currentEvent({
      id: 'EV-other',
      messageId: 'AC-other',
      text: 'other line',
      from: '+15550001111',
      to: '+15559999999',
      conversationId: 'CN9'
    })));
    const filtered = await invoke(handler, signStandard(elsewhere, { id: 'msg_other', timestamp: Math.floor(now / 1000) }), elsewhere);
    assert.strictEqual(filtered.status, 200);
    await settle();
    assert.strictEqual(posts.length, 2);

    const badRaw = Buffer.from(JSON.stringify(currentEvent({
      id: 'EV-bad',
      messageId: 'AC-bad',
      text: TEXT,
      from: '+15550001111',
      to: PHONE,
      conversationId: 'CN1'
    })));
    const badHeaders = signStandard(badRaw, { id: 'msg_bad', timestamp: Math.floor(now / 1000) });
    badHeaders['webhook-signature'] = `v1,${'a'.repeat(44)}`;
    const rejected = await invoke(handler, badHeaders, badRaw);
    assert.strictEqual(rejected.status, 401);
    await settle();
    assert.strictEqual(posts.length, 2);

    const staleRaw = Buffer.from(JSON.stringify(currentEvent({
      id: 'EV-stale',
      messageId: 'AC-stale',
      text: TEXT,
      from: '+15550001111',
      to: PHONE,
      conversationId: 'CN1'
    })));
    const stale = await invoke(
      handler,
      signStandard(staleRaw, { id: 'msg_old', timestamp: Math.floor(now / 1000) - 600 }),
      staleRaw
    );
    assert.strictEqual(stale.status, 401);
    await settle();
    assert.strictEqual(posts.length, 2);
    const logged = logs.join('\n');
    assert.ok(!logged.includes(TEXT));
    assert.ok(!logged.includes(LOGAN_KEY));
    assert.ok(!logged.includes(SECRET));
  });

  await check('a failed forward log keeps the message id and drops the body and key', async () => {
    const logs = [];
    const now = Date.now();
    const handler = quoWebhook.createHandler({
      env: handlerEnv(),
      seen: new Map(),
      now: () => now,
      post: async () => ({ ok: false, status: 502, error: `bad ${LOGAN_KEY}` }),
      log: (level, message) => logs.push(message)
    });
    const raw = Buffer.from(JSON.stringify(currentEvent({
      id: 'EV-fail',
      messageId: 'AC-fail',
      text: TEXT,
      from: '+15550001111',
      to: PHONE,
      conversationId: 'CN1'
    })));
    const res = await invoke(handler, signStandard(raw, { id: 'msg_fail', timestamp: Math.floor(now / 1000) }), raw);
    assert.strictEqual(res.status, 200);
    await settle();
    const logged = logs.join('\n');
    assert.match(logged, /forward failed for message AC-fail \(HTTP 502\)/);
    assert.ok(!logged.includes(TEXT));
    assert.ok(!logged.includes(LOGAN_KEY));
  });

  const hits = [];
  const receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (err) { body = {}; }
      hits.push({ authorization: req.headers.authorization || '', body });
      setTimeout(() => {
        res.writeHead(200);
        res.end('ok');
      }, 1200);
    });
  });
  const loganPort = await listen(receiver);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-quo-'));
  let srv;
  try {
    srv = await startServer({
      DATA_DIR: dataDir,
      QUO_WEBHOOK_SECRET: SECRET,
      LOGAN_QUO_WEBHOOK_URL: `http://127.0.0.1:${loganPort}/hook`,
      LOGAN_QUO_WEBHOOK_KEY: LOGAN_KEY,
      QUO_DT1_PHONE_NUMBER: PHONE
    });

    const raw = Buffer.from(`${JSON.stringify(currentEvent({
      id: 'EV-live',
      messageId: 'AC-live',
      text: TEXT,
      from: '+15550001111',
      to: '+1 (804) 259-2256',
      conversationId: 'CN-live'
    }), null, 2)}\n`);
    const headers = signStandard(raw, { id: 'msg_live', timestamp: Math.floor(Date.now() / 1000) });

    await check('valid signature forwards to Logan with Authorization: Bearer and answers Quo before Logan returns', async () => {
      const started = Date.now();
      const res = await request(srv.port, headers, raw);
      const elapsed = Date.now() - started;
      assert.strictEqual(res.status, 200);
      assert.ok(!res.headers.location, 'webhook redirected to login');
      assert.strictEqual(JSON.parse(res.body).ok, true);
      assert.ok(elapsed < 800, `Quo response waited ${elapsed}ms`);
      await waitUntil(() => hits.some((hit) => hit.body && hit.body.messageId === 'AC-live'), 3000);
      const hit = hits.find((item) => item.body.messageId === 'AC-live');
      assert.strictEqual(hit.authorization, `Bearer ${LOGAN_KEY}`);
      assert.strictEqual(hit.body.source, 'quo');
      assert.strictEqual(hit.body.line, PHONE);
      assert.strictEqual(hit.body.from, '+15550001111');
      assert.strictEqual(hit.body.to, '+1 (804) 259-2256');
      assert.strictEqual(hit.body.body, TEXT);
      assert.strictEqual(hit.body.conversationId, 'CN-live');
      assert.strictEqual(hit.body.receivedAt, '2026-04-13T12:00:00.000Z');
      await waitUntil(() => srv.output().includes('Quo webhook forwarded message AC-live'), 2000);
      const output = srv.output();
      assert.ok(!output.includes(TEXT));
      assert.ok(!output.includes(LOGAN_KEY));
      assert.ok(!output.includes(SECRET));
      const stored = fs.readFileSync(path.join(dataDir, 'dt1.db'));
      assert.ok(!stored.includes(Buffer.from(TEXT)));
    });

    await check('a repeated webhook-id or message id is not forwarded twice', async () => {
      const retry = await request(srv.port, headers, raw);
      assert.strictEqual(retry.status, 200);
      const otherId = signStandard(raw, { id: 'msg_live_retry', timestamp: Math.floor(Date.now() / 1000) });
      const sameMessage = await request(srv.port, otherId, raw);
      assert.strictEqual(sameMessage.status, 200);
      await sleep(400);
      assert.strictEqual(hits.filter((hit) => hit.body && hit.body.messageId === 'AC-live').length, 1);
    });

    await check('bad signature returns 401 and forwards nothing', async () => {
      const bad = signStandard(raw, { id: 'msg_live_bad', timestamp: Math.floor(Date.now() / 1000) });
      bad['webhook-signature'] = `v1,${crypto.createHmac('sha256', Buffer.from('wrong')).update('x').digest('base64')}`;
      const before = hits.length;
      const res = await request(srv.port, bad, raw);
      assert.strictEqual(res.status, 401);
      await sleep(300);
      assert.strictEqual(hits.length, before);
    });

    await check('stale timestamp returns 401 and forwards nothing', async () => {
      const staleRaw = Buffer.from(JSON.stringify(currentEvent({
        id: 'EV-live-stale',
        messageId: 'AC-live-stale',
        text: `${TEXT} stale`,
        from: '+15550001111',
        to: PHONE,
        conversationId: 'CN-live'
      })));
      const before = hits.length;
      const res = await request(
        srv.port,
        signStandard(staleRaw, { id: 'msg_live_stale', timestamp: Math.floor(Date.now() / 1000) - 600 }),
        staleRaw
      );
      assert.strictEqual(res.status, 401);
      await sleep(300);
      assert.strictEqual(hits.length, before);
    });

    await check('non message.received events are ignored', async () => {
      const other = Buffer.from(JSON.stringify(currentEvent({
        id: 'EV-live-call',
        messageId: 'CA-live',
        text: 'call transcript',
        from: '+15550001111',
        to: PHONE,
        conversationId: 'CN-live',
        type: 'call.completed'
      })));
      const before = hits.length;
      const res = await request(srv.port, signStandard(other, { id: 'msg_live_call', timestamp: Math.floor(Date.now() / 1000) }), other);
      assert.strictEqual(res.status, 200);
      await sleep(300);
      assert.strictEqual(hits.length, before);
    });

    await check('a text to another line is ignored when QUO_DT1_PHONE_NUMBER is set', async () => {
      const other = Buffer.from(JSON.stringify(currentEvent({
        id: 'EV-live-line',
        messageId: 'AC-live-line',
        text: 'wrong line',
        from: '+15550001111',
        to: '+15559999999',
        conversationId: 'CN-x'
      })));
      const before = hits.length;
      const res = await request(srv.port, signStandard(other, { id: 'msg_live_line', timestamp: Math.floor(Date.now() / 1000) }), other);
      assert.strictEqual(res.status, 200);
      await sleep(300);
      assert.strictEqual(hits.length, before);
    });

    await check('legacy openphone-signature forwards the message.received object', async () => {
      const legacy = Buffer.from(JSON.stringify({
        id: 'EVlegacy',
        object: 'event',
        apiVersion: 'v2',
        createdAt: '2026-04-13T12:00:00.000Z',
        type: 'message.received',
        data: {
          object: {
            id: 'MSlegacy',
            object: 'message',
            from: '+15550002222',
            to: PHONE,
            direction: 'incoming',
            body: 'Legacy yard text 9f3c',
            createdAt: '2026-04-13T12:05:00.000Z',
            conversationId: 'CNlegacy'
          }
        }
      }));
      const res = await request(srv.port, signLegacy(legacy, Date.now()), legacy);
      assert.strictEqual(res.status, 200);
      await waitUntil(() => hits.some((hit) => hit.body && hit.body.messageId === 'MSlegacy'), 3000);
      const hit = hits.find((item) => item.body.messageId === 'MSlegacy');
      assert.strictEqual(hit.authorization, `Bearer ${LOGAN_KEY}`);
      assert.strictEqual(hit.body.source, 'quo');
      assert.strictEqual(hit.body.from, '+15550002222');
      assert.strictEqual(hit.body.to, PHONE);
      assert.strictEqual(hit.body.body, 'Legacy yard text 9f3c');
      assert.strictEqual(hit.body.line, PHONE);
      assert.strictEqual(hit.body.conversationId, 'CNlegacy');
      assert.strictEqual(hit.body.receivedAt, '2026-04-13T12:05:00.000Z');
      const stored = fs.readFileSync(path.join(dataDir, 'dt1.db'));
      assert.ok(!stored.includes(Buffer.from('Legacy yard text 9f3c')));
    });
  } finally {
    if (srv) await stop(srv.child);
    await new Promise((resolve) => receiver.close(resolve));
  }

  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-quo-off-'));
  const off = await startServer({
    DATA_DIR: bareDir,
    QUO_WEBHOOK_SECRET: '',
    LOGAN_QUO_WEBHOOK_URL: `http://127.0.0.1:9/hook`,
    LOGAN_QUO_WEBHOOK_KEY: LOGAN_KEY,
    QUO_DT1_PHONE_NUMBER: ''
  });
  try {
    await check('the live route returns 503 when the signing secret is unset', async () => {
      const raw = Buffer.from(JSON.stringify(currentEvent({
        id: 'EV-off',
        messageId: 'AC-off',
        text: TEXT,
        from: '+15550001111',
        to: PHONE,
        conversationId: 'CN-off'
      })));
      const res = await request(off.port, { 'Content-Type': 'application/json' }, raw);
      assert.strictEqual(res.status, 503);
      await waitUntil(() => off.output().includes('QUO_WEBHOOK_SECRET is unset'), 2000);
      assert.ok(!off.output().includes(TEXT));
      assert.ok(!off.output().includes(LOGAN_KEY));
    });
  } finally {
    await stop(off.child);
  }

  console.log(`\n${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
