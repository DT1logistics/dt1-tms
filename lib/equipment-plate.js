// License plate fields for equipment (trucks and trailers).
'use strict';

const US_STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'],
  ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'],
  ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'],
  ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
  ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'],
  ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'],
  ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
  ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'],
  ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'], ['WY', 'Wyoming']
];

const STATE_CODES = new Set(US_STATES.map((pair) => pair[0]));

function normalizePlateNumber(value) {
  const text = String(value == null ? '' : value).toUpperCase().replace(/\s+/g, '');
  return text || null;
}

function normalizePlateState(value) {
  const text = String(value == null ? '' : value).trim().toUpperCase();
  if (!text) return { value: 'VA', error: null };
  if (!STATE_CODES.has(text)) return { value: null, error: 'Plate state must be a 2-letter US state code.' };
  return { value: text, error: null };
}

function formatPlate(item) {
  const number = normalizePlateNumber(item && item.plate_number);
  if (!number) return '';
  const state = normalizePlateState(item && item.plate_state);
  return `${state.value || 'VA'}-${number}`;
}

// ALTER TABLE only when the column is absent, so startup is safe on existing databases.
function ensurePlateColumns(db) {
  const names = new Set(db.prepare('PRAGMA table_info(equipment)').all().map((col) => col.name));
  if (!names.has('plate_number')) db.exec('ALTER TABLE equipment ADD COLUMN plate_number TEXT');
  if (!names.has('plate_state')) db.exec("ALTER TABLE equipment ADD COLUMN plate_state TEXT DEFAULT 'VA'");
}

module.exports = {
  US_STATES,
  STATE_CODES,
  normalizePlateNumber,
  normalizePlateState,
  formatPlate,
  ensurePlateColumns
};
