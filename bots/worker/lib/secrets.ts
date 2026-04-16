// @ts-nocheck
'use strict';

const fs   = require('fs');
const path = require('path');
const { fetchHubSecrets } = require('../../../packages/core/lib/hub-client');
const env = require('../../../packages/core/lib/env');

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots/hub/secrets-store.json');
let _cache = null;
let _hubInitDone = false;

function loadStoreSecrets() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    return raw?.worker || {};
  } catch {
    return {};
  }
}

function _load() {
  if (_cache) return _cache;
  const store = loadStoreSecrets();
  _cache = Object.keys(store).length > 0 ? store : {};
  return _cache;
}

async function initHubSecrets() {
  if (_hubInitDone) return !!_cache;

  const store = loadStoreSecrets();
  const base = Object.keys(store).length > 0 ? store : {};
  try {
    const hubData = await fetchHubSecrets('worker');
    if (hubData) {
      _cache = { ...base, ...hubData };
      _hubInitDone = true;
      return true;
    }
  } catch (e) {
    console.warn(`[worker/secrets] Hub 시크릿 로드 실패: ${e.message}`);
  }

  _cache = base;
  _hubInitDone = true;
  return false;
}

function getSecret(key) { return _load()[key] ?? null; }

function requireSecret(key) {
  const v = getSecret(key);
  if (!v) { console.error(`[worker/secrets] 필수 키 누락: ${key}`); process.exit(1); }
  return v;
}

module.exports = { initHubSecrets, getSecret, requireSecret };
