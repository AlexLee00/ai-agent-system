// @ts-nocheck
import { ACTIONS } from './signal.ts';

function clamp(value, min = 0, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function round4(value) {
  return Number(Number(value || 0).toFixed(4));
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

function componentCount(value, fallback = 0) {
  if (Array.isArray(value)) return value.length;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallback;
}

function inferSentimentSourceCount(sentiment) {
  if (!sentiment) return 0;
  return componentCount(
    sentiment.sourceCount
      ?? sentiment.signalCount
      ?? sentiment.sources?.length
      ?? sentiment.items?.length
      ?? sentiment.evidence?.length,
    1,
  );
}

function buildComponentQuality({
  regime = 'RANGING',
  discoverySignals = [],
  sentiment = null,
  technical = null,
  mtf = null,
  wyckoff = null,
  vsa = null,
  discoveryBase = 0.5,
  technicalScore = 0.5,
  sentimentScore = 0,
  mtfAlignment = 0,
  setupType = 'trend_following',
  rawScore = 0.5,
} = {}) {
  const reasonCodes = [];
  const sourceCounts = {
    discovery: Array.isArray(discoverySignals) ? discoverySignals.length : 0,
    sentiment: inferSentimentSourceCount(sentiment),
    technical: technical ? 1 : 0,
    mtf: mtf ? 1 : 0,
    wyckoff: wyckoff ? 1 : 0,
    vsa: vsa ? 1 : 0,
  };

  const sentimentConfidence = clamp(
    Number(sentiment?.confidence ?? sentiment?.confidenceScore ?? (sourceCounts.sentiment > 0 ? 0.6 : 0)),
    0,
    1,
  );
  const technicalConfidence = clamp(Number(technical?.confidence ?? technicalScore), 0, 1);
  const mtfConfidence = clamp(Number(mtf?.confidence ?? Math.abs(mtfAlignment)), 0, 1);
  const discoveryQuality = sourceCounts.discovery > 0 ? clamp(discoveryBase, 0, 1) : 0;
  const regimeLabel = String(regime || 'RANGING').toUpperCase();
  const regimeRisk = regimeLabel.includes('BEAR') || regimeLabel.includes('VOLATILE')
    ? 'elevated'
    : 'normal';

  let missingSourcePenalty = 0;
  if (sourceCounts.discovery === 0) {
    reasonCodes.push('discovery_source_missing');
    missingSourcePenalty += 0.04;
  }
  if (sourceCounts.sentiment === 0) {
    reasonCodes.push('sentiment_source_missing');
    missingSourcePenalty += 0.08;
  } else if (sentimentConfidence < 0.35) {
    reasonCodes.push('sentiment_degraded');
    missingSourcePenalty += 0.04;
  }
  if (sourceCounts.technical === 0) {
    reasonCodes.push('technical_source_missing');
    missingSourcePenalty += 0.06;
  }
  if (sourceCounts.mtf === 0) {
    reasonCodes.push('mtf_source_missing');
    missingSourcePenalty += 0.04;
  }
  if (regimeRisk === 'elevated') {
    reasonCodes.push(`market_regime_${regimeLabel.toLowerCase()}`);
  }
  if (technicalConfidence >= 0.75 && (sourceCounts.sentiment === 0 || sentimentScore <= 0.05 || sentimentConfidence < 0.45)) {
    reasonCodes.push('technical_sentiment_divergence');
  }
  if (setupType === 'avoid_long_distribution') {
    reasonCodes.push('wyckoff_distribution_avoid_long');
  }

  const adjustedScore = clamp(rawScore - missingSourcePenalty, 0, 1);
  const decisionState = reasonCodes.includes('wyckoff_distribution_avoid_long')
    ? 'deferred'
    : reasonCodes.includes('technical_sentiment_divergence') || reasonCodes.some((code) => code.endsWith('_missing'))
      ? 'watch'
      : 'ready';

  const qualityStatus = decisionState === 'ready'
    ? 'ready'
    : decisionState === 'deferred'
      ? 'deferred'
      : 'degraded';

  return {
    qualityStatus,
    decisionState,
    reasonCodes,
    missingSourcePenalty: round4(missingSourcePenalty),
    adjustedDiscoveryScore: round4(adjustedScore),
    sourceCounts,
    componentQuality: {
      discovery: round4(discoveryQuality),
      sentiment: round4(sentimentConfidence),
      technical: round4(technicalConfidence),
      mtf: round4(mtfConfidence),
      structure: round4(((Number(wyckoff?.confidence || 0) * 0.6) + (Number(vsa?.strength || 0) * 0.4))),
      marketRecognition: regimeRisk === 'elevated' ? 0.5 : 1,
    },
    marketRecognition: {
      regime: regimeLabel,
      volatilityBucket: regimeLabel.includes('VOLATILE') ? 'high' : 'normal',
      risk: regimeRisk,
    },
  };
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
  const quality = buildComponentQuality({
    regime,
    discoverySignals,
    sentiment,
    technical,
    mtf,
    wyckoff,
    vsa,
    discoveryBase,
    technicalScore,
    sentimentScore,
    mtfAlignment,
    setupType,
    rawScore: score,
  });
  const snapshot = {
    sentiment: {
      score: round4(sentimentScore),
      confidence: quality.componentQuality.sentiment,
      sourceCount: quality.sourceCounts.sentiment,
      status: quality.reasonCodes.includes('sentiment_source_missing')
        ? 'missing'
        : quality.reasonCodes.includes('sentiment_degraded')
          ? 'degraded'
          : 'ready',
    },
    technical: {
      confidence: round4(technicalScore),
      sourceCount: quality.sourceCounts.technical,
      mtfAlignment: round4(mtfAlignment),
      mtfAgreement: round4(mtf?.mtfAgreement || 0),
      wyckoffPhase: wyckoff?.phase || 'unknown',
      vsaPattern: vsa?.pattern || 'none',
    },
    marketRecognition: quality.marketRecognition,
    integratedScore: {
      rawScore: round4(score),
      adjustedScore: quality.adjustedDiscoveryScore,
      setupType,
      decisionState: quality.decisionState,
      reasonCodes: quality.reasonCodes,
    },
  };

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
      ...quality.reasonCodes.map((code) => `reason:${code}`),
    ],
    reasonCodes: quality.reasonCodes,
    quality,
    snapshot,
    components: {
      discoveryPart: Number(discoveryPart.toFixed(4)),
      technicalPart: Number(technicalPart.toFixed(4)),
      sentimentPart: Number(sentimentPart.toFixed(4)),
      mtfPart: Number(mtfPart.toFixed(4)),
      structurePart: Number(structurePart.toFixed(4)),
      missingSourcePenalty: quality.missingSourcePenalty,
      adjustedDiscoveryScore: quality.adjustedDiscoveryScore,
      componentQuality: quality.componentQuality,
      weights: {
        ...Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, Number(Number(value).toFixed(4))])),
        structure: Number(structureWeight.toFixed(4)),
      },
    },
  };
}

export default fuseDiscoveryScore;
