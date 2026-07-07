import env = require('./env');
import { fetchHubRuntimeProfile } from './hub-client.js';

type RuntimeProfileSelector = (team: string, purpose: string) => unknown;
type RuntimeProfileSelectorKeyLookup = (selectorKey: string) => unknown;

let localSelectRuntimeProfile: RuntimeProfileSelector | null = null;
let localSelectRuntimeProfileForSelectorKey: RuntimeProfileSelectorKeyLookup | null = null;

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

function getLocalSelectRuntimeProfileForSelectorKey(): RuntimeProfileSelectorKeyLookup | null {
  if (localSelectRuntimeProfileForSelectorKey) return localSelectRuntimeProfileForSelectorKey;
  try {
    const runtimeProfiles = require(env.projectPath('bots', 'hub', 'lib', 'runtime-profiles')) as {
      selectRuntimeProfileForSelectorKey?: RuntimeProfileSelectorKeyLookup;
    };
    localSelectRuntimeProfileForSelectorKey = runtimeProfiles.selectRuntimeProfileForSelectorKey || null;
  } catch {
    localSelectRuntimeProfileForSelectorKey = null;
  }
  return localSelectRuntimeProfileForSelectorKey;
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

export function selectLocalRuntimeProfileForSelectorKey(selectorKey: string | null | undefined): unknown | null {
  const normalizedSelectorKey = String(selectorKey || '').trim();
  if (!normalizedSelectorKey) return null;
  const selector = getLocalSelectRuntimeProfileForSelectorKey();
  if (!selector) return null;
  try {
    return selector(normalizedSelectorKey);
  } catch {
    return null;
  }
}
