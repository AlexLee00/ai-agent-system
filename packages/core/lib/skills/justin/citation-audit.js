'use strict';

function _clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function auditCitation(item = {}) {
  const type = String(item.type || 'unknown').toLowerCase();
  const hasCaseNumber = !!item.has_case_number;
  const hasQuote = !!item.has_quote;
  const hasSourceLink = !!item.has_source_link;

  let score = 2.0;
  const flags = [];

  if (type === 'unknown') {
    score += 3.0;
    flags.push('unknown citation type');
  }

  if (!hasCaseNumber && !['contract'].includes(type)) {
    score += 2.5;
    flags.push('missing identifier');
  }

  if (!hasQuote) {
    score += 1.8;
    flags.push('missing quote');
  }

  if (!hasSourceLink) {
    score += 1.6;
    flags.push('missing source link');
  }

  if (type === 'statute' && hasCaseNumber) {
    score -= 0.4;
  }

  score = _clamp(Number(score.toFixed(2)), 0, 10);

  let riskLevel = 'low';
  if (score >= 8.0) riskLevel = 'critical';
  else if (score >= 6.0) riskLevel = 'high';
  else if (score >= 4.0) riskLevel = 'medium';

  return {
    ...item,
    risk_score: score,
    risk_level: riskLevel,
    flags,
  };
}

function auditCitations(citations = []) {
  const items = (Array.isArray(citations) ? citations : []).map(auditCitation);
  return {
    items,
    summary: {
      total: items.length,
      critical: items.filter((item) => item.risk_level === 'critical').length,
      high: items.filter((item) => item.risk_level === 'high').length,
      medium: items.filter((item) => item.risk_level === 'medium').length,
      low: items.filter((item) => item.risk_level === 'low').length,
    },
  };
}

module.exports = {
  auditCitation,
  auditCitations,
};
