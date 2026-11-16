// Yearly load numbers (item 11, 11/16/2026). Format YYYY-NNNN, assigned at
// creation only. The year is the Eastern calendar year the load is entered;
// the sequence resets to 0001 on January 1. Existing loads stay unnumbered.
'use strict';

function easternYear(now) {
  const date = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric'
  }).formatToParts(date);
  const year = Number((parts.find((part) => part.type === 'year') || {}).value);
  return Number.isInteger(year) && year > 0 ? year : null;
}

function formatLoadNumber(year, seq) {
  const y = Number(year);
  const n = Number(seq);
  if (!Number.isInteger(y) || y < 1 || !Number.isInteger(n) || n < 1) return null;
  return `${y}-${String(n).padStart(4, '0')}`;
}

function displayLoadNumber(value) {
  const text = String(value == null ? '' : value).trim();
  return text || '—';
}

// Prefer the official yearly number in APIs and webhooks. Unnumbered existing
// loads keep the previous fallback (ticket number, then internal id).
function publicLoadNumber(row) {
  const official = String((row && row.load_number) || '').trim();
  if (official) return official;
  const ticket = String((row && row.ticket_number) || '').trim();
  if (ticket) return ticket;
  return row && row.id != null ? String(row.id) : '';
}

function searchPattern(q) {
  const text = String(q == null ? '' : q).trim().replace(/[%_\\]/g, '');
  return text || '';
}

// Must run inside the same transaction as the load insert. Never decrements,
// so deleting a load leaves a gap and the number is not reused.
function allocateLoadNumber(db, now) {
  const year = easternYear(now);
  if (!year) throw new Error('Cannot determine the Eastern year for a load number');
  db.prepare(`
    INSERT INTO load_number_seq (year, last) VALUES (?, 1)
    ON CONFLICT(year) DO UPDATE SET last = last + 1
  `).run(year);
  const row = db.prepare('SELECT last FROM load_number_seq WHERE year = ?').get(year);
  return formatLoadNumber(year, row && row.last);
}

function ensureSchema(db) {
  // Additive only. Existing load rows keep every current field; load_number stays NULL.
  try {
    db.exec('ALTER TABLE loads ADD COLUMN load_number TEXT');
  } catch (err) {
    // The column is already present on a later boot or a fresh CREATE TABLE.
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS load_number_seq (
      year INTEGER PRIMARY KEY,
      last INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_loads_load_number ON loads(load_number);
  `);
}

module.exports = {
  easternYear,
  formatLoadNumber,
  displayLoadNumber,
  publicLoadNumber,
  searchPattern,
  allocateLoadNumber,
  ensureSchema
};
