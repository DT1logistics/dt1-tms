// Natural numeric sort for equipment unit numbers. Display order only.
'use strict';

// Truck, then hotshot, then trailer — matches the existing CASE type lists.
const TYPE_GROUP_ORDER = { truck: 0, hotshot: 1, trailer: 2 };

function digitsOf(number) {
  const digits = String(number == null ? '' : number).replace(/\D/g, '');
  if (!digits) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

// Compare two unit-number strings: extract digits, ignoring '#', spaces, and
// letters, so '#1001', '1002', ' #1003', and 'Truck 1004' order as 1001..1004,
// and 2 comes before 10. Ties and values with no digits fall back to
// case-insensitive text. Numbered units sort before units with no digits.
function compareEquipmentNumber(a, b) {
  const aText = a == null ? '' : String(a);
  const bText = b == null ? '' : String(b);
  const aNum = digitsOf(aText);
  const bNum = digitsOf(bText);
  if (aNum != null && bNum == null) return -1;
  if (aNum == null && bNum != null) return 1;
  if (aNum != null && bNum != null && aNum !== bNum) return aNum < bNum ? -1 : 1;
  const aKey = aText.trim().toLowerCase();
  const bKey = bText.trim().toLowerCase();
  if (aKey < bKey) return -1;
  if (aKey > bKey) return 1;
  return 0;
}

// groupBy: 'truck-hotshot-trailer' keeps that type order, then number.
// 'type' keeps lexicographic type order (the older ORDER BY type, number lists).
function compareEquipmentRow(a, b, groupBy) {
  if (groupBy === 'truck-hotshot-trailer') {
    const aRank = Object.prototype.hasOwnProperty.call(TYPE_GROUP_ORDER, a && a.type)
      ? TYPE_GROUP_ORDER[a.type]
      : 99;
    const bRank = Object.prototype.hasOwnProperty.call(TYPE_GROUP_ORDER, b && b.type)
      ? TYPE_GROUP_ORDER[b.type]
      : 99;
    if (aRank !== bRank) return aRank - bRank;
  } else if (groupBy === 'type') {
    const aType = String((a && a.type) || '');
    const bType = String((b && b.type) || '');
    if (aType < bType) return -1;
    if (aType > bType) return 1;
  }
  return compareEquipmentNumber(a && a.number, b && b.number);
}

function sortEquipmentByNumber(rows) {
  return (rows || []).sort((a, b) => compareEquipmentNumber(a && a.number, b && b.number));
}

function sortEquipment(rows, groupBy) {
  return (rows || []).sort((a, b) => compareEquipmentRow(a, b, groupBy));
}

module.exports = {
  compareEquipmentNumber,
  compareEquipmentRow,
  sortEquipmentByNumber,
  sortEquipment
};
