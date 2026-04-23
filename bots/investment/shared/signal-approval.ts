// @ts-nocheck

export function buildSignalApprovalUpdate(input = {}) {
  const verdict = input.nemesisVerdict
    || input.nemesis_verdict
    || input.verdict
    || 'approved';
  const approvedAt = input.approvedAt
    || input.approved_at
    || input.timestamp
    || new Date().toISOString();

  return {
    status: input.status || 'approved',
    nemesisVerdict: verdict,
    approvedAt,
  };
}
