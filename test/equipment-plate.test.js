// Run: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const plate = require('../lib/equipment-plate');

function check(name, fn) { fn(); console.log('ok -', name); }

check('normalize plate number: uppercase and strip spaces', () => {
  assert.strictEqual(plate.normalizePlateNumber('UN 16065'), 'UN16065');
  assert.strictEqual(plate.normalizePlateNumber(' un\t16065 '), 'UN16065');
  assert.strictEqual(plate.normalizePlateNumber('va-ab 12'), 'VA-AB12');
  assert.strictEqual(plate.normalizePlateNumber(''), null);
  assert.strictEqual(plate.normalizePlateNumber(null), null);
  assert.strictEqual(plate.normalizePlateNumber('   '), null);
});

check('normalize plate state: default VA, uppercase, reject unknown codes', () => {
  assert.deepStrictEqual(plate.normalizePlateState(''), { value: 'VA', error: null });
  assert.deepStrictEqual(plate.normalizePlateState(null), { value: 'VA', error: null });
  assert.deepStrictEqual(plate.normalizePlateState('va'), { value: 'VA', error: null });
  assert.deepStrictEqual(plate.normalizePlateState('nc'), { value: 'NC', error: null });
  const bad = plate.normalizePlateState('ZZ');
  assert.strictEqual(bad.value, null);
  assert.ok(bad.error);
  assert.strictEqual(plate.US_STATES.length, 50);
  assert.ok(plate.US_STATES.some((pair) => pair[0] === 'VA'));
});

check('format plate as STATE-NUMBER', () => {
  assert.strictEqual(plate.formatPlate({ plate_state: 'VA', plate_number: 'UN 16065' }), 'VA-UN16065');
  assert.strictEqual(plate.formatPlate({ plate_state: '', plate_number: 'ab12' }), 'VA-AB12');
  assert.strictEqual(plate.formatPlate({ plate_number: '' }), '');
  assert.strictEqual(plate.formatPlate(null), '');
});

check('migration adds plate columns once and keeps existing rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt1-plate-'));
  const db = new Database(path.join(dir, 't.db'));
  db.exec('CREATE TABLE equipment (id INTEGER PRIMARY KEY, number TEXT, vin TEXT)');
  db.prepare('INSERT INTO equipment (number, vin) VALUES (?, ?)').run('#1001', '1HGBH41JXMN109186');
  plate.ensurePlateColumns(db);
  plate.ensurePlateColumns(db);
  const names = db.prepare('PRAGMA table_info(equipment)').all().map((col) => col.name);
  assert.ok(names.includes('plate_number'));
  assert.ok(names.includes('plate_state'));
  assert.strictEqual(names.filter((name) => name === 'plate_number').length, 1);
  const kept = db.prepare('SELECT number, vin, plate_number FROM equipment WHERE id = 1').get();
  assert.strictEqual(kept.number, '#1001');
  assert.strictEqual(kept.vin, '1HGBH41JXMN109186');
  assert.strictEqual(kept.plate_number, null);

  const state = plate.normalizePlateState('va');
  const number = plate.normalizePlateNumber('UN 16065');
  assert.strictEqual(state.error, null);
  db.prepare('UPDATE equipment SET plate_number = ?, plate_state = ? WHERE id = 1').run(number, state.value);
  const saved = db.prepare('SELECT plate_number, plate_state FROM equipment WHERE id = 1').get();
  assert.deepStrictEqual(saved, { plate_number: 'UN16065', plate_state: 'VA' });
  assert.strictEqual(plate.formatPlate(saved), 'VA-UN16065');
  db.close();
});

console.log('All equipment plate tests passed.');
