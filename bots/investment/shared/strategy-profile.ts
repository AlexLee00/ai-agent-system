// @ts-nocheck

import * as db from './db.ts';
import * as journalDb from './trade-journal-db.ts';
import { recommendStrategy } from '../team/argos.ts';
import { buildRoutedStrategyFallback } from './strategy-router.ts';

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
  const confidence = Math.max(0, Number(seedSignal?.confidence ?? decision?.confidence ?? 0.4));
  const bullishVotes = ['A', 'O', 'H', 'S'].filter((name) => analystSignals?.[name] === 'B').length;
  const bearishVotes = ['A', 'O', 'H', 'S'].filter((name) => analystSignals?.[name] === 'S').length;
  const setupType =
    reasoning.includes('반등')
    || reasoning.includes('oversold')
    || reasoning.includes('되돌림')
    || reasoning.includes('mean reversion')
      ? 'mean_reversion'
      : reasoning.includes('돌파')
        || reasoning.includes('breakout')
        || reasoning.includes('squeeze')
        || reasoning.includes('volume expansion')
        || reasoning.includes('거래량 급증')
          ? 'breakout'
          : reasoning.includes('trend')
            || reasoning.includes('추세')
            || reasoning.includes('pullback')
            || (bullishVotes >= 3 && confidence >= 0.62)
              ? (exchange === 'binance' ? 'trend_following' : 'equity_swing')
              : reasoning.includes('fast-path') || (analystSignals?.O === 'B' && bearishVotes === 0)
                ? (exchange === 'binance' ? 'momentum_rotation' : 'equity_swing')
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

function buildExecutionPlan({
  exchange = 'binance',
  setupType = null,
  responsibilityPlan = null,
  regime = null,
  familyPerformanceFeedback = null,
} = {}) {
  const normalizedSetupType = String(setupType || '').trim().toLowerCase() || 'unknown';
  const normalizedRegime = String(regime || '').trim().toLowerCase();
  const bearishRegime = normalizedRegime.includes('bear');
  const plan = responsibilityPlan && typeof responsibilityPlan === 'object' ? responsibilityPlan : {};
  const ownerMode = String(plan.ownerMode || '').trim().toLowerCase();
  const riskMission = String(plan.riskMission || '').trim().toLowerCase();
  const executionMission = String(plan.executionMission || '').trim().toLowerCase();
  const watchMission = String(plan.watchMission || '').trim().toLowerCase();

  let entrySizingMultiplier = 1.0;
  let partialAdjustBias = 1.0;
  let backtestUrgency = 'normal';
  let exitUrgency = 'normal';

  if (ownerMode === 'capital_preservation') entrySizingMultiplier *= 0.95;
  if (ownerMode === 'balanced_rotation' || ownerMode === 'equity_rotation') entrySizingMultiplier *= 0.98;
  if (ownerMode === 'opportunity_capture') entrySizingMultiplier *= 1.03;

  if (riskMission === 'strict_risk_gate') {
    entrySizingMultiplier *= 0.92;
    exitUrgency = 'high';
  } else if (riskMission === 'soft_sizing_preference') {
    entrySizingMultiplier *= 0.97;
  }

  if (executionMission === 'execution_safeguard' || executionMission === 'precision_execution') {
    entrySizingMultiplier *= 0.95;
  } else if (executionMission === 'partial_adjust_executor') {
    partialAdjustBias *= 1.1;
  }

  if (watchMission === 'backtest_drift_watcher') {
    backtestUrgency = 'high';
    partialAdjustBias *= 1.05;
  } else if (watchMission === 'risk_sentinel') {
    exitUrgency = 'high';
    entrySizingMultiplier *= 0.98;
  }

  if (normalizedSetupType === 'mean_reversion') {
    partialAdjustBias *= 1.12;
  } else if (normalizedSetupType === 'trend_following' || normalizedSetupType === 'momentum_rotation') {
    partialAdjustBias *= 1.04;
  } else if (normalizedSetupType === 'breakout') {
    exitUrgency = bearishRegime ? 'high' : exitUrgency;
  }

  if (exchange !== 'binance' && backtestUrgency === 'normal') {
    backtestUrgency = 'watchful';
  }

  const performanceBias = String(familyPerformanceFeedback?.bias || '').trim();
  if (performanceBias === 'downweight_by_pnl' || performanceBias === 'downweight_by_win_rate') {
    entrySizingMultiplier *= performanceBias === 'downweight_by_pnl' ? 0.9 : 0.94;
    partialAdjustBias *= performanceBias === 'downweight_by_pnl' ? 1.12 : 1.06;
    if (exitUrgency === 'normal') exitUrgency = 'watchful';
  } else if (performanceBias === 'upweight_candidate') {
    entrySizingMultiplier *= 1.03;
  }

  return {
    entrySizingMultiplier: Number(entrySizingMultiplier.toFixed(4)),
    partialAdjustBias: Number(partialAdjustBias.toFixed(4)),
    backtestUrgency,
    exitUrgency,
  };
}

async function buildFamilyPerformanceFeedback(exchange = 'binance', setupType = null) {
  const normalizedSetupType = String(setupType || '').trim();
  if (!normalizedSetupType) return null;
  try {
    const insight = await journalDb.getStrategyFamilyPerformanceInsight(exchange, 90);
    const family = insight?.byFamily?.[normalizedSetupType] || null;
    if (!family || Number(family.closed || 0) < 5) {
      return {
        family: normalizedSetupType,
        exchange,
        bias: 'insufficient_sample',
        closed: Number(family?.closed || 0),
        winRate: family?.winRate ?? null,
        winRatePct: Number.isFinite(Number(family?.winRate)) ? Number((Number(family.winRate) * 100).toFixed(1)) : null,
        avgPnlPercent: family?.avgPnlPercent ?? null,
        pnlNet: family?.pnlNet ?? 0,
        observedDays: insight?.days || 90,
      };
    }
    const winRate = Number(family.winRate);
    const avgPnl = Number(family.avgPnlPercent);
    let bias = 'neutral';
    if (Number.isFinite(avgPnl) && avgPnl < -2) bias = 'downweight_by_pnl';
    else if (Number.isFinite(winRate) && winRate < 0.34) bias = 'downweight_by_win_rate';
    else if (Number.isFinite(avgPnl) && avgPnl > 1 && Number.isFinite(winRate) && winRate >= 0.42) bias = 'upweight_candidate';
    return {
      family: normalizedSetupType,
      exchange,
      bias,
      closed: Number(family.closed || 0),
      winRate: family.winRate,
      winRatePct: Number.isFinite(Number(family.winRate)) ? Number((Number(family.winRate) * 100).toFixed(1)) : null,
      avgPnlPercent: family.avgPnlPercent,
      pnlNet: family.pnlNet,
      observedDays: insight?.days || 90,
    };
  } catch {
    return null;
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
  const strategyRoute = decision?.strategy_route || decision?.strategyRoute || null;
  const strategyLooksGeneric = String(strategy?.strategy_name || '').toLowerCase().includes('daily btc leverage');
  const shouldPreferFallback =
    !strategy
    || strategyLooksGeneric
    || decisionReasoning.includes('open_position_backfill');

  if (shouldPreferFallback) {
    strategy = strategyRoute
      ? buildRoutedStrategyFallback({ route: strategyRoute, exchange, decision, seedSignal })
      : buildFallbackStrategy(seedSignal, exchange, decision);
  }

  const setupType = strategyRoute?.setupType || strategy?.setup_type || buildSetupType(exchange, strategy, decision);
  const familyPerformanceFeedback = await buildFamilyPerformanceFeedback(exchange, setupType);
  const responsibilityPlan = buildResponsibilityPlan({
    exchange,
    setupType,
    regime: marketRegime?.regime || null,
  });
  const executionPlan = buildExecutionPlan({
    exchange,
    setupType,
    responsibilityPlan,
    regime: marketRegime?.regime || null,
    familyPerformanceFeedback,
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
      strategyRoute,
      familyPerformanceFeedback,
      responsibilityPlan,
      executionPlan,
    },
  });
}
