'use strict';

// Secret Metadata 헬퍼 — 값 노출 없이 presence/kind만 반환

const SECRET_KEY_EXACT = new Set([
  'token', 'secret', 'password', 'pw', 'key',
  'api_key', 'access_token', 'refresh_token', 'oc',
]);

const SECRET_KEY_SUFFIXES = [
  '_token', '_secret', '_password', '_pw', '_key', '_oc',
];

function isSecretKey(key) {
  const lower = key.toLowerCase();
  if (SECRET_KEY_EXACT.has(lower)) return true;
  return SECRET_KEY_SUFFIXES.some((s) => lower.endsWith(s));
}

function buildFieldMeta(key, value) {
  if (Array.isArray(value)) {
    return { present: value.length > 0, kind: 'array', count: value.length };
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    return { present: keys.length > 0, kind: 'nested', field_count: keys.length };
  }
  const kind = isSecretKey(key) ? 'secret' : 'config';
  const present = value !== undefined && value !== null && value !== '';
  return { present, kind };
}

function buildCategoryMeta(data) {
  const result = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = buildFieldMeta(key, value);
  }
  return result;
}

module.exports = { isSecretKey, buildFieldMeta, buildCategoryMeta };
