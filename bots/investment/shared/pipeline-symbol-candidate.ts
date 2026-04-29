// @ts-nocheck

import { ACTIONS, ANALYST_TYPES } from './signal.ts';

function clamp01(value, fallback = 0.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export async function buildPipelineSymbolCandidate({
  symbol,
  exchange,
  decision,
  analyses = [],
  intelligentFlags,
  currentPortfolio = null,
  discoveryCandidateBySymbol = new Map(),
  communitySentimentBySymbol = new Map(),
  discoveryMarket = null,
  getOHLCV,
  analyzeMultiTimeframe,
  detectWyckoffPhase,
  classifyVsaBar,
  fuseDiscoveryScore,
  normalizeRegimeLabel,
}) {
  const mtf = intelligentFlags.phases.mtfAnalyzerEnabled
    ? analyzeMultiTimeframe(symbol, analyses, exchange, intelligentFlags.mtf)
    : null;
  const sentiment = communitySentimentBySymbol.get(symbol) || null;
  let wyckoff = null;
  let vsa = null;
  if ((intelligentFlags.phases.wyckoffDetectionEnabled || intelligentFlags.phases.vsaClassificationEnabled) && exchange === 'binance') {
    const fromDate = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const candles = await getOHLCV(symbol, '1h', fromDate, null, 'binance').catch(() => []);
    if (intelligentFlags.phases.wyckoffDetectionEnabled) {
      wyckoff = detectWyckoffPhase(candles);
    }
    if (intelligentFlags.phases.vsaClassificationEnabled && candles.length > 10) {
      vsa = classifyVsaBar(candles[candles.length - 1], candles.slice(-30, -1));
    }
  }
  const taAnalysis = analyses.find((a) => a.analyst === ANALYST_TYPES.TA_MTF || a.analyst === ANALYST_TYPES.TA);
  const discoverySeed = discoveryCandidateBySymbol.get(symbol) || null;
  const fused = intelligentFlags.phases.scoreFusionEnabled
    ? fuseDiscoveryScore({
        regime: normalizeRegimeLabel(currentPortfolio?.marketRegime || null),
        discoverySignals: discoverySeed ? [discoverySeed] : [],
        sentiment,
        technical: { confidence: Number(taAnalysis?.confidence || 0.5) },
        mtf,
        wyckoff,
        vsa,
      })
    : null;
  const discoveryScore = clamp01(fused?.discoveryScore ?? decision?.confidence ?? 0.5, 0.5);
  const shouldMutateDecision = intelligentFlags.shouldApplyDecisionMutation();
  const shouldApplyScoreFusion = intelligentFlags.shouldApplyScoreFusion();
  const blendedConfidence = shouldApplyScoreFusion
    ? clamp01((Number(decision?.confidence || 0) * 0.7) + (discoveryScore * 0.3), Number(decision?.confidence || 0))
    : Number(decision?.confidence || 0);
  const predictiveScore = clamp01(
    (discoveryScore * 0.55) + (clamp01(((Number(mtf?.alignmentScore || 0) + 1) / 2), 0.5) * 0.45),
    discoveryScore,
  );
  const enrichedDecision = {
    ...decision,
    confidence: Number(blendedConfidence.toFixed(4)),
    setup_type: shouldMutateDecision ? (decision?.setup_type || fused?.setupType || null) : (decision?.setup_type || null),
    entry_strategy: shouldMutateDecision ? (decision?.entry_strategy || fused?.entryStrategy || null) : (decision?.entry_strategy || null),
    predictiveScore: Number(predictiveScore.toFixed(4)),
    triggerHints: {
      mtfAgreement: Number(mtf?.mtfAgreement || 0),
      discoveryScore: Number(discoveryScore || 0),
      volumeBurst: Number(vsa?.metrics?.volRatio || 0),
      breakoutRetest: String(wyckoff?.phase || '') === 'accumulation' && String(mtf?.dominantSignal || '') === ACTIONS.BUY,
      newsMomentum: Math.max(0, Number(sentiment?.sentimentScore || 0)),
    },
    block_meta: {
      ...(decision?.block_meta || {}),
      discoveryContext: {
        source: discoverySeed?.source || null,
        market: discoveryMarket,
        score: discoverySeed?.score ?? null,
        confidence: discoverySeed?.confidence ?? null,
        reasonCode: discoverySeed?.reasonCode ?? null,
        evidenceRef: discoverySeed?.evidenceRef ?? null,
        componentSnapshot: fused?.snapshot || null,
        componentQuality: fused?.quality || null,
      },
      mtf,
      sentiment,
      wyckoff,
      vsa,
      scoreFusion: fused,
    },
  };

  return {
    enrichedDecision,
    intelligentState: {
      discoverySeed,
      sentiment,
      mtf,
      wyckoff,
      vsa,
      fused,
      discoveryComponentSnapshot: fused?.snapshot || null,
      discoveryComponentQuality: fused?.quality || null,
      predictiveScore,
    },
  };
}

export function recordStrategyRouteStats(enrichedDecision, {
  strategyRouteCounts = {},
  strategyRouteQualityCounts = {},
  strategyRouteReadinessSum = 0,
  strategyRouteReadinessCount = 0,
} = {}) {
  const strategyRoute = enrichedDecision?.strategy_route || enrichedDecision?.strategyRoute || null;
  if (strategyRoute?.selectedFamily) {
    strategyRouteCounts[strategyRoute.selectedFamily] = (strategyRouteCounts[strategyRoute.selectedFamily] || 0) + 1;
  }
  if (strategyRoute?.quality) {
    strategyRouteQualityCounts[strategyRoute.quality] = (strategyRouteQualityCounts[strategyRoute.quality] || 0) + 1;
  }
  if (Number.isFinite(Number(strategyRoute?.readinessScore))) {
    strategyRouteReadinessSum += Number(strategyRoute.readinessScore);
    strategyRouteReadinessCount++;
  }
  return {
    strategyRouteCounts,
    strategyRouteQualityCounts,
    strategyRouteReadinessSum,
    strategyRouteReadinessCount,
  };
}

export default {
  buildPipelineSymbolCandidate,
  recordStrategyRouteStats,
};
