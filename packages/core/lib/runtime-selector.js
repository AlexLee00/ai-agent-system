'use strict';

const { fetchHubRuntimeProfile } = require('./hub-client');
const env = require('./env');

let _localSelectRuntimeProfile = null;

function _getLocalSelectRuntimeProfile() {
  if (_localSelectRuntimeProfile) return _localSelectRuntimeProfile;
  try {
    ({ selectRuntimeProfile: _localSelectRuntimeProfile } = require(env.projectPath('bots', 'hub', 'lib', 'runtime-profiles')));
  } catch {
    _localSelectRuntimeProfile = null;
  }
  return _localSelectRuntimeProfile;
}

async function selectRuntime(team, purpose = 'default') {
  const normalizedTeam = String(team || '').trim();
  const normalizedPurpose = String(purpose || 'default').trim() || 'default';
  if (!normalizedTeam) return null;
  try {
    const hubProfile = await fetchHubRuntimeProfile(normalizedTeam, normalizedPurpose);
    if (hubProfile) return hubProfile;
  } catch {
    // fall through to local runtime profiles
  }
  const localSelectRuntimeProfile = _getLocalSelectRuntimeProfile();
  if (!localSelectRuntimeProfile) return null;
  try {
    return localSelectRuntimeProfile(normalizedTeam, normalizedPurpose);
  } catch {
    return null;
  }
}

module.exports = {
  selectRuntime,
};
