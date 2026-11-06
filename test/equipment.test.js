// Run: npm test
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const equipment = require('../lib/equipment');

function check(name, fn) {
  fn();
  console.log('ok -', name);
}

function oldDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT CHECK(type IN ('truck', 'trailer')),
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      legacy_note TEXT
    );
    CREATE TABLE equipment_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      FOREIGN KEY (equipment_id) REFERENCES equipment(id)
    );
  `);
  return db;
}

check('labels distinguish hotshot, sold, total loss, and out of service', () => {
  assert.strictEqual(equipment.equipmentTypeLabel('truck'), 'Truck');
  assert.strictEqual(equipment.equipmentTypeLabel('trailer'), 'Trailer');
  assert.strictEqual(equipment.equipmentTypeLabel('hotshot'), 'Hotshot');
  assert.strictEqual(equipment.equipmentStatusLabel({ status: 'active' }), 'Active');
  assert.strictEqual(equipment.equipmentStatusLabel({ status: 'inactive' }), 'Inactive');
  assert.strictEqual(equipment.equipmentStatusLabel({ status: 'inactive', inactive_reason: 'sold' }), 'Inactive (Sold)');
  assert.strictEqual(equipment.equipmentStatusLabel({ status: 'inactive', inactive_reason: 'total_loss' }), 'Inactive (Total loss)');
  assert.strictEqual(equipment.equipmentStatusLabel({ status: 'inactive', inactive_reason: 'other' }), 'Inactive (Other)');
  assert.deepStrictEqual(
    equipment.equipmentBadges({ status: 'active', maintenance_status: 'out_of_service' }).map((badge) => badge.label),
    ['Out of service']
  );
  assert.deepStrictEqual(
    equipment.equipmentBadges({ status: 'inactive', inactive_reason: 'sold', maintenance_status: 'out_of_service' }).map((badge) => badge.label),
    ['Inactive (Sold)', 'Out of service']
  );
  assert.deepStrictEqual(
    equipment.equipmentBadges({ status: 'active', maintenance_status: 'active' }).map((badge) => badge.label),
    ['Active']
  );
  assert.strictEqual(equipment.equipmentPowerLabel({ type: 'truck', number: '1001', description: 'Cascadia' }), '1001 — Cascadia');
  assert.strictEqual(
    equipment.equipmentPowerLabel({ type: 'hotshot', number: '1006', description: 'Ford F350', maintenance_status: 'active', status: 'active' }),
    'Hotshot 1006 — Ford F350'
  );
  assert.strictEqual(
    equipment.equipmentPowerLabel({ type: 'truck', number: '1003', maintenance_status: 'out_of_service', status: 'active' }),
    '1003 (Out of service)'
  );
  assert.strictEqual(
    equipment.equipmentChoiceLabel({ type: 'hotshot', number: '1006', status: 'active', maintenance_status: 'active' }),
    'Hotshot 1006'
  );
});

check('load screens label trucks as Truck #unit, with the Ford F350 hotshot suffix', () => {
  assert.strictEqual(equipment.loadTruckLabel({ type: 'truck', number: '1001', description: 'Cascadia' }), 'Truck #1001');
  assert.strictEqual(equipment.loadTruckLabel({ type: 'truck', number: '1003', maintenance_status: 'out_of_service' }), 'Truck #1003');
  assert.strictEqual(
    equipment.loadTruckLabel({ type: 'hotshot', number: '1006', make: 'Ford', model: 'F350', description: 'Ford F350' }),
    'Truck #1006 - Ford F350/Hotshot'
  );
  assert.strictEqual(
    equipment.loadTruckLabel({ type: 'hotshot', number: '1006', make: 'ford', model: 'F-350' }),
    'Truck #1006 - Ford F350/Hotshot'
  );
  assert.strictEqual(equipment.loadTruckLabel({ type: 'hotshot', number: '1006' }), 'Truck #1006 - Ford F350/Hotshot');
  assert.strictEqual(
    equipment.loadTruckLabel({ truck_number: '1006', truck_type: 'hotshot', truck_make: 'Ford', truck_model: 'F350' }),
    'Truck #1006 - Ford F350/Hotshot'
  );
  assert.strictEqual(
    equipment.loadTruckLabel({ type: 'hotshot', number: '1008', make: 'Ford', model: 'F350' }),
    'Truck #1008 - Ford F350/Hotshot'
  );
  assert.strictEqual(equipment.loadTruckLabel({ type: 'hotshot', number: '1004', make: 'Ram', model: '2500' }), 'Truck #1004');
  assert.strictEqual(equipment.loadTruckLabel(null), '');
  assert.strictEqual(equipment.loadTruckLabel({ type: 'truck', make: 'Ford', model: 'F350' }), '');
  const row = { type: 'hotshot', number: '1006', make: 'Ford', model: 'F350' };
  equipment.loadTruckLabel(row);
  assert.deepStrictEqual(row, { type: 'hotshot', number: '1006', make: 'Ford', model: 'F350' });
  assert.strictEqual(
    equipment.equipmentPowerLabel({ type: 'hotshot', number: '1006', description: 'Ford F350' }),
    'Hotshot 1006 — Ford F350'
  );
});

check('new loads can use an active hotshot or out-of-service truck, not sold or total loss', () => {
  const db = oldDatabase();
  const insert = db.prepare(`INSERT INTO equipment (type, number, status, maintenance_status, description) VALUES (?, ?, ?, ?, ?)`);
  insert.run('truck', '1001', 'active', 'active', 'Tractor');
  insert.run('truck', '1002', 'inactive', 'active', 'Total loss');
  db.prepare('UPDATE equipment SET legacy_note = ? WHERE number = ?').run('keep me', '1002');
  insert.run('truck', '1003', 'active', 'out_of_service', 'Down');
  assert.throws(() => insert.run('hotshot', '1006', 'active', 'active', 'F350'));
  insert.run('trailer', 'T-1', 'active', 'active', 'Dump');
  insert.run('truck', '1004', 'active', 'active', 'Sale pending');
  const lossId = db.prepare("SELECT id FROM equipment WHERE number = '1002'").get().id;
  db.prepare(`UPDATE equipment SET status = 'inactive' WHERE id = ?`).run(lossId);
  db.prepare('INSERT INTO equipment_expenses (equipment_id, description) VALUES (?, ?)').run(lossId, 'brake job');
  const before = db.prepare('SELECT id, type, number, status, maintenance_status, description, legacy_note, created_at FROM equipment ORDER BY id').all();
  const createdAt = before[1].created_at;

  equipment.ensureEquipmentSchema(db);
  equipment.ensureEquipmentSchema(db);

  const after = db.prepare('SELECT id, type, number, status, maintenance_status, description, legacy_note, created_at, inactive_reason, vin FROM equipment ORDER BY id').all();
  assert.strictEqual(after.length, before.length);
  after.forEach((row, index) => {
    assert.strictEqual(row.id, before[index].id);
    assert.strictEqual(row.type, before[index].type);
    assert.strictEqual(row.number, before[index].number);
    assert.strictEqual(row.status, before[index].status);
    assert.strictEqual(row.maintenance_status, before[index].maintenance_status);
    assert.strictEqual(row.description, before[index].description);
    assert.strictEqual(row.created_at, before[index].created_at);
    assert.strictEqual(row.inactive_reason, null);
  });
  assert.strictEqual(after[1].legacy_note, 'keep me');
  assert.strictEqual(after[1].created_at, createdAt);
  assert.strictEqual(db.prepare('SELECT description FROM equipment_expenses WHERE equipment_id = ?').get(lossId).description, 'brake job');
  assert.strictEqual(db.pragma('foreign_key_check').length, 0);
  assert.strictEqual(db.pragma('foreign_keys', { simple: true }), 1);

  const hotshot = db.prepare(`INSERT INTO equipment (type, number, status) VALUES ('hotshot', '1006', 'active')`).run();
  const sold = db.prepare(`INSERT INTO equipment (type, number, status, inactive_reason) VALUES ('truck', '1008', 'inactive', 'sold')`).run();
  const total = db.prepare(`INSERT INTO equipment (type, number, status, inactive_reason) VALUES ('truck', '1009', 'inactive', 'total_loss')`).run();
  const other = db.prepare(`INSERT INTO equipment (type, number, status, inactive_reason) VALUES ('trailer', 'T-9', 'inactive', 'other')`).run();
  assert.throws(() => db.prepare(`INSERT INTO equipment (type, number) VALUES ('boat', 'x')`).run());
  assert.throws(() => db.prepare(`INSERT INTO equipment (type, number, status, inactive_reason) VALUES ('truck', 'bad', 'inactive', 'nope')`).run());
  const next = db.prepare(`INSERT INTO equipment (type, number) VALUES ('truck', '1010')`).run();
  assert.strictEqual(Number(next.lastInsertRowid), Number(other.lastInsertRowid) + 1);

  db.prepare(`UPDATE equipment SET inactive_reason = 'total_loss' WHERE id = ?`).run(lossId);
  const units = equipment.loadPowerUnits(db, null).map((row) => row.number);
  assert.deepStrictEqual(units, ['1001', '1003', '1004', '1010', '1006']);
  assert.ok(!units.includes('1002'));
  assert.ok(!units.includes('1008'));
  assert.ok(!units.includes('1009'));
  assert.ok(!units.includes('T-1'));
  assert.ok(!units.includes('T-9'));

  const kept = equipment.loadPowerUnits(db, { truck_id: lossId });
  assert.strictEqual(kept[0].id, lossId);
  assert.strictEqual(equipment.equipmentPowerLabel(kept[0]), '1002 (Inactive (Total loss)) — Total loss');

  assert.strictEqual(equipment.resolveAssignedTruckId(db, hotshot.lastInsertRowid, null), Number(hotshot.lastInsertRowid));
  assert.strictEqual(equipment.resolveAssignedTruckId(db, sold.lastInsertRowid, null), null);
  assert.strictEqual(equipment.resolveAssignedTruckId(db, total.lastInsertRowid, null), null);
  assert.strictEqual(equipment.resolveAssignedTruckId(db, lossId, null), null);
  assert.strictEqual(equipment.resolveAssignedTruckId(db, lossId, lossId), lossId);
  const oos = db.prepare("SELECT id FROM equipment WHERE number = '1003'").get().id;
  assert.strictEqual(equipment.resolveAssignedTruckId(db, oos, null), oos);
  const trailer = db.prepare("SELECT id FROM equipment WHERE number = 'T-1'").get().id;
  assert.strictEqual(equipment.resolveAssignedTruckId(db, trailer, null), null);
  assert.strictEqual(equipment.isAssignablePowerUnit({ type: 'hotshot', status: 'active', maintenance_status: 'out_of_service' }), true);
  assert.strictEqual(equipment.isAssignablePowerUnit({ type: 'truck', status: 'inactive', inactive_reason: 'sold' }), false);
  db.close();
});

check('a database created with hotshot already allowed is left in place', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT CHECK(type IN ('truck', 'trailer', 'hotshot')),
      number TEXT,
      status TEXT DEFAULT 'active',
      inactive_reason TEXT,
      created_at DATETIME DEFAULT '2001-01-01'
    );
  `);
  db.prepare(`INSERT INTO equipment (type, number, status, inactive_reason, created_at) VALUES ('truck', '1001', 'inactive', NULL, '2001-02-03')`).run();
  equipment.ensureEquipmentSchema(db);
  const row = db.prepare('SELECT number, status, inactive_reason, created_at FROM equipment').get();
  assert.deepStrictEqual(row, { number: '1001', status: 'inactive', inactive_reason: null, created_at: '2001-02-03' });
  assert.ok(/hotshot/i.test(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'equipment'").get().sql));
  db.close();
});

check('equipment screens and import call the new type and status', () => {
  const root = path.join(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(server.includes('equipment.ensureEquipmentSchema(db)'));
  assert.ok(server.includes("CHECK(type IN ('truck', 'trailer', 'hotshot'))"));
  assert.ok(server.includes('equipment.loadPowerUnits(db, load)'));
  assert.ok(server.includes('equipment.resolveAssignedTruckId'));
  const form = fs.readFileSync(path.join(root, 'views', 'equipment-form.ejs'), 'utf8');
  assert.ok(form.includes('value="hotshot"'));
  assert.ok(form.includes('value="total_loss"'));
  assert.ok(form.includes('value="sold"'));
  const list = fs.readFileSync(path.join(root, 'views', 'equipment.ejs'), 'utf8');
  assert.ok(list.includes('Hotshots'));
  assert.ok(!server.includes("type = 'truck' AND"));
});

console.log('All equipment tests passed.');
