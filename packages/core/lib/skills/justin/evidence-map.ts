// @ts-nocheck
'use strict';

function _statusForClaim(claim = {}) {
  const supportCount = Array.isArray(claim.evidence) ? claim.evidence.filter(Boolean).length : 0;
  const counterCount = Array.isArray(claim.counterpoints) ? claim.counterpoints.filter(Boolean).length : 0;

  if (supportCount === 0) return 'unsupported';
  if (supportCount >= 2 && counterCount === 0) return 'supported';
  if (supportCount >= 1) return 'weak';
  return 'unsupported';
}

function mapEvidence(claims = []) {
  const mapped = (Array.isArray(claims) ? claims : []).map((claim, index) => {
    const supportCount = Array.isArray(claim.evidence) ? claim.evidence.filter(Boolean).length : 0;
    const counterCount = Array.isArray(claim.counterpoints) ? claim.counterpoints.filter(Boolean).length : 0;
    const gaps = [];

    if (supportCount === 0) gaps.push('missing supporting evidence');
    if (!Array.isArray(claim.counterpoints) || claim.counterpoints.length === 0) gaps.push('no explicit counterpoints');

    return {
      id: claim.id || `claim-${index + 1}`,
      text: claim.text || '',
      support_count: supportCount,
      counter_count: counterCount,
      evidence_status: _statusForClaim(claim),
      gaps,
    };
  });

  return {
    mapped,
    summary: {
      total_claims: mapped.length,
      supported: mapped.filter((item) => item.evidence_status === 'supported').length,
      weak: mapped.filter((item) => item.evidence_status === 'weak').length,
      unsupported: mapped.filter((item) => item.evidence_status === 'unsupported').length,
    },
  };
}

module.exports = {
  mapEvidence,
};

