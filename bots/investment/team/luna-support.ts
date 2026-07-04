// @ts-nocheck

import { ANALYST_TYPES } from '../shared/signal.ts';
import { normalizeWeights } from '../shared/analyst-accuracy.ts';

export const REVIEW_HINT_MIN_TRADES = 30;
export const REVIEW_HINT_WIN_RATE_BOOST_DELTA = 0.025;
export const REVIEW_HINT_LOW_WIN_RATE_DELTA = -0.04;
export const REVIEW_HINT_NEGATIVE_AVG_PNL_DELTA = -0.025;

export function mapSuggestedWeightsToAnalystTypes(suggestedWeights = {}, fallbackWeights = {}) {
  const sentinelWeight = suggestedWeights.sentinel
    ?? (((suggestedWeights.sophia ?? fallbackWeights[ANALYST_TYPES.SENTIMENT]) + (suggestedWeights.hermes ?? fallbackWeights[ANALYST_TYPES.NEWS])) / 2);
  return normalizeWeights({
    [ANALYST_TYPES.TA_MTF]: suggestedWeights.aria ?? fallbackWeights[ANALYST_TYPES.TA_MTF],
    [ANALYST_TYPES.ONCHAIN]: suggestedWeights.oracle ?? fallbackWeights[ANALYST_TYPES.ONCHAIN],
    [ANALYST_TYPES.SENTINEL]: sentinelWeight,
    [ANALYST_TYPES.SENTIMENT]: suggestedWeights.sophia ?? fallbackWeights[ANALYST_TYPES.SENTIMENT],
    [ANALYST_TYPES.NEWS]: suggestedWeights.hermes ?? fallbackWeights[ANALYST_TYPES.NEWS],
  });
}

export function buildReviewConfidenceHint(insight) {
  if (!insight || Number(insight.closedTrades || 0) < REVIEW_HINT_MIN_TRADES) {
    return { insight, delta: 0, notes: [] };
  }

  let delta = 0;
  const notes = [];
  if (insight.winRate != null && insight.winRate >= 0.65) {
    delta += REVIEW_HINT_WIN_RATE_BOOST_DELTA;
    notes.push(`최근 승률 ${(insight.winRate * 100).toFixed(0)}%`);
  } else if (insight.winRate != null && insight.winRate < 0.4) {
    delta += REVIEW_HINT_LOW_WIN_RATE_DELTA;
    notes.push(`최근 승률 ${(insight.winRate * 100).toFixed(0)}%`);
  }
  if (insight.avgPnlPercent != null && insight.avgPnlPercent < 0) {
    delta += REVIEW_HINT_NEGATIVE_AVG_PNL_DELTA;
    notes.push(`평균 실현손익 ${insight.avgPnlPercent.toFixed(2)}%`);
  }
  return { insight, delta, notes };
}
