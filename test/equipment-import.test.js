// Run: npm test
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const imp = require('../lib/equipment-import');
const sample = require('./fixtures/sample-equipment-workbook');

function check(name, fn) {
  fn();
  console.log('ok -', name);
}

function memoryDb() {
  const db = new Database(':memory:');
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
      plate_state TEXT DEFAULT 'VA'
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER,
      actor_name TEXT,
      action TEXT,
      entity_type TEXT,
      entity_id INTEGER,
      detail TEXT
    );
  `);
  return db;
}

function rowValue(overrides) {
  return Object.assign({
    type: 'truck',
    number: '9001',
    description: '',
    vin: imp.makeVin('1FUJTEST0A123456'),
    year: '2010',
    make: 'Sample',
    model: 'Alpha',
    status: 'active',
    ownership: 'Owned',
    registration_expiration: null,
    inspection_expiration: null,
    maintenance_status: 'active',
    plate_number: null,
    plate_state: null
  }, overrides);
}

check('header aliases cover the equipment form labels and common variations', () => {
  const headers = [
    'Type', 'Equipment Number / Identifier', 'VIN#', 'Year', 'Make', 'Model', 'Description', 'Ownership',
    'Registration Expiration Date', 'Annual DOT Periodic Inspection Date', 'Status', 'Maintenance Status',
    'Source document', 'Confidence/Missing'
  ];
  const mapped = imp.mapHeaders(headers);
  assert.deepStrictEqual(mapped.fields, {
    type: 0, number: 1, vin: 2, year: 3, make: 4, model: 5, description: 6, ownership: 7,
    registration_expiration: 8, inspection_expiration: 9, status: 10, maintenance_status: 11
  });
  assert.deepStrictEqual(mapped.ignored, ['Source document', 'Confidence/Missing']);

  const varied = imp.mapHeaders(['Unit #', 'VIN Number', 'Equip Type', 'Reg Exp', 'DOT Inspection', 'License Plate', 'License State', 'Maint. Status']);
  assert.strictEqual(varied.fields.number, 0);
  assert.strictEqual(varied.fields.vin, 1);
  assert.strictEqual(varied.fields.type, 2);
  assert.strictEqual(varied.fields.registration_expiration, 3);
  assert.strictEqual(varied.fields.inspection_expiration, 4);
  assert.strictEqual(varied.fields.plate_number, 5);
  assert.strictEqual(varied.fields.plate_state, 6);
  assert.strictEqual(varied.fields.maintenance_status, 7);
});

check('dates: ISO, US formats, month names, Excel serials, and blanks', () => {
  assert.strictEqual(imp.parseDate('2026-07-31').value, '2026-07-31');
  assert.strictEqual(imp.parseDate('7/31/2026').value, '2026-07-31');
  assert.strictEqual(imp.parseDate('07-31-2026').value, '2026-07-31');
  assert.strictEqual(imp.parseDate('07/31/26').value, '2026-07-31');
  assert.strictEqual(imp.parseDate('July 31, 2026').value, '2026-07-31');
  assert.strictEqual(imp.parseDate('31-Jul-2026').value, '2026-07-31');
  assert.strictEqual(imp.parseDate('2026-07-31T00:00:00.000Z').value, '2026-07-31');
  assert.strictEqual(imp.parseDate(imp.isoToExcelSerial('2028-05-31')).value, '2028-05-31');
  assert.strictEqual(imp.parseDate(String(imp.isoToExcelSerial('2028-05-31'))).value, '2028-05-31');
  assert.strictEqual(imp.parseDate(new Date(Date.UTC(2026, 6, 31))).value, '2026-07-31');
  assert.strictEqual(imp.parseDate('').value, null);
  assert.strictEqual(imp.parseDate('None').value, null);
  assert.strictEqual(imp.parseDate('N/A').value, null);
  assert.strictEqual(imp.parseDate('2026-02-31').ok, false);
  assert.strictEqual(imp.parseDate('02/31/2026').ok, false);
  assert.strictEqual(imp.parseDate('yesterday').ok, false);
  assert.strictEqual(imp.parseDate(2026).ok, false);
});

check('VIN check digit accepts a computed VIN and flags length, letters, and the check digit', () => {
  const vin = imp.makeVin('1FUJTEST0A123456');
  assert.strictEqual(vin.length, 17);
  assert.strictEqual(vin[8], imp.vinCheckDigit(vin));
  const csv = `Type,Equipment Number,VIN\ntruck,1,${vin}\ntruck,2,${vin.slice(0, 16)}\ntruck,3,${vin.slice(0, 8)}I${vin.slice(9)}\ntruck,4,\n`;
  const parsed = imp.parseUpload(Buffer.from(csv), 'units.csv');
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.rows[0].warnings.length, 0);
  assert.ok(parsed.rows[1].warnings.some((w) => w.includes('17-character')));
  assert.ok(parsed.rows[2].warnings.some((w) => w.includes('17-character')));
  assert.ok(parsed.rows[3].warnings.some((w) => w === 'VIN is missing.'));
  const flipped = vin.slice(0, 16) + (vin[16] === '1' ? '2' : '1');
  const bad = imp.parseUpload(Buffer.from(`Type,Equipment Number,VIN\ntruck,9,${flipped}\n`), 'bad.csv');
  assert.ok(bad.rows[0].warnings.some((w) => w.includes('check digit')));
  assert.strictEqual(bad.rows[0].errors.length, 0);
});

check('sanitized workbook parses the truck and trailer sheets and skips reference data', () => {
  const buffer = sample.buildSampleWorkbook();
  const fixturePath = path.join(__dirname, 'fixtures', 'equipment-import-sample.xlsx');
  fs.writeFileSync(fixturePath, buffer);
  const parsed = imp.parseUpload(fs.readFileSync(fixturePath), 'equipment-import-sample.xlsx');
  assert.strictEqual(parsed.ok, true);
  assert.deepStrictEqual(parsed.skippedSheets, ['Reference (not TMS fields)', 'Notes']);
  assert.ok(parsed.ignoredHeaders.includes('Source document'));
  assert.ok(!parsed.rows.some((row) => row.value.number === 'SOLD-1'));

  const byKey = (sheet, row) => parsed.rows.find((item) => item.source.sheet === sheet && item.source.row === row);
  const pass9002 = byKey('Trucks', 3);
  assert.strictEqual(imp.outcome(pass9002), 'pass');
  assert.strictEqual(pass9002.value.maintenance_status, 'out_of_service');
  assert.strictEqual(pass9002.value.registration_expiration, '2027-07-31');
  assert.strictEqual(pass9002.value.inspection_expiration, '2027-06-30');

  const serialRow = byKey('Trucks', 4);
  assert.strictEqual(serialRow.value.registration_expiration, '2028-05-31');
  assert.strictEqual(serialRow.value.plate_state, 'VA');
  assert.strictEqual(serialRow.value.plate_number, 'XY99');
  assert.strictEqual(serialRow.value.year, '2012');

  const blankStatus = byKey('Trucks', 5);
  assert.strictEqual(blankStatus.value.status, null);
  assert.strictEqual(imp.valuesForInsert(blankStatus.value).status, 'active');

  const noVin = byKey('Trucks', 6);
  assert.strictEqual(imp.outcome(noVin), 'warn');
  assert.ok(noVin.warnings.some((w) => w === 'VIN is missing.'));
  assert.strictEqual(noVin.value.number, '9006');
  assert.strictEqual(noVin.value.model, 'F350');

  const noNumber = byKey('Trucks', 7);
  assert.strictEqual(imp.outcome(noNumber), 'fail');
  assert.ok(noNumber.errors.includes('Unit number is required.'));

  const dupA = byKey('Trucks', 2);
  const dupB = byKey('Trucks', 8);
  assert.ok(dupA.warnings.some((w) => w.includes('also on Trucks row 8')));
  assert.ok(dupB.warnings.some((w) => w.includes('also on Trucks row 2')));

  const badDigit = byKey('Trucks', 9);
  assert.strictEqual(imp.outcome(badDigit), 'warn');
  assert.ok(badDigit.warnings.some((w) => w.includes('check digit')));

  const badType = byKey('Trucks', 10);
  assert.ok(badType.errors.some((e) => e.includes('Invalid type "forklift"')));

  const badDate = byKey('Trucks', 11);
  assert.ok(badDate.errors.some((e) => e.includes('Registration expiration')));
  assert.ok(badDate.errors.some((e) => e.includes('Plate state "ZZ"')));

  const cobra = byKey('Trailers', 2);
  assert.strictEqual(imp.outcome(cobra), 'fail');
  assert.ok(cobra.errors.includes('Unit number is required.'));
  assert.ok(cobra.warnings.some((w) => w.includes('check digit')));
  assert.strictEqual(cobra.value.registration_expiration, null);
  assert.strictEqual(cobra.value.inspection_expiration, null);

  const sentinel = byKey('Trailers', 3);
  assert.ok(sentinel.errors.includes('Unit number is required.'));

  const inferred = byKey('Trailers', 4);
  assert.strictEqual(inferred.value.type, 'trailer');
  assert.strictEqual(inferred.value.number, 'T-100');
  assert.strictEqual(inferred.value.maintenance_status, 'maintenance');
  assert.strictEqual(inferred.value.registration_expiration, '2027-07-31');
  assert.strictEqual(inferred.value.plate_state, 'WV');
  assert.strictEqual(inferred.value.plate_number, 'WV99');
  assert.strictEqual(imp.outcome(inferred), 'pass');
  assert.strictEqual(parsed.rows.length, 13);
});

check('duplicate VIN inside the file is a warning and still importable', () => {
  const vin = imp.makeVin('1FUJTEST0A123456');
  const csv = `Type,Unit Number,VIN\ntruck,1,${vin}\ntruck,2,${vin.toLowerCase()}\n`;
  const parsed = imp.parseUpload(Buffer.from(csv), 'dup.csv');
  assert.strictEqual(parsed.rows[0].errors.length, 0);
  assert.ok(parsed.rows[0].warnings.some((w) => w.includes('also on CSV row 3')));
  assert.ok(parsed.rows[1].warnings.some((w) => w.includes('also on CSV row 2')));
});

check('existing unit number or VIN is a warning with skip or update; conflicts are errors', () => {
  const vinA = imp.makeVin('1FUJTEST0A123456');
  const vinB = imp.makeVin('1FUJTEST0B123456');
  const csv = `Type,Unit Number,VIN,Make\ntruck,9001,${vinA},Sample\ntruck,9002,${vinB},Other\ntruck,#9001,${vinB},Clash\n`;
  const parsed = imp.parseUpload(Buffer.from(csv), 'db.csv');
  const existing = [
    { id: 4, type: 'truck', number: '#9001', vin: vinA },
    { id: 5, type: 'trailer', number: 'T-9', vin: vinB }
  ];
  const rows = imp.annotateExisting(parsed.rows, existing);
  assert.strictEqual(rows[0].match.id, 4);
  assert.strictEqual(rows[0].match.via, 'both');
  assert.ok(rows[0].warnings.some((w) => w.includes('already on truck #9001')));
  assert.strictEqual(rows[1].match.id, 5);
  assert.strictEqual(rows[1].match.via, 'vin');
  assert.strictEqual(rows[2].errors.length > 0, true);
  assert.ok(rows[2].errors[0].includes('Unit number matches'));
  assert.ok(rows[2].errors[0].includes('VIN is already on'));

  const ambiguous = imp.annotateExisting(parsed.rows, [
    { id: 1, type: 'truck', number: '9001', vin: '' },
    { id: 2, type: 'truck', number: '9001', vin: 'OTHER' }
  ]);
  assert.ok(ambiguous[0].errors[0].includes('more than one'));
  assert.strictEqual(ambiguous[0].match.ambiguous, true);

  const decisions = ['update', 'skip', 'update'];
  const ops = imp.operationsFromDecisions(rows, decisions);
  assert.strictEqual(ops.length, 1);
  assert.strictEqual(ops[0].kind, 'update');
  assert.strictEqual(ops[0].id, 4);
  assert.strictEqual(imp.operationsFromDecisions(rows, ['import', 'import', 'import']).length, 0);
});

check('update keeps blank cells and insert defaults status and plate state', () => {
  const existing = {
    type: 'truck', number: '9001', description: 'Keep me', vin: 'GOODVIN123456789',
    year: '2010', make: 'Keep', model: 'Old', status: 'inactive', ownership: 'Owned',
    registration_expiration: '2027-01-01', inspection_expiration: '2027-02-01',
    maintenance_status: 'maintenance', plate_number: 'OLD1', plate_state: 'NC'
  };
  const merged = imp.valuesForUpdate(existing, rowValue({
    number: '9001', vin: '', make: 'Sample', model: '', description: '',
    status: null, maintenance_status: null, plate_number: null, plate_state: null,
    registration_expiration: null
  }));
  assert.strictEqual(merged.vin, 'GOODVIN123456789');
  assert.strictEqual(merged.description, 'Keep me');
  assert.strictEqual(merged.make, 'Sample');
  assert.strictEqual(merged.model, 'Old');
  assert.strictEqual(merged.status, 'inactive');
  assert.strictEqual(merged.maintenance_status, 'maintenance');
  assert.strictEqual(merged.plate_number, 'OLD1');
  assert.strictEqual(merged.plate_state, 'NC');
  assert.strictEqual(merged.registration_expiration, '2027-01-01');

  const created = imp.valuesForInsert(rowValue({ status: null, maintenance_status: null, plate_state: null, vin: '' }));
  assert.strictEqual(created.status, 'active');
  assert.strictEqual(created.maintenance_status, 'active');
  assert.strictEqual(created.plate_state, 'VA');
  assert.strictEqual(created.plate_number, null);
});

check('import writes in one transaction, audits, and rolls back on failure', () => {
  const db = memoryDb();
  const vin = imp.makeVin('1FUJTEST0A123456');
  db.prepare(`INSERT INTO equipment (type, number, vin, description, make, plate_state) VALUES ('truck', '9001', ?, 'Keep me', 'Keep', 'NC')`).run(vin);
  const parsed = imp.parseUpload(Buffer.from(`Type,Unit Number,VIN,Make,Description\ntruck,9001,${vin},Sample,\ntruck,9002,,Sample,New\n`), 'in.csv');
  const annotated = imp.annotateExisting(parsed.rows, db.prepare('SELECT * FROM equipment').all());
  const ops = imp.operationsFromDecisions(annotated, ['update', 'import']);
  const result = imp.applyImport(db, {
    operations: ops,
    actor: { id: 7, name: 'Ada Admin' },
    filename: 'in.csv',
    skipped: annotated.length - ops.length
  });
  assert.deepStrictEqual(result.updated, [1]);
  assert.strictEqual(result.created.length, 1);
  const kept = db.prepare('SELECT * FROM equipment WHERE number = ?').get('9001');
  assert.strictEqual(kept.make, 'Sample');
  assert.strictEqual(kept.description, 'Keep me');
  assert.strictEqual(kept.vin, vin);
  assert.strictEqual(kept.plate_state, 'NC');
  const created = db.prepare('SELECT * FROM equipment WHERE number = ?').get('9002');
  assert.strictEqual(created.plate_state, 'VA');
  assert.strictEqual(created.vin, '');
  const actions = db.prepare('SELECT action, entity_type, entity_id, detail FROM audit_log ORDER BY id').all();
  assert.deepStrictEqual(actions.map((row) => row.action), ['equipment_import_updated', 'equipment_import_created', 'equipment_import']);
  assert.ok(actions[2].detail.includes('created 1, updated 1, skipped 0'));
  assert.strictEqual(actions[0].entity_id, 1);

  const dup = imp.applyImport(db, {
    operations: [
      { kind: 'insert', value: rowValue({ number: 'SAME', vin: '' }), source: { sheet: 'CSV', row: 2 } },
      { kind: 'insert', value: rowValue({ number: 'SAME', vin: '' }), source: { sheet: 'CSV', row: 3 } }
    ],
    actor: { id: 7, name: 'Ada Admin' },
    filename: 'dup.csv',
    skipped: 0
  });
  assert.strictEqual(dup.created.length, 2);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM equipment WHERE number = 'SAME'").get().n, 2);

  const before = db.prepare('SELECT COUNT(*) AS n FROM equipment').get().n;
  const audits = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
  assert.throws(() => imp.applyImport(db, {
    operations: [
      { kind: 'insert', value: rowValue({ number: 'OK-1' }), source: { sheet: 'CSV', row: 2 } },
      { kind: 'insert', value: rowValue({ number: 'BAD', type: 'boat' }), source: { sheet: 'CSV', row: 3 } }
    ],
    actor: { name: 'Ada Admin' }
  }));
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM equipment').get().n, before);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, audits);
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all();
  assert.ok(!indexes.some((row) => /equipment/i.test(row.sql) && /unique/i.test(row.sql)));
  db.close();
});

check('template CSV round-trips into two ready rows', () => {
  const parsed = imp.parseUpload(Buffer.from(imp.templateCsv()), 'equipment-import-template.csv');
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.rows.length, 2);
  assert.strictEqual(imp.outcome(parsed.rows[0]), 'pass');
  assert.strictEqual(imp.outcome(parsed.rows[1]), 'pass');
  assert.strictEqual(parsed.rows[1].value.type, 'trailer');
  assert.strictEqual(parsed.rows[1].value.plate_state, 'WV');
});

check('quoted CSV cells and a sheet named Trucks without a type column', () => {
  const csv = 'Unit Number,Description,Type\n"9001","Said ""hello"", then left",trailer\n';
  const parsed = imp.parseUpload(Buffer.from(csv), 'q.csv');
  assert.strictEqual(parsed.rows[0].value.number, '9001');
  assert.strictEqual(parsed.rows[0].value.description, 'Said "hello", then left');
  assert.strictEqual(parsed.rows[0].value.type, 'trailer');
  assert.strictEqual(parsed.rows[0].warnings.length, 0);
});

check('server does not unique-constrain equipment numbers or VINs, and import stays off the upload disk', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes('equipmentPlate.ensurePlateColumns(db)'));
  assert.ok(src.includes('multer.memoryStorage()'));
  assert.ok(src.includes("app.get('/equipment/import'"));
  assert.ok(!/CREATE UNIQUE INDEX[^;]*\bon equipment\s*\(/i.test(src));
  const create = src.slice(src.indexOf('CREATE TABLE IF NOT EXISTS equipment'), src.indexOf('CREATE TABLE IF NOT EXISTS compliance_items'));
  assert.ok(!/UNIQUE/i.test(create));
});

check('reference and notes sheet names are skipped', () => {
  assert.strictEqual(imp.sheetSkipped('Reference (not TMS fields)'), true);
  assert.strictEqual(imp.sheetSkipped('Notes'), true);
  assert.strictEqual(imp.sheetSkipped('Trucks'), false);
  assert.strictEqual(imp.sheetSkipped('Trailers'), false);
});

console.log('All equipment import tests passed.');
