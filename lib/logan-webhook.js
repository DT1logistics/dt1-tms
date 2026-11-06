// Outbound load.created webhook for Logan's Grok Bot routine.
// The routine panel's key is sent as a Bearer token:
//   Authorization: Bearer <LOGAN_WEBHOOK_KEY>
// (https://cursor.com/help/grok-bot/routines — "key is the secret. Senders include it as Authorization: Bearer".)
// Delivery is async. Failures are logged without the key and never thrown to the caller.
const http = require('http');
const https = require('https');

function intEnv(value, fallback, min, max) {
  if (value == null || String(value).trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function webhookConfig(env) {
  const source = env || process.env;
  const url = String(source.LOGAN_WEBHOOK_URL || '').trim();
  const key = String(source.LOGAN_WEBHOOK_KEY || '').trim();
  return {
    url,
    key,
    timeoutMs: intEnv(source.LOGAN_WEBHOOK_TIMEOUT_MS, 4000, 100, 15000),
    retries: intEnv(source.LOGAN_WEBHOOK_RETRIES, 2, 0, 4),
    retryDelayMs: intEnv(source.LOGAN_WEBHOOK_RETRY_DELAY_MS, 400, 0, 5000)
  };
}

function webhookHost(url) {
  try {
    return new URL(url).host;
  } catch (err) {
    return 'webhook';
  }
}

function buildPayload(load, meta) {
  const info = meta || {};
  const origin = String((load && load.origin) || '').trim();
  const delivery = String((load && (load.destination || load.description)) || '').trim();
  const parts = [];
  if (origin) parts.push(`Pickup: ${origin}`);
  if (delivery) parts.push(`Delivery: ${delivery}`);
  const id = load && load.id;
  const ticket = String((load && load.ticket_number) || '').trim();
  const base = String(info.baseUrl || '').replace(/\/+$/, '');
  return {
    event: 'load.created',
    load_id: id,
    load_number: ticket || (id == null ? '' : String(id)),
    created_by: info.createdBy || '',
    created_via: info.createdVia === 'api' ? 'api' : 'ui',
    pickup: origin,
    delivery,
    pickup_delivery_summary: parts.join('; ') || 'No pickup or delivery on file',
    link: `${base}/loads/${id}`
  };
}

// One POST. The Quo inbound relay uses this same Bearer header and timeout behavior.
function postOnce(url, key, body, timeoutMs) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      resolve({ ok: false, error: 'invalid webhook url' });
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      resolve({ ok: false, error: 'invalid webhook url' });
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body));
    const req = lib.request({
      method: 'POST',
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        Authorization: `Bearer ${key}`
      },
      timeout: timeoutMs
    }, (res) => {
      res.resume();
      const done = () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
      res.on('end', done);
      res.on('error', () => resolve({ ok: false, status: res.statusCode, error: 'response error' }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    req.on('error', (err) => resolve({ ok: false, error: err && err.message ? err.message : 'request error' }));
    req.end(payload);
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
  });
}

// Resolves with { skipped } or the last attempt. Never rejects.
async function deliver(env, payload, log) {
  const write = typeof log === 'function' ? log : (message) => console.error(message);
  const cfg = webhookConfig(env);
  if (!cfg.url && !cfg.key) return { skipped: true, reason: 'unset' };
  if (!cfg.url || !cfg.key) {
    write(`Logan webhook skipped: ${cfg.url ? 'LOGAN_WEBHOOK_KEY' : 'LOGAN_WEBHOOK_URL'} is unset`);
    return { skipped: true, reason: 'incomplete' };
  }
  const attempts = cfg.retries + 1;
  let last = { ok: false, error: 'not attempted' };
  for (let i = 0; i < attempts; i += 1) {
    try {
      last = await postOnce(cfg.url, cfg.key, payload, cfg.timeoutMs);
    } catch (err) {
      last = { ok: false, error: err && err.message ? err.message : 'request error' };
    }
    if (last.ok) return last;
    if (i < attempts - 1 && cfg.retryDelayMs) await sleep(cfg.retryDelayMs);
  }
  const why = last.status ? `HTTP ${last.status}` : (last.error || 'error');
  write(`Logan webhook failed for load ${payload && payload.load_id} after ${attempts} attempts (${why}) host=${webhookHost(cfg.url)}`);
  return last;
}

// Schedules delivery and returns immediately. The returned promise is for tests;
// request handlers must not wait on it.
function notifyLoadCreated(env, load, meta) {
  let payload;
  try {
    if (!load || load.id == null) return Promise.resolve({ skipped: true, reason: 'no-load' });
    payload = buildPayload(load, meta);
  } catch (err) {
    console.error(`Logan webhook failed for load ${load && load.id}: ${err && err.message ? err.message : 'error'}`);
    return Promise.resolve({ skipped: true, reason: 'build-failed' });
  }
  return new Promise((resolve) => {
    setImmediate(() => {
      deliver(env, payload)
        .then(resolve)
        .catch((err) => {
          console.error(`Logan webhook failed for load ${payload.load_id}: ${err && err.message ? err.message : 'error'}`);
          resolve({ ok: false, error: 'webhook error' });
        });
    });
  });
}

module.exports = {
  webhookConfig,
  webhookHost,
  postOnce,
  buildPayload,
  deliver,
  notifyLoadCreated
};
