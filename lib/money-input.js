// Item 4 (11/15/2026): money inputs show a "$" in front and two decimals (210 -> 210.00).
// Served at /js/money-input.js and loaded on every page. Any <input data-money> is wrapped in
// <span class="money-field"> with a "$" prefix. The field stays type=number, so the mobile
// number pad and the server parsing do not change. Values are reformatted on load and blur.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DT1Money = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  function twoDecimals(value) {
    const raw = String(value == null ? '' : value).trim();
    if (raw === '') return '';
    const n = Number(raw);
    return Number.isFinite(n) ? n.toFixed(2) : raw;
  }

  // "$1,234.50" (negative: "-$5.00").
  function usd(value) {
    const n = Number(value);
    const safe = Number.isFinite(n) ? n : 0;
    const text = Math.abs(safe).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (safe < 0 && text !== '0.00' ? '-$' : '$') + text;
  }

  function normalize(input) {
    const next = twoDecimals(input.value);
    if (next !== input.value) input.value = next;
  }

  function enhance(input) {
    if (!input || input.getAttribute('data-money-ready') === '1' || !input.parentNode) return;
    input.setAttribute('data-money-ready', '1');
    const wrap = document.createElement('span');
    wrap.className = 'money-field';
    input.parentNode.insertBefore(wrap, input);
    const prefix = document.createElement('span');
    prefix.className = 'money-prefix';
    prefix.setAttribute('aria-hidden', 'true');
    prefix.textContent = '$';
    wrap.appendChild(prefix);
    wrap.appendChild(input);
    normalize(input);
    input.addEventListener('blur', function () { normalize(input); });
  }

  function enhanceAll(scope) {
    const rootEl = scope || (typeof document !== 'undefined' ? document : null);
    if (!rootEl || !rootEl.querySelectorAll) return;
    rootEl.querySelectorAll('input[data-money]').forEach(enhance);
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    const start = function () {
      enhanceAll(document);
      if (typeof MutationObserver !== 'undefined') {
        new MutationObserver(function () { enhanceAll(document); })
          .observe(document.body, { childList: true, subtree: true });
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  return { twoDecimals, usd, enhance, enhanceAll };
}));
