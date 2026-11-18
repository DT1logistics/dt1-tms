// Display labels for a load. Stored status values stay draft, submitted, and approved.
// Accept (review_decision) and rejection marks are read only at display time.
// Settled is approved plus a driver settlement that has been approved.
function rejectionEvidence(meta) {
  if (!meta || typeof meta !== 'object') return false;
  if (String(meta.review_decision || '') === 'rejected') return true;
  if (String(meta.rejection_reason || '').trim()) return true;
  if (meta.rejected_at) return true;
  return false;
}

function loadStatusLabel(status, settlementStatus, meta) {
  if (status === 'approved' && settlementStatus === 'approved') return 'Settled';
  if (status === 'approved') return 'Approved for Settlement';
  const review = meta && typeof meta === 'object' ? String(meta.review_decision || '') : '';
  if (review === 'accepted') return 'Approved';
  if (status === 'submitted') return 'Submitted – Pending Approval';
  if (status === 'draft' && rejectionEvidence(meta)) return 'Draft – Rejected';
  if (status === 'draft') return 'Draft';
  return status || 'Draft';
}

function loadStatusClass(status, settlementStatus, meta) {
  const label = loadStatusLabel(status, settlementStatus, meta);
  if (label === 'Settled' || label === 'Approved for Settlement' || label === 'Approved') return 'approved';
  if (label === 'Submitted – Pending Approval') return 'submitted';
  if (label === 'Draft – Rejected') return 'rejected';
  if (label === 'Draft') return 'draft';
  return status || 'draft';
}

module.exports = { loadStatusLabel, loadStatusClass };
