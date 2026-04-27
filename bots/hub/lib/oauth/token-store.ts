const fs = require('fs');
const path = require('path');
const env = require('../../../../packages/core/lib/env');

const STORE_FILE = process.env.HUB_OAUTH_STORE_FILE
  || path.join(env.PROJECT_ROOT, 'bots', 'hub', 'output', 'oauth', 'token-store.json');

let cache = null;

function ensureStoreShape(raw) {
  if (!raw || typeof raw !== 'object') return { providers: {} };
  if (!raw.providers || typeof raw.providers !== 'object') return { providers: {} };
  return { providers: raw.providers };
}

function readStore() {
  if (cache) return cache;
  try {
    if (!fs.existsSync(STORE_FILE)) {
      cache = { providers: {} };
      return cache;
    }
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    cache = ensureStoreShape(parsed);
    return cache;
  } catch {
    cache = { providers: {} };
    return cache;
  }
}

function writeStore(next) {
  cache = ensureStoreShape(next);
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  const tmpFile = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(cache, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpFile, STORE_FILE);
  try {
    fs.chmodSync(STORE_FILE, 0o600);
  } catch {
    // Best-effort on filesystems that do not support chmod.
  }
}

function updateProvider(provider, updater) {
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

function getProviderRecord(provider) {
  const current = readStore();
  return current.providers?.[provider] || {};
}

function setProviderToken(provider, token, metadata = {}) {
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

function clearProviderToken(provider) {
  updateProvider(provider, (entry) => ({
    ...entry,
    token: null,
    updatedAt: new Date().toISOString(),
  }));
}

function setProviderCanary(provider, canary) {
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
