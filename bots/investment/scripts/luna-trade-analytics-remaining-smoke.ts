#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { enforceTpSlRequirement } from '../shared/tp-sl-enforcer.ts';
import {
  applyStrategyRouteDecisionBias,
  buildStrategyFamilyPerformanceBiasFromInsight,
  buildStrategyRoute,
} from '../shared/strategy-router.ts';
import { ACTIONS, ANALYST_TYPES } from '../shared/signal.ts';
import { checkSymbolBlacklist, checkSymbolLossStreak } from '../shared/reflexion-guard.ts';
import { evaluateTradeDataEntryGuard, resolveExpectedSellNoopStatus } from '../shared/trade-data-derived-guards.ts';
import { buildAutotuneLearningDataset } from '../shared/autotune-learning-dataset.ts';
import { LUNA_AUTONOMY_PHASES } from '../shared/autonomy-phase.ts';
import { buildTradeAnalyticsReport } from '../shared/trade-analytics-report.ts';

export async function runSmoke() {
  const previousBlacklist = process.env.LUNA_PRE_ENTRY_SYMBOL_BLACKLIST;
  process.env.LUNA_PRE_ENTRY_SYMBOL_BLACKLIST = 'CRYPTO:TAO/USDT,005930';
  try {
    const noTpSl = enforceTpSlRequirement({ symbol: 'BTC/USDT', entryPrice: 100, side: 'BUY' });
    assert.equal(noTpSl.allowed, false, 'entry without TP/SL or ATR must be blocked');
    const computedTpSl = enforceTpSlRequirement({ symbol: 'BTC/USDT', entryPrice: 100, atr: 2, side: 'BUY' });
    assert.equal(computedTpSl.allowed, true, 'ATR-backed entry must compute TP/SL');
    assert.equal(computedTpSl.computed?.stopLoss, 98);

    const route = await buildStrategyRoute({
      symbol: 'SMOKESCALP/USDT',
      exchange: 'binance',
      analyses: [{
        analyst: ANALYST_TYPES.TA_MTF,
        signal: ACTIONS.BUY,
        confidence: 1,
        reasoning: '15m scalp volume burst',
        metadata: { timeframes: '15m,30m' },
      }],
      argosStrategy: { setup_type: 'short_term_scalping', quality_score: 1 },
      decision: { reasoning: 'short-term scalp entry', confidence: 1 },
    });
    assert.ok(['short_term_scalping', 'micro_swing'].includes(route.selectedFamily), `short-term route selected=${route.selectedFamily}`);
    assert.ok(route.scores.short_term_scalping > 0, 'short_term_scalping must be scored');

    const weakFamily = buildStrategyFamilyPerformanceBiasFromInsight({
      families: [{
        strategyFamily: 'trend_following',
        closed: 3,
        winRate: 1 / 3,
        avgPnlPercent: -2.11,
      }],
    });
    assert.ok(weakFamily.bias.trend_following <= -0.18, 'early weak trend_following feedback must affect routing before 5 samples');
    const adjustedTrend = applyStrategyRouteDecisionBias(
      { action: ACTIONS.BUY, confidence: 0.7, amount_usdt: 100, reasoning: 'trend entry' },
      {
        quality: 'watch',
        selectedFamily: 'trend_following',
        familyPerformance: { bias: weakFamily.bias },
      },
      'binance',
    );
    assert.ok(adjustedTrend.amount_usdt < 75, `weak trend following should reduce sizing, got ${adjustedTrend.amount_usdt}`);
    assert.ok(adjustedTrend.confidence < 0.7, `weak trend following should reduce confidence, got ${adjustedTrend.confidence}`);
    const trendGuard = evaluateTradeDataEntryGuard({
      symbol: 'BTC/USDT',
      exchange: 'binance',
      action: 'BUY',
      confidence: 0.7,
      amount_usdt: 100,
      strategy_route: {
        selectedFamily: 'trend_following',
        familyPerformance: { selectedBias: weakFamily.bias.trend_following },
      },
    });
    assert.equal(trendGuard.blocked, false, 'weak trend_following must not hard-block learning trades');
    assert.ok(trendGuard.warnings.includes('crypto_trend_following_current_epoch_probe_only'));
    assert.ok(trendGuard.warnings.includes('crypto_trend_following_confirmation_quality_thin'));
    assert.equal(trendGuard.meta.sizingMultiplier, 0.75);
    assert.equal(trendGuard.meta.confirmationQuality.grade, 'missing');
    const trendThinConfirmationGuard = evaluateTradeDataEntryGuard({
      symbol: 'BTC/USDT',
      exchange: 'binance',
      action: 'BUY',
      confidence: 0.7,
      amount_usdt: 100,
      strategy_route: {
        selectedFamily: 'trend_following',
        familyPerformance: { selectedBias: weakFamily.bias.trend_following },
        externalEvidence: { evidenceCount: 1, avgQuality: 0.42, avgFreshness: 0.35, sourceCount: 1 },
      },
    });
    assert.equal(trendThinConfirmationGuard.blocked, false, 'thin confirmation is advisory unless strict guard is enabled');
    assert.ok(trendThinConfirmationGuard.warnings.includes('crypto_trend_following_confirmation_quality_thin'));
    assert.ok(trendThinConfirmationGuard.meta.confirmationQuality.deficits.includes('source_quality_lt_0.55'));
    const trendStrictConfirmationGuard = evaluateTradeDataEntryGuard({
      symbol: 'BTC/USDT',
      exchange: 'binance',
      action: 'BUY',
      confidence: 0.7,
      amount_usdt: 100,
      strategy_route: {
        selectedFamily: 'trend_following',
        familyPerformance: { selectedBias: weakFamily.bias.trend_following },
        externalEvidence: { evidenceCount: 1, avgQuality: 0.42, avgFreshness: 0.35, sourceCount: 1 },
      },
    }, { LUNA_TRADE_DATA_STRICT_CONFIRMATION_GUARD: 'true' });
    assert.equal(trendStrictConfirmationGuard.blocked, true, 'strict confirmation guard must block thin underperforming trend_following entries');
    assert.ok(trendStrictConfirmationGuard.blockers.includes('crypto_trend_following_confirmation_quality_thin'));
    const trendNoConfirmationGuard = evaluateTradeDataEntryGuard({
      symbol: 'BTC/USDT',
      exchange: 'binance',
      action: 'BUY',
      confidence: 0.7,
      amount_usdt: 100,
      strategy_route: {
        selectedFamily: 'trend_following',
        familyPerformance: { selectedBias: weakFamily.bias.trend_following },
        externalEvidence: { evidenceCount: 0 },
      },
      hasTechnicalPresignal: false,
    });
    assert.equal(trendNoConfirmationGuard.blocked, true, 'underperforming trend_following without confirmation must be blocked');
    assert.ok(trendNoConfirmationGuard.blockers.includes('crypto_trend_following_without_confirmation'));
    const trendingBullGuard = evaluateTradeDataEntryGuard({
      symbol: 'ETH/USDT',
      exchange: 'binance',
      action: 'BUY',
      confidence: 0.72,
      amount_usdt: 100,
      strategy_family: 'momentum_rotation',
      market_regime: 'trending_bull',
      hasTechnicalPresignal: false,
    });
    assert.equal(trendingBullGuard.blocked, true, 'trending_bull without MTF confirmation must be blocked under current loss pressure');
    assert.ok(trendingBullGuard.blockers.includes('crypto_trending_bull_without_mtf_confirmation'));
    assert.ok(trendingBullGuard.warnings.includes('crypto_trending_bull_confirmation_quality_thin'));
    assert.equal(trendingBullGuard.meta.sizingMultiplier, 0.65);
    const meanReversionGuard = evaluateTradeDataEntryGuard({
      symbol: 'ROSE/USDT',
      exchange: 'binance',
      action: 'BUY',
      confidence: 0.71,
      amount_usdt: 100,
      strategy_family: 'mean_reversion',
      strategy_route: { selectedFamily: 'mean_reversion', externalEvidence: { evidenceCount: 0 } },
    });
    assert.equal(meanReversionGuard.blocked, true, 'mean_reversion without reversal evidence must be blocked');
    assert.ok(meanReversionGuard.warnings.includes('crypto_mean_reversion_current_epoch_probe_only'));
    assert.ok(meanReversionGuard.warnings.includes('crypto_mean_reversion_confirmation_quality_thin'));
    assert.ok(meanReversionGuard.blockers.includes('crypto_mean_reversion_without_reversal_evidence'));
    assert.equal(meanReversionGuard.meta.sizingMultiplier, 0.55);

    const rangingScalpGuard = evaluateTradeDataEntryGuard({
      symbol: 'AIGENSYN/USDT',
      exchange: 'binance',
      action: 'BUY',
      confidence: 0.7,
      amount_usdt: 100,
      strategy_family: 'short_term_scalping',
      market_regime: 'ranging',
      strategy_route: { selectedFamily: 'short_term_scalping', externalEvidence: { evidenceCount: 0 } },
      hasTechnicalPresignal: false,
    });
    assert.equal(rangingScalpGuard.blocked, true, 'ranging short-term scalp without confirmation must be blocked');
    assert.ok(rangingScalpGuard.blockers.includes('crypto_short_term_scalping_ranging_without_confirmation'));
    assert.ok(rangingScalpGuard.blockers.includes('crypto_ranging_without_reversal_confirmation'));
    assert.equal(rangingScalpGuard.meta.sizingMultiplier, 0.55);

    const promotionReadyGuard = evaluateTradeDataEntryGuard({
      symbol: '031330',
      exchange: 'kis',
      action: 'BUY',
      confidence: 0.72,
      amount_usdt: 200000,
      strategy_family: 'promotion_ready_shadow',
      strategy_route: { selectedFamily: 'promotion_ready_shadow', externalEvidence: { evidenceCount: 0 } },
      hasTechnicalPresignal: false,
    });
    assert.equal(promotionReadyGuard.blocked, true, 'promotion_ready_shadow equity entry must require confirmation');
    assert.ok(promotionReadyGuard.blockers.includes('promotion_ready_shadow_without_confirmation'));
    assert.equal(promotionReadyGuard.meta.sizingMultiplier, 0.25);

    const stablecoinGuard = evaluateTradeDataEntryGuard({
      symbol: 'RLUSD/USDT',
      exchange: 'binance',
      action: 'BUY',
      confidence: 0.73,
      amount_usdt: 50,
      strategy_family: 'defensive_rotation',
      strategy_route: {
        selectedFamily: 'defensive_rotation',
        externalEvidence: { evidenceCount: 3 },
      },
    });
    assert.equal(stablecoinGuard.blocked, true, 'stablecoin-like crypto pairs must be blocked before live auto-entry');
    assert.ok(stablecoinGuard.blockers.includes('trade_data_weak_symbol'));
    assert.equal(stablecoinGuard.meta.weakSymbol.source, 'pre_entry/crypto_structural_symbol_block');

    const defensiveNoEvidenceGuard = evaluateTradeDataEntryGuard({
      symbol: 'ROSE/USDT',
      exchange: 'binance',
      action: 'BUY',
      confidence: 0.7,
      amount_usdt: 50,
      strategy_family: 'defensive_rotation',
      strategy_route: {
        selectedFamily: 'defensive_rotation',
        externalEvidence: { evidenceCount: 0 },
      },
      hasTechnicalPresignal: false,
    });
    assert.equal(defensiveNoEvidenceGuard.blocked, true, 'defensive_rotation live entry without evidence/presignal must be blocked');
    assert.ok(defensiveNoEvidenceGuard.blockers.includes('crypto_defensive_rotation_without_live_evidence'));

    const horizonReport = buildTradeAnalyticsReport([{
      symbol: 'FAST/USDT',
      market: 'crypto',
      exchange: 'binance',
      status: 'closed',
      strategy_family: 'trend_following',
      hold_duration: 10 * 60 * 1000,
      entry_price: 100,
      exit_price: 99,
      pnl_percent: -1,
      tp_sl_set: true,
    }]);
    assert.equal(horizonReport.strategyFamily.shortTermCount, 1);
    assert.equal(horizonReport.strategyFamily.horizonAdjustedCount, 1);
    assert.ok(horizonReport.strategyFamily.buckets.some((bucket) => bucket.name === 'short_term_scalping'));
    assert.equal(horizonReport.earlyExit.samples[0].originalStrategyFamily, 'trend_following');

    const blacklist = checkSymbolBlacklist('TAO/USDT', 'crypto');
    assert.equal(blacklist.blocked, true);
    assert.equal(blacklist.source, 'pre_entry/symbol_blacklist');
    const devGuardEnv = { LUNA_ALLOW_DEV_DATA_DERIVED_GUARDS: 'true' };
    const derivedWeak = checkSymbolBlacklist('OPN/USDT', 'crypto', devGuardEnv);
    assert.equal(derivedWeak.blocked, true);
    assert.equal(derivedWeak.source, 'pre_entry/trade_data_weak_symbol');
    const poetWeak = checkSymbolBlacklist('POET', 'overseas', devGuardEnv);
    assert.equal(poetWeak.blocked, true);
    assert.equal(poetWeak.source, 'pre_entry/trade_data_weak_symbol');
    const lossStreak = await checkSymbolLossStreak('TAO/USDT', 'crypto');
    assert.equal(lossStreak.inCooldown, true, 'blacklist must feed pre-entry cooldown result');
    const sellNoop = resolveExpectedSellNoopStatus({ action: 'SELL', code: 'partial_sell_below_minimum' });
    assert.equal(sellNoop.status, 'skipped_below_min');
    const domesticGuard = evaluateTradeDataEntryGuard({
      symbol: '006340',
      exchange: 'kis',
      action: 'BUY',
      confidence: 0.8,
      strategy_family: 'defensive_rotation',
    }, devGuardEnv);
    assert.equal(domesticGuard.blocked, true);
    assert.ok(domesticGuard.blockers.includes('trade_data_weak_symbol'));
    assert.ok(domesticGuard.warnings.includes('domestic_defensive_rotation_probe_only'));

    const dataset = buildAutotuneLearningDataset([
      {
        trade_id: 'pre-1',
        symbol: 'BTC/USDT',
        market: 'crypto',
        exchange: 'binance',
        status: 'closed',
        entry_price: 100,
        exit_price: 101,
        pnl_percent: 1,
        strategy_family: 'trend_following',
        hold_duration: 10 * 60 * 1000,
        autonomy_phase: LUNA_AUTONOMY_PHASES.L4_PRE_AUTOTUNE,
        tp_sl_set: true,
      },
      {
        trade_id: 'post-1',
        symbol: 'ETH/USDT',
        market: 'crypto',
        exchange: 'binance',
        status: 'closed',
        entry_price: 100,
        exit_price: 99,
        pnl_percent: -1,
        autonomy_phase: LUNA_AUTONOMY_PHASES.L4_POST_AUTOTUNE,
        tp_sl_set: true,
      },
      {
        trade_id: 'low-trust-no-tpsl',
        symbol: 'LUNC/USDT',
        market: 'crypto',
        exchange: 'binance',
        status: 'closed',
        entry_price: 100,
        exit_price: 101,
        pnl_percent: 1,
        autonomy_phase: LUNA_AUTONOMY_PHASES.L4_POST_AUTOTUNE,
        tp_sl_set: false,
      },
    ]);
    assert.equal(dataset.preAutotuneIncluded, 1);
    assert.equal(dataset.learningRows, 2);
    assert.equal(dataset.skipped, 1);
    assert.equal(dataset.dataset[0].strategyFamily, 'short_term_scalping');
    assert.equal(dataset.dataset[0].originalStrategyFamily, 'trend_following');
    assert.equal(dataset.dataset[0].strategyFamilyHorizonAdjusted, true);
    assert.equal(dataset.contract.includesPreAutotune, true);
    return {
      ok: true,
      tpSl: { computed: computedTpSl.computed },
      selectedFamily: route.selectedFamily,
      blacklist,
      derivedWeak,
      poetWeak,
      stablecoinGuard,
      defensiveNoEvidenceGuard,
      trendNoConfirmationGuard,
      trendThinConfirmationGuard,
      trendStrictConfirmationGuard,
      trendingBullGuard,
      meanReversionGuard,
      rangingScalpGuard,
      promotionReadyGuard,
      sellNoop,
      domesticGuard,
      autotune: { learningRows: dataset.learningRows, preAutotuneIncluded: dataset.preAutotuneIncluded },
    };
  } finally {
    if (previousBlacklist == null) delete process.env.LUNA_PRE_ENTRY_SYMBOL_BLACKLIST;
    else process.env.LUNA_PRE_ENTRY_SYMBOL_BLACKLIST = previousBlacklist;
  }
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`luna-trade-analytics-remaining-smoke selectedFamily=${result.selectedFamily}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-trade-analytics-remaining-smoke 실패:' });
}
