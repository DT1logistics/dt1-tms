// Equipment type and fleet status. Trucks and trailers stay as they are.
// Hotshot is a power unit (assigned on a load the same way as a truck).
// Out of service stays on maintenance_status. Sold and total loss are inactive reasons.
'use strict';

const POWER_UNIT_TYPES = ['truck', 'hotshot'];
const EQUIPMENT_TYPES = ['truck', 'trailer', 'hotshot'];
const INACTIVE_REASONS = ['sold', 'total_loss', 'other'];

const COPY_COLUMNS = [
  'id', 'type', 'number', 'description', 'vin', 'year', 'make', 'model', 'status', 'ownership',
  'registration_expiration', 'inspection_expiration', 'maintenance_status', 'plate_number', 'plate_state',
  'inactive_reason', 'created_at'
];

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function equipmentTypeLabel(type) {
  if (type === 'trailer') return 'Trailer';
  if (type === 'hotshot') return 'Hotshot';
  return 'Truck';
}

function isPowerUnit(type) {
  return POWER_UNIT_TYPES.includes(type);
}

function equipmentStatusLabel(item) {
  if (!item || item.status !== 'inactive') return 'Active';
  if (item.inactive_reason === 'sold') return 'Inactive (Sold)';
  if (item.inactive_reason === 'total_loss') return 'Inactive (Total loss)';
  if (item.inactive_reason === 'other') return 'Inactive (Other)';
  return 'Inactive';
}

// One badge for fleet status, plus maintenance when it is not the normal active state.
// An inactive unit does not also get a green Active badge. Out of service stays visible.
function equipmentBadges(item) {
  const badges = [];
  if (item && item.status === 'inactive') {
    badges.push({ className: 'red', label: equipmentStatusLabel(item) });
  }
  if (item && item.maintenance_status === 'out_of_service') {
    badges.push({ className: 'red', label: 'Out of service' });
  } else if (item && item.maintenance_status === 'maintenance') {
    badges.push({ className: 'yellow', label: 'In maintenance' });
  } else if (!item || item.status !== 'inactive') {
    badges.push({ className: 'green', label: 'Active' });
  }
  return badges;
}

function equipmentPowerLabel(item) {
  if (!item) return '';
  const number = item.number || 'Unnumbered';
  const prefix = item.type === 'hotshot' ? 'Hotshot ' : '';
  const flags = [];
  if (item.status === 'inactive') flags.push(equipmentStatusLabel(item));
  if (item.maintenance_status === 'out_of_service') flags.push('Out of service');
  else if (item.maintenance_status === 'maintenance') flags.push('In maintenance');
  let text = prefix + number;
  if (flags.length) text += ` (${flags.join('; ')})`;
  if (item.description) text += ` — ${item.description}`;
  return text;
}

function equipmentChoiceLabel(item) {
  if (!item) return '';
  let text = `${equipmentTypeLabel(item.type)} ${item.number || 'Unnumbered'}`;
  if (item.status === 'inactive') text += ` — ${equipmentStatusLabel(item)}`;
  if (item.maintenance_status === 'out_of_service') text += ' — Out of service';
  else if (item.maintenance_status === 'maintenance') text += ' — In maintenance';
  return text;
}

function loadTruckNumber(item) {
  if (!item) return '';
  const raw = item.number != null && String(item.number).trim() !== '' ? item.number : item.truck_number;
  return String(raw == null ? '' : raw).trim();
}

function loadTruckField(item, direct, fromLoad) {
  if (!item) return '';
  if (item[direct] != null && String(item[direct]).trim() !== '') return String(item[direct]).trim();
  if (item[fromLoad] != null) return String(item[fromLoad]).trim();
  return '';
}

// Load screens only. Fleet pages keep equipmentPowerLabel.
// A Hotshot whose make/model is Ford F350, or unit 1006 when that data is missing,
// shows the hotshot suffix. Every other power unit is Truck #<number>.
function loadTruckLabel(item) {
  const number = loadTruckNumber(item);
  if (!number) return '';
  const type = loadTruckField(item, 'type', 'truck_type').toLowerCase();
  const make = loadTruckField(item, 'make', 'truck_make').toLowerCase();
  const model = loadTruckField(item, 'model', 'truck_model').toLowerCase().replace(/[\s-]+/g, '');
  const fordHotshot = type === 'hotshot' && make === 'ford' && model === 'f350';
  if (number === '1006' || fordHotshot) return `Truck #${number} - Ford F350/Hotshot`;
  return `Truck #${number}`;
}

// Inactive, sold, and total loss are status = 'inactive' and are not offered for a new load.
// Out of service stays assignable; the load form flags it.
function isAssignablePowerUnit(item) {
  if (!item || !isPowerUnit(item.type)) return false;
  return item.status == null || item.status === '' || item.status === 'active';
}

function loadPowerUnits(db, load) {
  const units = db.prepare(`
    SELECT id, number, description, status, type, make, model, maintenance_status, inactive_reason
    FROM equipment
    WHERE type IN ('truck', 'hotshot')
      AND (status IS NULL OR status = 'active')
    ORDER BY CASE type WHEN 'hotshot' THEN 1 ELSE 0 END, number
  `).all();
  if (load && load.truck_id != null && !units.some((unit) => String(unit.id) === String(load.truck_id))) {
    const current = db.prepare(`
      SELECT id, number, description, status, type, make, model, maintenance_status, inactive_reason
      FROM equipment
      WHERE id = ? AND type IN ('truck', 'hotshot')
    `).get(load.truck_id);
    if (current) units.unshift(current);
  }
  return units;
}

function resolveAssignedTruckId(db, rawId, existingTruckId) {
  if (rawId == null || String(rawId).trim() === '') return null;
  const parsed = parseInt(rawId, 10);
  if (!Number.isInteger(parsed)) return null;
  const row = db.prepare(`
    SELECT id, type, status, inactive_reason, maintenance_status
    FROM equipment WHERE id = ?
  `).get(parsed);
  if (!isPowerUnit(row && row.type)) return null;
  const keepingCurrent = existingTruckId != null && String(row.id) === String(existingTruckId);
  if (!isAssignablePowerUnit(row) && !keepingCurrent) return null;
  return row.id;
}

function normalizeInactiveReason(value) {
  return INACTIVE_REASONS.includes(value) ? value : null;
}

// Widen the type check (SQLite cannot ALTER a CHECK) and add inactive_reason.
// Every existing column is copied. Rows, ids, and child foreign keys stay put.
function ensureEquipmentSchema(db) {
  const master = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'equipment'").get();
  if (!master) return;
  const info = db.prepare('PRAGMA table_info(equipment)').all();
  const names = new Set(info.map((col) => col.name));
  const createSql = master.sql || '';
  if (/hotshot/i.test(createSql)) {
    if (!names.has('inactive_reason')) db.exec('ALTER TABLE equipment ADD COLUMN inactive_reason TEXT');
    return;
  }

  const foreignKeys = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    const rebuild = db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS equipment__new');
      const extras = info.filter((col) => !COPY_COLUMNS.includes(col.name));
      const extraSql = extras.map((col) => {
        let def = `${quoteIdent(col.name)} ${col.type || 'TEXT'}`;
        if (col.notnull) def += ' NOT NULL';
        if (col.dflt_value != null) def += ` DEFAULT ${col.dflt_value}`;
        return def;
      }).join(',\n');
      db.exec(`
        CREATE TABLE equipment__new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT CHECK(type IN ('truck', 'trailer', 'hotshot')),
          number TEXT,
          description TEXT,
          vin TEXT,
          year TEXT,
          make TEXT,
          model TEXT,
          status TEXT DEFAULT 'active',
          ownership TEXT,
          registration_expiration DATE,
          inspection_expiration DATE,
          maintenance_status TEXT DEFAULT 'active',
          plate_number TEXT,
          plate_state TEXT DEFAULT 'VA',
          inactive_reason TEXT CHECK (inactive_reason IS NULL OR inactive_reason IN ('sold', 'total_loss', 'other')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP${extraSql ? ',\n' + extraSql : ''}
        )
      `);
      const copy = COPY_COLUMNS.filter((name) => names.has(name)).concat(extras.map((col) => col.name));
      const quoted = copy.map(quoteIdent);
      db.exec(`INSERT INTO equipment__new (${quoted.join(', ')}) SELECT ${quoted.join(', ')} FROM equipment`);
      const maxId = Number((db.prepare('SELECT MAX(id) AS n FROM equipment').get() || {}).n) || 0;
      db.exec('DROP TABLE equipment');
      db.exec('ALTER TABLE equipment__new RENAME TO equipment');
      db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('equipment', 'equipment__new')").run();
      if (maxId > 0) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('equipment', ?)").run(maxId);
    });
    rebuild();
  } finally {
    db.pragma(foreignKeys ? 'foreign_keys = ON' : 'foreign_keys = OFF');
  }
}

module.exports = {
  POWER_UNIT_TYPES,
  EQUIPMENT_TYPES,
  INACTIVE_REASONS,
  equipmentTypeLabel,
  isPowerUnit,
  equipmentStatusLabel,
  equipmentBadges,
  equipmentPowerLabel,
  equipmentChoiceLabel,
  loadTruckLabel,
  isAssignablePowerUnit,
  loadPowerUnits,
  resolveAssignedTruckId,
  normalizeInactiveReason,
  ensureEquipmentSchema
};
