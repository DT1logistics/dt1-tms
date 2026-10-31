// Equipment Expenses / Maintenance Log helpers (pure functions, no DB) so totals are unit-tested.
// All money math is done in integer cents and converted back to dollars at the end.
'use strict';

const CATEGORIES = ['Repair', 'Maintenance', 'Tires', 'Parts', 'Inspection', 'Other'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function toCents(amount) {
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function fromCents(cents) {
  return Math.round(cents) / 100;
}

function normalizeCategory(value) {
  const text = String(value || '').trim().toLowerCase();
  return CATEGORIES.find((c) => c.toLowerCase() === text) || 'Other';
}

// Returns 'YYYY-MM-DD' or null for anything that is not a real calendar date.
function normalizeDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return m[0];
}

function monthKey(date) {
  const d = normalizeDate(date);
  return d ? d.slice(0, 7) : 'undated';
}

function monthLabel(key) {
  if (!/^\d{4}-\d{2}$/.test(key)) return 'No date';
  return MONTHS[Number(key.slice(5, 7)) - 1] + ' ' + key.slice(0, 4);
}

// Parse/validate an Admin line-item submission. Returns { value, errors }.
function parseExpenseInput(body) {
  const b = body || {};
  const errors = [];
  const description = String(b.description || '').trim();
  if (!description) errors.push('Description is required.');
  const expenseDate = normalizeDate(b.expense_date);
  if (!expenseDate) errors.push('A valid date is required.');
  const rawAmount = String(b.amount == null ? '' : b.amount).replace(/[$,\s]/g, '');
  const amount = Number(rawAmount);
  if (rawAmount === '' || !Number.isFinite(amount)) errors.push('Amount is required.');
  else if (amount < 0) errors.push('Amount cannot be negative.');
  const rawOdo = String(b.odometer == null ? '' : b.odometer).replace(/[,\s]/g, '');
  let odometer = null;
  if (rawOdo !== '') {
    const o = Number(rawOdo);
    if (!Number.isFinite(o) || o < 0) errors.push('Odometer must be a positive number.');
    else odometer = Math.round(o);
  }
  return {
    errors,
    value: {
      expense_date: expenseDate,
      category: normalizeCategory(b.category),
      vendor: String(b.vendor || '').trim().slice(0, 200) || null,
      description: description.slice(0, 2000),
      amount: Number.isFinite(amount) ? fromCents(toCents(amount)) : 0,
      odometer
    }
  };
}

// Builds the log view: items newest first, grouped by month with month totals, a YTD running
// total on each row of the selected year (cumulative from Jan 1 in date order), plus the YTD and
// all-time totals for the unit.
function summarize(expenses, year) {
  const y = String(year);
  const list = (expenses || []).map((e) => ({ ...e, amount: fromCents(toCents(e.amount)) }));
  const asc = list.slice().sort((a, b) => {
    const da = normalizeDate(a.expense_date) || '';
    const dbb = normalizeDate(b.expense_date) || '';
    if (da !== dbb) return da < dbb ? -1 : 1;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });
  let ytd = 0;
  let all = 0;
  asc.forEach((e) => {
    all += toCents(e.amount);
    const d = normalizeDate(e.expense_date);
    if (d && d.slice(0, 4) === y) {
      ytd += toCents(e.amount);
      e.ytdRunning = fromCents(ytd);
    } else {
      e.ytdRunning = null;
    }
  });
  const groups = [];
  const byKey = {};
  asc.slice().reverse().forEach((e) => {
    const key = monthKey(e.expense_date);
    if (!byKey[key]) {
      byKey[key] = { key, label: monthLabel(key), cents: 0, items: [] };
      groups.push(byKey[key]);
    }
    byKey[key].cents += toCents(e.amount);
    byKey[key].items.push(e);
  });
  groups.sort((a, b) => (a.key === 'undated' ? 1 : b.key === 'undated' ? -1 : (a.key < b.key ? 1 : -1)));
  return {
    year: y,
    months: groups.map((g) => ({ key: g.key, label: g.label, total: fromCents(g.cents), count: g.items.length, items: g.items })),
    ytdTotal: fromCents(ytd),
    allTimeTotal: fromCents(all),
    count: list.length
  };
}

// Per-unit totals for the Equipment list: { [equipment_id]: { ytd, allTime, count } }.
function totalsByEquipment(expenses, year) {
  const y = String(year);
  const out = {};
  (expenses || []).forEach((e) => {
    const id = String(e.equipment_id);
    if (!out[id]) out[id] = { ytdCents: 0, allCents: 0, count: 0 };
    const c = toCents(e.amount);
    out[id].allCents += c;
    out[id].count += 1;
    const d = normalizeDate(e.expense_date);
    if (d && d.slice(0, 4) === y) out[id].ytdCents += c;
  });
  Object.keys(out).forEach((id) => {
    out[id] = { ytd: fromCents(out[id].ytdCents), allTime: fromCents(out[id].allCents), count: out[id].count };
  });
  return out;
}

// Does a free-text receipt line tag ("Truck #1002", "trk 1002") refer to this unit number?
function receiptTagMatches(tag, unitNumber) {
  const unit = String(unitNumber || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!unit) return false;
  const tokens = String(tag || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const joined = String(tag || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (tokens.includes(unit)) return true;
  // Units like "T-12" / "#A7": compare the whole tag with words like truck/trailer removed.
  return joined.replace(/^(truck|trailer|trk|trl|unit|tractor)+/, '') === unit;
}

module.exports = { CATEGORIES, toCents, fromCents, normalizeCategory, normalizeDate, monthKey, monthLabel, parseExpenseInput, summarize, totalsByEquipment, receiptTagMatches };
