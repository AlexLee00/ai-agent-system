'use strict';

function canonicalHubTeam(value: unknown): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'luna') return 'investment';
  if (normalized === 'jay') return 'orchestrator';
  return normalized;
}

module.exports = { canonicalHubTeam };
