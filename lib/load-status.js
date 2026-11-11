// Display labels for a load. Stored status values stay draft, submitted, and approved.
// Settled is approved plus a driver settlement that has been approved.
function loadStatusLabel(status, settlementStatus) {
  if (status === 'approved' && settlementStatus === 'approved') return 'Settled';
  if (status === 'approved') return 'Approved for Settlement';
  if (status === 'submitted') return 'Submitted, pending approval';
  if (status === 'draft') return 'Draft';
  return status || 'Draft';
}

module.exports = { loadStatusLabel };
