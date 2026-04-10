'use strict';

function simulateJudgeReview(input = {}) {
  const claims = Array.isArray(input.claims) ? input.claims : [];
  const findings = [];
  const recommendations = [];

  for (const claim of claims) {
    const supportCount = Number(claim.support_count || 0);
    const counterCount = Number(claim.counter_count || 0);
    const status = String(claim.evidence_status || '').toLowerCase();

    if (status === 'unsupported') {
      findings.push({ text: '핵심 주장에 직접 증거가 부족함', severity: 'high' });
    } else if (status === 'weak') {
      findings.push({ text: '주장을 뒷받침하는 근거가 약함', severity: 'medium' });
    }

    if (counterCount > supportCount) {
      findings.push({ text: '반대논점 대비가 부족함', severity: 'high' });
    }

    if (supportCount > 0 && supportCount < 2) {
      recommendations.push('핵심 계약 조항 또는 1차 자료를 추가 인용');
    }
    if (counterCount > 0) {
      recommendations.push('counter evidence에 대한 정면 답변을 보강');
    }
  }

  const highCount = findings.filter((item) => item.severity === 'high').length;
  const mediumCount = findings.filter((item) => item.severity === 'medium').length;

  let judicialRisk = 'low';
  if (highCount > 0) judicialRisk = 'high';
  else if (mediumCount > 0) judicialRisk = 'medium';

  return {
    findings,
    judicial_risk: judicialRisk,
    recommendations: [...new Set(recommendations)],
  };
}

module.exports = {
  simulateJudgeReview,
};

