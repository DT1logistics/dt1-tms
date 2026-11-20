// A hidden 0 + checkbox 1 with the same name posts as ['0','1'] when
// express.urlencoded({ extended: true }) is used. String(['0','1']) is '0,1',
// so a strict === '1' check treats a checked box as off.
function isOn(value) {
  const parts = Array.isArray(value) ? value : [value];
  return parts.some((part) => {
    const s = String(part);
    return s === '1' || s === 'on';
  });
}

module.exports = { isOn };
