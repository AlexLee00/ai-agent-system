// @ts-nocheck

export const LAYER_SEARCH_INTENTS = ['principle', 'recent', 'prediction', 'evidence', 'strategy'] as const;

const INTENT_RULES = [
  {
    intent: 'prediction',
    confidence: 0.88,
    pattern: /전망|예측|예상|앞으로|미래|다음\s*(?:주|달|분기|해)|forecast|predict|outlook|projection|future/i,
    reason: 'prediction_terms',
  },
  {
    intent: 'strategy',
    confidence: 0.84,
    pattern: /전략\s*반영|실행\s*전략|validated|검증된|검증\s*완료|actionable|strategy/i,
    reason: 'strategy_validated_terms',
  },
  {
    intent: 'principle',
    confidence: 0.82,
    pattern: /원리|원칙|개념|패턴|why|principle|concept|pattern|mechanism/i,
    reason: 'principle_terms',
  },
  {
    intent: 'recent',
    confidence: 0.8,
    pattern: /최근|오늘|어제|이번\s*(?:주|달)|latest|recent|today|yesterday|new/i,
    reason: 'recent_terms',
  },
  {
    intent: 'evidence',
    confidence: 0.78,
    pattern: /근거|출처|원문|raw|evidence|source|citation|basis/i,
    reason: 'evidence_terms',
  },
];

export function isLayerSearchEnabled(env = process.env) {
  return env.SIGMA_LAYER_SEARCH_ENABLED === 'true';
}

export function normalizeLayerIntent(intent) {
  const normalized = String(intent || '').trim().toLowerCase();
  return LAYER_SEARCH_INTENTS.includes(normalized as any) ? normalized : null;
}

export function classifyLayerIntent(query = '', options = {}) {
  const forced = normalizeLayerIntent(options.intent);
  if (forced) {
    return {
      intent: forced,
      confidence: 1,
      reason: 'forced_intent',
    };
  }
  const text = String(query || '');
  const matched = INTENT_RULES.find((rule) => rule.pattern.test(text));
  if (matched) {
    return {
      intent: matched.intent,
      confidence: matched.confidence,
      reason: matched.reason,
    };
  }
  return {
    intent: 'evidence',
    confidence: 0.55,
    reason: 'default_evidence',
  };
}

export function coordFiltersForIntent(intent) {
  switch (normalizeLayerIntent(intent)) {
    case 'principle':
      return { abstractionLevel: ['L2'], timeStage: ['digest', 'pattern'] };
    case 'recent':
      return { timeStage: ['raw'], order: 'latest' };
    case 'prediction':
      return { predictionState: ['forward', 'due'] };
    case 'strategy':
      return { validationState: ['validated'] };
    case 'evidence':
    default:
      return { abstractionLevel: ['L0'], timeStage: ['raw'] };
  }
}

function normalizeList(value) {
  return [...new Set((Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item || '').split(','))
    .map((item) => item.trim())
    .filter(Boolean))];
}

export function normalizeCoordFilters(filters = {}) {
  const normalized = {};
  const mapping = [
    ['abstractionLevel', 'abstraction_level'],
    ['abstraction_level', 'abstraction_level'],
    ['timeStage', 'time_stage'],
    ['time_stage', 'time_stage'],
    ['validationState', 'validation_state'],
    ['validation_state', 'validation_state'],
    ['predictionState', 'prediction_state'],
    ['prediction_state', 'prediction_state'],
  ];
  for (const [from, to] of mapping) {
    const values = normalizeList(filters[from]);
    if (values.length > 0) normalized[to] = values;
  }
  if (filters.order === 'latest') normalized.order = 'latest';
  return normalized;
}

export function buildLayerRoute(query = '', options = {}) {
  const classification = classifyLayerIntent(query, options);
  const defaultFilters = coordFiltersForIntent(classification.intent);
  const overrideFilters = normalizeCoordFilters(options.coordFilters || {});
  const mergedFilters = {
    ...normalizeCoordFilters(defaultFilters),
    ...overrideFilters,
  };
  return {
    enabled: true,
    intent: classification.intent,
    confidence: classification.confidence,
    reason: classification.reason,
    coordFilters: mergedFilters,
  };
}

export function coordsMatchFilters(coords = {}, filters = {}) {
  const normalized = normalizeCoordFilters(filters);
  for (const key of ['abstraction_level', 'time_stage', 'validation_state', 'prediction_state']) {
    if (normalized[key]?.length > 0 && !normalized[key].includes(coords[key])) return false;
  }
  return true;
}

export default {
  LAYER_SEARCH_INTENTS,
  isLayerSearchEnabled,
  normalizeLayerIntent,
  classifyLayerIntent,
  coordFiltersForIntent,
  normalizeCoordFilters,
  buildLayerRoute,
  coordsMatchFilters,
};
