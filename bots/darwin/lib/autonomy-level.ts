'use strict';

/**
 * 다윈 자율 레벨 관리
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const env: { PROJECT_ROOT: string } = require('../../../packages/core/lib/env');

type AutonomyLevel = 'L3' | 'L4' | 'L5';

interface AutonomyState {
  level: AutonomyLevel;
  reason: string;
  updated_at: string | null;
  error_count: number;
  last_error: string | null;
  consecutiveSuccesses: number;
  appliedSuccesses: number;
  upgradedAt: string | null;
}

const STATE_FILE = path.join(env.PROJECT_ROOT, 'bots/darwin/sandbox/darwin-autonomy-level.json');
const AUTONOMY_PROMOTION_THRESHOLDS = Object.freeze({
  l4ConsecutiveSuccesses: 5,
  l5ConsecutiveSuccesses: 10,
  l5AppliedSuccesses: 3,
});

const DEFAULT_STATE: AutonomyState = {
  level: 'L4',
  reason: 'master_approval_required',
  updated_at: null,
  error_count: 0,
  last_error: null,
  consecutiveSuccesses: 0,
  appliedSuccesses: 0,
  upgradedAt: null,
};

function normalizeLevel(level: unknown): AutonomyLevel {
  if (typeof level === 'number') {
    if (level >= 5) return 'L5';
    if (level <= 3) return 'L3';
    return 'L4';
  }

  const raw = String(level || '').trim().toUpperCase();
  if (raw === '5' || raw === 'L5') return 'L5';
  if (raw === '3' || raw === 'L3') return 'L3';
  return 'L4';
}

function lowerLevel(left: AutonomyLevel, right: AutonomyLevel): AutonomyLevel {
  const rank: Record<AutonomyLevel, number> = { L3: 3, L4: 4, L5: 5 };
  return rank[left] <= rank[right] ? left : right;
}

function ensureStateDir() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function errorMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message?: unknown }).message || 'unknown error')
    : String(error || 'unknown error');
}

function killSwitchOn(): boolean {
  return String(process.env.DARWIN_KILL_SWITCH || 'false').trim().toLowerCase() === 'true';
}

function loadState(): AutonomyState {
  ensureStateDir();
  const envLevel = process.env.DARWIN_AUTONOMY_LEVEL;
  try {
    const merged: AutonomyState = {
      ...DEFAULT_STATE,
      ...(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<AutonomyState>),
    };
    const persistedLevel = normalizeLevel(merged.level);
    merged.level = envLevel ? lowerLevel(persistedLevel, normalizeLevel(envLevel)) : persistedLevel;
    merged.error_count = count(merged.error_count);
    merged.consecutiveSuccesses = count(merged.consecutiveSuccesses);
    merged.appliedSuccesses = count(merged.appliedSuccesses);
    return merged;
  } catch {
    const defaultLevel = normalizeLevel(DEFAULT_STATE.level);
    return {
      ...DEFAULT_STATE,
      level: envLevel ? lowerLevel(defaultLevel, normalizeLevel(envLevel)) : defaultLevel,
    };
  }
}

function saveState(state: Partial<AutonomyState>): AutonomyState {
  ensureStateDir();
  const nextState: AutonomyState = {
    ...DEFAULT_STATE,
    ...state,
    level: normalizeLevel(state?.level),
    error_count: count(state?.error_count),
    consecutiveSuccesses: count(state?.consecutiveSuccesses),
    appliedSuccesses: count(state?.appliedSuccesses),
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(nextState, null, 2), 'utf8');
  return nextState;
}

function setLevel(level: unknown, reason = ''): AutonomyState {
  return saveState({
    ...loadState(),
    level: normalizeLevel(level),
    reason,
  });
}

function evaluatePromotion(state: AutonomyState): AutonomyState {
  const level = normalizeLevel(state.level);
  const consecutiveSuccesses = count(state.consecutiveSuccesses);
  const appliedSuccesses = count(state.appliedSuccesses);
  const eligibleForL4 = level === 'L3'
    && consecutiveSuccesses >= AUTONOMY_PROMOTION_THRESHOLDS.l4ConsecutiveSuccesses;
  const eligibleForL5 = level === 'L4'
    && consecutiveSuccesses >= AUTONOMY_PROMOTION_THRESHOLDS.l5ConsecutiveSuccesses
    && appliedSuccesses >= AUTONOMY_PROMOTION_THRESHOLDS.l5AppliedSuccesses;

  if (killSwitchOn() && (eligibleForL4 || eligibleForL5)) {
    return saveState({
      ...state,
      level,
      consecutiveSuccesses,
      appliedSuccesses,
      reason: 'promotion_blocked_by_kill_switch',
    });
  }

  if (eligibleForL4 || eligibleForL5) {
    return saveState({
      ...state,
      level: eligibleForL5 ? 'L5' : 'L4',
      consecutiveSuccesses,
      appliedSuccesses,
      reason: 'auto_recovery',
      upgradedAt: new Date().toISOString(),
    });
  }

  return saveState({
    ...state,
    level,
    consecutiveSuccesses,
    appliedSuccesses,
  });
}

function recordVerifiedSuccess(): AutonomyState {
  const current = loadState();
  return evaluatePromotion({
    ...current,
    consecutiveSuccesses: count(current.consecutiveSuccesses) + 1,
  });
}

function recordMergeSuccess(): AutonomyState {
  const current = loadState();
  return evaluatePromotion({
    ...current,
    appliedSuccesses: count(current.appliedSuccesses) + 1,
  });
}

function recordMergeFailure(error: unknown): AutonomyState {
  const current = loadState();
  return saveState({
    ...current,
    reason: 'merge_failed_after_verification',
    consecutiveSuccesses: 0,
    last_error: errorMessage(error),
  });
}

function recordError(error: unknown): AutonomyState {
  const current = loadState();
  return saveState({
    ...current,
    level: 'L3',
    reason: 'auto_demotion_after_error',
    error_count: Number(current.error_count || 0) + 1,
    consecutiveSuccesses: 0,
    last_error: errorMessage(error),
  });
}

function requiresApproval(): boolean {
  if (killSwitchOn()) return true;
  if (String(process.env.DARWIN_L5_ENABLED || '').trim().toLowerCase() !== 'true') return true;
  if (String(process.env.DARWIN_TIER2_AUTO_APPLY || '').trim().toLowerCase() !== 'true') return true;
  return loadState().level !== 'L5';
}

module.exports = {
  STATE_FILE,
  AUTONOMY_PROMOTION_THRESHOLDS,
  loadState,
  saveState,
  setLevel,
  recordVerifiedSuccess,
  recordMergeSuccess,
  recordMergeFailure,
  recordError,
  requiresApproval,
};
