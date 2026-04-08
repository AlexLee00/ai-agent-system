import env = require('./env');
import { fetchHubRuntimeProfile } from './hub-client.js';

type RuntimeProfileSelector = (team: string, purpose: string) => unknown;

let localSelectRuntimeProfile: RuntimeProfileSelector | null = null;

function getLocalSelectRuntimeProfile(): RuntimeProfileSelector | null {
  if (localSelectRuntimeProfile) return localSelectRuntimeProfile;
  try {
    const runtimeProfiles = require(env.projectPath('bots', 'hub', 'lib', 'runtime-profiles')) as {
      selectRuntimeProfile?: RuntimeProfileSelector;
    };
    localSelectRuntimeProfile = runtimeProfiles.selectRuntimeProfile || null;
  } catch {
    localSelectRuntimeProfile = null;
  }
  return localSelectRuntimeProfile;
}

export async function selectRuntime(team: string, purpose = 'default'): Promise<unknown | null> {
  const normalizedTeam = String(team || '').trim();
  const normalizedPurpose = String(purpose || 'default').trim() || 'default';
  if (!normalizedTeam) return null;
  try {
    const hubProfile = await fetchHubRuntimeProfile(normalizedTeam, normalizedPurpose);
    if (hubProfile) return hubProfile;
  } catch {}

  const selector = getLocalSelectRuntimeProfile();
  if (!selector) return null;
  try {
    return selector(normalizedTeam, normalizedPurpose);
  } catch {
    return null;
  }
}
