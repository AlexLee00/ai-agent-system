'use strict';

const fs   = require('fs');
const path = require('path');

const SECRETS_PATH = path.join(__dirname, '..', 'secrets.json');
let _cache = null;

function _load() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf-8'));
  } catch {
    _cache = {};
  }
  return _cache;
}

function getSecret(key) { return _load()[key] ?? null; }

function requireSecret(key) {
  const v = getSecret(key);
  if (!v) { console.error(`[worker/secrets] 필수 키 누락: ${key}`); process.exit(1); }
  return v;
}

module.exports = { getSecret, requireSecret };
