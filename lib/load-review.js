// Logan's load-review states. Accept and reject are not in this list:
// only an admin can record that decision, never the bot API.
const REVIEW_STATUSES = ['none', 'needs_review', 'flagged_missing_info', 'cleared'];

function normalizeNotes(value) {
  if (Array.isArray(value)) {
    const lines = value.map((item) => String(item == null ? '' : item).trim()).filter(Boolean);
    return lines.join('\n').slice(0, 4000) || null;
  }
  if (value == null) return null;
  const text = String(value).trim().slice(0, 4000);
  return text || null;
}

// True when a payload is trying to accept, reject, or approve a load.
function forbiddenReviewChange(body) {
  if (!body || typeof body !== 'object') return false;
  const status = String(body.review_status || '').trim().toLowerCase();
  if (status === 'rejected' || status === 'accepted' || status === 'approved') return true;
  if (body.review_decision != null && String(body.review_decision).trim() !== '') return true;
  if (body.decision != null && String(body.decision).trim() !== '') return true;
  const action = String(body.action || '').trim().toLowerCase();
  return action === 'reject' || action === 'accept' || action === 'approve';
}

function reviewStatusLabel(status) {
  if (status === 'needs_review') return 'Needs review';
  if (status === 'flagged_missing_info') return 'Flagged — missing info';
  if (status === 'cleared') return 'Cleared';
  if (!status || status === 'none') return 'Not reviewed';
  return String(status);
}

function reviewStatusClass(status) {
  if (status === 'flagged_missing_info') return 'flagged';
  if (status === 'needs_review') return 'needs-review';
  if (status === 'cleared') return 'cleared';
  return 'draft';
}

module.exports = {
  REVIEW_STATUSES,
  normalizeNotes,
  forbiddenReviewChange,
  reviewStatusLabel,
  reviewStatusClass
};
