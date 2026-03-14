'use strict';

const AUTO_PROMOTE_DEFAULTS = {
  windowDays: 30,
  minCount: 5,
  minConfidence: 0.8,
};

const AUTO_PROMOTE_THRESHOLDS = {
  default:        { minCount: AUTO_PROMOTE_DEFAULTS.minCount, minConfidence: AUTO_PROMOTE_DEFAULTS.minConfidence },
  luna_query:     { minCount: 4, minConfidence: 0.75 },
  ska_query:      { minCount: 4, minConfidence: 0.75 },
  claude_query:   { minCount: 4, minConfidence: 0.75 },
  blog_query:     { minCount: 4, minConfidence: 0.75 },
  worker_query:   { minCount: 4, minConfidence: 0.75 },
  status:         { minCount: 3, minConfidence: 0.7 },
  queue:          { minCount: 3, minConfidence: 0.7 },
  brief:          { minCount: 3, minConfidence: 0.7 },
  system_logs:    { minCount: 3, minConfidence: 0.7 },
  telegram_status:{ minCount: 3, minConfidence: 0.7 },
  speed_test:     { minCount: 3, minConfidence: 0.7 },
};

const SAFE_AUTO_PROMOTE_INTENTS = new Set([
  'status',
  'queue',
  'brief',
  'telegram_status',
  'system_logs',
  'speed_test',
  'promotion_candidates',
  'unrecognized_report',
]);

const SAFE_AUTO_PROMOTE_PREFIXES = [
  'luna_query',
  'ska_query',
  'claude_query',
  'blog_query',
  'worker_query',
];

function normalizeIntentText(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function escapeRegex(text = '') {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildAutoLearnPattern(text = '') {
  const normalized = normalizeIntentText(text);
  if (!normalized) return null;
  return normalized.split(' ').map(escapeRegex).join('\\s+');
}

function summarizeIntentFamily(intent = '') {
  const value = String(intent || '').trim();
  if (!value) return 'unknown';
  const [head] = value.split(/[/:]/);
  return head || 'unknown';
}

function isSafeAutoPromoteIntent(intent = '') {
  const value = String(intent || '').trim();
  if (!value) return false;
  if (SAFE_AUTO_PROMOTE_INTENTS.has(value)) return true;
  return SAFE_AUTO_PROMOTE_PREFIXES.some(prefix => value === prefix || value.startsWith(`${prefix}/`));
}

function getAutoPromoteThreshold(intent = '') {
  const value = String(intent || '').trim();
  if (!value) return AUTO_PROMOTE_THRESHOLDS.default;
  if (AUTO_PROMOTE_THRESHOLDS[value]) return AUTO_PROMOTE_THRESHOLDS[value];
  const family = summarizeIntentFamily(value);
  return AUTO_PROMOTE_THRESHOLDS[family] || AUTO_PROMOTE_THRESHOLDS.default;
}

module.exports = {
  AUTO_PROMOTE_DEFAULTS,
  AUTO_PROMOTE_THRESHOLDS,
  SAFE_AUTO_PROMOTE_INTENTS,
  SAFE_AUTO_PROMOTE_PREFIXES,
  normalizeIntentText,
  escapeRegex,
  buildAutoLearnPattern,
  summarizeIntentFamily,
  isSafeAutoPromoteIntent,
  getAutoPromoteThreshold,
};
