// @ts-nocheck

import * as db from './db.ts';
import { recommendStrategy } from '../team/argos.ts';

function parseAnalystSignals(raw = '') {
  const result = {};
  for (const part of String(raw || '').split('|')) {
    const [name, signal] = part.split(':');
    if (!name || !signal) continue;
    result[String(name).trim()] = String(signal).trim().toUpperCase();
  }
  return result;
}

function buildFallbackStrategy(seedSignal = null, exchange = 'binance', decision = null) {
  const reasoning = String(seedSignal?.reasoning || decision?.reasoning || '').toLowerCase();
  const analystSignals = parseAnalystSignals(seedSignal?.analyst_signals || '');
  const dominantOracle = analystSignals?.O || null;
  const setupType =
    reasoning.includes('fast-path') || dominantOracle === 'B'
      ? (exchange === 'binance' ? 'momentum_rotation' : 'equity_swing')
      : reasoning.includes('반등') || reasoning.includes('mean reversion')
        ? 'mean_reversion'
        : reasoning.includes('돌파') || reasoning.includes('breakout')
          ? 'breakout'
          : exchange === 'binance'
            ? 'momentum_rotation'
            : 'equity_swing';

  return {
    source: 'historical_signal_backfill',
    strategy_name: `Backfilled ${setupType}`,
    quality_score: Math.max(0.35, Number(seedSignal?.confidence ?? decision?.confidence ?? 0.4)),
    summary: seedSignal?.reasoning || decision?.reasoning || 'historical buy signal backfill',
    entry_condition: seedSignal?.reasoning || decision?.reasoning || 'historical buy signal context',
    exit_condition: 'strategy_break_or_risk_exit',
    risk_management: 'historical signal backfill guard',
    applicable_timeframe: exchange === 'binance' ? '4h' : '1d',
    setup_type: setupType,
  };
}

function buildSetupType(exchange = 'binance', strategy = null, decision = null) {
  const source = [
    String(strategy?.strategy_name || ''),
    String(strategy?.summary || ''),
    String(strategy?.entry_condition || ''),
    String(strategy?.risk_management || ''),
    String(decision?.reasoning || ''),
  ].join(' ').toLowerCase();

  if (source.includes('breakout') || source.includes('돌파')) return 'breakout';
  if (source.includes('mean reversion') || source.includes('되돌림') || source.includes('반등')) return 'mean_reversion';
  if (source.includes('trend') || source.includes('추세')) return 'trend_following';
  if (exchange === 'binance') return 'momentum_rotation';
  return 'equity_swing';
}

function buildMonitoringPlan(exchange = 'binance', regime = null, strategy = null) {
  return {
    cadence: exchange === 'binance' ? 'realtime' : 'market_hours_realtime',
    factors: [
      'market_regime',
      'tradingview_mtf',
      'position_pnl',
      'community_sentiment',
      'liquidity_health',
    ],
    triggers: [
      'tv_live_bearish',
      'stop_loss_attention',
      'partial_adjust_attention',
      'backtest_drift_attention',
    ],
    regime: regime?.regime || null,
    timeframe: strategy?.applicable_timeframe || null,
  };
}

function buildResponsibilityPlan({
  exchange = 'binance',
  setupType = null,
  regime = null,
} = {}) {
  const normalizedSetupType = String(setupType || '').trim().toLowerCase() || 'unknown';
  const normalizedRegime = String(regime || '').trim().toLowerCase();
  const bearishRegime = normalizedRegime.includes('bear');

  let ownerAgent = 'luna';
  let ownerMode = bearishRegime ? 'capital_preservation' : 'balanced_rotation';
  let watchMission = bearishRegime ? 'risk_sentinel' : 'strategy_invalidation_watcher';
  let riskMission = bearishRegime ? 'strict_risk_gate' : 'execution_safeguard';
  let executionMission = 'precision_execution';

  if (normalizedSetupType === 'mean_reversion') {
    ownerMode = bearishRegime ? 'capital_preservation' : 'opportunity_capture';
    watchMission = 'strategy_invalidation_watcher';
    riskMission = 'soft_sizing_preference';
    executionMission = 'partial_adjust_executor';
  } else if (normalizedSetupType === 'breakout') {
    ownerMode = bearishRegime ? 'capital_preservation' : 'opportunity_capture';
    watchMission = 'risk_sentinel';
    riskMission = bearishRegime ? 'strict_risk_gate' : 'execution_safeguard';
  } else if (normalizedSetupType === 'trend_following' || normalizedSetupType === 'momentum_rotation') {
    ownerMode = bearishRegime ? 'capital_preservation' : 'balanced_rotation';
    watchMission = bearishRegime ? 'risk_sentinel' : 'backtest_drift_watcher';
    riskMission = bearishRegime ? 'strict_risk_gate' : 'soft_sizing_preference';
    executionMission = 'partial_adjust_executor';
  } else if (exchange !== 'binance') {
    ownerMode = 'equity_rotation';
    watchMission = 'strategy_invalidation_watcher';
    riskMission = 'execution_safeguard';
  }

  return {
    ownerAgent,
    ownerMode,
    strategyScoutAgent: 'argos',
    riskAgent: 'nemesis',
    riskMission,
    executionAgent: 'hephaestos',
    executionMission,
    watchAgent: 'position_watch',
    watchMission,
  };
}

function buildExitLadder(setupType = null) {
  switch (String(setupType || '')) {
    case 'mean_reversion':
      return {
        partialExitRatios: {
          profit_lock_candidate: 0.65,
          mean_reversion_profit_take: 0.6,
          tv_live_bearish: 0.5,
          backtest_drift_adjust: 0.45,
        },
        minHoldHours: 2,
        mildLossGracePct: -1.2,
      };
    case 'breakout':
      return {
        partialExitRatios: {
          profit_lock_candidate: 0.4,
          tv_live_bearish: 0.35,
          breakout_failed: 0.5,
          backtest_drift_adjust: 0.35,
        },
        minHoldHours: 4,
        mildLossGracePct: -1.5,
      };
    case 'trend_following':
    case 'momentum_rotation':
      return {
        partialExitRatios: {
          profit_lock_candidate: 0.33,
          trend_following_trail: 0.25,
          tv_live_bearish: 0.25,
          backtest_drift_adjust: 0.2,
        },
        minHoldHours: 6,
        mildLossGracePct: -0.8,
      };
    default:
      return {
        partialExitRatios: {
          profit_lock_candidate: 0.5,
          tv_live_bearish: 0.4,
          backtest_drift_adjust: 0.3,
        },
        minHoldHours: 3,
        mildLossGracePct: -1.0,
      };
  }
}

function buildExitPlan(strategy = null, latestBacktest = null, setupType = null) {
  const ladder = buildExitLadder(setupType);
  return {
    primaryExit: strategy?.exit_condition || 'strategy_break_or_risk_exit',
    riskManagement: strategy?.risk_management || null,
    partialAdjust: [
      'profit_lock_candidate',
      'tv_live_bearish',
      'mild_loss_hold_guard_release',
    ],
    partialExitRatios: ladder.partialExitRatios,
    minHoldHours: ladder.minHoldHours,
    mildLossGracePct: ladder.mildLossGracePct,
    backtestAnchor: latestBacktest ? {
      label: latestBacktest.label || null,
      sharpe: latestBacktest.sharpe ?? null,
      totalReturn: latestBacktest.total_return ?? null,
      maxDrawdown: latestBacktest.max_drawdown ?? null,
      totalTrades: latestBacktest.total_trades ?? null,
    } : null,
  };
}

function buildBacktestPlan(exchange = 'binance', latestBacktest = null) {
  return {
    mode: 'active_backtest',
    baselineWindowDays: exchange === 'binance' ? 30 : 120,
    latestBaseline: latestBacktest ? {
      createdAt: latestBacktest.created_at || null,
      label: latestBacktest.label || null,
      sharpe: latestBacktest.sharpe ?? null,
      totalReturn: latestBacktest.total_return ?? null,
    } : null,
  };
}

export async function createOrUpdatePositionStrategyProfile({
  signalId,
  symbol,
  exchange = 'binance',
  tradeMode = 'normal',
  decision = null,
  seedSignal = null,
} = {}) {
  if (!symbol || !exchange || !decision || String(decision?.action || '').toUpperCase() !== 'BUY') {
    return null;
  }

  let [strategy, latestBacktest, marketRegime] = await Promise.all([
    recommendStrategy(symbol, exchange).catch(() => null),
    db.getLatestVectorbtBacktestForSymbol(symbol, exchange === 'binance' ? 45 : 180).catch(() => null),
    db.getLatestMarketRegimeSnapshot(exchange).catch(() => null),
  ]);

  const decisionReasoning = String(decision?.reasoning || '');
  const strategyLooksGeneric = String(strategy?.strategy_name || '').toLowerCase().includes('daily btc leverage');
  const shouldPreferFallback =
    !strategy
    || strategyLooksGeneric
    || decisionReasoning.includes('open_position_backfill');

  if (shouldPreferFallback) {
    strategy = buildFallbackStrategy(seedSignal, exchange, decision);
  }

  const setupType = strategy?.setup_type || buildSetupType(exchange, strategy, decision);
  const responsibilityPlan = buildResponsibilityPlan({
    exchange,
    setupType,
    regime: marketRegime?.regime || null,
  });
  const thesis = [
    decision?.reasoning ? `decision=${decision.reasoning}` : null,
    strategy?.summary ? `strategy=${strategy.summary}` : null,
    strategy?.entry_condition ? `entry=${strategy.entry_condition}` : null,
    seedSignal?.id ? `seedSignal=${seedSignal.id}` : null,
  ].filter(Boolean).join(' | ');

  return db.upsertPositionStrategyProfile({
    symbol,
    exchange,
    signalId: signalId || seedSignal?.id || null,
    tradeMode,
    strategyName: strategy?.strategy_name || `${exchange}:${setupType}`,
    strategyQualityScore: Number(strategy?.quality_score ?? decision?.confidence ?? 0),
    setupType,
    thesis,
    monitoringPlan: buildMonitoringPlan(exchange, marketRegime, strategy),
    exitPlan: buildExitPlan(strategy, latestBacktest, setupType),
    backtestPlan: buildBacktestPlan(exchange, latestBacktest),
    marketContext: marketRegime ? {
      regime: marketRegime.regime || null,
      confidence: marketRegime.confidence ?? null,
      capturedAt: marketRegime.captured_at || null,
    } : {},
    strategyContext: {
      source: strategy?.source || 'argos_recommendation',
      sourceUrl: strategy?.source_url || null,
      applicableTimeframe: strategy?.applicable_timeframe || null,
      decisionConfidence: decision?.confidence ?? null,
      amountUsdt: decision?.amount_usdt ?? null,
      responsibilityPlan,
    },
  });
}
