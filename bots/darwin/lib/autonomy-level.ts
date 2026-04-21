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
}

const STATE_FILE = path.join(env.PROJECT_ROOT, 'bots/darwin/sandbox/darwin-autonomy-level.json');

const DEFAULT_STATE: AutonomyState = {
  level: 'L4',
  reason: 'master_approval_required',
  updated_at: null,
  error_count: 0,
  last_error: null,
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

function ensureStateDir() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
}

function loadState(): AutonomyState {
  ensureStateDir();
  const envLevel = process.env.DARWIN_AUTONOMY_LEVEL;
  try {
    const merged: AutonomyState = {
      ...DEFAULT_STATE,
      ...(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<AutonomyState>),
    };
    merged.level = normalizeLevel(envLevel || merged.level);
    return merged;
  } catch {
    return {
      ...DEFAULT_STATE,
      level: normalizeLevel(envLevel || DEFAULT_STATE.level),
    };
  }
}

function saveState(state: Partial<AutonomyState>): AutonomyState {
  ensureStateDir();
  const nextState: AutonomyState = {
    ...DEFAULT_STATE,
    ...state,
    level: normalizeLevel(state?.level),
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

function recordError(error: unknown): AutonomyState {
  const errorMessage =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message?: unknown }).message || 'unknown error')
      : String(error || 'unknown error');

  const current = loadState();
  return saveState({
    ...current,
    level: 'L3',
    reason: 'auto_demotion_after_error',
    error_count: Number(current.error_count || 0) + 1,
    last_error: errorMessage,
  });
}

function requiresApproval(): boolean {
  return loadState().level !== 'L5';
}

module.exports = {
  STATE_FILE,
  loadState,
  saveState,
  setLevel,
  recordError,
  requiresApproval,
};
