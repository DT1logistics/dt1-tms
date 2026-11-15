// Live Driver Pay on the admin load form and review edit panel (item 2, 11/15/2026).
// Served to the browser at /js/load-pay.js. Mirrors calcDriverPay() in server.js:
// flat loads = Flat/Daily Rate + Drive Time + Self Load + Detention; percentage loads =
// Qty x Rate x Pay% + (Drive Time x Pay%, rounded) + Self Load + Detention.
// Fuel surcharge is never part of driver pay.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DT1LoadPay = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  function round2(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }
  function driverPay(o) {
    const opts = o || {};
    const pct = num(opts.pct);
    const drive = num(opts.drive);
    const self = num(opts.self);
    const detention = num(opts.detention);
    if (opts.isFlat) return num(opts.flatRate) + drive + self + detention;
    return num(opts.qty) * num(opts.rate) * (pct / 100) + round2(drive * (pct / 100)) + self + detention;
  }
  // "$1,234.50" (always two decimals), same as the server-side usd() helper.
  function usd(value) {
    const n = num(value);
    const text = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n < 0 && text !== '0.00' ? '-$' : '$') + text;
  }
  return { driverPay, usd };
}));
