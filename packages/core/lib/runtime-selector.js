'use strict';

const { fetchHubRuntimeProfile } = require('./hub-client');

async function selectRuntime(team, purpose = 'default') {
  const normalizedTeam = String(team || '').trim();
  const normalizedPurpose = String(purpose || 'default').trim() || 'default';
  if (!normalizedTeam) return null;
  try {
    return await fetchHubRuntimeProfile(normalizedTeam, normalizedPurpose);
  } catch {
    return null;
  }
}

module.exports = {
  selectRuntime,
};
