// DT1 fuel surcharge formula (Kammy, Oct 2026):
//   Step 1: FSC decimal = (Weekly Diesel Rate - 4.00) / 10   -> shown as a percent, e.g. $6.485 -> 24.85%
//   Step 2: Surcharge/Ton = Load Rate x FSC decimal          (full precision, e.g. 12.65 x 0.2485 = 3.143525)
//   Step 3: Total Fuel Surcharge = Surcharge/Ton x Wet Tons  (rounded to cents at the end, e.g. 75.95)
// Flat-rate loads (no qty x rate): Total Fuel Surcharge = Flat Amount x FSC decimal.
// Fuel surcharge is never part of Load Total or Driver Pay; invoices show it as its own line.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DT1Fuel = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const BASE_DIESEL = 4.00;

  function round(value, places) {
    const f = Math.pow(10, places);
    return Math.round((Number(value) + Number.EPSILON) * f) / f;
  }

  // Decimal factor, e.g. 6.485 -> 0.2485. 0 when diesel <= $4.00.
  function fscDecimal(dieselRate) {
    const rate = Number(dieselRate);
    if (!Number.isFinite(rate) || rate <= BASE_DIESEL) return 0;
    return round((rate - BASE_DIESEL) / 10, 6);
  }

  // Percent shown to admins, e.g. 6.485 -> 24.85
  function fscPercent(dieselRate) {
    return round(fscDecimal(dieselRate) * 100, 4);
  }

  // percent (e.g. 24.85) -> decimal (0.2485)
  function decimalFromPercent(percent) {
    const p = Number(percent);
    return Number.isFinite(p) && p > 0 ? round(p / 100, 6) : 0;
  }

  // Calculate the surcharge for one load given the FSC percent (e.g. 24.85).
  function loadFuelSurcharge(opts) {
    const o = opts || {};
    const decimal = decimalFromPercent(o.percent);
    const rate = Number(o.rate) || 0;
    const tons = Number(o.tons) || 0;
    const flatAmount = Number(o.flatAmount) || 0;
    const baseHauling = rate * tons;
    const useFlat = !!o.isFlat && baseHauling === 0;
    if (useFlat) {
      return {
        decimal, perTon: null, flat: true, baseHauling: round(flatAmount, 2),
        total: round(flatAmount * decimal, 2)
      };
    }
    const perTon = round(rate * decimal, 8);
    return {
      decimal, perTon, flat: false, baseHauling: round(baseHauling, 2),
      total: round(perTon * tons, 2)
    };
  }

  // Weekly rate for a load: the fuel-rate row with the latest effective date on or before the Load Date
  // (weekly rows are effective Monday and posted by the Tuesday routine). null = rate pending.
  function rateForDate(history, loadDate) {
    const d = String(loadDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    let best = null;
    (history || []).forEach((row) => {
      const e = String((row && row.effective_date) || '').slice(0, 10);
      if (!e || e > d || row.central_atlantic_rate == null || row.central_atlantic_rate === '') return;
      if (!best || e > best.e || (e === best.e && (Number(row.id) || 0) > (Number(best.row.id) || 0))) best = { e, row };
    });
    return best ? best.row : null;
  }

  // Surcharge for a load using its own week's rate. pending=true (and $0) until that week's rate is posted.
  function loadFuelSurchargeForDate(opts) {
    const o = opts || {};
    const row = rateForDate(o.history, o.loadDate);
    if (!row) {
      return { pending: true, percent: null, dieselRate: null, effectiveDate: null, decimal: 0, perTon: 0, flat: false, baseHauling: 0, total: 0 };
    }
    const percent = fscPercent(row.central_atlantic_rate);
    const r = loadFuelSurcharge({ percent, rate: o.rate, tons: o.tons, isFlat: o.isFlat, flatAmount: o.flatAmount });
    return Object.assign(r, {
      pending: false, percent, dieselRate: Number(row.central_atlantic_rate), effectiveDate: String(row.effective_date).slice(0, 10)
    });
  }

  return { BASE_DIESEL, fscDecimal, fscPercent, decimalFromPercent, loadFuelSurcharge, rateForDate, loadFuelSurchargeForDate, round };
}));
