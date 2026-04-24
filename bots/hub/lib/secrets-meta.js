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

function isPresentScalar(value) {
  return value !== undefined && value !== null && value !== '';
}

function mergeRepresentativeField(base, next) {
  if (base === undefined) return next;
  if (!isPresentScalar(base) && isPresentScalar(next)) return next;
  return base;
}

function buildArrayElementSchema(values) {
  const nonNull = values.filter((item) => item !== undefined && item !== null);
  if (nonNull.length === 0) return null;

  const objectItems = nonNull.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  if (objectItems.length > 0) {
    const representative = {};
    for (const item of objectItems) {
      for (const [k, v] of Object.entries(item)) {
        representative[k] = mergeRepresentativeField(representative[k], v);
      }
    }
    const fields = {};
    for (const [k, v] of Object.entries(representative)) {
      fields[k] = buildFieldMeta(k, v);
    }
    return { kind: 'nested', field_count: Object.keys(fields).length, fields };
  }

  const primitiveTypes = new Set(nonNull.map((item) => (Array.isArray(item) ? 'array' : typeof item)));
  if (primitiveTypes.size === 1) {
    const [single] = Array.from(primitiveTypes);
    if (single === 'array') {
      const firstArray = nonNull.find(Array.isArray);
      return { kind: 'array', count: Array.isArray(firstArray) ? firstArray.length : 0 };
    }
    return { kind: single };
  }

  return { kind: 'mixed', primitive_types: Array.from(primitiveTypes).sort() };
}

function buildFieldMeta(key, value) {
  if (Array.isArray(value)) {
    const meta = { present: value.length > 0, kind: 'array', count: value.length };
    const elementSchema = buildArrayElementSchema(value);
    if (elementSchema) {
      meta.element_schema = elementSchema;
      if (elementSchema.kind === 'nested' && elementSchema.fields) {
        meta.element_keys = Object.keys(elementSchema.fields);
      }
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
  const present = isPresentScalar(value);
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
    const isPresent = isPresentScalar(value);
    (isPresent ? present : missing).push(path);
  }
  return { missing, present };
}

function hasPresentSecretMeta(meta) {
  if (!meta || typeof meta !== 'object') return false;
  if (meta.kind === 'secret' && meta.present === true) return true;

  if (meta.kind === 'nested' && meta.fields && typeof meta.fields === 'object') {
    return Object.values(meta.fields).some((child) => hasPresentSecretMeta(child));
  }

  if (meta.kind === 'array' && meta.element_schema) {
    return hasPresentSecretMeta(meta.element_schema);
  }

  return false;
}

function summarizeCategoryCompleteness(category, data) {
  const source = (data && typeof data === 'object') ? data : {};
  const fields = buildCategoryMeta(source);
  const required = buildRequiredSummary(category, source);
  const secretPresent = Object.values(fields).some((meta) => hasPresentSecretMeta(meta));

  const requiredPresent = required ? required.present.length : null;
  const requiredMissing = required ? required.missing.length : null;
  const requiredTotal = required ? (requiredPresent + requiredMissing) : null;

  const present = required ? requiredPresent > 0 : secretPresent;
  const ready = required ? requiredMissing === 0 : secretPresent;

  return {
    present,
    ready,
    field_count: Object.keys(source).length,
    secret_present: secretPresent,
    required_total: requiredTotal,
    required_present: requiredPresent,
    required_missing: requiredMissing,
  };
}

module.exports = {
  isSecretKey,
  buildFieldMeta,
  buildCategoryMeta,
  buildRequiredSummary,
  summarizeCategoryCompleteness,
  REQUIRED_FIELDS,
};
