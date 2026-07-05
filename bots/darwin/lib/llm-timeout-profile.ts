'use strict';

type TimeoutTier = 'short' | 'medium' | 'long';

const DARWIN_LLM_TIMEOUT_TIER_MS: Record<TimeoutTier, number> = {
  short: 25_000,
  medium: 45_000,
  long: 120_000,
};

const DEFAULT_MIN_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_TIMEOUT_MS = 180_000;

function clampTimeoutMs(value: number, minMs = DEFAULT_MIN_TIMEOUT_MS, maxMs = DEFAULT_MAX_TIMEOUT_MS): number {
  if (!Number.isFinite(value) || value <= 0) return minMs;
  return Math.min(maxMs, Math.max(minMs, Math.trunc(value)));
}

function readDarwinTimeoutOverride(
  envName: string,
  fallbackMs: number,
  envObj: NodeJS.ProcessEnv = process.env,
  options: { minMs?: number; maxMs?: number } = {},
): number {
  const raw = Number.parseInt(String(envObj[envName] || ''), 10);
  if (!Number.isFinite(raw) || raw <= 0) return fallbackMs;
  return clampTimeoutMs(raw, options.minMs, options.maxMs);
}

function getDarwinTimeoutTier(tier: TimeoutTier): number {
  return DARWIN_LLM_TIMEOUT_TIER_MS[tier] || DARWIN_LLM_TIMEOUT_TIER_MS.medium;
}

function resolveDarwinTimeoutTier(purpose: string): TimeoutTier {
  const key = String(purpose || '').toLowerCase();
  if (/evaluat|judge|score/.test(key)) return 'short';
  if (/edison|synth|proposal|prototype|predicate/.test(key)) return 'long';
  if (/implement|skill/.test(key)) return 'medium';
  return 'medium';
}

function getDarwinLlmTimeout(purpose: string): number {
  return getDarwinTimeoutTier(resolveDarwinTimeoutTier(purpose));
}

module.exports = {
  DARWIN_LLM_TIMEOUT_TIER_MS,
  clampTimeoutMs,
  readDarwinTimeoutOverride,
  getDarwinTimeoutTier,
  resolveDarwinTimeoutTier,
  getDarwinLlmTimeout,
};
