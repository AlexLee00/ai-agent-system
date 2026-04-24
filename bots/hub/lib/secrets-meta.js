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
    const meta = { present: value.length > 0, kind: 'array', count: value.length };
    if (value.length > 0 && value[0] !== null && typeof value[0] === 'object') {
      meta.element_keys = Object.keys(value[0]);
    }
    return meta;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    const fields = {};
    for (const [k, v] of entries) {
      fields[k] = buildFieldMeta(k, v);
    }
    return { present: entries.length > 0, kind: 'nested', field_count: entries.length, fields };
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

// category별 required field 목록 (dot-path 표기)
const REQUIRED_FIELDS = {
  justin: ['korea_law.user_id', 'korea_law.user_name', 'korea_law.oc'],
  openai_oauth: ['access_token'],
  telegram: ['bot_token'],
};

function _getNestedValue(data, path) {
  const parts = path.split('.');
  let current = data;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

// category의 required fields 누락/존재 여부를 반환. required 정의 없으면 null.
function buildRequiredSummary(category, data) {
  const required = REQUIRED_FIELDS[category];
  if (!required) return null;
  const missing = [];
  const present = [];
  for (const path of required) {
    const value = _getNestedValue(data, path);
    const isPresent = value !== undefined && value !== null && value !== '';
    (isPresent ? present : missing).push(path);
  }
  return { missing, present };
}

module.exports = { isSecretKey, buildFieldMeta, buildCategoryMeta, buildRequiredSummary, REQUIRED_FIELDS };
