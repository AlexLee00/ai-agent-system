import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const { isExpectedIdleService, isOptionalService } = require('./service-ownership');

type HealthState = Record<string, string>;

const AI_AGENT_HOME = process.env.AI_AGENT_HOME
  || process.env.JAY_HOME
  || path.join(os.homedir(), '.ai-agent-system');
const AI_AGENT_WORKSPACE = process.env.AI_AGENT_WORKSPACE
  || process.env.JAY_WORKSPACE
  || path.join(AI_AGENT_HOME, 'workspace');

const STATE_FILE = path.join(AI_AGENT_WORKSPACE, 'health-check-state.json');
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

const TEAM_PREFIXES: Record<string, string> = {
  ska: 'ai.ska.',
  claude: 'ai.claude.',
  luna: 'ai.investment.',
  blog: 'ai.blog.',
};

const EXTRA_TEAM_PREFIXES: Record<string, string[]> = {
  luna: ['ai.luna.', 'ai.elixir.supervisor'],
  platform: ['ai.hub.'],
};

const DEV_SERVICES = new Set([
  'ai.claude.dexter.quick',
  'ai.claude.dexter.full',
  'ai.claude.dexter',
  'ai.claude.dexter.daily',
  'ai.claude.archer',
  'ai.claude.auto-dev',
  'ai.claude.auto-dev.shadow',
  'ai.claude.auto-dev.autonomous',
  'ai.claude.health-dashboard',
  'ai.claude.health-check',
  'ai.ska.health-check',
  'ai.luna.ops-scheduler',
  'ai.blog.health-check',
]);

function loadState(): HealthState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as HealthState;
  } catch {
    return {};
  }
}

function saveState(state: HealthState): boolean {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return true;
  } catch (error) {
    console.error(`[health-state-manager] 상태 저장 실패: ${(error as Error).message}`);
    return false;
  }
}

function canAlert(state: HealthState, key: string): boolean {
  const last = state[key];
  if (!last) return true;
  return Date.now() - new Date(last).getTime() > ALERT_COOLDOWN_MS;
}

function recordAlert(state: HealthState, key: string): void {
  state[key] = new Date().toISOString();
}

function clearAlert(state: HealthState, key: string, prefix = false): void {
  if (prefix) {
    Object.keys(state)
      .filter((entryKey) => entryKey.startsWith(key))
      .forEach((entryKey) => delete state[entryKey]);
  } else {
    delete state[key];
  }
}

function getTeam(label: string): string | null {
  for (const [team, prefix] of Object.entries(TEAM_PREFIXES)) {
    if (label.startsWith(prefix)) return team;
  }
  for (const [team, prefixes] of Object.entries(EXTRA_TEAM_PREFIXES)) {
    if (prefixes.some((prefix) => label.startsWith(prefix))) return team;
  }
  return null;
}

function isDevService(label: string): boolean {
  return DEV_SERVICES.has(label);
}

function getAlertTag(label: string): string {
  return isDevService(label) ? '[점검] ' : '';
}

function getAlertLevel(label: string): number {
  return isDevService(label) ? 2 : 3;
}

function parseLabelFromKey(key: string): string {
  const parts = key.split(':');
  if (parts.length < 2) return key;
  const isExitCode = parts[0] === 'exitcode' && /^\d+$/.test(parts[parts.length - 1]);
  return isExitCode ? parts.slice(1, -1).join(':') : parts.slice(1).join(':');
}

function shortLabel(label: string): string {
  return label.replace(/^ai\.[a-z-]+\./, '');
}

function isExpectedIdleHealthService(label: string): boolean {
  return isExpectedIdleService(label);
}

function isOptionalHealthService(label: string): boolean {
  return isOptionalService(label);
}

export = {
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
  isExpectedIdleHealthService,
  isOptionalHealthService,
  TEAM_PREFIXES,
  EXTRA_TEAM_PREFIXES,
  DEV_SERVICES,
};
