const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const env = require('../../../../packages/core/lib/env');

const REQUIRED_CLASS_TOPICS = ['ops_work', 'ops_reports', 'ops_error_resolution', 'ops_emergency'];
const LEGACY_TOPIC_KEYS = [
  'general',
  'reservation',
  'ska',
  'investment',
  'luna',
  'claude',
  'claude_lead',
  'blog',
  'darwin',
  'sigma',
  'meeting',
  'emergency',
];
const ENV_TOPIC_KEYS: Record<string, string> = {
  TELEGRAM_TOPIC_GENERAL: 'general',
  TELEGRAM_TOPIC_SKA: 'ska',
  TELEGRAM_TOPIC_LUNA: 'luna',
  TELEGRAM_TOPIC_CLAUDE_LEAD: 'claude_lead',
  TELEGRAM_TOPIC_BLOG: 'blog',
  TELEGRAM_TOPIC_DARWIN: 'darwin',
  TELEGRAM_TOPIC_SIGMA: 'sigma',
  TELEGRAM_TOPIC_MEETING: 'meeting',
  TELEGRAM_TOPIC_EMERGENCY: 'emergency',
  TELEGRAM_TOPIC_OPS_WORK: 'ops_work',
  TELEGRAM_TOPIC_OPS_REPORTS: 'ops_reports',
  TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION: 'ops_error_resolution',
  TELEGRAM_TOPIC_OPS_EMERGENCY: 'ops_emergency',
};

function isEnabled(value: unknown): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isUsable(value: unknown): boolean {
  const text = String(value || '').trim();
  return Boolean(text) && !/^(__SET_|changeme|todo|placeholder|example|replace_me)/i.test(text);
}

function loadSecretStore() {
  const filePath = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function readLaunchctlValue(name: string): string {
  try {
    return String(execFileSync('launchctl', ['getenv', name], { encoding: 'utf8' }) || '').trim();
  } catch {
    return '';
  }
}

function isLaunchdLoaded(label: string): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid == null) return false;
  try {
    execFileSync('launchctl', ['print', `gui/${uid}/${label}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function readPlistEnv(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = execFileSync('plutil', ['-convert', 'json', '-o', '-', filePath], { encoding: 'utf8' });
    const parsed = JSON.parse(raw);
    const plistEnv = parsed?.EnvironmentVariables;
    return plistEnv && typeof plistEnv === 'object' && !Array.isArray(plistEnv) ? plistEnv : {};
  } catch {
    return {};
  }
}

function resolveRuntimeSecret(candidates: Array<{ source: string; value: unknown }>): { ready: boolean; source: string | null } {
  for (const candidate of candidates) {
    if (isUsable(candidate.value)) return { ready: true, source: candidate.source };
  }
  return { ready: false, source: null };
}

function buildLaunchdRuntimeStatus(label: string, requiredEnvKeys: string[]) {
  const installedPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const installedEnv = readPlistEnv(installedPath);
  const envStatus = Object.fromEntries(requiredEnvKeys.map((key) => {
    const resolved = resolveRuntimeSecret([
      { source: `installed:${installedPath}`, value: installedEnv[key] },
      { source: `launchctl:${key}`, value: readLaunchctlValue(key) },
    ]);
    return [key, resolved];
  }));
  return {
    label,
    installed: fs.existsSync(installedPath),
    loaded: isLaunchdLoaded(label),
    installed_path: installedPath,
    required_env: envStatus,
  };
}

function collectTopicSources() {
  const store = loadSecretStore();
  const reservation = store?.reservation || {};
  const telegram = store?.telegram || {};
  const sources: Array<{ key: string; source: string }> = [];

  for (const key of Object.keys(reservation.telegram_topic_ids || {})) {
    if (isUsable(reservation.telegram_topic_ids[key])) sources.push({ key, source: 'reservation' });
  }
  const telegramTopics = telegram.topic_ids || telegram.telegram_topic_ids || {};
  for (const key of Object.keys(telegramTopics || {})) {
    if (isUsable(telegramTopics[key])) sources.push({ key, source: 'telegram' });
  }
  for (const [envKey, key] of Object.entries(ENV_TOPIC_KEYS)) {
    if (isUsable(process.env[envKey])) sources.push({ key, source: 'env' });
  }

  const byKey = new Map<string, string[]>();
  for (const item of sources) {
    byKey.set(item.key, [...(byKey.get(item.key) || []), item.source]);
  }
  return byKey;
}

function collectLegacyTopicKeys() {
  const store = loadSecretStore();
  const reservation = store?.reservation || {};
  const telegram = store?.telegram || {};
  const keys = [
    ...Object.keys(reservation.telegram_topic_ids || {}),
    ...Object.keys(telegram.topic_ids || telegram.telegram_topic_ids || {}),
    ...Object.entries(ENV_TOPIC_KEYS)
      .filter(([envKey]) => isUsable(process.env[envKey]))
      .map(([, key]) => key),
  ].filter((key) => LEGACY_TOPIC_KEYS.includes(key));
  return [...new Set(keys)].sort();
}

export function buildAlarmReadinessSnapshot() {
  const store = loadSecretStore();
  const topicSources = collectTopicSources();
  const classTopicsEnabled = isEnabled(process.env.HUB_ALARM_USE_CLASS_TOPICS)
    || store?.telegram?.topic_alias_mode === 'class_topics';
  const missingClassTopics = REQUIRED_CLASS_TOPICS.filter((key) => !topicSources.has(key));
  const legacyTopicKeys = classTopicsEnabled ? collectLegacyTopicKeys() : [];
  const monitorScripts = {
    noise_report: fs.existsSync(path.join(env.PROJECT_ROOT, 'bots', 'hub', 'scripts', 'alarm-noise-report.ts')),
    stale_auto_repair: fs.existsSync(path.join(env.PROJECT_ROOT, 'bots', 'hub', 'scripts', 'alarm-auto-repair-stale-scan.ts')),
    suppression_proposals: fs.existsSync(path.join(env.PROJECT_ROOT, 'bots', 'hub', 'scripts', 'alarm-suppression-proposals.ts')),
    contract_audit: fs.existsSync(path.join(env.PROJECT_ROOT, 'bots', 'hub', 'scripts', 'alarm-contract-audit.ts')),
  };
  const launchd = {
    noise_report: fs.existsSync(path.join(env.PROJECT_ROOT, 'bots', 'hub', 'launchd', 'ai.hub.alarm-noise-report.plist')),
    stale_auto_repair: fs.existsSync(path.join(env.PROJECT_ROOT, 'bots', 'hub', 'launchd', 'ai.hub.alarm-stale-auto-repair.plist')),
  };
  const runtimeLaunchd = {
    stale_auto_repair: buildLaunchdRuntimeStatus('ai.hub.alarm-stale-auto-repair', ['HUB_AUTH_TOKEN']),
  };
  const missingMonitors = Object.entries({ ...monitorScripts, ...launchd })
    .filter(([, ok]) => !ok)
    .map(([key]) => key);
  const operationalMissing = [
    runtimeLaunchd.stale_auto_repair.installed ? null : 'stale_auto_repair_installed_launchagent',
    runtimeLaunchd.stale_auto_repair.loaded ? null : 'stale_auto_repair_loaded_launchagent',
    runtimeLaunchd.stale_auto_repair.required_env.HUB_AUTH_TOKEN.ready ? null : 'stale_auto_repair_hub_auth_token',
  ].filter(Boolean);
  const ok = (!classTopicsEnabled || missingClassTopics.length === 0)
    && legacyTopicKeys.length === 0
    && missingMonitors.length === 0
    && operationalMissing.length === 0;

  return {
    ok,
    status: ok ? 'pass' : 'warn',
    class_topics: {
      enabled: classTopicsEnabled,
      ready: !classTopicsEnabled || missingClassTopics.length === 0,
      required_keys: REQUIRED_CLASS_TOPICS,
      configured_keys: [...topicSources.keys()].sort(),
      missing_keys: missingClassTopics,
      legacy_active_keys: legacyTopicKeys,
      sources_by_key: Object.fromEntries([...topicSources.entries()].sort()),
    },
    monitors: {
      scripts: monitorScripts,
      launchd,
      runtime_launchd: runtimeLaunchd,
      missing: missingMonitors,
      operational_missing: operationalMissing,
    },
  };
}
