'use strict';

function auditSources(input = {}) {
  const items = Array.isArray(input.items) ? input.items : [];
  const issues = [];
  const trustedSources = [];
  const blockedSources = [];

  for (const item of items) {
    const title = String(item.title || 'untitled');
    const score = Number(item.trust_score || 0);
    const flags = Array.isArray(item.risk_flags) ? item.risk_flags : [];

    if (score >= 7.5 && flags.length === 0) {
      trustedSources.push(title);
    } else {
      blockedSources.push(title);
      issues.push({
        title,
        reasons: flags.length ? flags : ['low trust score'],
      });
    }
  }

  return {
    passed: blockedSources.length === 0,
    issues,
    trusted_sources: trustedSources,
    blocked_sources: blockedSources,
  };
}

module.exports = {
  auditSources,
};

