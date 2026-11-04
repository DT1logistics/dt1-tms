// Admin bulk import for trucks, hotshots, and trailers. Parsing and checks live
// here so they can run without booting Express. Nothing in here creates a UNIQUE
// constraint: duplicate unit numbers and VINs are reported, not rejected by SQL.
'use strict';

const equipmentPlate = require('./equipment-plate');

const MAX_ROWS = 2000;

const BLANK_SENTINELS = new Set([
  '', 'none', 'null', 'n/a', 'na', 'n.a', 'n.a.', '-', '--', '—', '–', 'unknown', 'tbd', '?', 'blank'
]);

const VIN_VALUES = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9
};
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

const HEADER_ALIASES = {
  type: 'type',
  equipmenttype: 'type',
  unittype: 'type',
  equiptype: 'type',
  kind: 'type',

  equipmentnumber: 'number',
  equipmentnumberidentifier: 'number',
  unitnumber: 'number',
  unitno: 'number',
  unit: 'number',
  number: 'number',
  trucknumber: 'number',
  trailernumber: 'number',
  equipmentno: 'number',
  identifier: 'number',
  unitidentifier: 'number',

  vin: 'vin',
  vinnumber: 'vin',
  vehicleidentificationnumber: 'vin',

  year: 'year',
  modelyear: 'year',

  make: 'make',
  manufacturer: 'make',

  model: 'model',

  description: 'description',
  equipmentdescription: 'description',
  desc: 'description',

  ownership: 'ownership',

  registrationexpiration: 'registration_expiration',
  registrationexpirationdate: 'registration_expiration',
  regexp: 'registration_expiration',
  regexpiration: 'registration_expiration',
  registrationexp: 'registration_expiration',

  annualdotperiodicinspectiondate: 'inspection_expiration',
  annualdotperiodicinspection: 'inspection_expiration',
  annualdotinspection: 'inspection_expiration',
  inspectionexpiration: 'inspection_expiration',
  inspectionexpirationdate: 'inspection_expiration',
  inspectiondate: 'inspection_expiration',
  dotinspection: 'inspection_expiration',
  dotexpiration: 'inspection_expiration',
  dotinspectionexpiration: 'inspection_expiration',
  annualinspection: 'inspection_expiration',
  annualinspectionexpiration: 'inspection_expiration',

  status: 'status',
  equipmentstatus: 'status',
  unitstatus: 'status',

  inactivereason: 'inactive_reason',
  statusreason: 'inactive_reason',
  disposition: 'inactive_reason',

  maintenancestatus: 'maintenance_status',
  maintstatus: 'maintenance_status',
  maintenance: 'maintenance_status',

  platenumber: 'plate_number',
  plate: 'plate_number',
  licenseplate: 'plate_number',
  licenseplatenumber: 'plate_number',
  licensenumber: 'plate_number',
  plateno: 'plate_number',

  platestate: 'plate_state',
  licensestate: 'plate_state',
  registrationstate: 'plate_state'
};

const STATE_BY_NAME = new Map(equipmentPlate.US_STATES.map((pair) => [pair[1].toLowerCase(), pair[0]]));

const TEMPLATE_HEADERS = [
  'Type', 'Equipment Number', 'VIN', 'Year', 'Make', 'Model', 'Description', 'Ownership',
  'Registration Expiration', 'Inspection Expiration', 'Status', 'Maintenance Status',
  'Plate Number', 'Plate State', 'Inactive Reason'
];

function isBlank(value) {
  if (value == null) return true;
  if (typeof value === 'number') return !Number.isFinite(value);
  if (value instanceof Date) return Number.isNaN(value.getTime());
  const text = String(value).replace(/\u00a0/g, ' ').trim().toLowerCase();
  return text === '' || BLANK_SENTINELS.has(text);
}

function asText(value) {
  if (isBlank(value)) return '';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value);
    const rounded = Math.round(value);
    if (Math.abs(value - rounded) < 1e-8) return String(rounded);
    return String(value);
  }
  return String(value).replace(/\u00a0/g, ' ').trim();
}

function normalizeHeader(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/#/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '');
}

function mapHeaders(cells) {
  const fields = {};
  const ignored = [];
  const duplicates = [];
  (cells || []).forEach((cell, index) => {
    const raw = cell == null ? '' : String(cell).trim();
    if (!raw) return;
    const field = HEADER_ALIASES[normalizeHeader(raw)];
    if (!field) {
      ignored.push(raw);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(fields, field)) {
      duplicates.push(raw);
      return;
    }
    fields[field] = index;
  });
  return { fields, ignored, duplicates };
}

function sheetSkipped(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  if (/^(notes?|reference|readme|instructions|legend|lookup|documentation)\b/.test(n)) return true;
  if (n.includes('not tms') || n.includes('do not import') || n.includes('do not add')) return true;
  return false;
}

function typeFromSheetName(name) {
  const n = String(name || '').toLowerCase();
  if (/\btrailers?\b/.test(n)) return 'trailer';
  if (/\bhot\s*-?\s*shots?\b/.test(n)) return 'hotshot';
  if (/\b(trucks?|tractors?|power\s*units?)\b/.test(n)) return 'truck';
  return '';
}

function displayRaw(value) {
  let text;
  if (value instanceof Date) text = Number.isNaN(value.getTime()) ? '' : value.toISOString();
  else text = String(value);
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 48) text = text.slice(0, 45) + '...';
  return text;
}

function ymd(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1950 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function excelSerialToIso(serial) {
  if (!Number.isFinite(serial)) return null;
  const n = Math.floor(Number(serial));
  // Excel's fake 1900-02-29. Real registration dates never use it.
  if (n === 60 || n < 1 || n > 80000) return null;
  const dt = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
  const iso = ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  return iso;
}

function isoToExcelSerial(iso) {
  const match = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - Date.UTC(1899, 11, 30);
  return Math.round(ms / 86400000);
}

function parseDate(value) {
  if (isBlank(value)) return { ok: true, value: null };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { ok: false, error: 'Unparseable date' };
    const iso = ymd(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
    return iso ? { ok: true, value: iso } : { ok: false, error: 'Unparseable date' };
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 1900 && value <= 2100) {
      return { ok: false, error: `"${value}" is a year, not a full date` };
    }
    const iso = excelSerialToIso(value);
    return iso ? { ok: true, value: iso } : { ok: false, error: `Unparseable Excel date ${value}` };
  }
  let text = String(value).replace(/\u00a0/g, ' ').trim();
  text = text.replace(/[T\s]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2}|[AP]M)?$/i, '').trim();
  if (isBlank(text)) return { ok: true, value: null };

  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    const iso = ymd(match[1], match[2], match[3]);
    return iso ? { ok: true, value: iso } : { ok: false, error: `"${displayRaw(text)}" is not a real calendar date` };
  }
  match = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (match) {
    let year = match[3];
    if (year.length === 2) year = (Number(year) >= 70 ? '19' : '20') + year;
    const iso = ymd(year, match[1], match[2]);
    return iso ? { ok: true, value: iso } : { ok: false, error: `"${displayRaw(text)}" is not a real calendar date` };
  }
  match = text.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (match && MONTHS[match[1].toLowerCase()]) {
    const iso = ymd(match[3], MONTHS[match[1].toLowerCase()], match[2]);
    return iso ? { ok: true, value: iso } : { ok: false, error: `"${displayRaw(text)}" is not a real calendar date` };
  }
  match = text.match(/^(\d{1,2})[\s\-]+([A-Za-z]+)[\s,\-]+(\d{4})$/);
  if (match && MONTHS[match[2].toLowerCase()]) {
    const iso = ymd(match[3], MONTHS[match[2].toLowerCase()], match[1]);
    return iso ? { ok: true, value: iso } : { ok: false, error: `"${displayRaw(text)}" is not a real calendar date` };
  }
  if (/^\d+(\.\d+)?$/.test(text) && text.split('.')[0].length >= 5) {
    const iso = excelSerialToIso(Number(text));
    return iso ? { ok: true, value: iso } : { ok: false, error: `"${displayRaw(text)}" is not a valid Excel date` };
  }
  return { ok: false, error: `"${displayRaw(text)}" is not a recognized date` };
}

function takeDate(raw, label, errors) {
  const parsed = parseDate(raw);
  if (!parsed.ok) {
    errors.push(`${label} is not a valid date (${parsed.error}).`);
    return null;
  }
  return parsed.value;
}

function vinCheckDigit(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    const val = ch >= '0' && ch <= '9' ? Number(ch) : VIN_VALUES[ch];
    if (val == null) return null;
    sum += val * VIN_WEIGHTS[i];
  }
  const rem = sum % 11;
  return rem === 10 ? 'X' : String(rem);
}

// `sixteen` is the VIN without the check digit (positions 1-8 and 10-17).
function makeVin(sixteen) {
  const body = String(sixteen || '').toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{16}$/.test(body)) throw new Error('VIN body must be 16 characters without I, O, or Q');
  const chars = (body.slice(0, 8) + '0' + body.slice(8)).split('');
  chars[8] = vinCheckDigit(chars.join(''));
  return chars.join('');
}

function inspectVin(raw, columnPresent) {
  if (!columnPresent) return { vin: '' };
  const text = asText(raw);
  if (!text) return { vin: '', warning: 'VIN is missing.' };
  const vin = text.toUpperCase().replace(/[\s-]/g, '');
  if (vin.length !== 17 || /[^A-HJ-NPR-Z0-9]/.test(vin)) {
    const why = vin.length !== 17
      ? `it is ${vin.length} characters`
      : 'it contains a character other than 0-9 and A-Z excluding I, O, and Q';
    return { vin, warning: `VIN "${vin}" failed the 17-character check-digit test (${why}).` };
  }
  const expected = vinCheckDigit(vin);
  if (vin[8] !== expected) {
    return { vin, warning: `VIN "${vin}" failed the check-digit test (check digit is ${vin[8]}, expected ${expected}).` };
  }
  return { vin };
}

function statusKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function cleanType(raw, sheetType) {
  const text = asText(raw);
  if (!text) {
    if (sheetType) return { value: sheetType };
    return { error: 'Type is missing. Use truck, trailer, or hotshot.' };
  }
  const key = text.toLowerCase().replace(/[\s-]+/g, '_');
  if (['truck', 'trucks', 'tractor', 'tractors', 'power_unit', 'power_units', 'tk'].includes(key)) return { value: 'truck' };
  if (['trailer', 'trailers', 'trl'].includes(key)) return { value: 'trailer' };
  if (['hotshot', 'hotshots', 'hot_shot', 'hot_shots', 'hs'].includes(key)) return { value: 'hotshot' };
  return { error: `Invalid type "${text}". Use truck, trailer, or hotshot.` };
}

function cleanStatus(raw) {
  const text = asText(raw);
  if (!text) return { value: null, inactive_reason: null, maintenance_status: null };
  const key = statusKey(text);
  if (['active', 'in_service', 'inservice'].includes(key)) {
    return { value: 'active', inactive_reason: null, maintenance_status: null };
  }
  if (['inactive', 'in_active'].includes(key)) {
    return { value: 'inactive', inactive_reason: null, maintenance_status: null };
  }
  if (['sold', 'sale', 'sold_inactive', 'inactive_sold'].includes(key)) {
    return { value: 'inactive', inactive_reason: 'sold', maintenance_status: null };
  }
  if (['total_loss', 'totalloss', 'totaled', 'totalled', 'inactive_total_loss', 'total_loss_inactive'].includes(key)) {
    return { value: 'inactive', inactive_reason: 'total_loss', maintenance_status: null };
  }
  if (['other', 'inactive_other'].includes(key)) {
    return { value: 'inactive', inactive_reason: 'other', maintenance_status: null };
  }
  if (['out_of_service', 'outofservice', 'oos'].includes(key)) {
    return { value: 'active', inactive_reason: null, maintenance_status: 'out_of_service' };
  }
  return {
    value: null,
    inactive_reason: null,
    maintenance_status: null,
    warning: `Status "${text}" is not active, inactive, sold, total loss, or out of service, so it was not applied.`
  };
}

function cleanInactiveReason(raw) {
  const text = asText(raw);
  if (!text) return { value: null };
  const key = statusKey(text);
  if (['sold', 'sale', 'inactive_sold'].includes(key)) return { value: 'sold' };
  if (['total_loss', 'totalloss', 'totaled', 'totalled', 'inactive_total_loss'].includes(key)) return { value: 'total_loss' };
  if (['other', 'inactive_other'].includes(key)) return { value: 'other' };
  return { value: null, warning: `Inactive reason "${text}" is not sold, total loss, or other, so it was not applied.` };
}

function cleanMaintenance(raw) {
  const text = asText(raw);
  if (!text) return { value: null };
  const key = text.toLowerCase().replace(/[\s-]+/g, '_');
  if (key === 'active' || key === 'in_service') return { value: 'active' };
  if (key === 'maintenance' || key === 'in_maintenance') return { value: 'maintenance' };
  if (key === 'out_of_service' || key === 'outofservice' || key === 'oos') return { value: 'out_of_service' };
  return { value: null, warning: `Maintenance status "${text}" is not active, maintenance, or out of service, so it was not applied.` };
}

function cleanPlateState(raw, columnPresent) {
  if (!columnPresent) return { value: null };
  const text = asText(raw);
  if (!text) return { value: null };
  const named = STATE_BY_NAME.get(text.toLowerCase());
  const normalized = equipmentPlate.normalizePlateState(named || text);
  if (normalized.error) return { value: null, error: `Plate state "${text}" must be a 2-letter US state code.` };
  return { value: normalized.value };
}

function cleanUnit(raw) {
  return asText(raw).replace(/\s+/g, ' ');
}

function normalizeUnitKey(value) {
  return String(value || '').trim().replace(/^#/, '').replace(/\s+/g, '').toLowerCase();
}

function normalizeVinKey(value) {
  return String(value || '').toUpperCase().replace(/[\s-]/g, '');
}

function cellAt(cells, index) {
  if (index == null) return null;
  const value = cells[index];
  return value == null ? null : value;
}

function isEmptyRow(cells) {
  return !(cells || []).some((cell) => !isBlank(cell));
}

function parseDataRow(row, mapped, sheetName, sheetType) {
  const cells = row.cells || [];
  const errors = [];
  const warnings = [];
  const get = (field) => cellAt(cells, mapped.fields[field]);
  const has = (field) => Object.prototype.hasOwnProperty.call(mapped.fields, field);

  const typeResult = cleanType(get('type'), sheetType);
  if (typeResult.error) errors.push(typeResult.error);

  const number = cleanUnit(get('number'));
  if (!number) errors.push('Unit number is required.');

  const vinResult = inspectVin(get('vin'), has('vin'));
  if (vinResult.warning) warnings.push(vinResult.warning);

  const registration = takeDate(get('registration_expiration'), 'Registration expiration', errors);
  const inspection = takeDate(get('inspection_expiration'), 'Inspection expiration', errors);

  const statusResult = cleanStatus(get('status'));
  if (statusResult.warning) warnings.push(statusResult.warning);
  const maintResult = cleanMaintenance(get('maintenance_status'));
  if (maintResult.warning) warnings.push(maintResult.warning);
  const reasonResult = cleanInactiveReason(has('inactive_reason') ? get('inactive_reason') : null);
  if (has('inactive_reason') && reasonResult.warning) warnings.push(reasonResult.warning);

  let status = statusResult.value;
  let inactiveReason = statusResult.inactive_reason;
  if (reasonResult.value) {
    if (status === 'active') {
      warnings.push(`Inactive reason "${asText(get('inactive_reason'))}" was not applied because Status is active.`);
    } else {
      if (inactiveReason && inactiveReason !== reasonResult.value) {
        warnings.push(`Inactive reason column (${reasonResult.value}) was kept instead of ${inactiveReason} from Status.`);
      }
      inactiveReason = reasonResult.value;
      if (!status) status = 'inactive';
    }
  }
  let maintenance = maintResult.value;
  if (statusResult.maintenance_status) {
    if (!maintenance) maintenance = statusResult.maintenance_status;
    else if (maintenance !== statusResult.maintenance_status) {
      warnings.push(`Maintenance status column (${maintenance}) was kept instead of "${asText(get('status'))}" from Status.`);
    }
  }

  const plateState = cleanPlateState(get('plate_state'), has('plate_state'));
  if (plateState.error) errors.push(plateState.error);

  const plateNumber = has('plate_number') ? equipmentPlate.normalizePlateNumber(asText(get('plate_number'))) : null;

  return {
    source: { sheet: sheetName, row: row.excelRow },
    errors,
    warnings,
    value: {
      type: typeResult.value || '',
      number,
      vin: vinResult.vin || '',
      year: asText(get('year')),
      make: asText(get('make')),
      model: asText(get('model')),
      description: asText(get('description')),
      ownership: asText(get('ownership')),
      registration_expiration: registration,
      inspection_expiration: inspection,
      status,
      inactive_reason: inactiveReason,
      maintenance_status: maintenance,
      plate_number: plateNumber,
      plate_state: plateState.value
    }
  };
}

function findHeader(rows) {
  const limit = Math.min(rows.length, 15);
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < limit; i++) {
    const mapped = mapHeaders(rows[i].cells);
    const fields = Object.keys(mapped.fields);
    const useful = fields.includes('number') || fields.includes('vin') || fields.includes('type');
    if (!useful || fields.length <= bestScore) continue;
    bestScore = fields.length;
    best = i;
  }
  return best;
}

function parseSheet(sheet) {
  const headerIndex = findHeader(sheet.rows || []);
  if (headerIndex < 0) return { unrecognized: true };
  const mapped = mapHeaders(sheet.rows[headerIndex].cells);
  const sheetType = typeFromSheetName(sheet.name);
  const data = [];
  for (let i = headerIndex + 1; i < sheet.rows.length; i++) {
    const row = sheet.rows[i];
    if (isEmptyRow(row.cells)) continue;
    data.push(parseDataRow(row, mapped, sheet.name, sheetType));
  }
  return { data, ignored: mapped.ignored, duplicates: mapped.duplicates };
}

function place(source) {
  if (!source) return 'import';
  return `${source.sheet} row ${source.row}`;
}

function addDuplicateWarnings(rows) {
  const byNumber = new Map();
  const byVin = new Map();
  rows.forEach((row, index) => {
    const num = normalizeUnitKey(row.value.number);
    const vin = normalizeVinKey(row.value.vin);
    if (num) {
      if (!byNumber.has(num)) byNumber.set(num, []);
      byNumber.get(num).push(index);
    }
    if (vin) {
      if (!byVin.has(vin)) byVin.set(vin, []);
      byVin.get(vin).push(index);
    }
  });
  const flag = (groups, label, display) => {
    groups.forEach((indexes) => {
      if (indexes.length < 2) return;
      const places = indexes.map((index) => place(rows[index].source));
      indexes.forEach((index, nth) => {
        const others = places.filter((_, j) => j !== nth);
        rows[index].warnings.push(`${label} "${display(rows[index])}" is also on ${others.join(' and ')}.`);
      });
    });
  };
  flag(byNumber, 'Unit number', (row) => row.value.number);
  flag(byVin, 'VIN', (row) => row.value.vin);
}

function finalizeSheets(sheets) {
  const skippedSheets = [];
  const unrecognizedSheets = [];
  const ignoredHeaders = [];
  const sheetWarnings = [];
  const rows = [];
  let used = 0;
  (sheets || []).forEach((sheet) => {
    if (sheetSkipped(sheet.name)) {
      skippedSheets.push(sheet.name);
      return;
    }
    const parsed = parseSheet(sheet);
    if (parsed.unrecognized) {
      if ((sheet.rows || []).some((row) => !isEmptyRow(row.cells))) unrecognizedSheets.push(sheet.name);
      return;
    }
    used += 1;
    parsed.ignored.forEach((header) => {
      if (!ignoredHeaders.includes(header)) ignoredHeaders.push(header);
    });
    parsed.duplicates.forEach((header) => {
      sheetWarnings.push(`${sheet.name}: column "${header}" is repeated, so the first one is used.`);
    });
    rows.push(...parsed.data);
  });
  if (!used) {
    return {
      ok: false,
      error: 'No equipment sheet found. Include a header row with a unit number or VIN. Sheets named Reference or Notes are skipped.'
    };
  }
  if (!rows.length) return { ok: false, error: 'No equipment rows were found under the header row.' };
  if (rows.length > MAX_ROWS) return { ok: false, error: `This file has more than ${MAX_ROWS} equipment rows.` };
  addDuplicateWarnings(rows);
  return { ok: true, rows, skippedSheets, unrecognizedSheets, ignoredHeaders, sheetWarnings };
}

function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const records = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;
  const pushRecord = () => {
    row.push(cur);
    records.push({ excelRow: rowStartLine, cells: row });
    row = [];
    cur = '';
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else inQuotes = false;
      } else {
        if (ch === '\n') line += 1;
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      pushRecord();
      line += 1;
      rowStartLine = line;
    } else cur += ch;
  }
  if (cur.length || row.length) pushRecord();
  return records;
}

function sheetToRows(XLSX, sheet) {
  if (!sheet || !sheet['!ref']) return [];
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const rows = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cells = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (!cell || cell.v == null || cell.v === '') cells.push(null);
      else cells.push(cell.v);
    }
    rows.push({ excelRow: r + 1, cells });
  }
  return rows;
}

function parseUpload(buffer, filename) {
  const ext = String(filename || '').toLowerCase().match(/\.[a-z0-9]+$/);
  const suffix = ext ? ext[0] : '';
  if (!buffer || !buffer.length) return { ok: false, error: 'The file is empty.' };
  try {
    if (suffix === '.csv' || suffix === '.txt') {
      if (buffer.length >= 2 && buffer.slice(0, 2).toString() === 'PK') {
        return { ok: false, error: 'This file is an Excel workbook. Upload it with a .xlsx name.' };
      }
      return finalizeSheets([{ name: 'CSV', rows: parseCsv(buffer.toString('utf8')) }]);
    }
    if (suffix === '.xlsx' || suffix === '.xls') {
      const XLSX = require('xlsx');
      const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
      const sheets = wb.SheetNames.map((name) => ({ name, rows: sheetToRows(XLSX, wb.Sheets[name]) }));
      return finalizeSheets(sheets);
    }
  } catch (err) {
    return { ok: false, error: 'Could not read that file. Save it as .csv or .xlsx and try again.' };
  }
  return { ok: false, error: 'Upload a .csv or .xlsx file.' };
}

function equipLabel(row) {
  const type = row && row.type;
  const kind = type === 'trailer' ? 'trailer' : (type === 'hotshot' ? 'hotshot' : 'truck');
  const number = row && row.number ? row.number : (row && row.id ? `#${row.id}` : 'unit');
  return `${kind} ${number}`;
}

function indexEquipment(existing) {
  const byNumber = new Map();
  const byVin = new Map();
  (existing || []).forEach((row) => {
    const num = normalizeUnitKey(row.number);
    const vin = normalizeVinKey(row.vin);
    if (num) {
      if (!byNumber.has(num)) byNumber.set(num, []);
      byNumber.get(num).push(row);
    }
    if (vin) {
      if (!byVin.has(vin)) byVin.set(vin, []);
      byVin.get(vin).push(row);
    }
  });
  return { byNumber, byVin };
}

function resolveMatch(value, index, errors, warnings) {
  const byNum = value.number ? (index.byNumber.get(normalizeUnitKey(value.number)) || []) : [];
  const byVin = value.vin ? (index.byVin.get(normalizeVinKey(value.vin)) || []) : [];
  if (byNum.length > 1) {
    errors.push(`Unit number "${value.number}" matches more than one equipment row (${byNum.map((row) => '#' + row.id).join(', ')}).`);
    return { ambiguous: true };
  }
  if (byVin.length > 1) {
    errors.push(`VIN "${value.vin}" matches more than one equipment row (${byVin.map((row) => '#' + row.id).join(', ')}).`);
    return { ambiguous: true };
  }
  if (byNum.length === 1 && byVin.length === 1 && String(byNum[0].id) !== String(byVin[0].id)) {
    errors.push(`Unit number matches ${equipLabel(byNum[0])} but this VIN is already on ${equipLabel(byVin[0])}.`);
    return { ambiguous: true };
  }
  const hit = byNum[0] || byVin[0];
  if (!hit) return null;
  const via = byNum.length && byVin.length ? 'both' : (byNum.length ? 'number' : 'vin');
  if (via === 'both') warnings.push(`Unit number "${value.number}" and this VIN are already on ${equipLabel(hit)}. Choose skip or update.`);
  else if (via === 'number') warnings.push(`Unit number "${value.number}" is already on ${equipLabel(hit)}. Choose skip or update.`);
  else warnings.push(`VIN "${value.vin}" is already on ${equipLabel(hit)}. Choose skip or update.`);
  return {
    id: hit.id,
    type: hit.type,
    number: hit.number,
    vin: hit.vin || '',
    via,
    ambiguous: false
  };
}

function annotateExisting(rows, existing) {
  const index = indexEquipment(existing);
  return (rows || []).map((row) => {
    const errors = row.errors.slice();
    const warnings = row.warnings.slice();
    const match = resolveMatch(row.value, index, errors, warnings);
    return { source: row.source, value: row.value, errors, warnings, match };
  });
}

function matchStamp(rows) {
  return (rows || []).map((row) => {
    const err = row.errors.length;
    if (row.match && row.match.ambiguous) return `A${err}`;
    if (row.match && row.match.id != null) return `M${row.match.id}:${row.match.via}:${err}`;
    return `N${err}`;
  }).join('|');
}

function filled(value) {
  return value != null && String(value).trim() !== '';
}

function resolveInactiveReason(existing, value) {
  const status = value.status || (existing && existing.status) || 'active';
  if (status !== 'inactive') return null;
  if (value.inactive_reason) return value.inactive_reason;
  if (value.status === 'inactive') return null;
  return (existing && existing.inactive_reason) || null;
}

function valuesForInsert(value) {
  const status = value.status || 'active';
  return {
    type: value.type,
    number: value.number,
    description: value.description || '',
    vin: value.vin || '',
    year: value.year || '',
    make: value.make || '',
    model: value.model || '',
    status,
    inactive_reason: status === 'inactive' ? (value.inactive_reason || null) : null,
    ownership: value.ownership || '',
    registration_expiration: value.registration_expiration || null,
    inspection_expiration: value.inspection_expiration || null,
    maintenance_status: value.maintenance_status || 'active',
    plate_number: value.plate_number || null,
    plate_state: value.plate_state || 'VA'
  };
}

function valuesForUpdate(existing, value) {
  const keep = (next, prev) => (filled(next) ? next : (prev || ''));
  return {
    type: value.type || existing.type,
    number: value.number || existing.number,
    description: keep(value.description, existing.description),
    vin: keep(value.vin, existing.vin),
    year: keep(value.year, existing.year),
    make: keep(value.make, existing.make),
    model: keep(value.model, existing.model),
    status: value.status || existing.status || 'active',
    inactive_reason: resolveInactiveReason(existing, value),
    ownership: keep(value.ownership, existing.ownership),
    registration_expiration: value.registration_expiration || existing.registration_expiration || null,
    inspection_expiration: value.inspection_expiration || existing.inspection_expiration || null,
    maintenance_status: value.maintenance_status || existing.maintenance_status || 'active',
    plate_number: value.plate_number || existing.plate_number || null,
    plate_state: value.plate_state || existing.plate_state || 'VA'
  };
}

const WRITE_COLUMNS = [
  'type', 'number', 'description', 'vin', 'year', 'make', 'model', 'status', 'inactive_reason', 'ownership',
  'registration_expiration', 'inspection_expiration', 'maintenance_status', 'plate_number', 'plate_state'
];

function operationsFromDecisions(rows, decisions) {
  const ops = [];
  (rows || []).forEach((row, index) => {
    if (row.errors.length) return;
    const action = String((decisions && decisions[index]) || 'skip');
    if (row.match && !row.match.ambiguous) {
      if (action === 'update') ops.push({ kind: 'update', id: row.match.id, value: row.value, source: row.source });
      return;
    }
    if (!row.match && action === 'import') ops.push({ kind: 'insert', value: row.value, source: row.source });
  });
  return ops;
}

function applyImport(db, options) {
  const opts = options || {};
  const operations = opts.operations || [];
  const actor = opts.actor || {};
  const insert = db.prepare(`INSERT INTO equipment (${WRITE_COLUMNS.join(', ')}) VALUES (${WRITE_COLUMNS.map(() => '?').join(', ')})`);
  const update = db.prepare(`UPDATE equipment SET ${WRITE_COLUMNS.map((col) => `${col} = ?`).join(', ')} WHERE id = ?`);
  const get = db.prepare('SELECT * FROM equipment WHERE id = ?');
  const audit = db.prepare(`
    INSERT INTO audit_log (actor_id, actor_name, action, entity_type, entity_id, detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const actorId = actor.id != null ? actor.id : null;
  const actorName = actor.name || 'Unknown';
  const run = db.transaction((ops) => {
    const created = [];
    const updated = [];
    ops.forEach((op) => {
      if (op.kind === 'insert') {
        const value = valuesForInsert(op.value);
        const info = insert.run(...WRITE_COLUMNS.map((col) => value[col]));
        const id = Number(info.lastInsertRowid);
        audit.run(actorId, actorName, 'equipment_import_created', 'equipment', id, `Created ${value.type} ${value.number} from ${place(op.source)}.`);
        created.push(id);
        return;
      }
      if (op.kind === 'update') {
        const existing = get.get(op.id);
        if (!existing) throw new Error(`Equipment ${op.id} is no longer in the database.`);
        const value = valuesForUpdate(existing, op.value);
        update.run(...WRITE_COLUMNS.map((col) => value[col]), op.id);
        audit.run(actorId, actorName, 'equipment_import_updated', 'equipment', Number(op.id), `Updated ${value.type} ${value.number} from ${place(op.source)}.`);
        updated.push(Number(op.id));
        return;
      }
      throw new Error('Unknown import operation.');
    });
    const file = opts.filename ? ` of "${opts.filename}"` : '';
    const skipped = opts.skipped == null ? '' : `, skipped ${opts.skipped}`;
    audit.run(actorId, actorName, 'equipment_import', 'equipment', null, `Equipment import${file}: created ${created.length}, updated ${updated.length}${skipped}.`);
    return { created, updated };
  });
  return run(operations);
}

function summarize(rows) {
  const counts = { total: (rows || []).length, ready: 0, warnings: 0, errors: 0, matches: 0 };
  (rows || []).forEach((row) => {
    if (row.errors.length) counts.errors += 1;
    else if (row.match && !row.match.ambiguous) counts.matches += 1;
    else if (row.warnings.length) counts.warnings += 1;
    else counts.ready += 1;
  });
  return counts;
}

function outcome(row) {
  if (row.errors.length) return 'fail';
  if ((row.warnings && row.warnings.length) || (row.match && !row.match.ambiguous)) return 'warn';
  return 'pass';
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function templateCsv() {
  const truckVin = makeVin('1FUJTEST0A123456');
  const trailerVin = makeVin('1T9TEST0B1234567');
  const hotshotVin = makeVin('1FTTEST0C1234567');
  const rows = [
    TEMPLATE_HEADERS,
    ['truck', '1001', truckVin, '2013', 'Freightliner', 'Cascadia', 'Example tractor', 'Owned', '2027-07-31', '2027-06-30', 'active', 'active', 'ABC1234', 'VA', ''],
    ['trailer', 'T-1', trailerVin, '1998', 'Example', 'Dump', 'Example trailer', 'Leased', '2027-12-31', '', 'active', 'active', '', 'WV', ''],
    ['hotshot', '1006', hotshotVin, '2026', 'Ford', 'F350', 'Leased hotshot', 'Leased', '', '', 'active', 'active', '', 'VA', '']
  ];
  return rows.map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

module.exports = {
  mapHeaders,
  parseDate,
  parseUpload,
  annotateExisting,
  matchStamp,
  operationsFromDecisions,
  applyImport,
  valuesForInsert,
  valuesForUpdate,
  summarize,
  outcome,
  templateCsv,
  makeVin,
  vinCheckDigit,
  isoToExcelSerial,
  normalizeUnitKey,
  sheetSkipped
};
