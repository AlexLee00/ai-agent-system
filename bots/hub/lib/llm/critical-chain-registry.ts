// Critical Chain Registry
// Identifies team/agent combos where local LLMs must be excluded (realtime decisions)
// Used by unified-caller to enable aggressive (immediate) fallback on first failure.

import { selectRuntimeProfile } from '../runtime-profiles';

export function isCriticalChain(team: string, agent: string): boolean {
  const profile = selectRuntimeProfile(team, agent);
  return profile?.critical === true;
}

export function getTimeoutForChain(team: string, agent: string): number {
  const profile = selectRuntimeProfile(team, agent);
  return profile?.timeout_ms ?? 30_000;
}

// Returns all critical chains in PROFILES for documentation/monitoring
export function listCriticalChains(): Array<{ team: string; agent: string; timeout_ms: number }> {
  const { PROFILES } = require('../runtime-profiles');
  const result: Array<{ team: string; agent: string; timeout_ms: number }> = [];
  for (const [team, agents] of Object.entries(PROFILES as Record<string, Record<string, any>>)) {
    for (const [agent, profile] of Object.entries(agents)) {
      if (profile?.critical === true) {
        result.push({ team, agent, timeout_ms: profile.timeout_ms ?? 30_000 });
      }
    }
  }
  return result;
}
