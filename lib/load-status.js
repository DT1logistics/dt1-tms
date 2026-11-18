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

// Week-summary captions, in the same status process used on every project.
const WEEK_SUMMARY_LABELS = [
  'Submitted – Pending Approval',
  'Approved',
  'Approved for Settlement',
  'Draft – Rejected',
  'Draft'
];

function loadStatusLabelCounts(loads) {
  const counts = Object.fromEntries(WEEK_SUMMARY_LABELS.map((label) => [label, 0]));
  for (const load of loads || []) {
    const label = loadStatusLabel(load.status, load.settlement_status, load);
    if (Object.prototype.hasOwnProperty.call(counts, label)) counts[label] += 1;
  }
  return counts;
}

// Approve for Settlement is available on any project when the load is submitted
// or has been Accepted, including accepted drafts. Already-approved, settled,
// rejected, and plain unreviewed drafts stay blocked.
function canApproveForSettlement(load) {
  if (!load || typeof load !== 'object') return false;
  if (load.status === 'approved') return false;
  if (String(load.settlement_status || '') === 'approved') return false;
  if (String(load.review_decision || '') === 'rejected') return false;
  if (load.status === 'draft' && rejectionEvidence(load) && String(load.review_decision || '') !== 'accepted') {
    return false;
  }
  if (load.status === 'submitted') return true;
  if (String(load.review_decision || '') === 'accepted') return true;
  return false;
}

module.exports = {
  loadStatusLabel,
  loadStatusClass,
  loadStatusLabelCounts,
  WEEK_SUMMARY_LABELS,
  canApproveForSettlement
};
