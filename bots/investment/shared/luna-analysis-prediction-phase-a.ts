// @ts-nocheck

import { detectHMMRegime } from './hmm-regime-detector.ts';
import { forecastGarchVolatility } from './garch-volatility.ts';
import { analyzeFinbertSentiment } from './finbert-analyzer.ts';
import { calculateWorldQuantAlphas } from './worldquant-alphas.ts';

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, finite(value, min)));
}

function round(value, digits = 4) {
  return Number(finite(value, 0).toFixed(digits));
}

function normalizePredictiveScore({ hmm, garch, finbert, worldquant }) {
  const regimeScore =
    hmm.currentRegime === 'bull' ? 0.68
      : hmm.currentRegime === 'bear' ? 0.32
        : hmm.currentRegime === 'volatile' ? 0.42
          : 0.52;
  const sentimentScore = clamp(0.5 + finite(finbert.aggregate?.score, 0) * 0.45, 0, 1);
  const alphaScore = clamp(0.5 + finite(worldquant.composite, 0) * 0.8, 0, 1);
  const volPenalty = clamp(1 - Math.max(0, 1 - finite(garch.positionSizeFactor, 1)) * 0.45, 0.5, 1);
  return round((regimeScore * 0.25 + sentimentScore * 0.25 + alphaScore * 0.35 + volPenalty * 0.15), 4);
}

function buildStrategyBias({ hmm, garch, finbert, worldquant }) {
  const bias = {};
  const reasons = [];
  const add = (key, value, reason) => {
    bias[key] = round((bias[key] || 0) + value, 4);
    reasons.push(`${key}: ${reason}`);
  };

  if (hmm.currentRegime === 'bull') {
    add('trend_following', 0.12, 'hmm bull regime');
    add('breakout', 0.08, 'hmm bull regime');
  } else if (hmm.currentRegime === 'bear') {
    add('defensive_rotation', 0.14, 'hmm bear regime');
    add('mean_reversion', 0.04, 'hmm bear relief watch');
  } else if (hmm.currentRegime === 'sideways') {
    add('mean_reversion', 0.10, 'hmm sideways regime');
    add('stat_arb', 0.06, 'hmm sideways regime');
  } else if (hmm.currentRegime === 'volatile') {
    add('defensive_rotation', 0.12, 'hmm volatile regime');
    add('short_term_scalping', -0.05, 'volatility dampening');
  }

  if (finite(garch.positionSizeFactor, 1) < 0.65) {
    add('defensive_rotation', 0.08, 'garch high volatility');
    add('breakout', -0.03, 'garch high volatility');
  }
  if (finbert.aggregate?.sentiment === 'positive') add('breakout', 0.05, 'positive FinBERT sentiment');
  if (finbert.aggregate?.sentiment === 'negative') add('defensive_rotation', 0.07, 'negative FinBERT sentiment');
  if (worldquant.signal === 'long_bias') add('momentum_rotation', 0.08, 'WorldQuant long bias');
  if (worldquant.signal === 'avoid_or_short_bias') add('defensive_rotation', 0.08, 'WorldQuant avoid bias');

  return { bias, reasons: reasons.slice(0, 8) };
}

export function buildLunaAnalysisPredictionPhaseA(input = {}, options = {}) {
  const bars = input.bars || input.ohlcv || input.candles || [];
  const hmm = detectHMMRegime({ bars, vix: input.vix }, options.hmm || {});
  const garch = forecastGarchVolatility({ bars, returns: input.returns }, options.garch || {});
  const finbert = analyzeFinbertSentiment({ events: input.evidence || input.textEvidence || input.texts || [] }, {
    symbol: input.symbol,
    ...(options.finbert || {}),
  });
  const worldquant = calculateWorldQuantAlphas({ bars, factors: input.factors || {} });
  const strategy = buildStrategyBias({ hmm, garch, finbert, worldquant });
  const predictiveScore = normalizePredictiveScore({ hmm, garch, finbert, worldquant });
  const blockers = [];
  if (!hmm.ok) blockers.push(hmm.status);
  if (!garch.ok) blockers.push(garch.status);
  if (!worldquant.ok) blockers.push(worldquant.status);

  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'phase_a_shadow_partial' : 'phase_a_shadow_ready',
    symbol: input.symbol || null,
    market: input.market || null,
    generatedAt: new Date().toISOString(),
    shadowOnly: true,
    liveTradeImpact: false,
    predictiveScore,
    positionSizeFactor: garch.positionSizeFactor,
    blockers,
    modules: {
      hmm,
      garch,
      finbert,
      worldquant,
    },
    strategy,
    promotion: {
      requiredShadowDays: 7,
      canPromote: false,
      reason: 'phase_a_shadow_first_no_live_impact',
    },
  };
}

export default { buildLunaAnalysisPredictionPhaseA };
