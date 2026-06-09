const fs = require('fs');
const path = require('path');
const env = require('../../../../packages/core/lib/env');

const STORE_FILE = process.env.HUB_OAUTH_STORE_FILE
  || path.join(env.PROJECT_ROOT, 'bots', 'hub', 'output', 'oauth', 'token-store.json');

type OAuthProviderRecord = {
  token?: string | null;
  metadata?: Record<string, unknown>;
  canary?: Record<string, unknown>;
  updatedAt?: string;
};

type OAuthStore = {
  providers: Record<string, OAuthProviderRecord>;
};

type CanaryInput = {
  ok?: boolean;
  error?: unknown;
  details?: unknown;
};

let cache: OAuthStore | null = null;
let cacheMtimeMs: number | null = null;

function ensureStoreShape(raw: unknown): OAuthStore {
  if (!raw || typeof raw !== 'object') return { providers: {} };
  const candidate = raw as { providers?: unknown };
  if (!candidate.providers || typeof candidate.providers !== 'object') return { providers: {} };
  return { providers: candidate.providers as Record<string, OAuthProviderRecord> };
}

function readStore() {
  try {
    if (!fs.existsSync(STORE_FILE)) {
      cache = { providers: {} };
      cacheMtimeMs = null;
      return cache;
    }
    const stat = fs.statSync(STORE_FILE);
    if (cache && cacheMtimeMs === stat.mtimeMs) return cache;
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    cache = ensureStoreShape(parsed);
    cacheMtimeMs = stat.mtimeMs;
    return cache;
  } catch {
    cache = { providers: {} };
    cacheMtimeMs = null;
    return cache;
  }
}

function writeStore(next: unknown) {
  cache = ensureStoreShape(next);
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  const tmpFile = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(cache, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpFile, STORE_FILE);
  try {
    cacheMtimeMs = fs.statSync(STORE_FILE).mtimeMs;
  } catch {
    cacheMtimeMs = null;
  }
  try {
    fs.chmodSync(STORE_FILE, 0o600);
  } catch {
    // Best-effort on filesystems that do not support chmod.
  }
}

function updateProvider(provider: string, updater: (entry: OAuthProviderRecord) => OAuthProviderRecord) {
  const current = readStore();
  const prev = current.providers?.[provider] || {};
  const nextEntry = updater(prev) || prev;
  const next = {
    providers: {
      ...current.providers,
      [provider]: nextEntry,
    },
  };
  writeStore(next);
}

function getOAuthStoreFilePath() {
  return STORE_FILE;
}

function getProviderRecord(provider: string) {
  const current = readStore();
  return current.providers?.[provider] || {};
}

function setProviderToken(provider: string, token: string | null, metadata: Record<string, unknown> = {}) {
  updateProvider(provider, (entry) => ({
    ...entry,
    token: token || null,
    metadata: {
      ...(entry.metadata || {}),
      ...(metadata || {}),
    },
    updatedAt: new Date().toISOString(),
  }));
}

function clearProviderToken(provider: string) {
  updateProvider(provider, (entry) => ({
    ...entry,
    token: null,
    updatedAt: new Date().toISOString(),
  }));
}

function setProviderCanary(provider: string, canary: CanaryInput) {
  updateProvider(provider, (entry) => ({
    ...entry,
    canary: {
      ok: Boolean(canary?.ok),
      checkedAt: new Date().toISOString(),
      ...(canary?.error ? { error: String(canary.error) } : {}),
      ...(canary?.details ? { details: canary.details } : {}),
    },
    updatedAt: new Date().toISOString(),
  }));
}

module.exports = {
  getOAuthStoreFilePath,
  getProviderRecord,
  setProviderToken,
  clearProviderToken,
  setProviderCanary,
};
