// Official customer invoice numbers (item 12, 11/16/2026).
// Format: DT1-YYYY-NNNN. 2026 continues Logan's sequence (next is 4012). On January 1
// (America/New_York) the counter starts over at 0001. A number is never reused.
// The clock can be injected so tests can cover the yearly reset without waiting.
'use strict';

const TZ = 'America/New_York';

function padSeq(seq) {
  const n = Number(seq) || 0;
  return String(n).padStart(Math.max(4, String(n).length), '0');
}

function formatInvoiceNumber(year, seq) {
  return `DT1-${Number(year)}-${padSeq(seq)}`;
}

function invoiceFileName(number, projectName) {
  const project = String(projectName || 'Invoice').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Invoice';
  return `${number} - ${project}.pdf`;
}

// Parse "DT1-2026-4012" (also accepts "DT1 - 2026-4012").
function parseInvoiceNumber(value) {
  const m = String(value || '').trim().match(/^DT1\s*-\s*(\d{4})-(\d+)$/i);
  if (!m) return null;
  return { year: Number(m[1]), seq: Number(m[2]), number: formatInvoiceNumber(m[1], m[2]) };
}

function easternParts(date, zone) {
  const when = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(when.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone || TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(when);
  const pick = (type) => (parts.find((part) => part.type === type) || {}).value;
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour: Number(pick('hour')),
    minute: Number(pick('minute')),
    second: Number(pick('second')),
    date: `${pick('year')}-${pick('month')}-${pick('day')}`
  };
}

function resolveClock(clock) {
  if (typeof clock === 'function') return clock();
  if (clock instanceof Date) return clock;
  if (clock) return new Date(clock);
  if (process.env.INVOICE_NOW) return new Date(process.env.INVOICE_NOW);
  return new Date();
}

function easternDate(clock) {
  const parts = easternParts(resolveClock(clock));
  return parts ? parts.date : '';
}

function invoiceYear(clock) {
  const parts = easternParts(resolveClock(clock));
  return parts ? parts.year : new Date().getFullYear();
}

function ensureCounterSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoice_number_counters (
      year INTEGER PRIMARY KEY,
      next_seq INTEGER NOT NULL
    );
  `);
  // Seed only when 2026 has no row yet, so a later deploy cannot reset the counter.
  const row = db.prepare('SELECT next_seq FROM invoice_number_counters WHERE year = 2026').get();
  if (!row) {
    db.prepare('INSERT INTO invoice_number_counters (year, next_seq) VALUES (2026, 4012)').run();
  }
}

// Allocate the next number for `year` inside the caller's transaction when possible.
// Returns { year, seq, number }. Never updates an existing assignment.
function allocateInvoiceNumber(db, opts) {
  const o = opts || {};
  const year = o.year != null ? Number(o.year) : invoiceYear(o.clock);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error('Invalid invoice year');
  }
  ensureCounterSchema(db);
  const startSeq = year === 2026 ? 4012 : 1;
  db.prepare(`
    INSERT INTO invoice_number_counters (year, next_seq) VALUES (?, ?)
    ON CONFLICT(year) DO NOTHING
  `).run(year, startSeq);
  const row = db.prepare('SELECT next_seq FROM invoice_number_counters WHERE year = ?').get(year);
  const seq = Number(row && row.next_seq) || startSeq;
  db.prepare('UPDATE invoice_number_counters SET next_seq = ? WHERE year = ?').run(seq + 1, year);
  return { year, seq, number: formatInvoiceNumber(year, seq) };
}

module.exports = {
  TZ,
  padSeq,
  formatInvoiceNumber,
  invoiceFileName,
  parseInvoiceNumber,
  easternParts,
  easternDate,
  invoiceYear,
  resolveClock,
  ensureCounterSchema,
  allocateInvoiceNumber
};
