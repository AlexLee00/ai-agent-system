'use strict';

type TimeoutTier = 'short' | 'medium' | 'long';

type SelectorTimeoutResolution = {
  enabled: boolean;
  selectorKey: string;
  timeoutMs: number | null;
  tier: string | null;
  source: string;
};

const { resolveSelectorTimeoutProfile }: {
  resolveSelectorTimeoutProfile: (
    selectorKey: string,
    options?: { env?: NodeJS.ProcessEnv; fallbackTimeoutMs?: number | null; runtimePurpose?: string },
  ) => SelectorTimeoutResolution;
} = require('../../../packages/core/lib/selector-timeout-profiles');

const DARWIN_SELECTOR_KEY = 'darwin.agent_policy';

const PROFILE_PURPOSE_BY_TIER: Record<TimeoutTier, string> = {
  short: 'evaluator',
  medium: 'implementation',
  long: 'synthesis',
};

const LEGACY_ENV_BY_PURPOSE: Record<string, string> = {
  synthesis: 'DARWIN_APPLICATOR_PROPOSAL_TIMEOUT_MS',
  edison: 'DARWIN_APPLICATOR_PROTOTYPE_TIMEOUT_MS',
  success_predicate: 'DARWIN_APPLICATOR_PROPOSAL_TIMEOUT_MS',
};

function selectorTimeoutEnvName(selectorKey: string): string {
  return `SELECTOR_TIMEOUT_MS_${selectorKey.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function resolveDarwinTimeoutPurpose(purpose: string): string {
  const key = String(purpose || '').toLowerCase();
  if (/evaluat|judge|score/.test(key)) return 'evaluator';
  if (/predicate/.test(key)) return 'success_predicate';
  if (/edison|prototype/.test(key)) return 'edison';
  if (/synth|proposal/.test(key)) return 'synthesis';
  if (/skill/.test(key)) return 'skill_generation';
  if (/scanner/.test(key)) return 'scanner';
  return 'implementation';
}

function resolveDarwinTimeoutProfileKey(_purpose: string): string {
  return DARWIN_SELECTOR_KEY;
}

function profileEnv(purpose: string, envObj: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...envObj, SELECTOR_TIMEOUT_PROFILES_ENABLED: 'true' };
  const actualEnvName = selectorTimeoutEnvName(DARWIN_SELECTOR_KEY);
  const purposeEnvName = selectorTimeoutEnvName(`darwin.${purpose}`);
  const legacyEnvName = LEGACY_ENV_BY_PURPOSE[purpose];
  if (!env[actualEnvName] && env[purposeEnvName]) {
    env[actualEnvName] = env[purposeEnvName];
  }
  if (!env[actualEnvName] && legacyEnvName && env[legacyEnvName]) {
    env[actualEnvName] = env[legacyEnvName];
  }
  return env;
}

function resolveDarwinLlmTimeoutProfile(
  purpose: string,
  envObj: NodeJS.ProcessEnv = process.env,
): SelectorTimeoutResolution {
  const timeoutPurpose = resolveDarwinTimeoutPurpose(purpose);
  return resolveSelectorTimeoutProfile(DARWIN_SELECTOR_KEY, {
    env: profileEnv(timeoutPurpose, envObj),
    runtimePurpose: timeoutPurpose,
  });
}

function timeoutFromResolution(resolution: SelectorTimeoutResolution): number {
  if (!resolution.timeoutMs) {
    throw new Error(`Darwin timeout profile missing: ${resolution.selectorKey}`);
  }
  return resolution.timeoutMs;
}

function getDarwinTimeoutTier(tier: TimeoutTier): number {
  const purpose = PROFILE_PURPOSE_BY_TIER[tier] || PROFILE_PURPOSE_BY_TIER.medium;
  return timeoutFromResolution(resolveSelectorTimeoutProfile(DARWIN_SELECTOR_KEY, {
    env: { SELECTOR_TIMEOUT_PROFILES_ENABLED: 'true' },
    runtimePurpose: purpose,
  }));
}

function resolveDarwinTimeoutTier(purpose: string): TimeoutTier {
  const timeoutPurpose = resolveDarwinTimeoutPurpose(purpose);
  if (timeoutPurpose === PROFILE_PURPOSE_BY_TIER.short) return 'short';
  if (timeoutPurpose === PROFILE_PURPOSE_BY_TIER.medium || timeoutPurpose === 'scanner' || timeoutPurpose === 'skill_generation') return 'medium';
  return 'long';
}

function getDarwinLlmTimeout(purpose: string, envObj: NodeJS.ProcessEnv = process.env): number {
  return timeoutFromResolution(resolveDarwinLlmTimeoutProfile(purpose, envObj));
}

const DARWIN_LLM_TIMEOUT_TIER_MS: Record<TimeoutTier, number> = {
  short: getDarwinTimeoutTier('short'),
  medium: getDarwinTimeoutTier('medium'),
  long: getDarwinTimeoutTier('long'),
};

module.exports = {
  DARWIN_LLM_TIMEOUT_TIER_MS,
  getDarwinTimeoutTier,
  resolveDarwinTimeoutTier,
  resolveDarwinTimeoutProfileKey,
  resolveDarwinLlmTimeoutProfile,
  getDarwinLlmTimeout,
};
