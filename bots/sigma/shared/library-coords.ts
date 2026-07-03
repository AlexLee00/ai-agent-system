// @ts-nocheck

export const LIBRARY_COORD_VALUES = {
  abstractionLevels: ['L0', 'L1', 'L2', 'L3'],
  timeStages: ['raw', 'digest', 'pattern', 'decayed'],
  validationStates: ['unverified', 'observed', 'validated', 'contradicted', 'retired'],
  predictionStates: ['none', 'forward', 'due', 'resolved'],
};

const PREDICTION_HINT = /\b(forecast|predict(?:ion|ed)?|expected|expect|target|outlook|projection|will|next\s+(?:week|month|quarter|year)|by\s+\d{4})\b|전망|예상|예측|목표|타깃|다음\s*(?:주|달|분기|해)|내일|연말/u;

function includesValue(list, value) {
  return list.includes(String(value || '').trim());
}

function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function detectPredictionHint(input = '') {
  return PREDICTION_HINT.test(String(input || ''));
}

export function estimatePredictionHorizon(input = '', now = new Date()) {
  const text = String(input || '');
  const explicitDate = text.match(/\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/);
  if (explicitDate) {
    return isoOrNull(`${explicitDate[1]}-${explicitDate[2].padStart(2, '0')}-${explicitDate[3].padStart(2, '0')}T00:00:00.000Z`);
  }

  const base = new Date(now);
  if (/내일|tomorrow/i.test(text)) base.setUTCDate(base.getUTCDate() + 1);
  else if (/다음\s*주|next\s+week/i.test(text)) base.setUTCDate(base.getUTCDate() + 7);
  else if (/다음\s*달|next\s+month/i.test(text)) base.setUTCMonth(base.getUTCMonth() + 1);
  else if (/분기|quarter/i.test(text)) base.setUTCMonth(base.getUTCMonth() + 3);
  else if (/연말|end\s+of\s+year/i.test(text)) {
    base.setUTCMonth(11, 31);
    base.setUTCHours(23, 59, 59, 0);
  } else if (detectPredictionHint(text)) {
    base.setUTCDate(base.getUTCDate() + 30);
  } else {
    return null;
  }
  return base.toISOString();
}

export function normalizeLibraryCoords(input = {}, options = {}) {
  const now = options.now || new Date();
  const textForPrediction = options.text || '';
  const hasPrediction = detectPredictionHint(textForPrediction);
  const predictionState = includesValue(LIBRARY_COORD_VALUES.predictionStates, input.prediction_state)
    ? input.prediction_state
    : (hasPrediction ? 'forward' : 'none');
  const horizon = predictionState === 'forward'
    ? isoOrNull(input.prediction_horizon) || estimatePredictionHorizon(textForPrediction, now)
    : isoOrNull(input.prediction_horizon);

  return {
    abstraction_level: includesValue(LIBRARY_COORD_VALUES.abstractionLevels, input.abstraction_level) ? input.abstraction_level : 'L0',
    time_stage: includesValue(LIBRARY_COORD_VALUES.timeStages, input.time_stage) ? input.time_stage : 'raw',
    validation_state: includesValue(LIBRARY_COORD_VALUES.validationStates, input.validation_state) ? input.validation_state : 'unverified',
    prediction_state: predictionState,
    prediction_horizon: horizon,
  };
}

export function inferRawLibraryCoords({ title = '', content = '', source = '', tags = [], meta = {}, now = new Date() } = {}) {
  const text = [
    title,
    content,
    source,
    Array.isArray(tags) ? tags.join(' ') : '',
    typeof meta === 'object' && meta ? JSON.stringify(meta) : '',
  ].join('\n');
  return normalizeLibraryCoords({}, { text, now });
}

export function attachLibraryCoordsToMeta(meta = {}, coords = {}) {
  const normalized = normalizeLibraryCoords(coords);
  return {
    ...(meta || {}),
    libraryCoords: normalized,
  };
}

export default {
  LIBRARY_COORD_VALUES,
  normalizeLibraryCoords,
  inferRawLibraryCoords,
  detectPredictionHint,
  estimatePredictionHorizon,
  attachLibraryCoordsToMeta,
};
