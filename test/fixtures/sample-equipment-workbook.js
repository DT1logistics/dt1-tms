// Sanitized equipment workbook. Invented unit numbers and VINs only.
// Do not replace this with the real fleet spreadsheet.
'use strict';

const XLSX = require('xlsx');
const imp = require('../../lib/equipment-import');

const HEADERS = [
  'Type', 'Equipment Number / Identifier', 'VIN#', 'Year', 'Make', 'Model', 'Description', 'Ownership',
  'Registration Expiration Date', 'Annual DOT Periodic Inspection Date', 'Status', 'Maintenance Status',
  'Plate Number', 'Plate State', 'Source document'
];

function badCheckVin(valid) {
  const flip = valid[16] === '1' ? '2' : '1';
  return valid.slice(0, 16) + flip;
}

function buildSampleWorkbook() {
  const vin = {
    a: imp.makeVin('1FUJTEST0A123456'),
    b: imp.makeVin('1FUJTEST0B123456'),
    c: imp.makeVin('1FUJTEST0C123456'),
    d: imp.makeVin('1FUJTEST0D123456'),
    e: imp.makeVin('1FUJTEST0E123456'),
    f: imp.makeVin('1FUJTEST0F123456'),
    g: imp.makeVin('1FUJTEST0G123456'),
    h: imp.makeVin('1FUJTEST0H123456'),
    i: imp.makeVin('1T9TEST0A1234567'),
    j: imp.makeVin('1T9TEST0B1234567'),
    k: imp.makeVin('1T9TEST0C1234567')
  };
  const serial = imp.isoToExcelSerial('2028-05-31');
  const trucks = [
    HEADERS,
    ['truck', '9001', vin.a, 2010, 'Sample', 'Alpha', 'Example tractor', 'Owned', '2027-07-31', null, 'active', 'active', 'ABC123', 'VA', 'sanitized'],
    ['truck', '9002', vin.b, 2011, 'Sample', 'Bravo', 'Example tractor', 'Owned', '7/31/2027', 'June 30, 2027', 'active', 'out_of_service', null, null, 'sanitized'],
    ['truck', '9003', vin.c, 2012, 'Sample', 'Charlie', 'Serial date', 'Owned', serial, null, 'active', 'active', 'xy 99', 'Virginia', 'sanitized'],
    ['truck', '9004', vin.d, 2014, 'Sample', 'Delta', 'Blank status', 'Owned', null, null, null, null, null, null, 'sanitized'],
    ['truck', '9006', null, 2026, 'Ford', 'F350', 'Example pickup with no VIN', 'Leased', null, null, 'active', 'active', null, null, 'sanitized'],
    ['truck', null, vin.e, null, null, null, 'Missing unit number', null, null, null, null, null, null, null, 'sanitized'],
    ['truck', '9001', vin.f, 2010, 'Sample', 'Alpha', 'Duplicate unit number', 'Owned', null, null, 'active', 'active', null, null, 'sanitized'],
    ['truck', '9008', badCheckVin(vin.a), 2001, 'Sample', 'Hotel', 'Bad check digit', 'Owned', null, null, 'active', 'active', null, null, 'sanitized'],
    ['forklift', '9007', vin.g, 2015, 'Sample', 'Golf', 'Invalid type', 'Owned', null, null, 'active', 'active', null, null, 'sanitized'],
    ['truck', '9009', vin.h, 2016, 'Sample', 'India', 'Bad date', 'Owned', 'yesterday', null, 'active', 'active', null, 'ZZ', 'sanitized']
  ];
  const trailers = [
    HEADERS,
    ['trailer', null, badCheckVin(vin.i), 1988, 'SampleCoach', 'Dump', 'Missing number and bad VIN', 'Owned', 'None', 'N/A', 'active', 'active', null, null, 'sanitized'],
    ['trailer', '—', vin.j, 1998, 'SampleStar', 'Dump', 'Sentinel unit number', 'Leased', null, null, 'active', 'active', null, null, 'sanitized'],
    [null, 'T-100', vin.k, 2004, 'Sample', 'Van', 'Type comes from the sheet name', 'Owned', '31-Jul-2027', null, 'active', 'In maintenance', 'wv99', 'wv', 'sanitized']
  ];
  const reference = [
    ['VIN', 'Unit', 'Plate', 'Other notes'],
    [vin.a, 'SOLD-1', 'ZZZ999', 'Do not import this sheet']
  ];
  const notes = [['Prepared as a sanitized fixture. Nothing here is equipment.']];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(trucks), 'Trucks');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(trailers), 'Trailers');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(reference), 'Reference (not TMS fields)');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(notes), 'Notes');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildSampleWorkbook, HEADERS };
