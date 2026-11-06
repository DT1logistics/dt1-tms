// Display-only load dates. Stored values stay YYYY-MM-DD.
// The calendar day is read from the date prefix so a UTC midnight string
// does not shift to the previous day in US timezones.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DT1LoadDate = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  function formatLoadDate(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return '';
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/.exec(text);
    if (!match) return '';
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const utc = new Date(Date.UTC(year, month - 1, day));
    if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return '';
    return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}-${year}`;
  }

  return { formatLoadDate };
}));
