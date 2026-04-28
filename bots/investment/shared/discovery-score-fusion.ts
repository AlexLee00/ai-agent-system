// @ts-nocheck
import { ACTIONS } from './signal.ts';

function clamp(value, min = 0, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function regimeWeights(regime = 'RANGING') {
  const r = String(regime || '').toUpperCase();
  if (r.includes('TRENDING_BULL')) return { technical: 0.4, sentiment: 0.3, discovery: 0.3, mtf: 0.2 };
  if (r.includes('TRENDING_BEAR')) return { technical: 0.5, sentiment: 0.2, discovery: 0.3, mtf: 0.2 };
  if (r.includes('VOLATILE')) return { technical: 0.3, sentiment: 0.5, discovery: 0.2, mtf: 0.2 };
  return { technical: 0.5, sentiment: 0.2, discovery: 0.3, mtf: 0.3 };
}

function normalizeWeights(weights = {}, structureWeight = 0.2) {
  const total = Object.values(weights).reduce((sum, value) => sum + Number(value || 0), 0) + Number(structureWeight || 0);
  if (!Number.isFinite(total) || total <= 0) return { weights, structureWeight };
  return {
    weights: Object.fromEntries(
      Object.entries(weights).map(([key, value]) => [key, Number(value || 0) / total]),
    ),
    structureWeight: Number(structureWeight || 0) / total,
  };
}

function detectSetup({
  wyckoffPhase = null,
  vsaPattern = null,
  mtfDominant = ACTIONS.HOLD,
  sentimentScore = 0,
}) {
  const phase = String(wyckoffPhase || '').toLowerCase();
  const vsa = String(vsaPattern || '').toLowerCase();
  if (phase === 'accumulation') return 'wyckoff_accumulation';
  if (phase === 'distribution') return 'avoid_long_distribution';
  if (vsa === 'stopping_volume') return 'vsa_stopping_volume_long';
  if (mtfDominant === ACTIONS.BUY && sentimentScore > 0.2) return 'breakout_confirmation';
  if (mtfDominant === ACTIONS.SELL && sentimentScore < -0.2) return 'defensive_rotation';
  return 'trend_following';
}

export function fuseDiscoveryScore({
  regime = 'RANGING',
  discoverySignals = [],
  sentiment = null,
  technical = null,
  mtf = null,
  wyckoff = null,
  vsa = null,
} = {}) {
  const normalized = normalizeWeights(regimeWeights(regime), 0.2);
  const weights = normalized.weights;
  const structureWeight = normalized.structureWeight;
  const discoveryBase = Array.isArray(discoverySignals) && discoverySignals.length > 0
    ? discoverySignals.slice(0, 5).reduce((sum, row) => sum + Number(row.score || 0), 0) / Math.min(5, discoverySignals.length)
    : 0.5;
  const technicalScore = clamp(Number(technical?.confidence || 0.5), 0, 1);
  const sentimentScore = clamp(Number(sentiment?.sentimentScore || 0), -1, 1);
  const mtfAlignment = clamp(Number(mtf?.alignmentScore || 0), -1, 1);
  const wyckoffConf = clamp(Number(wyckoff?.confidence || 0.5), 0, 1);
  const vsaStrength = clamp(Number(vsa?.strength || 0), 0, 1);

  const discoveryPart = discoveryBase * weights.discovery;
  const technicalPart = technicalScore * weights.technical;
  const sentimentPart = ((sentimentScore + 1) / 2) * weights.sentiment;
  const mtfPart = ((mtfAlignment + 1) / 2) * weights.mtf;
  const structurePart = ((wyckoffConf * 0.6) + (vsaStrength * 0.4)) * structureWeight;

  const score = clamp(discoveryPart + technicalPart + sentimentPart + mtfPart + structurePart, 0, 1);
  const setupType = detectSetup({
    wyckoffPhase: wyckoff?.phase,
    vsaPattern: vsa?.pattern,
    mtfDominant: mtf?.dominantSignal || ACTIONS.HOLD,
    sentimentScore,
  });

  return {
    discoveryScore: Number(score.toFixed(4)),
    setupType,
    entryStrategy: setupType,
    reasons: [
      `discovery=${discoveryBase.toFixed(2)}`,
      `technical=${technicalScore.toFixed(2)}`,
      `sentiment=${sentimentScore.toFixed(2)}`,
      `mtf=${mtfAlignment.toFixed(2)}`,
      `wyckoff=${String(wyckoff?.phase || 'unknown')}`,
      `vsa=${String(vsa?.pattern || 'none')}`,
    ],
    components: {
      discoveryPart: Number(discoveryPart.toFixed(4)),
      technicalPart: Number(technicalPart.toFixed(4)),
      sentimentPart: Number(sentimentPart.toFixed(4)),
      mtfPart: Number(mtfPart.toFixed(4)),
      structurePart: Number(structurePart.toFixed(4)),
      weights: {
        ...Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, Number(Number(value).toFixed(4))])),
        structure: Number(structureWeight.toFixed(4)),
      },
    },
  };
}

export default fuseDiscoveryScore;
