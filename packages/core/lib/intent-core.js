'use strict';

const fs = require('fs');

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

function evaluateAutoPromoteDecision({
  intent = '',
  occurrenceCount = 0,
  confidence = 0,
  pattern = null,
} = {}) {
  const threshold = getAutoPromoteThreshold(intent);
  if (occurrenceCount < threshold.minCount) {
    return { allowed: false, reason: 'threshold_count', threshold };
  }
  if (!pattern) {
    return { allowed: false, reason: 'missing_pattern', threshold };
  }
  if (confidence < threshold.minConfidence) {
    return { allowed: false, reason: 'threshold_confidence', threshold };
  }
  if (!isSafeAutoPromoteIntent(intent)) {
    return { allowed: false, reason: 'unsafe_intent', threshold };
  }
  return { allowed: true, reason: 'ok', threshold };
}

function loadLearnedPatternsFromFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return raw
      .filter(item => item?.re && item?.intent)
      .map(item => ({
        re: new RegExp(item.re, 'i'),
        intent: item.intent,
        args: item.args || {},
      }));
  } catch {
    return [];
  }
}

function createDynamicExampleLoader({
  ttlMs = 5 * 60 * 1000,
  fetchRows,
  formatRow = (row) => row,
} = {}) {
  let cache = [];
  let lastLoadedAt = 0;

  return async function loadDynamicExamples() {
    const now = Date.now();
    if (now - lastLoadedAt < ttlMs) return cache;
    if (typeof fetchRows !== 'function') return cache;
    try {
      const rows = await fetchRows();
      cache = Array.isArray(rows) ? rows.map(formatRow).filter(Boolean) : [];
      lastLoadedAt = now;
    } catch {
      cache = [];
    }
    return cache;
  };
}

function formatIntentConfidence(value, digits = 0) {
  const ratio = Number(value || 0);
  return `${(ratio * 100).toFixed(digits)}%`;
}

function getPromotionCandidateStatus(candidate = {}) {
  if (candidate.latest_event_type) {
    return candidate.latest_event_type;
  }
  if (candidate.auto_applied) {
    return 'auto_applied';
  }
  if (candidate.suggested_intent) {
    return 'candidate';
  }
  return 'unlinked';
}

function getPromotionEventReason(metadata = {}) {
  if (!metadata || typeof metadata !== 'object') return '';
  return metadata.reason ? String(metadata.reason) : '';
}

function buildPromotionFilterBits(filters = {}) {
  const bits = [];
  if (filters.applied === true) bits.push('자동반영만');
  if (filters.applied === false) bits.push('후보만');
  if (filters.intent) bits.push(`intent=${filters.intent}`);
  if (filters.eventsOnly) bits.push('최근변경만');
  if (filters.eventType) bits.push(`event=${filters.eventType}`);
  if (filters.actor) bits.push(`actor=${filters.actor}`);
  if (filters.summaryOnly) bits.push('요약만');
  if (filters.thresholdsOnly) bits.push('기준만');
  return bits;
}

function buildPromotionFamilySummary(rows = []) {
  const familyMap = new Map();
  for (const row of rows) {
    const family = summarizeIntentFamily(row.suggested_intent);
    const entry = familyMap.get(family) || { family, total: 0, applied: 0, pending: 0, occurrences: 0 };
    entry.total += 1;
    entry.occurrences += Number(row.occurrence_count || 0);
    if (row.auto_applied) entry.applied += 1;
    else entry.pending += 1;
    familyMap.set(family, entry);
  }
  return [...familyMap.values()].sort((a, b) => b.total - a.total);
}

function buildPromotionEventLines(events = []) {
  if (!Array.isArray(events) || events.length === 0) return [];
  return events.map((event) => {
    const when = String(event.created_at || '').slice(0, 16);
    const sample = String(event.sample_text || '').slice(0, 28);
    const suggestedIntent = event.suggested_intent || '-';
    const actor = event.actor || 'system';
    return `  ${when} KST | ${event.event_type} | "${sample}" → ${suggestedIntent} (${actor})`;
  });
}

function buildUnrecognizedSummary(rows = [], resolveCandidate = () => null) {
  const llmMap = new Map();
  const statusMap = new Map();

  for (const row of rows) {
    const llmIntent = String(row.llm_intent || 'unknown');
    llmMap.set(llmIntent, (llmMap.get(llmIntent) || 0) + Number(row.cnt || 0));

    const candidate = resolveCandidate(row);
    const status = getPromotionCandidateStatus(candidate || {});
    statusMap.set(status, (statusMap.get(status) || 0) + Number(row.cnt || 0));
  }

  return {
    llmIntentCounts: [...llmMap.entries()].sort((a, b) => b[1] - a[1]),
    candidateStatusCounts: [...statusMap.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function buildUnrecognizedEntryLine(row = {}) {
  const promoted = row.promoted_to ? ` ✅→${row.promoted_to}` : '';
  const sample = String(row.text || '').slice(0, 50);
  return `  [${row.cnt}회] "${sample}"${promoted}`;
}

function buildUnrecognizedCandidateLine(candidate = {}) {
  if (!candidate || !candidate.suggested_intent) return '';
  const badge = candidate.auto_applied ? '✅자동반영' : '🕓후보';
  const conf = formatIntentConfidence(candidate.confidence);
  return `         ${badge}: ${candidate.suggested_intent} (${candidate.occurrence_count}회 / ${conf})`;
}

function buildUnrecognizedCandidateStatusLine(candidate = {}) {
  if (!candidate || !candidate.latest_event_type) return '';
  const metadata = candidate.latest_event_metadata && typeof candidate.latest_event_metadata === 'object'
    ? candidate.latest_event_metadata
    : {};
  const reasonValue = getPromotionEventReason(metadata);
  const reason = reasonValue ? ` | reason=${reasonValue}` : '';
  return `         상태: ${candidate.latest_event_type}${reason}`;
}

function buildPromotionCandidateLine(candidate = {}) {
  if (!candidate || !candidate.suggested_intent) return '';
  const badge = candidate.auto_applied ? '✅자동반영' : '🕓후보';
  const conf = formatIntentConfidence(candidate.confidence);
  const seen = String(candidate.updated_at || '').slice(0, 16);
  return [
    `  ${badge} [id=${candidate.id} | ${candidate.occurrence_count}회 / ${conf}] "${String(candidate.sample_text || '').slice(0, 40)}" → ${candidate.suggested_intent}`,
    `     최근: ${seen} KST`,
  ];
}

function buildPromotionCandidateStatusLine(candidate = {}) {
  if (!candidate || !candidate.latest_event_type) return '';
  const metadata = candidate.latest_event_metadata && typeof candidate.latest_event_metadata === 'object'
    ? candidate.latest_event_metadata
    : {};
  const reasonValue = getPromotionEventReason(metadata);
  const reason = reasonValue ? ` | reason=${reasonValue}` : '';
  return `     상태: ${candidate.latest_event_type}${reason}`;
}

function buildPromotionThresholdLines(thresholds = AUTO_PROMOTE_THRESHOLDS) {
  return Object.entries(thresholds).map(([key, value]) => {
    return `  ${key}: ${value.minCount}회 / ${formatIntentConfidence(value.minConfidence)}`;
  });
}

function buildPromotionPolicyNoteLines(windowDays = AUTO_PROMOTE_DEFAULTS.windowDays) {
  return [
    `기준: 최근 ${windowDays}일, intent family별 최소 반복/일치율 적용`,
    '안전정책: 자동반영은 query/status/report 성격만 허용, action 계열은 후보로만 유지',
    '조회: /promotions applied | /promotions pending | /promotions intent:luna_query',
    '요약: /promotions summary',
    '이력: /promotions events | /promotions event:rollback | /promotions actor:master',
    '롤백: /rollback <id> 또는 /rollback <문구>',
  ];
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
  evaluateAutoPromoteDecision,
  loadLearnedPatternsFromFile,
  createDynamicExampleLoader,
  formatIntentConfidence,
  getPromotionCandidateStatus,
  getPromotionEventReason,
  buildPromotionFilterBits,
  buildPromotionFamilySummary,
  buildPromotionEventLines,
  buildUnrecognizedSummary,
  buildUnrecognizedEntryLine,
  buildUnrecognizedCandidateLine,
  buildUnrecognizedCandidateStatusLine,
  buildPromotionCandidateLine,
  buildPromotionCandidateStatusLine,
  buildPromotionThresholdLines,
  buildPromotionPolicyNoteLines,
};
