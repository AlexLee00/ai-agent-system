// @ts-nocheck

import * as db from './db.ts';
import { recommendStrategy } from '../team/argos.ts';

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

function buildExitPlan(strategy = null, latestBacktest = null) {
  return {
    primaryExit: strategy?.exit_condition || 'strategy_break_or_risk_exit',
    riskManagement: strategy?.risk_management || null,
    partialAdjust: [
      'profit_lock_candidate',
      'tv_live_bearish',
      'mild_loss_hold_guard_release',
    ],
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
} = {}) {
  if (!signalId || !symbol || !exchange || !decision || String(decision?.action || '').toUpperCase() !== 'BUY') {
    return null;
  }

  const [strategy, latestBacktest, marketRegime] = await Promise.all([
    recommendStrategy(symbol, exchange).catch(() => null),
    db.getLatestVectorbtBacktestForSymbol(symbol, exchange === 'binance' ? 45 : 180).catch(() => null),
    db.getLatestMarketRegimeSnapshot(exchange).catch(() => null),
  ]);

  const setupType = buildSetupType(exchange, strategy, decision);
  const thesis = [
    decision?.reasoning ? `decision=${decision.reasoning}` : null,
    strategy?.summary ? `strategy=${strategy.summary}` : null,
    strategy?.entry_condition ? `entry=${strategy.entry_condition}` : null,
  ].filter(Boolean).join(' | ');

  return db.upsertPositionStrategyProfile({
    symbol,
    exchange,
    signalId,
    tradeMode,
    strategyName: strategy?.strategy_name || `${exchange}:${setupType}`,
    strategyQualityScore: Number(strategy?.quality_score ?? decision?.confidence ?? 0),
    setupType,
    thesis,
    monitoringPlan: buildMonitoringPlan(exchange, marketRegime, strategy),
    exitPlan: buildExitPlan(strategy, latestBacktest),
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
    },
  });
}
