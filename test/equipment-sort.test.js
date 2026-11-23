// Natural numeric sort for equipment unit numbers. Run: npm test
const assert = require('assert');
const h = require('./helpers/server');
const equipmentSort = require('../lib/equipment-sort');

function sortedNumbers(values) {
  return values.slice().sort(equipmentSort.compareEquipmentNumber);
}

(async () => {
  const { check, results } = h.makeChecker();

  await check('compareEquipmentNumber extracts digits and sorts 2 before 10', () => {
    assert.deepStrictEqual(
      sortedNumbers(['#1001', '1002', ' #1003', 'Truck 1004']),
      ['#1001', '1002', ' #1003', 'Truck 1004']
    );
    assert.deepStrictEqual(
      sortedNumbers(['Truck 1004', '1002', ' #1003', '#1001']),
      ['#1001', '1002', ' #1003', 'Truck 1004']
    );
    assert.deepStrictEqual(sortedNumbers(['10', '2', '1', '100']), ['1', '2', '10', '100']);
    assert.ok(equipmentSort.compareEquipmentNumber('2', '10') < 0);
    assert.ok(equipmentSort.compareEquipmentNumber('10', '2') > 0);
  });

  await check('compareEquipmentNumber ties and no-digit values fall back to case-insensitive text', () => {
    assert.ok(equipmentSort.compareEquipmentNumber('1001A', '1001B') < 0);
    assert.ok(equipmentSort.compareEquipmentNumber('1001b', '1001A') > 0);
    assert.strictEqual(equipmentSort.compareEquipmentNumber('Unit 12', 'unit 12'), 0);
    assert.strictEqual(equipmentSort.compareEquipmentNumber('  10  ', '10'), 0);
    // Same numeric value, different text: '#' sorts before '1'
    assert.ok(equipmentSort.compareEquipmentNumber('#1001', '1001') < 0);
    assert.deepStrictEqual(sortedNumbers(['beta', 'Alpha', 'Gamma']), ['Alpha', 'beta', 'Gamma']);
    assert.ok(equipmentSort.compareEquipmentNumber('Alpha', 'beta') < 0);
    // Numbered units come before units with no digits
    assert.ok(equipmentSort.compareEquipmentNumber('2', 'Alpha') < 0);
    assert.ok(equipmentSort.compareEquipmentNumber('Alpha', '2') > 0);
    assert.ok(equipmentSort.compareEquipmentNumber(null, '2') > 0);
    assert.strictEqual(equipmentSort.compareEquipmentNumber('', null), 0);
  });

  await check('sortEquipment keeps truck, then hotshot, then trailer groups', () => {
    const rows = [
      { type: 'trailer', number: 'T-10' },
      { type: 'hotshot', number: 'H-10' },
      { type: 'truck', number: '10' },
      { type: 'trailer', number: 'T-2' },
      { type: 'hotshot', number: 'H-2' },
      { type: 'truck', number: '2' }
    ];
    const sorted = equipmentSort.sortEquipment(rows.slice(), 'truck-hotshot-trailer');
    assert.deepStrictEqual(sorted.map((row) => `${row.type}:${row.number}`), [
      'truck:2', 'truck:10', 'hotshot:H-2', 'hotshot:H-10', 'trailer:T-2', 'trailer:T-10'
    ]);
  });

  const adminPassword = 'Equip-Sort-Admin-1';
  const dataDir = h.tempDataDir('dt1-equipment-sort-');
  const srv = await h.startServer({
    DATA_DIR: dataDir,
    LOGAN_TMS_PASSWORD: adminPassword,
    LOGAN_API_TOKEN: '',
    SESSION_SECRET: 'equipment-sort-test'
  });

  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    const auth = { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: h.cookieHeader(admin) };

    async function addUnit(fields) {
      const res = await h.request(srv.port, auth, {
        method: 'POST',
        path: '/equipment',
        body: h.form(Object.assign({ plate_state: 'VA', maintenance_status: 'active', status: 'active' }, fields))
      });
      assert.strictEqual(res.status, 302, (fields.number || fields.type) + ' ' + res.body.slice(0, 240));
    }

    // Insert in scrambled order, including mixed formats that a text sort would mis-order.
    await addUnit({ type: 'truck', number: 'Truck 1004' });
    await addUnit({ type: 'trailer', number: 'T-10' });
    await addUnit({ type: 'hotshot', number: 'H-10' });
    await addUnit({ type: 'truck', number: '10' });
    await addUnit({ type: 'truck', number: '#1001' });
    await addUnit({ type: 'trailer', number: 'T-2' });
    await addUnit({ type: 'truck', number: '2' });
    await addUnit({ type: 'hotshot', number: 'H-2' });
    await addUnit({ type: 'truck', number: '1003' });
    await addUnit({ type: 'truck', number: '1002' });
    // The equipment form trims the unit number, so a leading-space format is
    // written here to cover values already stored that way.
    h.writeDb(dataDir, (database) => {
      database.prepare("UPDATE equipment SET number = ' #1003' WHERE number = '1003'").run();
    });

    await check('admin /equipment lists trucks in numeric order with mixed number formats', async () => {
      const res = await h.request(srv.port, {
        Cookie: h.cookieHeader(admin),
        Accept: 'application/json'
      }, { path: '/equipment' });
      assert.strictEqual(res.status, 200, res.body.slice(0, 240));
      const body = JSON.parse(res.body);
      assert.deepStrictEqual(body.trucks.map((row) => row.number), [
        '2', '10', '#1001', '1002', ' #1003', 'Truck 1004'
      ]);
      assert.deepStrictEqual(body.hotshots.map((row) => row.number), ['H-2', 'H-10']);
      assert.deepStrictEqual(body.trailers.map((row) => row.number), ['T-2', 'T-10']);
    });
  } finally {
    await h.stop(srv.child);
  }

  console.log('equipment-sort tests:', results.length, 'passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
