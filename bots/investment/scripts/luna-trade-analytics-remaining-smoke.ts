#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { enforceTpSlRequirement } from '../shared/tp-sl-enforcer.ts';
import { buildStrategyRoute } from '../shared/strategy-router.ts';
import { ACTIONS, ANALYST_TYPES } from '../shared/signal.ts';
import { checkSymbolBlacklist, checkSymbolLossStreak } from '../shared/reflexion-guard.ts';
import { evaluateTradeDataEntryGuard, resolveExpectedSellNoopStatus } from '../shared/trade-data-derived-guards.ts';
import { buildAutotuneLearningDataset } from '../shared/autotune-learning-dataset.ts';
import { LUNA_AUTONOMY_PHASES } from '../shared/autonomy-phase.ts';

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

    const blacklist = checkSymbolBlacklist('TAO/USDT', 'crypto');
    assert.equal(blacklist.blocked, true);
    assert.equal(blacklist.source, 'pre_entry/symbol_blacklist');
    const derivedWeak = checkSymbolBlacklist('OPN/USDT', 'crypto');
    assert.equal(derivedWeak.blocked, true);
    assert.equal(derivedWeak.source, 'pre_entry/trade_data_weak_symbol');
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
    });
    assert.equal(domesticGuard.blocked, true);
    assert.ok(domesticGuard.blockers.includes('domestic_defensive_rotation_validation_only'));

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
        autonomy_phase: LUNA_AUTONOMY_PHASES.L4_PRE_AUTOTUNE,
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
      },
    ]);
    assert.equal(dataset.preAutotuneIncluded, 1);
    assert.equal(dataset.contract.includesPreAutotune, true);
    return {
      ok: true,
      tpSl: { computed: computedTpSl.computed },
      selectedFamily: route.selectedFamily,
      blacklist,
      derivedWeak,
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
