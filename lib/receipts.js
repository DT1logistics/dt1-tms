// Receipt type, unit matching, and weekly admin totals (pure functions, no DB).
'use strict';

const equipExpenses = require('./equipment-expenses');

const GENERAL_RECEIPT_TAG = 'General / Shop Supplies & Business Expense';

function isGeneralReceiptTag(tag) {
  return String(tag || '').trim().toLowerCase() === GENERAL_RECEIPT_TAG.toLowerCase();
}

function normalizeReceiptType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'fuel') return 'fuel';
  if (text === 'expense') return 'expense';
  return null;
}

function parseUploadedReceiptType(value) {
  const type = normalizeReceiptType(value);
  if (!type) return { error: 'Select a receipt type: Fuel or Expense.' };
  return { value: type };
}

function receiptTypeLabel(value) {
  const type = normalizeReceiptType(value);
  if (type === 'fuel') return 'Fuel';
  if (type === 'expense') return 'Expense';
  return 'Expense (untyped)';
}

// Auto-created equipment expense category: untyped receipts count as Expense.
function receiptTypeCategory(value) {
  return normalizeReceiptType(value) === 'fuel' ? 'Fuel' : 'Expense';
}

function receiptTypeBucket(value) {
  return normalizeReceiptType(value) === 'fuel' ? 'fuel' : 'expense';
}

// Same Monday–Sunday rule as server.js weekBounds (local calendar date).
function weekBounds(dateStr) {
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
  const range = `${label(monday)} - ${label(sunday)}`;
  return { start: iso(monday), end: iso(sunday), range };
}

function emptyTotals() {
  return { fuel: 0, expense: 0, total: 0 };
}

function addAmount(bucket, type, cents) {
  bucket[type] += cents;
  bucket.total += cents;
}

function fromCents(cents) {
  return Math.round(cents) / 100;
}

function moneyTotals(bucket) {
  return {
    fuel: fromCents(bucket.fuel),
    expense: fromCents(bucket.expense),
    total: fromCents(bucket.total)
  };
}

function unitLabel(line) {
  if (isGeneralReceiptTag(line.equipment_type) || line.is_general) return GENERAL_RECEIPT_TAG;
  const loggedNumber = String(line.logged_equipment_number || '').trim();
  if (loggedNumber) {
    const kind = String(line.logged_equipment_type || '').trim();
    const number = loggedNumber.startsWith('#') ? loggedNumber : '#' + loggedNumber;
    return kind ? `${kind} ${number}` : number;
  }
  const tag = String(line.equipment_type || '').trim();
  return tag || 'Untagged';
}

function driverKey(receipt) {
  return receipt.uploaded_by == null || receipt.uploaded_by === '' ? 'unknown' : String(receipt.uploaded_by);
}

function driverLabel(receipt) {
  return String(receipt.uploader_name || '').trim() || 'Unknown';
}

// Weekly Mon–Sun totals by type, by driver, and by truck/unit.
// Untyped receipts count as Expense. Rejected receipts are excluded by default.
function buildWeeklyReceiptSummary(receipts, options) {
  const exclude = new Set((options && options.excludeStatuses ? options.excludeStatuses : ['rejected'])
    .map((status) => String(status || '').toLowerCase()));
  const weeks = new Map();

  function weekEntry(receipt) {
    const bounds = weekBounds(receipt.expense_date);
    const key = bounds ? bounds.start : 'undated';
    if (!weeks.has(key)) {
      weeks.set(key, {
        start: bounds ? bounds.start : 'undated',
        end: bounds ? bounds.end : '',
        range: bounds ? bounds.range : 'Undated',
        totals: emptyTotals(),
        drivers: new Map(),
        units: new Map()
      });
    }
    return weeks.get(key);
  }

  (receipts || []).forEach((receipt) => {
    if (exclude.has(String(receipt.status || '').toLowerCase())) return;
    const week = weekEntry(receipt);
    const type = receiptTypeBucket(receipt.receipt_type);
    const dKey = driverKey(receipt);
    if (!week.drivers.has(dKey)) week.drivers.set(dKey, { key: dKey, name: driverLabel(receipt), totals: emptyTotals() });
    const driver = week.drivers.get(dKey);
    if (!driver.name || driver.name === 'Unknown') driver.name = driverLabel(receipt);

    const lines = (receipt.lines && receipt.lines.length) ? receipt.lines : [{ amount: 0, equipment_type: '' }];
    lines.forEach((line) => {
      const cents = equipExpenses.toCents(line.amount);
      addAmount(week.totals, type, cents);
      addAmount(driver.totals, type, cents);
      const uKey = unitLabel(line);
      if (!week.units.has(uKey)) week.units.set(uKey, { name: uKey, totals: emptyTotals() });
      addAmount(week.units.get(uKey).totals, type, cents);
    });
  });

  const list = Array.from(weeks.values()).map((week) => ({
    start: week.start,
    end: week.end,
    range: week.range,
    totals: moneyTotals(week.totals),
    drivers: Array.from(week.drivers.values())
      .map((row) => ({ name: row.name, totals: moneyTotals(row.totals) }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.totals.total - b.totals.total),
    units: Array.from(week.units.values())
      .map((row) => ({ name: row.name, totals: moneyTotals(row.totals) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }));

  list.sort((a, b) => {
    if (a.start === 'undated') return 1;
    if (b.start === 'undated') return -1;
    return a.start < b.start ? 1 : a.start > b.start ? -1 : 0;
  });
  return list;
}

// Exact one equipment match, or flag. Never pick among several. General lines are skipped.
function matchReceiptLineToEquipment(line, equipmentList) {
  if (isGeneralReceiptTag(line && line.equipment_type) || (line && line.is_general)) {
    return { kind: 'general' };
  }
  const tag = String((line && line.equipment_type) || '').trim();
  if (!tag) {
    return { kind: 'unmatched', reason: 'This line has no truck or unit tag.' };
  }
  const matches = (equipmentList || []).filter((eq) => equipExpenses.receiptTagMatches(tag, eq.number));
  if (matches.length === 1) return { kind: 'matched', equipment: matches[0] };
  if (matches.length === 0) return { kind: 'unmatched', reason: `No equipment unit matches “${tag}”.` };
  return {
    kind: 'unmatched',
    reason: `More than one equipment unit matches “${tag}”. Choose the unit or fix the tag so it is unique.`
  };
}

function isActiveExpense(row) {
  return String((row && row.status) || 'active') !== 'voided';
}

module.exports = {
  GENERAL_RECEIPT_TAG,
  isGeneralReceiptTag,
  normalizeReceiptType,
  parseUploadedReceiptType,
  receiptTypeLabel,
  receiptTypeCategory,
  receiptTypeBucket,
  weekBounds,
  buildWeeklyReceiptSummary,
  matchReceiptLineToEquipment,
  isActiveExpense,
  unitLabel
};
