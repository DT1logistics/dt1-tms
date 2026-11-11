// Inbound Quo (formerly OpenPhone) text relay.
// Current deliveries (https://www.quo.com/docs/2026-03-30/webhooks-signature-validation)
// use Standard Webhooks headers webhook-id, webhook-timestamp, and webhook-signature.
// The HMAC key is the base64-decoded secret after the whsec_ prefix, and the signed
// bytes are `${id}.${timestamp}.${rawBody}`.
// Legacy OpenPhone deliveries use openphone-signature: hmac;1;<timestamp>;<base64>.
// Those sign `${timestamp}.${rawBody}` with the base64-decoded secret. The documented
// legacy timestamp is milliseconds (13 digits); 10-digit values are seconds.
// A bad signature or a timestamp more than 5 minutes off returns 401 and is not forwarded.
const crypto = require('crypto');
const loganWebhook = require('./logan-webhook');

const ROUTE = '/webhooks/quo/message-received';
const MAX_AGE_MS = 5 * 60 * 1000;
const DEDUPE_MS = 10 * 60 * 1000;
const FORWARD_TIMEOUT_MS = 4000;
const MAX_BODY_BYTES = 1024 * 1024;

const defaultSeen = new Map();

function defaultLog(level, message) {
  if (level === 'warn') console.warn(message);
  else if (level === 'error') console.error(message);
  else console.log(message);
}

function redact(message, cfg) {
  let text = String(message);
  [cfg && cfg.secret, cfg && cfg.key].forEach((secret) => {
    const value = String(secret || '');
    if (value.length >= 4) text = text.split(value).join('[redacted]');
  });
  return text;
}

function quoConfig(env) {
  const source = env || process.env;
  const url = String(source.LOGAN_QUO_WEBHOOK_URL || '').trim();
  let urlOk = false;
  if (url) {
    try {
      const parsed = new URL(url);
      urlOk = parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch (err) {
      urlOk = false;
    }
  }
  return {
    secret: String(source.QUO_WEBHOOK_SECRET || '').trim(),
    url,
    urlOk,
    key: String(source.LOGAN_QUO_WEBHOOK_KEY || '').trim(),
    phone: String(source.QUO_DT1_PHONE_NUMBER || '').trim(),
    timeoutMs: FORWARD_TIMEOUT_MS
  };
}

function configProblems(cfg) {
  const problems = [];
  if (!cfg.secret) problems.push('QUO_WEBHOOK_SECRET is unset');
  if (!cfg.url) problems.push('LOGAN_QUO_WEBHOOK_URL is unset');
  else if (!cfg.urlOk) problems.push('LOGAN_QUO_WEBHOOK_URL is invalid');
  if (!cfg.key) problems.push('LOGAN_QUO_WEBHOOK_KEY is unset');
  return problems;
}

function headerValue(headers, name) {
  if (!headers) return '';
  const value = headers[name] != null ? headers[name] : headers[String(name).toLowerCase()];
  if (Array.isArray(value)) return value.map((part) => String(part)).join(name === 'openphone-signature' ? ',' : ' ');
  return value == null ? '' : String(value);
}

function asBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.alloc(0);
}

function secretKey(secret) {
  const text = String(secret || '').trim();
  const encoded = text.startsWith('whsec_') ? text.slice('whsec_'.length) : text;
  if (!encoded) return Buffer.alloc(0);
  return Buffer.from(encoded, 'base64');
}

function timestampMs(timestamp) {
  const text = String(timestamp == null ? '' : timestamp).trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return text.length >= 12 ? value : value * 1000;
}

function freshTimestamp(timestamp, now) {
  const ms = timestampMs(timestamp);
  if (ms == null) return false;
  return Math.abs(now - ms) <= MAX_AGE_MS;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function signedDigest(key, prefix, raw) {
  return crypto.createHmac('sha256', key).update(Buffer.concat([
    Buffer.from(prefix, 'utf8'),
    raw
  ])).digest('base64');
}

function verifyStandard({ raw, id, timestamp, signature, secret, now }) {
  const deliveryId = String(id || '').trim();
  const stamp = String(timestamp || '').trim();
  const provided = String(signature || '').trim();
  if (!deliveryId || !stamp || !provided) return { ok: false, reason: 'signature' };
  if (!freshTimestamp(stamp, now)) return { ok: false, reason: 'stale', deliveryId };
  const key = secretKey(secret);
  if (!key.length) return { ok: false, reason: 'signature', deliveryId };
  const expected = signedDigest(key, `${deliveryId}.${stamp}.`, raw);
  let match = false;
  provided.split(/\s+/).forEach((entry) => {
    const comma = entry.indexOf(',');
    if (comma === -1) return;
    const version = entry.slice(0, comma).trim();
    const sig = entry.slice(comma + 1).trim();
    if (version !== 'v1' || !sig) return;
    if (safeEqual(sig, expected)) match = true;
  });
  return match ? { ok: true, deliveryId } : { ok: false, reason: 'signature', deliveryId };
}

function verifyLegacy({ raw, header, secret, now }) {
  const provided = String(header || '').trim();
  if (!provided) return { ok: false, reason: 'signature' };
  const key = secretKey(secret);
  if (!key.length) return { ok: false, reason: 'signature' };
  let match = false;
  let sawStale = false;
  provided.split(',').forEach((part) => {
    const fields = part.trim().split(';');
    if (fields.length < 4) return;
    const scheme = fields[0];
    const version = fields[1];
    const stamp = fields[2];
    const sig = fields.slice(3).join(';');
    if (scheme !== 'hmac' || version !== '1' || !stamp || !sig) return;
    if (!freshTimestamp(stamp, now)) {
      sawStale = true;
      return;
    }
    const expected = signedDigest(key, `${stamp}.`, raw);
    if (safeEqual(sig, expected)) match = true;
  });
  if (match) return { ok: true, deliveryId: '' };
  return { ok: false, reason: sawStale ? 'stale' : 'signature' };
}

function verifyRequest({ raw, headers, secret, now }) {
  const id = headerValue(headers, 'webhook-id').trim();
  const timestamp = headerValue(headers, 'webhook-timestamp').trim();
  const signature = headerValue(headers, 'webhook-signature').trim();
  const legacy = headerValue(headers, 'openphone-signature').trim();
  if (id || timestamp || signature) {
    return verifyStandard({ raw, id, timestamp, signature, secret, now });
  }
  if (legacy) return verifyLegacy({ raw, header: legacy, secret, now });
  return { ok: false, reason: 'signature' };
}

function text(value) {
  if (value == null) return '';
  return String(value).trim();
}

function phoneValues(value) {
  if (Array.isArray(value)) return value.flatMap(phoneValues);
  if (value == null) return [];
  return String(value).split(',').map((part) => part.trim()).filter(Boolean);
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function samePhone(left, right) {
  const a = digits(left);
  const b = digits(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const national = (value) => (value.length === 11 && value.startsWith('1') ? value.slice(1) : value);
  const na = national(a);
  const nb = national(b);
  return na.length === 10 && na === nb;
}

function summarize(event, configuredPhone) {
  const data = event && event.data && typeof event.data === 'object' ? event.data : {};
  const context = data.context && typeof data.context === 'object' ? data.context : {};
  const resource = data.resource && typeof data.resource === 'object' ? data.resource : {};
  const object = data.object && typeof data.object === 'object' ? data.object : {};
  const recipients = phoneValues(
    context.recipientIdentifiers != null
      ? context.recipientIdentifiers
      : (resource.to != null ? resource.to : object.to)
  );
  const matched = !configuredPhone || recipients.some((value) => samePhone(value, configuredPhone));
  const bodyValue = resource.text != null ? resource.text : (object.body != null ? object.body : resource.body);
  return {
    matched,
    summary: {
      source: 'quo',
      line: (configuredPhone && matched) ? configuredPhone : (recipients[0] || ''),
      from: text(context.senderIdentifier || resource.from || object.from),
      to: recipients.join(', '),
      body: bodyValue == null ? '' : String(bodyValue),
      receivedAt: text(resource.createdAt || object.createdAt || (event && event.createdAt)),
      conversationId: text(context.conversationId || resource.conversationId || object.conversationId),
      messageId: text(resource.id || object.id || (event && event.id))
    }
  };
}

function deliveryKeys(deliveryId, messageId) {
  const keys = [];
  if (deliveryId) keys.push(`delivery:${deliveryId}`);
  if (messageId) keys.push(`message:${messageId}`);
  return keys;
}

function pruneSeen(seen, now) {
  for (const [key, expires] of seen) {
    if (expires <= now) seen.delete(key);
  }
}

function alreadyForwarded(seen, keys, now) {
  pruneSeen(seen, now);
  return keys.some((key) => seen.has(key));
}

function rememberForward(seen, keys, now) {
  const expires = now + DEDUPE_MS;
  keys.forEach((key) => seen.set(key, expires));
}

function scheduleForward(cfg, summary, post, log) {
  const id = summary.messageId || 'unknown';
  Promise.resolve()
    .then(() => post(cfg.url, cfg.key, summary, cfg.timeoutMs))
    .then((result) => {
      if (result && result.ok) {
        log('info', `Quo webhook forwarded message ${id}`);
        return;
      }
      const why = result && result.status ? `HTTP ${result.status}` : ((result && result.error) || 'error');
      log('error', `Quo webhook forward failed for message ${id} (${why}) host=${loganWebhook.webhookHost(cfg.url)}`);
    })
    .catch(() => {
      log('error', `Quo webhook forward failed for message ${id}`);
    });
}

function readRawBody(req, res, next) {
  const chunks = [];
  let size = 0;
  let settled = false;
  req.on('data', (chunk) => {
    if (settled) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      settled = true;
      res.status(413).json({ error: 'payload too large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (settled) return;
    settled = true;
    req.body = Buffer.concat(chunks);
    next();
  });
  req.on('error', () => {
    if (settled || res.headersSent) return;
    settled = true;
    res.status(400).json({ error: 'bad request' });
  });
}

function createHandler(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const post = opts.post || loganWebhook.postOnce;
  const nowFn = opts.now || (() => Date.now());
  const log = opts.log || defaultLog;
  const seen = opts.seen || defaultSeen;

  return function quoMessageReceived(req, res) {
    const write = (level, message) => log(level, redact(message, quoConfig(env)));
    try {
      const cfg = quoConfig(env);
      const problems = configProblems(cfg);
      if (problems.length) {
        write('warn', `Quo webhook unavailable: ${problems.join('; ')}`);
        return res.status(503).json({ error: 'webhook not configured' });
      }

      const raw = asBuffer(req.body);
      const now = nowFn();
      const verdict = verifyRequest({ raw, headers: req.headers, secret: cfg.secret, now });
      if (!verdict.ok) {
        const why = verdict.reason === 'stale' ? 'stale timestamp' : 'invalid signature';
        write('warn', `Quo webhook rejected${verdict.deliveryId ? ` delivery ${verdict.deliveryId}` : ''}: ${why}`);
        return res.status(401).json({ error: 'unauthorized' });
      }

      let event;
      try {
        event = JSON.parse(raw.toString('utf8'));
      } catch (err) {
        write('warn', 'Quo webhook rejected: invalid json');
        return res.status(400).json({ error: 'invalid json' });
      }

      const label = (event && event.id) || verdict.deliveryId || 'unknown';
      if (!event || typeof event !== 'object' || event.type !== 'message.received') {
        write('info', `Quo webhook ignored ${label}: not message.received`);
        return res.status(200).json({ ok: true });
      }

      const parsed = summarize(event, cfg.phone);
      const messageId = parsed.summary.messageId || verdict.deliveryId || label;
      if (!parsed.matched) {
        write('info', `Quo webhook ignored message ${messageId}: line filter`);
        return res.status(200).json({ ok: true });
      }

      const keys = deliveryKeys(verdict.deliveryId, parsed.summary.messageId);
      if (keys.length && alreadyForwarded(seen, keys, now)) {
        write('info', `Quo webhook ignored message ${messageId}: duplicate`);
        return res.status(200).json({ ok: true });
      }
      if (keys.length) rememberForward(seen, keys, now);

      scheduleForward(cfg, parsed.summary, post, write);
      return res.status(200).json({ ok: true });
    } catch (err) {
      write('error', 'Quo webhook failed');
      if (!res.headersSent) return res.status(500).json({ error: 'error' });
      return undefined;
    }
  };
}

function mount(app, options) {
  app.post(ROUTE, readRawBody, createHandler(options));
}

module.exports = {
  ROUTE,
  MAX_AGE_MS,
  DEDUPE_MS,
  quoConfig,
  verifyRequest,
  summarize,
  createHandler,
  mount,
  deliveryKeys,
  alreadyForwarded,
  rememberForward
};
