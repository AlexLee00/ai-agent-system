// @ts-nocheck

function normalizeSymbol(symbol = '') {
  return String(symbol || '').trim().toUpperCase();
}

function baseAsset(symbol = '') {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return '';
  return normalized.split(/[/:_-]/)[0] || normalized;
}

function normalizeStrategy(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeDirection(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (['buy', 'long'].includes(normalized)) return 'long';
  if (['sell', 'short'].includes(normalized)) return 'short';
  return normalized || 'unknown';
}

function clamp(value, min = 0, max = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

export function estimatePositionCorrelation(candidate = {}, position = {}) {
  const candidateSymbol = normalizeSymbol(candidate.symbol);
  const positionSymbol = normalizeSymbol(position.symbol);
  if (!candidateSymbol || !positionSymbol) return 0;
  if (candidateSymbol === positionSymbol) return 1;

  let score = 0;
  if (baseAsset(candidateSymbol) && baseAsset(candidateSymbol) === baseAsset(positionSymbol)) {
    score += 0.65;
  }

  const candidateStrategy = normalizeStrategy(candidate.strategy || candidate.setupType || candidate.setup_type);
  const positionStrategy = normalizeStrategy(position.strategy || position.setupType || position.setup_type);
  if (candidateStrategy && candidateStrategy === positionStrategy) score += 0.2;

  const candidateDirection = normalizeDirection(candidate.direction || candidate.side);
  const positionDirection = normalizeDirection(position.direction || position.side || 'buy');
  if (candidateDirection !== 'unknown' && candidateDirection === positionDirection) score += 0.15;

  return clamp(score, 0, 1);
}

export function buildPositionCorrelationAdvisory({
  candidate = {},
  openPositions = [],
  threshold = 0.8,
  reductionMultiplier = 0.8,
} = {}) {
  const rows = (Array.isArray(openPositions) ? openPositions : [])
    .map((position) => ({
      symbol: normalizeSymbol(position?.symbol),
      correlation: estimatePositionCorrelation(candidate, position),
      direction: normalizeDirection(position?.direction || position?.side || 'buy'),
      strategy: normalizeStrategy(position?.strategy || position?.setupType || position?.setup_type),
    }))
    .filter((row) => row.symbol);
  const maxCorrelation = rows.reduce((max, row) => Math.max(max, row.correlation), 0);
  const enabled = maxCorrelation >= Number(threshold || 0.8);
  return {
    enabled,
    advisoryOnly: true,
    threshold: clamp(threshold, 0, 1),
    maxCorrelation,
    reductionMultiplier: enabled ? clamp(reductionMultiplier, 0.05, 1) : 1,
    matches: rows.filter((row) => row.correlation >= Number(threshold || 0.8)),
  };
}

export default {
  estimatePositionCorrelation,
  buildPositionCorrelationAdvisory,
};
