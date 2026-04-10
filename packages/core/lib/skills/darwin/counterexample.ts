// @ts-nocheck
'use strict';

function _severityRank(level) {
  return { high: 3, medium: 2, low: 1 }[level] || 0;
}

function _pushCounterexample(items, title, severity, why) {
  items.push({
    title,
    severity,
    why_it_breaks: why,
  });
}

function extractCounterexamples(input = {}) {
  const claim = String(input.claim || '').trim();
  const assumptions = Array.isArray(input.assumptions) ? input.assumptions : [];
  const evidenceStrength = String(input.evidence_strength || 'medium').toLowerCase();
  const domain = String(input.domain || 'general').toLowerCase();
  const counterexamples = [];

  if (!claim) {
    return {
      counterexamples: [],
      risk_summary: { total: 0, high: 0, medium: 0, low: 0 },
      verdict: 'insufficient_input',
    };
  }

  if (/(always|반드시|무조건|항상)/i.test(claim)) {
    _pushCounterexample(
      counterexamples,
      'absolute claim overreach',
      'high',
      '절대 표현은 반례 하나만 있어도 전체 주장을 무너뜨릴 수 있음'
    );
  }

  if (evidenceStrength === 'low') {
    _pushCounterexample(
      counterexamples,
      'weak evidence base',
      'high',
      '근거 강도가 낮으면 같은 결론을 재현하거나 일반화하기 어려움'
    );
  } else if (evidenceStrength === 'medium') {
    _pushCounterexample(
      counterexamples,
      'partial evidence coverage',
      'medium',
      '부분 근거만 있으면 조건이 바뀔 때 결론이 유지되지 않을 수 있음'
    );
  }

  if (assumptions.length === 0) {
    _pushCounterexample(
      counterexamples,
      'hidden assumptions',
      'medium',
      '전제가 명시되지 않으면 반례 탐지가 어려워지고 결론 신뢰도가 낮아짐'
    );
  } else {
    for (const assumption of assumptions) {
      if (/(없다|none|never|zero|완전)/i.test(String(assumption))) {
        _pushCounterexample(
          counterexamples,
          `assumption stress: ${assumption}`,
          'medium',
          '강한 부정 전제는 실제 운영 환경에서 쉽게 깨질 수 있음'
        );
      }
    }
  }

  if (domain.includes('agent') || domain.includes('multi')) {
    _pushCounterexample(
      counterexamples,
      'routing overhead dominates',
      'medium',
      '작업이 짧고 단순하면 라우팅/조정 비용이 성능 이득보다 커질 수 있음'
    );
  }

  const sorted = counterexamples.sort((a, b) => _severityRank(b.severity) - _severityRank(a.severity));
  const high = sorted.filter((item) => item.severity === 'high').length;
  const medium = sorted.filter((item) => item.severity === 'medium').length;
  const low = sorted.filter((item) => item.severity === 'low').length;

  let verdict = 'stable';
  if (high > 0) verdict = 'needs_review';
  else if (medium > 1) verdict = 'watch';

  return {
    counterexamples: sorted,
    risk_summary: {
      total: sorted.length,
      high,
      medium,
      low,
    },
    verdict,
  };
}

module.exports = {
  extractCounterexamples,
};

