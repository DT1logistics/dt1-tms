// Item 12 (11/16/2026): generate a customer invoice from the Invoices screen,
// matching Logan's manual template (DT1-4011 layout). One invoice per project
// per Monday-Sunday work week. Additive schema only; load rows are never changed.
'use strict';

const fuelCalc = require('./fuel-surcharge');
const invoiceNumber = require('./invoice-number');

const DEFAULT_SETTINGS = {
  company_name: 'DT1 Logistics, LLC',
  company_address1: 'P.O. Box 38161',
  company_address2: 'Henrico, VA 23231',
  company_phone: '(804) 506-0061',
  company_email: 'admin@dt1logistics.com',
  remit_intro: 'Make all checks payable to:',
  remit_name: 'Gulf Coast Bank & Trust Company dba Phoenix Capital Group',
  remit_address1: 'P.O. Box 1415',
  remit_address2: 'Des Moines, IA 50305-1415'
};

const BILLING_MODES = ['actual', 'flat_qty_1'];

function hasTotalLoadPay(load) {
  return !!load && load.total_load_pay != null && String(load.total_load_pay).trim() !== ''
    && Number.isFinite(Number(load.total_load_pay));
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function workWeek(dateStr) {
  if (!dateStr) return null;
  const date = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  const monday = new Date(date);
  monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const iso = (value) => {
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  };
  const label = (value) => value.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  return { start: iso(monday), end: iso(sunday), range: `${label(monday)} - ${label(sunday)}` };
}

function normalizeBillingMode(value) {
  return String(value || '').trim() === 'flat_qty_1' ? 'flat_qty_1' : 'actual';
}

// Billed quantity and rate for one load, driven by the project's invoice settings
// (not by hard-coded project or customer names).
//   actual      — use the load's qty and rate; if invoice_min_qty is set, bill at least that qty
//   flat_qty_1  — bill quantity 1 at the project's default rate (Uber Freight style)
function billedQuantities(load) {
  const actualQty = Number(load && load.weight_quantity) || 0;
  const loadRate = Number(load && load.rate) || 0;
  const projectRate = Number(
    load && (load.project_default_rate != null ? load.project_default_rate : load.default_rate)
  ) || 0;
  const mode = normalizeBillingMode(load && (load.invoice_billing_mode || load.billing_mode));
  const minRaw = load && load.invoice_min_qty;
  const minQty = minRaw != null && String(minRaw).trim() !== '' && Number.isFinite(Number(minRaw))
    ? Number(minRaw) : null;

  if (mode === 'flat_qty_1') {
    const rate = projectRate || loadRate;
    return { qty: 1, rate, mode, minApplied: false, actualQty, loadRate };
  }
  const qty = (minQty != null && minQty > 0 && actualQty < minQty) ? minQty : actualQty;
  return {
    qty,
    rate: loadRate,
    mode: 'actual',
    minApplied: minQty != null && minQty > 0 && actualQty < minQty,
    actualQty,
    loadRate
  };
}

function haulDescription(load) {
  const dest = String((load && (load.destination || load.description)) || '').trim();
  if (!dest) return 'Haul';
  if (/^haul(\s+to)?\s+/i.test(dest)) return dest.replace(/^haul\s+/i, 'Haul ');
  return `Haul to ${dest}`;
}

// Line amounts for the customer invoice. Price = Qty x Rate + Fuel + Self Load + Travel Time.
// Shipper detention, when present, is kept as its own amount (shown as a footer line, not a
// column) so the official Price formula stays unchanged. Fuel comes from the same FSC math
// the TMS already uses (weekly diesel rate + load flags), applied to the billed qty/rate.
function invoiceLineAmounts(load, fuelRates) {
  const billed = billedQuantities(load);
  const usesTotalLoadPay = hasTotalLoadPay(load);
  const hauling = usesTotalLoadPay ? Number(load.total_load_pay) : roundMoney(billed.qty * billed.rate);
  const travelTime = Number(load && load.has_drive_time) ? (Number(load.drive_time_amount) || 0) : 0;
  const selfLoad = Number(load && load.has_self_load) ? (Number(load.self_load_amount) || 0) : 0;
  const shipperDetention = Number(load && load.shipper_detention) ? (Number(load.shipper_detention_amount) || 0) : 0;
  const fscInput = Object.assign({}, load, { weight_quantity: billed.qty, rate: billed.rate });
  const history = Array.isArray(fuelRates) ? fuelRates : [];
  const computed = fuelCalc.loadFuelSurchargeForDate({
    history,
    loadDate: load && load.load_date,
    rate: billed.rate,
    tons: billed.qty,
    isFlat: false,
    flatAmount: 0
  });
  const fscApplies = Number(load && load.has_fuel_surcharge) === 1 && !usesTotalLoadPay;
  const lineFsc = fscApplies ? (computed.total || 0) : 0;
  const price = roundMoney(hauling + lineFsc + travelTime + selfLoad);
  return {
    billed,
    usesTotalLoadPay,
    hauling,
    travelTime,
    selfLoad,
    shipperDetention,
    fscApplies,
    lineFsc,
    fscPercent: computed.percent,
    fscPending: !!(fscApplies && computed.pending),
    fscPerTon: computed.perTon,
    fscFlat: computed.flat,
    fscDiesel: computed.dieselRate,
    fscEffective: computed.effectiveDate,
    fscBase: fscApplies ? (computed.baseHauling || 0) : 0,
    price,
    // Official line price (Qty x Rate + Fuel + Self + Travel). Detention is extra, not in Price.
    lineTotal: roundMoney(price + shipperDetention),
    description: haulDescription(load)
  };
}

function emptyTotals() {
  return {
    hauling: 0, fscBase: 0, fuelSurcharge: 0, travelTime: 0, selfLoad: 0,
    shipperDetention: 0, driverPay: 0, price: 0, total: 0, fscPercents: [], fscPendingCount: 0
  };
}

function addLineToTotals(totals, line) {
  totals.hauling += line.hauling;
  if (line.fscApplies) {
    totals.fscBase += line.fscBase;
    totals.fuelSurcharge += line.lineFsc;
    if (line.fscPending) totals.fscPendingCount += 1;
    else if (line.fscPercent != null && !totals.fscPercents.includes(line.fscPercent)) {
      totals.fscPercents.push(line.fscPercent);
    }
  }
  totals.travelTime += line.travelTime;
  totals.selfLoad += line.selfLoad;
  totals.shipperDetention += line.shipperDetention;
  totals.price += line.price;
  totals.driverPay += line.payInfo ? line.payInfo.pay : 0;
}

function finishTotals(totals) {
  totals.hauling = roundMoney(totals.hauling);
  totals.fuelSurcharge = fuelCalc.round(totals.fuelSurcharge, 2);
  totals.travelTime = roundMoney(totals.travelTime);
  totals.selfLoad = roundMoney(totals.selfLoad);
  totals.shipperDetention = fuelCalc.round(totals.shipperDetention, 2);
  totals.price = roundMoney(totals.price);
  totals.driverPay = roundMoney(totals.driverPay);
  // TOTAL = hauling + FSC + travel + self + detention (detention only when billed).
  totals.total = roundMoney(totals.hauling + totals.fuelSurcharge + totals.travelTime + totals.selfLoad + totals.shipperDetention);
  return totals;
}

function defaultSettings() {
  return Object.assign({}, DEFAULT_SETTINGS);
}

function readSettings(db) {
  const settings = defaultSettings();
  if (!db) return settings;
  try {
    const rows = db.prepare('SELECT key, value FROM invoice_settings').all();
    rows.forEach((row) => {
      if (Object.prototype.hasOwnProperty.call(settings, row.key) && row.value != null && String(row.value).trim() !== '') {
        settings[row.key] = String(row.value);
      }
    });
  } catch (err) {
    // Table may not exist yet in a brand-new test database mid-migration.
  }
  return settings;
}

function writeSetting(db, key, value) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return;
  db.prepare(`
    INSERT INTO invoice_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value == null ? '' : value));
}

function seedSettings(db) {
  const insert = db.prepare('INSERT OR IGNORE INTO invoice_settings (key, value) VALUES (?, ?)');
  Object.entries(DEFAULT_SETTINGS).forEach(([key, value]) => insert.run(key, value));
}

function ensureColumn(db, table, column, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    // Column already exists on this database.
  }
}

function seedProjectBilling(db) {
  // One-time, name-based seed only. After this, billing is data-driven from the project row.
  // King George Pad: 24-ton minimum. Uber Freight projects: qty 1 at the project's default rate.
  db.prepare(`
    UPDATE projects
    SET invoice_min_qty = 24
    WHERE invoice_min_qty IS NULL
      AND invoice_billing_seeded IS NULL
      AND LOWER(TRIM(project_name)) = 'king george pad'
  `).run();
  db.prepare(`
    UPDATE projects
    SET invoice_billing_mode = 'flat_qty_1'
    WHERE (invoice_billing_mode IS NULL OR invoice_billing_mode = '' OR invoice_billing_mode = 'actual')
      AND invoice_billing_seeded IS NULL
      AND customer_id IN (SELECT id FROM customers WHERE LOWER(TRIM(name)) = 'uber freight')
  `).run();
  db.prepare(`
    UPDATE projects
    SET invoice_billing_seeded = 1
    WHERE invoice_billing_seeded IS NULL
      AND (
        LOWER(TRIM(project_name)) = 'king george pad'
        OR customer_id IN (SELECT id FROM customers WHERE LOWER(TRIM(name)) = 'uber freight')
      )
  `).run();
}

// Copy existing customer-week Invoiced/Paid marks onto per-project rows without
// deleting or rewriting invoice_weeks. Official DT1-YYYY-NNNN numbers are not
// assigned here (those marks predate the generator). invoice_tracker rows stay put.
function migrateInvoiceWeeks(db) {
  let weeks = [];
  try {
    weeks = db.prepare('SELECT * FROM invoice_weeks').all();
  } catch (err) {
    return { migrated: 0 };
  }
  if (!weeks.length) return { migrated: 0 };
  const findProjects = db.prepare(`
    SELECT DISTINCT l.project_id AS project_id, p.customer_id AS customer_id
    FROM loads l
    JOIN projects p ON p.id = l.project_id
    WHERE l.status = 'approved'
      AND l.load_date >= ?
      AND l.load_date <= ?
      AND p.customer_id = ?
  `);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO project_invoices (
      customer_id, project_id, week_start, week_end,
      invoiced_at, invoiced_by, invoiced_by_name, invoiced_amount,
      paid_at, paid_by, paid_by_name, migrated_from_invoice_week
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  let migrated = 0;
  const run = db.transaction(() => {
    weeks.forEach((week) => {
      const weekEnd = week.week_end || week.week_start;
      const projects = findProjects.all(week.week_start, weekEnd, week.customer_id);
      const targets = projects.length ? projects : [{ project_id: 0, customer_id: week.customer_id }];
      targets.forEach((project) => {
        const result = insert.run(
          project.customer_id, project.project_id, week.week_start, weekEnd,
          week.invoiced_at, week.invoiced_by, week.invoiced_by_name,
          // Only copy the snapshot amount when this customer-week has a single project,
          // otherwise a shared total would falsely flag every project as "changed".
          targets.length === 1 ? week.invoiced_amount : null,
          week.paid_at, week.paid_by, week.paid_by_name
        );
        if (result.changes) migrated += 1;
      });
    });
  });
  run();
  return { migrated };
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoice_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      week_start DATE NOT NULL,
      week_end DATE,
      invoice_number TEXT UNIQUE,
      invoice_year INTEGER,
      invoice_seq INTEGER,
      invoice_date DATE,
      invoiced_at DATETIME,
      invoiced_by INTEGER,
      invoiced_by_name TEXT,
      invoiced_amount REAL,
      paid_at DATETIME,
      paid_by INTEGER,
      paid_by_name TEXT,
      include_tickets INTEGER DEFAULT 1,
      migrated_from_invoice_week INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(customer_id, project_id, week_start)
    );
  `);
  invoiceNumber.ensureCounterSchema(db);
  seedSettings(db);
  ensureColumn(db, 'projects', 'invoice_min_qty', 'REAL');
  ensureColumn(db, 'projects', 'invoice_billing_mode', "TEXT DEFAULT 'actual'");
  ensureColumn(db, 'projects', 'invoice_billing_seeded', 'INTEGER');
  ensureColumn(db, 'invoice_tracker', 'amount_invoiced', 'REAL');
  ensureColumn(db, 'invoice_tracker', 'invoice_number', 'TEXT');
  seedProjectBilling(db);
  migrateInvoiceWeeks(db);
}

function parseBillingFromBody(body, existing) {
  const has = (key) => Object.prototype.hasOwnProperty.call(body || {}, key);
  let mode = existing ? normalizeBillingMode(existing.invoice_billing_mode) : 'actual';
  if (has('invoice_billing_mode')) mode = normalizeBillingMode(body.invoice_billing_mode);
  let minQty = existing && existing.invoice_min_qty != null && String(existing.invoice_min_qty).trim() !== ''
    ? Number(existing.invoice_min_qty) : null;
  if (has('invoice_min_qty')) {
    const raw = String(body.invoice_min_qty == null ? '' : body.invoice_min_qty).trim();
    if (raw === '') minQty = null;
    else {
      const n = Number(raw);
      minQty = Number.isFinite(n) && n > 0 ? n : null;
    }
  }
  if (mode === 'flat_qty_1') {
    // Min qty does not apply to flat-qty-1 billing; keep any stored value but the mode wins.
  }
  return { invoice_billing_mode: mode, invoice_min_qty: minQty };
}

function statusFromMark(mark) {
  if (mark && mark.paid_at) return 'paid';
  if (mark && mark.invoiced_at) return 'invoiced';
  return 'open';
}

function recordTrackerInvoiced(db, opts) {
  const o = opts || {};
  db.prepare(`
    INSERT INTO invoice_tracker (
      customer_id, project_id, week_start, amount_invoiced, invoice_number,
      updated_by, updated_by_name, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(customer_id, project_id, week_start) DO UPDATE SET
      amount_invoiced = excluded.amount_invoiced,
      invoice_number = excluded.invoice_number,
      updated_by = excluded.updated_by,
      updated_by_name = excluded.updated_by_name,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    o.customerId, o.projectId, o.weekStart, o.amount, o.invoiceNumber || null,
    o.actorId || null, o.actorName || null
  );
}

function clearTrackerInvoiced(db, opts) {
  const o = opts || {};
  db.prepare(`
    UPDATE invoice_tracker
    SET amount_invoiced = NULL, updated_by = ?, updated_by_name = ?, updated_at = CURRENT_TIMESTAMP
    WHERE customer_id = ? AND project_id = ? AND week_start = ?
  `).run(o.actorId || null, o.actorName || null, o.customerId, o.projectId, o.weekStart);
}

function ensureProjectInvoiceRow(db, opts) {
  const o = opts || {};
  db.prepare(`
    INSERT INTO project_invoices (customer_id, project_id, week_start, week_end)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(customer_id, project_id, week_start) DO NOTHING
  `).run(o.customerId, o.projectId, o.week.start, o.week.end);
  return db.prepare(`
    SELECT * FROM project_invoices WHERE customer_id = ? AND project_id = ? AND week_start = ?
  `).get(o.customerId, o.projectId, o.week.start);
}

// Assign a number if the project-week does not already have one. Regenerating keeps it.
// Must be called inside a transaction with the status update.
function assignNumberIfNeeded(db, row, clock) {
  if (row && row.invoice_number) {
    return {
      year: row.invoice_year, seq: row.invoice_seq, number: row.invoice_number,
      invoiceDate: row.invoice_date, reused: true
    };
  }
  const allocated = invoiceNumber.allocateInvoiceNumber(db, { clock });
  const invoiceDate = invoiceNumber.easternDate(clock);
  db.prepare(`
    UPDATE project_invoices
    SET invoice_number = ?, invoice_year = ?, invoice_seq = ?, invoice_date = COALESCE(invoice_date, ?)
    WHERE id = ?
  `).run(allocated.number, allocated.year, allocated.seq, invoiceDate, row.id);
  return { year: allocated.year, seq: allocated.seq, number: allocated.number, invoiceDate, reused: false };
}

function applyMark(db, opts) {
  const o = opts || {};
  const row = ensureProjectInvoiceRow(db, o);
  const actorId = o.actorId || null;
  const actorName = o.actorName || '';
  const amount = o.amount != null ? Number(o.amount) : null;
  const mark = String(o.mark || '');
  const clock = o.clock;
  let detail = '';
  let allocated = null;

  const run = db.transaction(() => {
    if (mark === 'invoiced' || mark === 'generate' || mark === 'paid') {
      if (mark === 'invoiced' || mark === 'generate' || (mark === 'paid' && !row.invoiced_at)) {
        allocated = assignNumberIfNeeded(db, row, clock);
        const includeTickets = o.includeTickets == null ? row.include_tickets : (o.includeTickets ? 1 : 0);
        db.prepare(`
          UPDATE project_invoices SET
            invoiced_at = COALESCE(invoiced_at, CURRENT_TIMESTAMP),
            invoiced_by = COALESCE(invoiced_by, ?),
            invoiced_by_name = COALESCE(invoiced_by_name, ?),
            invoiced_amount = ?,
            include_tickets = ?
          WHERE id = ?
        `).run(actorId, actorName, amount, includeTickets == null ? 1 : includeTickets, row.id);
        recordTrackerInvoiced(db, {
          customerId: o.customerId, projectId: o.projectId, weekStart: o.week.start,
          amount, invoiceNumber: allocated.number, actorId, actorName
        });
        detail = mark === 'generate'
          ? `Generated invoice ${allocated.number} (${formatUsd(amount)})`
          : `Marked Invoiced (${formatUsd(amount)})`;
        if (allocated.reused && mark === 'generate') {
          detail = `Regenerated invoice ${allocated.number} (${formatUsd(amount)})`;
        }
      }
      if (mark === 'paid') {
        db.prepare(`
          UPDATE project_invoices SET
            paid_at = CURRENT_TIMESTAMP, paid_by = ?, paid_by_name = ?
          WHERE id = ?
        `).run(actorId, actorName, row.id);
        if (!detail) detail = 'Marked Paid';
        else detail += ', marked Paid';
      }
    } else if (mark === 'unpaid') {
      db.prepare(`
        UPDATE project_invoices SET paid_at = NULL, paid_by = NULL, paid_by_name = NULL WHERE id = ?
      `).run(row.id);
      detail = 'Paid mark removed';
    } else if (mark === 'open') {
      // Undo Invoiced: keep the official number so a later generate reuses it.
      db.prepare(`
        UPDATE project_invoices SET
          invoiced_at = NULL, invoiced_by = NULL, invoiced_by_name = NULL, invoiced_amount = NULL,
          paid_at = NULL, paid_by = NULL, paid_by_name = NULL
        WHERE id = ?
      `).run(row.id);
      clearTrackerInvoiced(db, {
        customerId: o.customerId, projectId: o.projectId, weekStart: o.week.start,
        actorId, actorName
      });
      detail = row.invoice_number
        ? `Invoiced mark removed (number ${row.invoice_number} kept)`
        : 'Invoiced mark removed';
    } else {
      throw new Error('Unknown invoice mark');
    }
  });
  run();
  const updated = db.prepare('SELECT * FROM project_invoices WHERE id = ?').get(row.id);
  return { row: updated, detail, number: (allocated && allocated.number) || updated.invoice_number };
}

function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  const text = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 && text !== '0.00' ? '-$' : '$') + text;
}

module.exports = {
  DEFAULT_SETTINGS,
  BILLING_MODES,
  hasTotalLoadPay,
  roundMoney,
  workWeek,
  normalizeBillingMode,
  billedQuantities,
  haulDescription,
  invoiceLineAmounts,
  emptyTotals,
  addLineToTotals,
  finishTotals,
  defaultSettings,
  readSettings,
  writeSetting,
  ensureSchema,
  seedProjectBilling,
  migrateInvoiceWeeks,
  parseBillingFromBody,
  statusFromMark,
  ensureProjectInvoiceRow,
  assignNumberIfNeeded,
  applyMark,
  recordTrackerInvoiced,
  invoiceNumber,
  formatUsd
};
