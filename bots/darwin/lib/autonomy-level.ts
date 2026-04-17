// @ts-nocheck
'use strict';

/**
 * 다윈 자율 레벨 관리
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'sandbox', 'darwin-autonomy-level.json');
const DEFAULT_STATE = {
  level: 'L4',
  reason: 'master_approval_required',
  updated_at: null,
  error_count: 0,
  last_error: null,
};

function ensureStateDir() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
}

function loadState() {
  ensureStateDir();
  try {
    return {
      ...DEFAULT_STATE,
      ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')),
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state) {
  ensureStateDir();
  const nextState = {
    ...DEFAULT_STATE,
    ...state,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(nextState, null, 2), 'utf8');
  return nextState;
}

function setLevel(level, reason = '') {
  return saveState({
    ...loadState(),
    level,
    reason,
  });
}

function recordError(error) {
  const current = loadState();
  return saveState({
    ...current,
    level: 'L3',
    reason: 'auto_demotion_after_error',
    error_count: Number(current.error_count || 0) + 1,
    last_error: String(error?.message || error || 'unknown error'),
  });
}

function requiresApproval() {
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
