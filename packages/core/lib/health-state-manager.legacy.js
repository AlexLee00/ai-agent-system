'use strict';

/**
 * packages/core/lib/health-state-manager.js — 전 팀 공통 헬스 상태 관리자
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const STATE_FILE = path.join(os.homedir(), '.openclaw', 'workspace', 'health-check-state.json');
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

const TEAM_PREFIXES = {
  ska:    'ai.ska.',
  claude: 'ai.claude.',
  luna:   'ai.investment.',
  blog:   'ai.blog.',
  worker: 'ai.worker.',
};

const DEV_SERVICES = new Set([
  'ai.claude.dexter.quick',
  'ai.claude.dexter.full',
  'ai.claude.dexter',
  'ai.claude.dexter.daily',
  'ai.claude.archer',
  'ai.claude.health-dashboard',
  'ai.claude.health-check',
  'ai.ska.health-check',
  'ai.investment.health-check',
  'ai.blog.health-check',
  'ai.worker.health-check',
]);

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return true;
  } catch (e) {
    console.error(`[health-state-manager] 상태 저장 실패: ${e.message}`);
    return false;
  }
}

function canAlert(state, key) {
  const last = state[key];
  if (!last) return true;
  return Date.now() - new Date(last).getTime() > ALERT_COOLDOWN_MS;
}

function recordAlert(state, key) {
  state[key] = new Date().toISOString();
}

function clearAlert(state, key, prefix = false) {
  if (prefix) {
    Object.keys(state).filter(k => k.startsWith(key)).forEach(k => delete state[k]);
  } else {
    delete state[key];
  }
}

function getTeam(label) {
  for (const [team, prefix] of Object.entries(TEAM_PREFIXES)) {
    if (label.startsWith(prefix)) return team;
  }
  return null;
}

function isDevService(label) {
  return DEV_SERVICES.has(label);
}

function getAlertTag(label) {
  return isDevService(label) ? '[점검] ' : '';
}

function getAlertLevel(label) {
  return isDevService(label) ? 2 : 3;
}

function parseLabelFromKey(key) {
  const parts = key.split(':');
  if (parts.length < 2) return key;
  const isExitCode = parts[0] === 'exitcode' && /^\d+$/.test(parts[parts.length - 1]);
  return isExitCode
    ? parts.slice(1, -1).join(':')
    : parts.slice(1).join(':');
}

function shortLabel(label) {
  return label.replace(/^ai\.[a-z-]+\./, '');
}

module.exports = {
  STATE_FILE,
  loadState,
  saveState,
  canAlert,
  recordAlert,
  clearAlert,
  ALERT_COOLDOWN_MS,
  getTeam,
  isDevService,
  getAlertTag,
  getAlertLevel,
  parseLabelFromKey,
  shortLabel,
  TEAM_PREFIXES,
  DEV_SERVICES,
};
