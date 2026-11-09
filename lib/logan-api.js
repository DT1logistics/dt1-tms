// Token-protected API Logan uses to read loads, flag missing info, and create loads.
// Same gate as GET /admin/backup: 404 when LOGAN_API_TOKEN is unset or shorter than 32
// characters, 401 on a missing or wrong Bearer token, compared in constant time.
// This router cannot accept, reject, approve, delete, or change users, passwords, or equipment.
const express = require('express');
const review = require('./load-review');
const equipment = require('./equipment');

const ACTOR = 'Logan (API)';

function bearerToken(req) {
  const auth = req.get('authorization') || '';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(auth);
  return match ? match[1] : '';
}

function createRateLimiter(limit, windowMs) {
  const buckets = new Map();
  return function allow(key) {
    const now = Date.now();
    const recent = (buckets.get(key) || []).filter((stamp) => now - stamp < windowMs);
    if (recent.length >= limit) {
      buckets.set(key, recent);
      return false;
    }
    recent.push(now);
    buckets.set(key, recent);
    if (buckets.size > 5000) {
      buckets.forEach((stamps, id) => {
        if (!stamps.some((stamp) => now - stamp < windowMs)) buckets.delete(id);
      });
    }
    return true;
  };
}

function clientIp(req) {
  return (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown').replace(/^::ffff:/, '');
}

// A blank truck_id means no unit. A value must resolve to an active truck or hotshot.
function explicitTruckChoice(body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'truck_id')) return false;
  return String(body.truck_id == null ? '' : body.truck_id).trim() !== '';
}

function loadJson(row, baseUrl) {
  if (!row) return null;
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return {
    id: row.id,
    load_number: row.ticket_number || String(row.id),
    ticket_number: row.ticket_number || null,
    load_date: row.load_date || null,
    status: row.status || 'draft',
    entry_mode: row.entry_mode || null,
    created_via: row.created_via || null,
    created_by_role: row.created_by_role || null,
    driver_id: row.driver_id || null,
    driver_name: row.driver_name || null,
    truck_id: row.truck_id || null,
    truck_number: row.truck_number || null,
    project_id: row.project_id || null,
    project: row.project_display || null,
    customer: row.customer_name || null,
    origin: row.origin || null,
    destination: row.destination || row.description || null,
    detention: Number(row.detention) === 1,
    detention_amount: Number(row.detention) === 1 && row.detention_amount != null ? row.detention_amount : null,
    notes: row.notes || null,
    weight_quantity: row.weight_quantity == null ? null : row.weight_quantity,
    rate: row.rate == null ? null : row.rate,
    review_status: row.review_status || 'none',
    review_notes: row.review_notes || null,
    review_set_by_name: row.review_set_by_name || null,
    review_set_at: row.review_set_at || null,
    review_decision: row.review_decision || null,
    review_decision_reason: row.review_decision_reason || null,
    review_decision_by_name: row.review_decision_by_name || null,
    review_decision_at: row.review_decision_at || null,
    created_at: row.created_at || null,
    link: `${base}/loads/${row.id}`
  };
}

function mountLoganApi(app, deps) {
  const limit = Math.min(600, Math.max(10, Number(process.env.LOGAN_API_RATE_LIMIT) || 60));
  const windowMs = Math.min(600000, Math.max(1000, Number(process.env.LOGAN_API_RATE_WINDOW_MS) || 60000));
  const allow = createRateLimiter(limit, windowMs);
  const router = express.Router();

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const expected = process.env.LOGAN_API_TOKEN;
    if (!deps.tokenConfigured(expected)) return res.status(404).json({ error: 'Not found' });
    if (!allow(clientIp(req))) return res.status(429).json({ error: 'Too many requests' });
    if (!deps.tokenMatches(bearerToken(req), expected)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  });

  function deny(req, res) {
    res.status(403).json({ error: 'Forbidden' });
  }

  router.all('/loads/:id/reject', deny);
  router.all('/loads/:id/accept', deny);
  router.all('/loads/:id/approve', deny);
  router.all('/loads/:id/delete', deny);
  router.delete('/loads/:id', deny);
  router.delete('/loads/:id/review', deny);
  router.all('/users', deny);
  router.all('/users/:id', deny);
  router.all('/password', deny);
  router.all('/password/:id', deny);
  router.all('/equipment', deny);
  router.all('/equipment/:id', deny);
  router.post('/drivers', deny);
  router.put('/drivers', deny);
  router.patch('/drivers', deny);
  router.patch('/drivers/:id', deny);
  router.delete('/drivers/:id', deny);

  router.get('/drivers', (req, res) => {
    const drivers = deps.getDb().prepare(`
      SELECT id, name, email, status
      FROM users
      WHERE role = 'driver'
      ORDER BY name
    `).all();
    res.json({
      drivers: drivers.map((driver) => ({
        id: driver.id,
        name: driver.name || '',
        email: driver.email || '',
        status: driver.status || 'active'
      }))
    });
  });

  router.get('/loads', (req, res) => {
    const db = deps.getDb();
    const params = [];
    let sql = deps.loadQuery();
    const flagged = req.query.flagged === '1' || req.query.review === 'flagged' || req.query.review_status === 'flagged_missing_info';
    if (flagged) {
      sql += " WHERE l.review_status = 'flagged_missing_info'";
    } else if (req.query.review_status && review.REVIEW_STATUSES.includes(String(req.query.review_status))) {
      sql += ' WHERE l.review_status = ?';
      params.push(String(req.query.review_status));
    }
    const parsedLimit = parseInt(req.query.limit, 10);
    const rowLimit = Math.min(100, Math.max(1, Number.isInteger(parsedLimit) ? parsedLimit : 50));
    sql += ' ORDER BY l.created_at DESC, l.id DESC LIMIT ?';
    params.push(rowLimit);
    const loads = db.prepare(sql).all(...params).map((row) => loadJson(row, deps.publicBaseUrl()));
    res.json({ loads });
  });

  router.get('/loads/:key', (req, res) => {
    const row = deps.findLoadByKey(req.params.key);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ load: loadJson(row, deps.publicBaseUrl()) });
  });

  function updateReview(req, res) {
    const body = req.body || {};
    if (review.forbiddenReviewChange(body)) {
      return res.status(403).json({ error: 'Logan cannot accept or reject loads' });
    }
    const status = String(body.review_status || '').trim();
    if (!review.REVIEW_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'review_status must be none, needs_review, flagged_missing_info, or cleared' });
    }
    const id = parseInt(req.params.id, 10);
    const existing = Number.isInteger(id) ? deps.getDb().prepare('SELECT * FROM loads WHERE id = ?').get(id) : null;
    if (!existing) return res.status(404).json({ error: 'Not found' });
    let notes;
    if (Object.prototype.hasOwnProperty.call(body, 'review_notes')) notes = review.normalizeNotes(body.review_notes);
    else if (Object.prototype.hasOwnProperty.call(body, 'missing_items')) notes = review.normalizeNotes(body.missing_items);
    else notes = existing.review_notes || null;
    const result = deps.applyLoadReview(existing.id, {
      status,
      notes,
      actorId: null,
      actorName: ACTOR
    });
    if (result.error) return res.status(result.code || 400).json({ error: result.error });
    res.json({ load: loadJson(deps.findLoadByKey(String(existing.id)), deps.publicBaseUrl()) });
  }

  router.post('/loads/:id/review', updateReview);
  router.patch('/loads/:id/review', updateReview);

  router.post('/loads', (req, res) => {
    const body = req.body || {};
    if (review.forbiddenReviewChange(body)) {
      return res.status(403).json({ error: 'Logan cannot accept or reject loads' });
    }
    const action = body.action === 'draft' ? 'draft' : (body.action && body.action !== 'submit' ? null : 'submit');
    if (!action) return res.status(400).json({ error: 'action must be draft or submit' });
    const apiBody = { ...body, action };
    delete apiBody.shipper_detention;
    delete apiBody.shipper_detention_amount;
    const apiReq = {
      body: apiBody,
      session: { user: { id: null, name: ACTOR, role: 'admin' } }
    };
    const project = deps.findActiveProject(body.project_id);
    const values = deps.buildLoadValues(apiReq, project, null);
    if (values.detentionError) return res.status(400).json({ error: values.detentionError });
    if (explicitTruckChoice(body)) {
      const allowed = equipment.resolveAssignedTruckId(deps.getDb(), body.truck_id, null);
      if (!allowed || !values.truck_id) {
        return res.status(400).json({
          error: 'Choose an active truck or hotshot. Inactive, sold, and total-loss units cannot be assigned to a new load.'
        });
      }
    }
    if (!values.driver_id) return res.status(400).json({ error: 'Select a driver' });
    const driver = deps.getDb().prepare("SELECT id, name FROM users WHERE id = ? AND role = 'driver'").get(values.driver_id);
    if (!driver) return res.status(400).json({ error: 'Select a driver' });
    if (!project && action !== 'draft') return res.status(400).json({ error: 'Select an active project' });
    const entry = deps.resolveLoadEntry(apiReq, null);
    const id = deps.insertNewLoad(values, entry, { id: null, name: ACTOR, via: 'api' });
    deps.logAudit(apiReq, entry.auditAction, 'load', id, entry.auditDetail);
    if (typeof deps.recordDetentionAudit === 'function') deps.recordDetentionAudit(apiReq, id, null, values);
    const row = deps.findLoadByKey(String(id));
    res.status(201).json({ load: loadJson(row, deps.publicBaseUrl()) });
  });

  app.use('/api/logan', router);
}

module.exports = { mountLoganApi, loadJson, bearerToken, createRateLimiter };
