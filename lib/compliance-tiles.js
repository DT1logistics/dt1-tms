'use strict';

// Dashboard tiles summarize the red and yellow alerts collectAlerts already builds.
// Counts are not recomputed from dates here, so any exclusion in that collector
// (for example a registration flag that was never emitted) stays excluded.

const TILE_SPECS = [
  { category: 'Compliance', title: 'Compliance', href: '/compliance', yellowLabel: 'expiring soon' },
  { category: 'Driver Document', title: 'Driver Documents', href: '/drivers?compliance=attention', yellowLabel: 'expiring soon' },
  { category: 'Equipment', title: 'Equipment', href: '/equipment?compliance=attention', yellowLabel: 'expiring soon' },
  { category: 'Load', title: 'Loads', href: '/loads', yellowLabel: 'need attention' },
  { category: 'Password Reset', title: 'Password Reset', href: '/drivers', yellowLabel: 'expiring soon' }
];

function tileClassName(accent) {
  if (accent === 'red') return 'quick quick-alert';
  if (accent === 'yellow') return 'quick quick-warn';
  return 'quick';
}

function buildComplianceTiles(alerts) {
  const counts = {};
  TILE_SPECS.forEach((spec) => {
    counts[spec.category] = { red: 0, yellow: 0 };
  });
  (alerts || []).forEach((alert) => {
    if (!alert || (alert.level !== 'red' && alert.level !== 'yellow')) return;
    if (!counts[alert.category]) counts[alert.category] = { red: 0, yellow: 0 };
    counts[alert.category][alert.level] += 1;
  });

  const known = new Set(TILE_SPECS.map((spec) => spec.category));
  const extras = Object.keys(counts).filter((category) => !known.has(category)).sort();
  const specs = TILE_SPECS.concat(extras.map((category) => ({
    category,
    title: category,
    href: '/',
    yellowLabel: 'expiring soon'
  })));

  return specs.map((spec) => {
    const count = counts[spec.category] || { red: 0, yellow: 0 };
    let accent = 'neutral';
    if (count.red > 0) accent = 'red';
    else if (count.yellow > 0) accent = 'yellow';
    return {
      category: spec.category,
      title: spec.title,
      href: spec.href,
      redCount: count.red,
      yellowCount: count.yellow,
      yellowLabel: spec.yellowLabel || 'expiring soon',
      accent,
      // True only for a red (out of compliance) count. Yellow must not set this.
      red: count.red > 0,
      className: tileClassName(accent)
    };
  });
}

module.exports = {
  TILE_SPECS,
  tileClassName,
  buildComplianceTiles
};
