'use strict';

const BLOCKED_PREFIXES = [
  'AI_AGENT_',
  'BROWSER_',
  'CLAUDE_CODE_',
  'GEMINI_',
  'HUB_',
  'OPENCLAW_',
  'OPENAI_',
  'PG_',
  'PLAYWRIGHT_',
  'TELEGRAM_',
];

const BLOCKED_EXACT = new Set([
  'ANTHROPIC_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GROQ_API_KEY',
]);

const BLOCKED_KEY_FRAGMENTS = [
  'ACCESS_TOKEN',
  'API_KEY',
  'AUTH_TOKEN',
  'CLIENT_SECRET',
  'PASSWORD',
  'REFRESH_TOKEN',
  'SECRET',
  'TOKEN',
];

function normalizeEnvKey(key) {
  return String(key || '').trim().toUpperCase();
}

function isBlockedRuntimeEnvKey(key) {
  const normalized = normalizeEnvKey(key);
  if (!normalized) return false;
  if (BLOCKED_EXACT.has(normalized)) return true;
  if (BLOCKED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  return BLOCKED_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function filterUntrustedEnvPatch(patch = {}, options = {}) {
  const source = String(options.source || 'untrusted').trim() || 'untrusted';
  const allowed = {};
  const blocked = [];
  if (!patch || typeof patch !== 'object') {
    return { env: allowed, allowed, blocked };
  }

  for (const [rawKey, rawValue] of Object.entries(patch)) {
    const key = String(rawKey || '').trim();
    if (!key) continue;
    if (isBlockedRuntimeEnvKey(key)) {
      blocked.push({ key, source, reason: 'runtime_env_control_blocked' });
      continue;
    }
    if (rawValue == null) continue;
    allowed[key] = String(rawValue);
  }

  return { env: allowed, allowed, blocked };
}

function mergeTrustedEnvWithUntrustedPatch(baseEnv = process.env, patch = {}, options = {}) {
  const filtered = filterUntrustedEnvPatch(patch, options);
  return {
    env: {
      ...(baseEnv || {}),
      ...filtered.env,
    },
    allowed: filtered.allowed,
    blocked: filtered.blocked,
  };
}

module.exports = {
  BLOCKED_EXACT,
  BLOCKED_KEY_FRAGMENTS,
  BLOCKED_PREFIXES,
  filterUntrustedEnvPatch,
  isBlockedRuntimeEnvKey,
  mergeTrustedEnvWithUntrustedPatch,
  normalizeEnvKey,
};

