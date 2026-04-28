// @ts-nocheck

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as db from './db.ts';
import { refreshInvestmentAgentRoles } from './agent-role-state.ts';
import { getInvestmentSyncRuntimeConfig, getPositionReevaluationRuntimeConfig } from './runtime-config.ts';
import { buildPositionRuntimeState, getPositionRuntimeMarket } from './position-runtime-state.ts';
import { buildEvidenceSummaryForAgent } from './external-evidence-ledger.ts';
import { updateExternalEvidenceGapTaskQueue } from './evidence-gap-task-queue.ts';
import { recordLifecyclePhaseSnapshot } from './lifecycle-contract.ts';
import { evaluateStrategyValidity } from './strategy-validity-evaluator.ts';
import { resolveAdaptiveCadence } from './adaptive-cadence-resolver.ts';
import { evaluateStrategyMutation } from './strategy-mutation-engine.ts';
import { resolvePositionLifecycleFlags } from './position-lifecycle-flags.ts';
import { refreshPositionSignals } from './position-signal-refresh.ts';
import { computeDynamicTrail } from './dynamic-trail-engine.ts';
import { computeDynamicPositionSizing } from './dynamic-position-sizer.ts';
import { analyzeReflexivePortfolioState } from './portfolio-reflexive-monitor.ts';

const execFileAsync = promisify(execFile);
const TRADINGVIEW_MCP_SCRIPT = new URL('../scripts/tradingview-mcp-server.py', import.meta.url);

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toYahooTicker(symbol, exchange) {
  if (exchange === 'binance' && typeof symbol === 'string' && symbol.endsWith('/USDT')) {
    return symbol.replace('/USDT', '-USD');
  }
  if (exchange === 'kis' && /^\d{6}$/.test(String(symbol || ''))) {
    return `${symbol}.KS`;
  }
  return symbol;
}

function getIndicatorFramesForExchange(exchange = 'binance') {
  const runtime = getPositionReevaluationRuntimeConfig();
  const configured = runtime?.tradingViewFrames?.byExchange?.[exchange];
  if (Array.isArray(configured) && configured.length > 0) {
    return configured.map((item) => String(item)).filter(Boolean);
  }
  if (exchange === 'kis') return ['1h', '1d'];
  return ['1h', '4h', '1d'];
}

function getIndicatorWeightsForExchange(exchange = 'binance', frames = []) {
  const runtime = getPositionReevaluationRuntimeConfig();
  const configured = runtime?.tradingViewFrames?.weightsByExchange?.[exchange];
  const weights = {};
  if (configured && typeof configured === 'object') {
    for (const frame of frames) {
      const raw = Number(configured?.[frame]);
      if (Number.isFinite(raw) && raw > 0) {
        weights[frame] = raw;
      }
    }
  }
  if (Object.keys(weights).length > 0) {
    return weights;
  }
  if (exchange === 'kis') {
    return { '1h': 0.35, '1d': 0.65 };
  }
  return { '1h': 0.2, '4h': 0.35, '1d': 0.45 };
}

function getIndicatorThresholdsForExchange(exchange = 'binance') {
  const runtime = getPositionReevaluationRuntimeConfig();
  const configured = runtime?.tradingViewFrames?.thresholdsByExchange?.[exchange];
  const buy = Number(configured?.buy);
  const sell = Number(configured?.sell);
  if (Number.isFinite(buy) && Number.isFinite(sell)) {
    return { buy, sell };
  }
  if (exchange === 'kis') {
    return { buy: 0.2, sell: -0.2 };
  }
  return { buy: 0.25, sell: -0.25 };
}

async function fetchTradingViewIndicatorSnapshot(symbol, exchange, interval = '1h') {
  const yahooSymbol = toYahooTicker(symbol, exchange);
  const { stdout } = await execFileAsync('python3', [
    TRADINGVIEW_MCP_SCRIPT.pathname,
    '--indicators',
    '--json',
    `--symbol=${yahooSymbol}`,
    `--interval=${interval}`,
  ], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 4,
  });

  const payload = JSON.parse(String(stdout || '{}'));
  if (String(payload?.status || 'error') !== 'ok') {
    throw new Error(payload?.message || 'indicator fetch failed');
  }

  const signal = String(payload?.signal || 'HOLD').toUpperCase();
  const confidence = signal === 'HOLD'
    ? 0.4
    : Math.min(1, Math.max(
        Math.abs(safeNumber(payload?.macd_hist)) * 8,
        Math.abs(safeNumber(payload?.bb_pct) - 0.5),
        Math.abs((safeNumber(payload?.rsi) - 50) / 50),
      ));

  return {
    analyst: `tradingview_indicator_${interval}`,
    signal,
    confidence,
    reasoning: [
      `TV ${interval}`,
      `RSI ${safeNumber(payload?.rsi).toFixed(1)}`,
      `MACD ${safeNumber(payload?.macd).toFixed(4)}`,
      `BB ${safeNumber(payload?.bb_pct).toFixed(2)}`,
    ].join(' | '),
    snapshot: {
      symbol: yahooSymbol,
      interval,
      close: payload?.close ?? null,
      rsi: payload?.rsi ?? null,
      macd: payload?.macd ?? null,
      macdSignal: payload?.macd_signal ?? null,
      macdHist: payload?.macd_hist ?? null,
      bbPct: payload?.bb_pct ?? null,
      signal,
    },
  };
}

function normalizeIndicatorSignal(signal = '') {
  const normalized = String(signal || '').toUpperCase();
  if (normalized === 'BUY') return 'BUY';
  if (normalized === 'SELL') return 'SELL';
  return 'HOLD';
}

function buildTradingViewMtfAnalysis(snapshots = [], exchange = 'binance') {
  const valid = snapshots.filter(Boolean);
  if (valid.length === 0) return null;

  const frameIds = valid.map((item) => String(item?.snapshot?.interval || ''));
  const weights = getIndicatorWeightsForExchange(exchange, frameIds);
  const thresholds = getIndicatorThresholdsForExchange(exchange);
  let buy = 0;
  let sell = 0;
  let hold = 0;
  let confidenceSum = 0;
  let weightedBias = 0;
  let weightedTotal = 0;
  for (const item of valid) {
    const signal = normalizeIndicatorSignal(item.signal);
    const interval = String(item?.snapshot?.interval || '');
    const weight = Number(weights?.[interval] || 1);
    if (signal === 'BUY') buy += 1;
    else if (signal === 'SELL') sell += 1;
    else hold += 1;
    confidenceSum += safeNumber(item.confidence);
    const directional = signal === 'BUY' ? 1 : signal === 'SELL' ? -1 : 0;
    weightedBias += directional * weight;
    weightedTotal += weight;
  }

  let signal = 'HOLD';
  const normalizedBias = weightedTotal > 0 ? (weightedBias / weightedTotal) : 0;
  if (normalizedBias >= thresholds.buy) signal = 'BUY';
  else if (normalizedBias <= thresholds.sell) signal = 'SELL';

  const avgConfidence = confidenceSum / valid.length;
  const reasoning = valid
    .map((item) => `${item.snapshot?.interval || 'n/a'} ${normalizeIndicatorSignal(item.signal)} RSI ${safeNumber(item.snapshot?.rsi).toFixed(1)} BB ${safeNumber(item.snapshot?.bbPct).toFixed(2)}`)
    .join(' | ');

  return {
    analyst: 'tradingview_indicator_mtf',
    signal,
    confidence: avgConfidence,
    reasoning: `TV-MTF ${reasoning}`,
    snapshot: {
      timeframes: valid.map((item) => item.snapshot),
      buy,
      sell,
      hold,
      weights,
      thresholds,
      weightedBias: normalizedBias,
      compositeSignal: signal,
      avgConfidence,
    },
  };
}

function calcPnlPct(position) {
  const amount = safeNumber(position?.amount);
  const avgPrice = safeNumber(position?.avg_price);
  const unrealizedPnl = safeNumber(position?.unrealized_pnl);
  const basis = amount * avgPrice;
  if (!(basis > 0)) return 0;
  return (unrealizedPnl / basis) * 100;
}

function getExitGuardConfig() {
  const runtime = getPositionReevaluationRuntimeConfig();
  const guards = runtime?.exitGuards || {};
  return {
    mildLossHoldThresholdPct: safeNumber(guards?.mildLossHoldThresholdPct, -1.0),
    shortHoldHours: safeNumber(guards?.shortHoldHours, 6),
    overwhelmingSellVotes: Math.max(1, Math.round(safeNumber(guards?.overwhelmingSellVotes, 3))),
  };
}

function getBacktestDriftConfig() {
  const runtime = getPositionReevaluationRuntimeConfig();
  const drift = runtime?.backtestDrift || {};
  return {
    enabled: drift?.enabled !== false,
    minTradeCount: Math.max(1, Math.round(safeNumber(drift?.minTradeCount, 4))),
    adjustSharpeDrop: safeNumber(drift?.adjustSharpeDrop, 0.75),
    exitSharpeDrop: safeNumber(drift?.exitSharpeDrop, 1.5),
    adjustReturnDropPct: safeNumber(drift?.adjustReturnDropPct, 5),
    exitReturnDropPct: safeNumber(drift?.exitReturnDropPct, 10),
  };
}

function getDustConfig() {
  const syncRuntime = getInvestmentSyncRuntimeConfig();
  return {
    cryptoMinNotionalUsdt: safeNumber(syncRuntime?.cryptoMinNotionalUsdt, 10),
  };
}

function getPositionNotional(position = {}) {
  return safeNumber(position?.amount) * safeNumber(position?.avg_price);
}

function classifyDustPosition(position = {}) {
  const dust = getDustConfig();
  if (position?.exchange !== 'binance' || position?.paper === true) return null;
  const notional = getPositionNotional(position);
  if (!(notional > 0) || notional >= dust.cryptoMinNotionalUsdt) return null;
  return {
    ignored: true,
    recommendation: 'HOLD',
    reasonCode: 'dust_position_ignored',
    reason: `잔여 포지션 ${notional.toFixed(4)} USDT가 dust 기준 ${dust.cryptoMinNotionalUsdt} USDT 미만이라 재평가에서 분리`,
    dustNotionalUsdt: notional,
  };
}

function deriveHeldHours(position = {}) {
  const entryTime = position?.entry_time || position?.created_at || position?.updated_at || null;
  if (!entryTime) return 0;
  const ts = new Date(entryTime).getTime();
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return Math.max(0, (Date.now() - ts) / 3600000);
}

function isStrongBearishExitSignal({ sell = 0, buy = 0, tvComposite = 'HOLD', tv4hSignal = 'HOLD', tv1dSignal = 'HOLD', overwhelmingSellVotes = 3 } = {}) {
  const stackedTvBearish = tv4hSignal === 'SELL' && (tv1dSignal === 'SELL' || tvComposite === 'SELL');
  const overwhelmingDbSell = sell >= Math.max(overwhelmingSellVotes, buy + 2);
  return stackedTvBearish || overwhelmingDbSell;
}

function summarizeAnalyses(rows = []) {
  const summary = {
    total: rows.length,
    buy: 0,
    hold: 0,
    sell: 0,
    avgConfidence: 0,
    analysts: {},
    liveIndicator: null,
    liveIndicatorFrames: [],
  };

  let confidenceSum = 0;
  for (const row of rows) {
    const signal = String(row?.signal || '').toUpperCase();
    const analyst = String(row?.analyst || 'unknown');
    const confidence = safeNumber(row?.confidence);
    if (signal === 'BUY') summary.buy += 1;
    else if (signal === 'SELL') summary.sell += 1;
    else summary.hold += 1;
    confidenceSum += confidence;
    summary.analysts[analyst] = {
      signal,
      confidence,
      reasoning: String(row?.reasoning || '').slice(0, 160) || null,
    };

    if (analyst === 'tradingview_indicator_mtf') {
      summary.liveIndicator = row?.snapshot || null;
    } else if (String(analyst).startsWith('tradingview_indicator_') && row?.snapshot) {
      summary.liveIndicatorFrames.push(row.snapshot);
    }
  }

  summary.avgConfidence = rows.length > 0 ? confidenceSum / rows.length : 0;
  return summary;
}

function getIndicatorFrame(summary = {}, interval = '4h') {
  const frames = Array.isArray(summary?.liveIndicatorFrames) ? summary.liveIndicatorFrames : [];
  return frames.find((item) => String(item?.interval || '') === interval) || null;
}

function getStrategySetupType(strategyProfile = null) {
  return String(strategyProfile?.setup_type || '').trim().toLowerCase() || null;
}

function getResponsibilityPlan(strategyProfile = null) {
  const plan = strategyProfile?.strategy_context?.responsibilityPlan
    || strategyProfile?.strategyContext?.responsibilityPlan
    || {};
  return typeof plan === 'object' && plan ? plan : {};
}

function getFamilyPerformanceFeedback(strategyProfile = null) {
  const feedback = strategyProfile?.strategy_context?.familyPerformanceFeedback
    || strategyProfile?.strategyContext?.familyPerformanceFeedback
    || {};
  return typeof feedback === 'object' && feedback ? feedback : {};
}

function buildStrategyStateUpdate({
  position = null,
  recommendation = null,
  reasonCode = null,
  reason = null,
  analysisSummary = null,
  driftContext = null,
  runtimeState = null,
} = {}) {
  return {
    lifecycleStatus: recommendation === 'EXIT'
      ? 'exit_candidate'
      : recommendation === 'ADJUST'
        ? 'adjust_candidate'
        : 'holding',
    latestRecommendation: recommendation || null,
    latestReasonCode: reasonCode || null,
    latestReason: reason || null,
    latestPnlPct: calcPnlPct(position),
    latestAnalysis: {
      buy: Number(analysisSummary?.buy || 0),
      hold: Number(analysisSummary?.hold || 0),
      sell: Number(analysisSummary?.sell || 0),
      avgConfidence: safeNumber(analysisSummary?.avgConfidence),
    },
    backtestDrift: driftContext || null,
    positionRuntimeState: runtimeState || null,
    updatedBy: 'position_reevaluator',
    updatedAt: new Date().toISOString(),
  };
}

function buildBacktestDriftContext(strategyProfile = null, latestBacktest = null) {
  const baseline = strategyProfile?.backtest_plan?.latestBaseline || null;
  if (!baseline || !latestBacktest) return null;

  const baselineCreatedAt = baseline?.createdAt ? new Date(baseline.createdAt).getTime() : NaN;
  const latestCreatedAt = latestBacktest?.created_at ? new Date(latestBacktest.created_at).getTime() : NaN;
  if (Number.isFinite(baselineCreatedAt) && Number.isFinite(latestCreatedAt) && latestCreatedAt <= baselineCreatedAt) {
    return null;
  }

  const baselineSharpe = safeNumber(baseline?.sharpe, null);
  const latestSharpe = safeNumber(latestBacktest?.sharpe, null);
  const baselineReturn = safeNumber(baseline?.totalReturn, null);
  const latestReturn = safeNumber(latestBacktest?.total_return, null);
  const totalTrades = Math.max(
    safeNumber(latestBacktest?.total_trades, 0),
    safeNumber(baseline?.totalTrades, 0),
  );

  return {
    baseline: {
      createdAt: baseline?.createdAt || null,
      label: baseline?.label || null,
      sharpe: baselineSharpe,
      totalReturn: baselineReturn,
      totalTrades: safeNumber(baseline?.totalTrades, 0),
    },
    latest: {
      createdAt: latestBacktest?.created_at || null,
      label: latestBacktest?.label || null,
      sharpe: latestSharpe,
      totalReturn: latestReturn,
      totalTrades: safeNumber(latestBacktest?.total_trades, 0),
      maxDrawdown: safeNumber(latestBacktest?.max_drawdown, null),
      winRate: safeNumber(latestBacktest?.win_rate, null),
    },
    sharpeDrop: Number.isFinite(baselineSharpe) && Number.isFinite(latestSharpe)
      ? baselineSharpe - latestSharpe
      : null,
    returnDropPct: Number.isFinite(baselineReturn) && Number.isFinite(latestReturn)
      ? baselineReturn - latestReturn
      : null,
    totalTrades,
  };
}

function applyBacktestDriftDecision(baseDecision, {
  strategyProfile = null,
  latestBacktest = null,
  pnlPct = 0,
} = {}) {
  const driftConfig = getBacktestDriftConfig();
  if (!driftConfig.enabled) return { decision: baseDecision, driftContext: null };

  const driftContext = buildBacktestDriftContext(strategyProfile, latestBacktest);
  if (!driftContext) return { decision: baseDecision, driftContext: null };
  if (driftContext.totalTrades < driftConfig.minTradeCount) {
    return { decision: baseDecision, driftContext: { ...driftContext, ignored: 'thin_backtest' } };
  }

  const severeDrift = (
    (Number.isFinite(driftContext.sharpeDrop) && driftContext.sharpeDrop >= driftConfig.exitSharpeDrop)
    || (Number.isFinite(driftContext.returnDropPct) && driftContext.returnDropPct >= driftConfig.exitReturnDropPct)
  );
  const moderateDrift = (
    (Number.isFinite(driftContext.sharpeDrop) && driftContext.sharpeDrop >= driftConfig.adjustSharpeDrop)
    || (Number.isFinite(driftContext.returnDropPct) && driftContext.returnDropPct >= driftConfig.adjustReturnDropPct)
  );

  if (
    severeDrift
    && baseDecision.recommendation !== 'EXIT'
    && pnlPct < 0
  ) {
    return {
      decision: {
        recommendation: 'EXIT',
        reasonCode: 'backtest_drift_exit',
        reason: `최근 active backtest가 baseline 대비 크게 악화(sharpeΔ ${safeNumber(driftContext.sharpeDrop).toFixed(2)}, returnΔ ${safeNumber(driftContext.returnDropPct).toFixed(2)}%p)되어 손실 구간 EXIT 우선`,
      },
      driftContext,
    };
  }

  if (
    moderateDrift
    && baseDecision.recommendation === 'HOLD'
  ) {
    return {
      decision: {
        recommendation: 'ADJUST',
        reasonCode: 'backtest_drift_adjust',
        reason: `최근 active backtest가 baseline 대비 약화(sharpeΔ ${safeNumber(driftContext.sharpeDrop).toFixed(2)}, returnΔ ${safeNumber(driftContext.returnDropPct).toFixed(2)}%p)되어 보호 조정 우선`,
      },
      driftContext,
    };
  }

  return { decision: baseDecision, driftContext };
}

function applyStrategyAwareDecision(baseDecision, {
  strategyProfile = null,
  pnlPct = 0,
  heldHours = 0,
  tvComposite = 'HOLD',
  tv4hSignal = 'HOLD',
  tv1dSignal = 'HOLD',
  tv4hRsi = null,
  sell = 0,
  buy = 0,
} = {}) {
  const setupType = getStrategySetupType(strategyProfile);
  if (!setupType) return baseDecision;
  const familyFeedback = getFamilyPerformanceFeedback(strategyProfile);
  const familyBias = String(familyFeedback?.bias || '').trim();
  const weakFamilyBias = familyBias === 'downweight_by_pnl' || familyBias === 'downweight_by_win_rate';

  if (setupType === 'breakout') {
    if (
      baseDecision.recommendation === 'EXIT'
      && pnlPct > -1.5
      && heldHours < 12
      && tvComposite !== 'SELL'
      && tv1dSignal !== 'SELL'
    ) {
      return {
        recommendation: 'HOLD',
        reasonCode: 'breakout_hold_guard',
        reason: `breakout 전략은 초기 되돌림 ${pnlPct.toFixed(2)}% / ${heldHours.toFixed(1)}h 구간에서 즉시 청산보다 추세 확인을 우선`,
      };
    }
    return baseDecision;
  }

  if (setupType === 'mean_reversion') {
    if (
      baseDecision.recommendation === 'HOLD'
      && pnlPct >= 4
      && (tv4hSignal === 'SELL' || tv4hRsi != null && tv4hRsi < 48)
    ) {
      return {
        recommendation: 'ADJUST',
        reasonCode: 'mean_reversion_profit_take',
        reason: `mean reversion 전략은 반등 수익 ${pnlPct.toFixed(2)}% 구간에서 4h 약세 조짐이 보이면 부분익절을 우선`,
      };
    }
    return baseDecision;
  }

  if (setupType === 'trend_following' || setupType === 'momentum_rotation') {
    if (
      weakFamilyBias
      && baseDecision.recommendation === 'HOLD'
      && pnlPct >= 2.5
      && (tv4hSignal === 'SELL' || tvComposite === 'SELL' || sell > buy)
    ) {
      return {
        recommendation: 'ADJUST',
        reasonCode: 'family_performance_protective_adjust',
        reason: `${setupType} 패밀리 최근 성과 피드백(${familyBias}, winRate ${familyFeedback?.winRatePct ?? 'n/a'}%)이 약해 수익 ${pnlPct.toFixed(2)}% 구간 보호 조정을 우선`,
      };
    }
    if (
      baseDecision.recommendation === 'HOLD'
      && pnlPct >= 6
      && (tvComposite === 'SELL' || tv4hSignal === 'SELL')
    ) {
      return {
        recommendation: 'ADJUST',
        reasonCode: 'trend_following_trail',
        reason: `trend 전략은 수익 ${pnlPct.toFixed(2)}% 구간에서 추세 약화(${tv4hSignal}/${tvComposite})가 보이면 보호 조정`,
      };
    }
    if (
      baseDecision.recommendation === 'EXIT'
      && pnlPct > -0.75
      && buy >= sell
      && tv1dSignal !== 'SELL'
      && !weakFamilyBias
    ) {
      return {
        recommendation: 'HOLD',
        reasonCode: 'trend_following_pullback_hold',
        reason: `trend 전략은 미세 손실 ${pnlPct.toFixed(2)}% 구간의 단기 조정보다 상위 추세 확인을 우선`,
      };
    }
    return baseDecision;
  }

  return baseDecision;
}

function decideReevaluation(position, analysisSummary, strategyProfile = null, latestBacktest = null) {
  const pnlPct = calcPnlPct(position);
  const heldHours = deriveHeldHours(position);
  const buy = Number(analysisSummary.buy || 0);
  const hold = Number(analysisSummary.hold || 0);
  const sell = Number(analysisSummary.sell || 0);
  const avgConfidence = safeNumber(analysisSummary.avgConfidence);
  const tvComposite = String(analysisSummary?.liveIndicator?.compositeSignal || 'HOLD').toUpperCase();
  const tv4h = getIndicatorFrame(analysisSummary, '4h');
  const tv1d = getIndicatorFrame(analysisSummary, '1d');
  const tv4hSignal = String(tv4h?.signal || 'HOLD').toUpperCase();
  const tv4hRsi = safeNumber(tv4h?.rsi, null);
  const tv1dSignal = String(tv1d?.signal || 'HOLD').toUpperCase();
  const tv1dRsi = safeNumber(tv1d?.rsi, null);
  const exitGuards = getExitGuardConfig();
  const strongBearishExit = isStrongBearishExitSignal({
    sell,
    buy,
    tvComposite,
    tv4hSignal,
    tv1dSignal,
    overwhelmingSellVotes: exitGuards.overwhelmingSellVotes,
  });
  const mildLossShortHoldGuard = pnlPct < 0
    && pnlPct > exitGuards.mildLossHoldThresholdPct
    && heldHours < exitGuards.shortHoldHours
    && !strongBearishExit;

  let baseDecision = null;

  if (pnlPct <= -5) {
    baseDecision = {
      recommendation: 'EXIT',
      reasonCode: 'stop_loss_threshold',
      reason: `미실현손익 ${pnlPct.toFixed(2)}%로 -5% 손절 기준 이하`,
    };
  } else if (mildLossShortHoldGuard) {
    baseDecision = {
      recommendation: 'HOLD',
      reasonCode: 'mild_loss_hold_guard',
      reason: `작은 손실 ${pnlPct.toFixed(2)}% / 짧은 보유 ${heldHours.toFixed(1)}h 구간이라 즉시 청산보다 관찰 유지`,
    };
  } else if (sell >= buy && pnlPct < 0 && sell > 0) {
    baseDecision = {
      recommendation: 'EXIT',
      reasonCode: 'bearish_loss_consensus',
      reason: `SELL 우세(${sell} > ${buy})이며 손실 구간 ${pnlPct.toFixed(2)}%`,
    };
  } else if (pnlPct < 0 && sell >= buy && sell > 0 && (tv4hSignal === 'SELL' || tv1dSignal === 'SELL' || tvComposite === 'SELL')) {
    baseDecision = {
      recommendation: 'EXIT',
      reasonCode: 'mtf_bearish_consensus_exit',
      reason: `DB 약세 우세(BUY ${buy} / SELL ${sell})와 TV 약세(${tv4hSignal}/${tv1dSignal}/${tvComposite})가 겹친 손실 구간 ${pnlPct.toFixed(2)}%`,
    };
  } else if (pnlPct < 0 && tv4hSignal === 'SELL') {
    baseDecision = {
      recommendation: 'EXIT',
      reasonCode: 'tv_4h_bearish_reversal',
      reason: `4h TradingView 약세 전환(SELL)이며 손실 구간 ${pnlPct.toFixed(2)}%`,
    };
  } else if (pnlPct >= 10) {
    baseDecision = {
      recommendation: 'ADJUST',
      reasonCode: 'profit_lock_candidate',
      reason: `미실현수익 ${pnlPct.toFixed(2)}%로 부분익절/TP 조정 후보`,
    };
  } else if (pnlPct >= 5 && (tv4hSignal === 'SELL' || tvComposite === 'SELL')) {
    baseDecision = {
      recommendation: 'ADJUST',
      reasonCode: 'tv_trend_weakening',
      reason: `TradingView MTF 약세(${tv4hSignal}/${tvComposite})가 보여 수익 구간 ${pnlPct.toFixed(2)}% 보호 조정 후보`,
    };
  } else if (pnlPct >= 8 && tv1dSignal === 'SELL') {
    baseDecision = {
      recommendation: 'ADJUST',
      reasonCode: 'tv_1d_bearish_reversal',
      reason: `1d TradingView 약세 전환(SELL)으로 수익 구간 ${pnlPct.toFixed(2)}% 보호 조정 후보`,
    };
  } else if (pnlPct >= 3 && tv4hSignal === 'HOLD' && tv4hRsi != null && tv4hRsi < 45) {
    baseDecision = {
      recommendation: 'ADJUST',
      reasonCode: 'tv_4h_momentum_cooling',
      reason: `4h RSI ${tv4hRsi.toFixed(2)}로 모멘텀 둔화가 보여 수익 구간 ${pnlPct.toFixed(2)}% 조정 후보`,
    };
  } else if (pnlPct >= 5 && tv1dSignal === 'HOLD' && tv1dRsi != null && tv1dRsi < 48) {
    baseDecision = {
      recommendation: 'ADJUST',
      reasonCode: 'tv_1d_momentum_cooling',
      reason: `1d RSI ${tv1dRsi.toFixed(2)}로 상위 추세 모멘텀 둔화가 보여 수익 구간 ${pnlPct.toFixed(2)}% 조정 후보`,
    };
  } else if (buy === 0 && hold > 0 && avgConfidence < 0.35) {
    baseDecision = {
      recommendation: 'ADJUST',
      reasonCode: 'weak_support',
      reason: `BUY 지지 없이 HOLD 중심(${hold})이며 평균 확신도 ${avgConfidence.toFixed(2)}`,
    };
  } else {
    baseDecision = {
      recommendation: 'HOLD',
      reasonCode: 'hold_bias',
      reason: `보유 유지 조건 충족 (BUY ${buy} / HOLD ${hold} / SELL ${sell}, PnL ${pnlPct.toFixed(2)}%)`,
    };
  }

  const strategyDecision = applyStrategyAwareDecision(baseDecision, {
    strategyProfile,
    pnlPct,
    heldHours,
    tvComposite,
    tv4hSignal,
    tv1dSignal,
    tv4hRsi,
    sell,
    buy,
  });
  return applyBacktestDriftDecision(strategyDecision, {
    strategyProfile,
    latestBacktest,
    pnlPct,
  });
}

function applyValidityActionDecision(decision = null, validityResult = null) {
  const baseDecision = decision && typeof decision === 'object'
    ? {
        recommendation: String(decision.recommendation || 'HOLD'),
        reasonCode: decision.reasonCode || null,
        reason: decision.reason || null,
      }
    : { recommendation: 'HOLD', reasonCode: null, reason: null };
  if (!validityResult || validityResult.shadowMode) {
    return {
      decision: baseDecision,
      mutationRequired: false,
      validityReason: null,
    };
  }

  if (validityResult.recommendedAction === 'EXIT' && baseDecision.recommendation !== 'EXIT') {
    return {
      decision: {
        recommendation: 'EXIT',
        reasonCode: 'validity_forced_exit',
        reason: `strategy validity ${safeNumber(validityResult.score).toFixed(3)} / action EXIT로 강제 종료`,
      },
      mutationRequired: false,
      validityReason: 'force_exit',
    };
  }

  if (validityResult.recommendedAction === 'PIVOT') {
    return {
      decision: baseDecision.recommendation === 'EXIT'
        ? baseDecision
        : {
            recommendation: 'ADJUST',
            reasonCode: 'validity_pivot_adjust',
            reason: `strategy validity ${safeNumber(validityResult.score).toFixed(3)} / action PIVOT으로 보호 조정`,
          },
      mutationRequired: true,
      validityReason: 'pivot_adjust',
    };
  }

  if (validityResult.recommendedAction === 'CAUTION' && baseDecision.recommendation === 'HOLD') {
    return {
      decision: {
        recommendation: 'ADJUST',
        reasonCode: 'validity_caution_adjust',
        reason: `strategy validity ${safeNumber(validityResult.score).toFixed(3)} / action CAUTION으로 관찰 강화`,
      },
      mutationRequired: false,
      validityReason: 'caution_adjust',
    };
  }

  return {
    decision: baseDecision,
    mutationRequired: false,
    validityReason: null,
  };
}

function buildMutationProfilePatch(candidate = null, currentProfile = null) {
  if (!candidate || typeof candidate !== 'object') return null;
  const nextSetupType = String(candidate.newSetupType || '').trim().toLowerCase();
  if (!nextSetupType) return null;
  const monitoringPlan = {
    ...(currentProfile?.monitoring_plan || {}),
    reevaluation_window_minutes: Number(candidate.newReevaluationWindowMinutes || 60),
    cadence_ms: Number(candidate.newCadenceMs || 300000),
  };
  const exitPlan = {
    ...(currentProfile?.exit_plan || {}),
    stopLossPct: Number(candidate.newSlPct || 0),
    takeProfitPct: Number(candidate.newTpPct || 0),
    partialExitRatios: {
      ...(currentProfile?.exit_plan?.partialExitRatios || {}),
      mutation_default: Array.isArray(candidate.newPartialExitRatios)
        ? candidate.newPartialExitRatios
        : [0.5],
    },
  };
  return {
    setupType: nextSetupType,
    monitoringPlan,
    exitPlan,
  };
}

async function applyStrategyMutationProfile(profileId, patch, previousProfile = null) {
  if (!profileId || !patch) return false;
  const strategyContext = {
    ...(previousProfile?.strategy_context || {}),
    mutation: {
      lastAppliedAt: new Date().toISOString(),
      fromSetupType: previousProfile?.setup_type || null,
      toSetupType: patch.setupType,
      reason: 'strategy_mutation_engine',
    },
  };
  await db.run(
    `UPDATE investment.position_strategy_profiles
        SET setup_type = $1,
            monitoring_plan = $2::jsonb,
            exit_plan = $3::jsonb,
            strategy_context = $4::jsonb,
            updated_at = now()
      WHERE id = $5`,
    [
      patch.setupType,
      JSON.stringify(patch.monitoringPlan || {}),
      JSON.stringify(patch.exitPlan || {}),
      JSON.stringify(strategyContext),
      profileId,
    ],
  );
  return true;
}

async function ensurePositionReevaluationSchema() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS position_reevaluation_runs (
      id SERIAL PRIMARY KEY,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      paper BOOLEAN DEFAULT false,
      trade_mode TEXT DEFAULT 'normal',
      recommendation TEXT NOT NULL,
      reason_code TEXT,
      reason TEXT,
      pnl_pct DOUBLE PRECISION,
      position_snapshot JSONB,
      analysis_snapshot JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function persistRuns(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  await ensurePositionReevaluationSchema();
  for (const row of rows) {
    await db.run(`
      INSERT INTO position_reevaluation_runs (
        exchange, symbol, paper, trade_mode, recommendation, reason_code, reason,
        pnl_pct, position_snapshot, analysis_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)
    `, [
      row.exchange,
      row.symbol,
      row.paper === true,
      row.tradeMode || 'normal',
      row.recommendation,
      row.reasonCode || null,
      row.reason || null,
      row.pnlPct ?? null,
      JSON.stringify(row.positionSnapshot || {}),
      JSON.stringify(row.analysisSnapshot || {}),
    ]);
  }
  return rows.length;
}

export async function reevaluateOpenPositions({
  exchange = null,
  paper = false,
  tradeMode = null,
  symbol = null,
  minutesBack = 180,
  persist = true,
  liveIndicators = true,
  eventSource = 'position_reevaluator',
  attentionType = null,
  attentionReason = null,
  eventPayload = null,
} = {}) {
  const lifecycleFlags = resolvePositionLifecycleFlags();
  const positions = (await db.getOpenPositions(exchange, paper, tradeMode))
    .filter((item) => !symbol || String(item.symbol || '').toUpperCase() === String(symbol || '').toUpperCase());
  const results = [];
  const regimeByMarket = {
    crypto: (await db.getLatestMarketRegimeSnapshot('binance').catch(() => null))?.regime || null,
    domestic: (await db.getLatestMarketRegimeSnapshot('domestic').catch(() => null))?.regime || null,
    overseas: (await db.getLatestMarketRegimeSnapshot('overseas').catch(() => null))?.regime || null,
  };
  const reflexivePortfolioState = analyzeReflexivePortfolioState({
    positions,
    latestRegimeByMarket: regimeByMarket,
  });

  for (const position of positions) {
    const effectiveTradeMode = position.trade_mode || 'normal';
    const dustDecision = classifyDustPosition(position);
    if (dustDecision) {
      await recordLifecyclePhaseSnapshot({
        symbol: position.symbol,
        exchange: position.exchange,
        tradeMode: effectiveTradeMode,
        phase: 'phase5_monitor',
        ownerAgent: 'position_reevaluator',
        eventType: 'skipped',
        outputSnapshot: {
          recommendation: dustDecision.recommendation,
          reasonCode: dustDecision.reasonCode,
          dustNotionalUsdt: dustDecision.dustNotionalUsdt,
        },
      }).catch(() => null);
      results.push({
        exchange: position.exchange,
        symbol: position.symbol,
        paper: position.paper === true,
        tradeMode: effectiveTradeMode,
        pnlPct: calcPnlPct(position),
        recommendation: dustDecision.recommendation,
        reasonCode: dustDecision.reasonCode,
        reason: dustDecision.reason,
        ignored: true,
        positionSnapshot: {
          amount: safeNumber(position.amount),
          avgPrice: safeNumber(position.avg_price),
          unrealizedPnl: safeNumber(position.unrealized_pnl),
          entryTime: position.entry_time || null,
          notionalUsdt: dustDecision.dustNotionalUsdt,
        },
        analysisSnapshot: {
          total: 0,
          buy: 0,
          hold: 0,
          sell: 0,
          avgConfidence: 0,
          ignoredAsDust: true,
          dustNotionalUsdt: dustDecision.dustNotionalUsdt,
        },
      });
      continue;
    }

    const [analyses, strategyProfile, latestBacktest] = await Promise.all([
      db.getRecentAnalysis(position.symbol, minutesBack, position.exchange).catch(() => []),
      db.getPositionStrategyProfile(position.symbol, {
        exchange: position.exchange,
        tradeMode: effectiveTradeMode,
      }).catch(() => null),
      db.getLatestVectorbtBacktestForSymbol(position.symbol, position.exchange === 'binance' ? 45 : 180).catch(() => null),
    ]);
    const signalRefreshResult = lifecycleFlags.shouldExecuteSignalRefresh()
      ? await refreshPositionSignals({
          exchange: position.exchange,
          symbol: position.symbol,
          tradeMode: effectiveTradeMode,
          source: eventSource || 'position_reevaluator',
          limit: 1,
        }).catch(() => ({ ok: false, rows: [] }))
      : null;
    const signalRefreshRow = signalRefreshResult?.rows?.[0] || null;
    const regimeMarket = getPositionRuntimeMarket(position.exchange);
    const regimeKey = regimeMarket === 'crypto' ? 'binance' : regimeMarket;
    const regimeSnapshot = await db.getLatestMarketRegimeSnapshot(regimeKey).catch(() => null);
    const externalEvidenceSummary = await buildEvidenceSummaryForAgent({
      symbol: position.symbol,
      market: regimeMarket,
      days: 3,
    }).catch(() => null);
    const externalEvidenceGapState = updateExternalEvidenceGapTaskQueue({
      symbol: position.symbol,
      exchange: position.exchange,
      tradeMode: effectiveTradeMode,
      evidenceCount: Number(externalEvidenceSummary?.evidenceCount || 0),
      threshold: 3,
      cooldownMinutes: 60,
      reason: externalEvidenceSummary?.warning || null,
    });
    let indicatorAnalyses = [];
    let indicatorAnalysis = null;
    if (liveIndicators) {
      const intervals = getIndicatorFramesForExchange(position.exchange);
      const indicatorFrames = await Promise.all(
        intervals.map((interval) =>
          fetchTradingViewIndicatorSnapshot(position.symbol, position.exchange, interval).catch(() => null),
        ),
      );
      indicatorAnalyses = indicatorFrames.filter(Boolean);
      indicatorAnalysis = buildTradingViewMtfAnalysis(indicatorAnalyses, position.exchange);
    }
    const mergedAnalyses = [
      ...analyses,
      ...indicatorAnalyses,
      ...(indicatorAnalysis ? [indicatorAnalysis] : []),
    ];
    const analysisSummary = summarizeAnalyses(mergedAnalyses);
    const decision = decideReevaluation(position, analysisSummary, strategyProfile, latestBacktest);
    const pnlPct = calcPnlPct(position);

    // Phase B — Strategy Validity Score (shadow mode 기본값: kill switch false 시 HOLD만 반환)
    const validityResult = evaluateStrategyValidity({
      position,
      strategyProfile,
      analysisSummary,
      latestBacktest,
      regimeSnapshot,
      externalEvidenceSummary,
      driftContext: decision.driftContext,
      pnlPct,
      heldHours: deriveHeldHours(position),
      previousScore: strategyProfile?.strategy_state?.positionRuntimeState?.strategyValidityScore ?? null,
    });

    const validityDecision = applyValidityActionDecision(decision?.decision, validityResult);
    let effectiveDecision = validityDecision.decision;
    let mutationResult = null;
    if (validityDecision.mutationRequired) {
      mutationResult = await evaluateStrategyMutation({
        position: {
          symbol: position.symbol,
          exchange: position.exchange,
          trade_mode: effectiveTradeMode,
          unrealized_pnl: safeNumber(position?.unrealized_pnl),
          avg_price: safeNumber(position?.avg_price),
          amount: safeNumber(position?.amount),
          entry_time: position?.entry_time || null,
        },
        currentStrategyProfile: strategyProfile,
        validityResult,
        regimeSnapshot,
        latestBacktest,
        pnlPct,
        heldHours: deriveHeldHours(position),
        analysisSummary,
      }).catch(() => null);
      if (mutationResult?.mutationApplied === true && mutationResult?.candidate) {
        const patch = buildMutationProfilePatch(mutationResult.candidate, strategyProfile);
        if (patch && strategyProfile?.id) {
          const mutationProfileApplied = await applyStrategyMutationProfile(strategyProfile.id, patch, strategyProfile).catch(() => false);
          if (mutationProfileApplied) {
            strategyProfile.setup_type = patch.setupType;
            strategyProfile.monitoring_plan = patch.monitoringPlan;
            strategyProfile.exit_plan = patch.exitPlan;
          } else {
            mutationResult = {
              ...mutationResult,
              mutationApplied: false,
              rejectionReason: 'strategy_profile_update_failed',
            };
          }
        }
        if (mutationResult?.mutationApplied === true) {
          effectiveDecision = {
            recommendation: 'ADJUST',
            reasonCode: 'strategy_mutation_applied',
            reason: mutationResult?.candidate?.mutationReason || 'strategy mutation applied',
          };
        }
      } else if (mutationResult?.rejectionReason && effectiveDecision.recommendation === 'HOLD') {
        effectiveDecision = {
          recommendation: 'ADJUST',
          reasonCode: 'strategy_mutation_rejected_guarded_adjust',
          reason: `mutation rejected: ${mutationResult.rejectionReason}`,
        };
      }
    }

    if (
      lifecycleFlags.shouldApplyReflexiveMonitoring()
      && reflexivePortfolioState?.protective
      && effectiveDecision.recommendation === 'HOLD'
    ) {
      effectiveDecision = {
        recommendation: reflexivePortfolioState?.bias?.preferExit ? 'EXIT' : 'ADJUST',
        reasonCode: 'portfolio_reflexive_protective_bias',
        reason: `portfolio reflexive guard: ${(reflexivePortfolioState.reasonCodes || []).join(', ') || 'protective bias'}`,
      };
    }

    // Phase A — Adaptive Cadence (shadow mode 기본값: kill switch false 시 5분 반환)
    const adaptiveCadence = resolveAdaptiveCadence({
      exchange: position.exchange,
      attentionType: signalRefreshRow?.attentionType || attentionType,
      volatilityBurst: attentionType?.includes('volatil') || attentionType?.includes('atr') || false,
      newsEvent: attentionType?.includes('news') || attentionType?.includes('뉴스') || false,
      volumeBurst: attentionType?.includes('volume') || attentionType?.includes('거래량') || false,
    });
    const dynamicSizing = computeDynamicPositionSizing({
      pnlPct,
      currentWeightPct: 0.12,
      targetVolatility: 0.03,
      realizedVolatility: Math.max(0.01, Math.abs(Number(analysisSummary?.liveIndicator?.weightedBias || 0)) * 0.04),
      winRate: Number(getFamilyPerformanceFeedback(strategyProfile)?.winRatePct || 50) / 100,
      rewardRisk: 1.8,
    });
    if (
      dynamicSizing?.enabled === true
      && dynamicSizing?.mode === 'pyramid'
      && effectiveDecision.recommendation === 'HOLD'
      && reflexivePortfolioState?.bias?.blockPyramid !== true
    ) {
      effectiveDecision = {
        recommendation: 'ADJUST',
        reasonCode: dynamicSizing.reasonCode || 'pyramid_continuation',
        reason: `dynamic position sizing requests pyramid continuation (${Number(dynamicSizing.adjustmentRatio || 0).toFixed(4)})`,
      };
    }
    const previousRuntimeState = strategyProfile?.strategy_state?.positionRuntimeState || null;
    const previousTrail = previousRuntimeState?.dynamicTrail
      || previousRuntimeState?.marketState?.trailSnapshot
      || null;
    const dynamicTrail = computeDynamicTrail({
      method: 'atr',
      side: 'long',
      close: analysisSummary?.liveIndicator?.timeframes?.[0]?.close || position?.avg_price || 0,
      atr: Math.max(0.000001, Math.abs(safeNumber(analysisSummary?.liveIndicator?.weightedBias, 0)) * safeNumber(position?.avg_price, 0) * 0.02),
      highestHigh: analysisSummary?.liveIndicator?.timeframes?.[0]?.high || position?.avg_price || 0,
      lowestLow: analysisSummary?.liveIndicator?.timeframes?.[0]?.low || position?.avg_price || 0,
      vwap: analysisSummary?.liveIndicator?.timeframes?.[0]?.close || position?.avg_price || 0,
      sar: analysisSummary?.liveIndicator?.timeframes?.[0]?.close || position?.avg_price || 0,
      previousStopPrice: previousTrail?.stopPrice || null,
    });
    if (
      dynamicTrail?.breached === true
      && effectiveDecision.recommendation !== 'EXIT'
    ) {
      effectiveDecision = {
        recommendation: 'EXIT',
        reasonCode: dynamicTrail.breachReasonCode || 'dynamic_trail_stop_breached',
        reason: `dynamic trail stop breached: close=${dynamicTrail.close}, previousStop=${dynamicTrail.previousStopPrice}`,
      };
    }

    const runtimeState = buildPositionRuntimeState({
      position: {
        ...position,
        pnlPct,
      },
      strategyProfile,
      analysisSummary,
      latestBacktest,
      driftContext: decision.driftContext,
      recommendation: effectiveDecision.recommendation,
      reasonCode: effectiveDecision.reasonCode,
      reason: effectiveDecision.reason,
      regimeSnapshot,
      externalEvidenceSummary,
      externalEvidenceGapState,
      portfolioReflexiveBias: reflexivePortfolioState?.bias || null,
      trailSnapshot: dynamicTrail,
      positionSizingSnapshot: dynamicSizing,
      signalRefreshSnapshot: signalRefreshRow || null,
      trigger: {
        source: eventSource,
        attentionType: signalRefreshRow?.attentionType || attentionType,
        attentionReason,
        payload: eventPayload,
      },
      previousState: previousRuntimeState,
    });
    if (strategyProfile?.id) {
      const attentionAt = effectiveDecision.recommendation === 'HOLD' ? null : new Date().toISOString();
      const baseStrategyState = buildStrategyStateUpdate({
        position,
        recommendation: effectiveDecision.recommendation,
        reasonCode: effectiveDecision.reasonCode,
        reason: effectiveDecision.reason,
        analysisSummary,
        driftContext: decision.driftContext,
        runtimeState,
      });
      // Phase B validity score를 positionRuntimeState 내에 저장 (다음 사이클 Bayesian prior로 활용)
      if (baseStrategyState?.positionRuntimeState) {
        baseStrategyState.positionRuntimeState.strategyValidityScore = validityResult.score;
        baseStrategyState.positionRuntimeState.strategyValidityActionScore = validityResult.actionScore;
        baseStrategyState.positionRuntimeState.strategyValidityWeightedScore = validityResult.weightedScore;
        baseStrategyState.positionRuntimeState.strategyValidityBaseAction = validityResult.baseAction;
        baseStrategyState.positionRuntimeState.strategyValidityAction = validityResult.recommendedAction;
        baseStrategyState.positionRuntimeState.adaptiveCadenceMs = adaptiveCadence.cadenceMs;
        baseStrategyState.positionRuntimeState.dynamicTrail = dynamicTrail;
        baseStrategyState.positionRuntimeState.dynamicPositionSizing = dynamicSizing;
        baseStrategyState.positionRuntimeState.signalRefresh = signalRefreshRow || null;
        baseStrategyState.positionRuntimeState.strategyMutation = mutationResult || null;
      }
      await db.updatePositionStrategyProfileState(position.symbol, {
        exchange: position.exchange,
        tradeMode: effectiveTradeMode,
        strategyState: baseStrategyState,
        lastEvaluationAt: new Date().toISOString(),
        lastAttentionAt: attentionAt,
      }).catch(() => null);
    }
    const lifecycleVersion = Number(runtimeState?.version || 0);
    const lifecycleBase = `${position.exchange}:${position.symbol}:${effectiveTradeMode}:${lifecycleVersion}`;
    await Promise.all([
      recordLifecyclePhaseSnapshot({
        symbol: position.symbol,
        exchange: position.exchange,
        tradeMode: effectiveTradeMode,
        phase: 'phase2_analyze',
        ownerAgent: 'position_reevaluator',
        eventType: 'completed',
        inputSnapshot: {
          minutesBack,
          analysisCount: mergedAnalyses.length,
          eventSource,
          attentionType: attentionType || null,
        },
        outputSnapshot: {
          recommendation: effectiveDecision.recommendation,
          reasonCode: effectiveDecision.reasonCode,
          reason: effectiveDecision.reason,
          pnlPct,
          strategyValidityScore: validityResult.score,
          strategyValidityActionScore: validityResult.actionScore,
          strategyValidityAction: validityResult.recommendedAction,
          dynamicSizingMode: dynamicSizing?.mode || null,
          dynamicTrailBreached: dynamicTrail?.breached === true,
        },
        policySnapshot: runtimeState?.policyMatrix || {},
        evidenceSnapshot: {
          regime: regimeSnapshot ? {
            market: regimeSnapshot.market || regimeKey,
            regime: regimeSnapshot.regime || null,
            confidence: regimeSnapshot.confidence ?? null,
            capturedAt: regimeSnapshot.captured_at || null,
          } : null,
          externalEvidenceSummary: externalEvidenceSummary || null,
          externalEvidenceGapState: externalEvidenceGapState || null,
        },
        idempotencyKey: `phase2:${lifecycleBase}`,
      }).catch(() => null),
      recordLifecyclePhaseSnapshot({
        symbol: position.symbol,
        exchange: position.exchange,
        tradeMode: effectiveTradeMode,
        phase: 'phase5_monitor',
        ownerAgent: 'position_watch',
        eventType: 'completed',
        inputSnapshot: {
          eventSource,
          attentionType: attentionType || null,
          attentionReason: attentionReason || null,
        },
        outputSnapshot: {
          recommendation: effectiveDecision.recommendation,
          reasonCode: effectiveDecision.reasonCode,
          validationSeverity: runtimeState?.validationState?.severity || null,
          executionAllowed: runtimeState?.executionIntent?.executionAllowed === true,
          stageId: 'stage_5',
          dynamicTrailBreached: dynamicTrail?.breached === true,
          dynamicSizingMode: dynamicSizing?.mode || null,
        },
        policySnapshot: {
          monitoringPolicy: runtimeState?.monitoringPolicy || {},
          policyMatrix: runtimeState?.policyMatrix || {},
        },
        evidenceSnapshot: {
          externalEvidenceSummary: externalEvidenceSummary || null,
          externalEvidenceGapState: externalEvidenceGapState || null,
        },
        idempotencyKey: `phase5:${lifecycleBase}`,
      }).catch(() => null),
    ]);
    results.push({
      exchange: position.exchange,
      symbol: position.symbol,
      paper: position.paper === true,
      tradeMode: effectiveTradeMode,
      pnlPct: calcPnlPct(position),
      recommendation: effectiveDecision.recommendation,
      reasonCode: effectiveDecision.reasonCode,
      reason: effectiveDecision.reason,
      executionIntent: runtimeState.executionIntent,
      runtimeState,
      strategyValidity: {
        score: validityResult.score,
        action: validityResult.recommendedAction,
        actionScore: validityResult.actionScore,
        weightedScore: validityResult.weightedScore,
        baseAction: validityResult.baseAction,
        driftReasons: validityResult.driftReasons,
        shadowMode: validityResult.shadowMode,
      },
      strategyMutation: mutationResult || null,
      adaptiveCadence: {
        cadenceMs: adaptiveCadence.cadenceMs,
        triggerType: adaptiveCadence.triggerType,
        overrideApplied: adaptiveCadence.overrideApplied,
      },
      dynamicPositionSizing: dynamicSizing,
      dynamicTrail,
      positionSnapshot: {
        amount: safeNumber(position.amount),
        avgPrice: safeNumber(position.avg_price),
        unrealizedPnl: safeNumber(position.unrealized_pnl),
        entryTime: position.entry_time || null,
        strategyProfile: strategyProfile ? {
          strategyName: strategyProfile.strategy_name || null,
          setupType: strategyProfile.setup_type || null,
          thesis: strategyProfile.thesis || null,
          strategyState: strategyProfile.strategy_state || {},
          familyPerformanceFeedback: getFamilyPerformanceFeedback(strategyProfile),
          responsibilityPlan: getResponsibilityPlan(strategyProfile),
          positionRuntimeState: runtimeState,
        } : null,
      },
      analysisSnapshot: {
        ...analysisSummary,
        backtestDrift: decision.driftContext,
        regime: regimeSnapshot ? {
          market: regimeSnapshot.market || regimeKey,
          regime: regimeSnapshot.regime || null,
          confidence: regimeSnapshot.confidence ?? null,
          capturedAt: regimeSnapshot.captured_at || null,
        } : null,
        externalEvidenceSummary: externalEvidenceSummary || null,
        externalEvidenceGapState: externalEvidenceGapState || null,
        runtimeState,
        latestBacktest: latestBacktest ? {
          createdAt: latestBacktest.created_at || null,
          label: latestBacktest.label || null,
          sharpe: latestBacktest.sharpe ?? null,
          totalReturn: latestBacktest.total_return ?? null,
          maxDrawdown: latestBacktest.max_drawdown ?? null,
          totalTrades: latestBacktest.total_trades ?? null,
        } : null,
        strategyProfile: strategyProfile ? {
          strategyName: strategyProfile.strategy_name || null,
          setupType: strategyProfile.setup_type || null,
          monitoringPlan: strategyProfile.monitoring_plan || {},
          exitPlan: strategyProfile.exit_plan || {},
          strategyState: strategyProfile.strategy_state || {},
          familyPerformanceFeedback: getFamilyPerformanceFeedback(strategyProfile),
          responsibilityPlan: getResponsibilityPlan(strategyProfile),
          positionRuntimeState: runtimeState,
        } : null,
      },
    });
  }

  const activeResults = results.filter((item) => item.ignored !== true);
  const ignoredResults = results.filter((item) => item.ignored === true);

  let persisted = 0;
  if (persist && results.length > 0) {
    persisted = await persistRuns(results);
  }

  await refreshInvestmentAgentRoles({
    reevaluationReport: {
      rows: results,
      activeCount: activeResults.length,
      ignoredCount: ignoredResults.length,
      summary: {
        hold: activeResults.filter((item) => item.recommendation === 'HOLD').length,
        adjust: activeResults.filter((item) => item.recommendation === 'ADJUST').length,
        exit: activeResults.filter((item) => item.recommendation === 'EXIT').length,
        ignored: ignoredResults.length,
      },
    },
    exchange: exchange || 'binance',
  }).catch(() => null);

  return {
    ok: true,
    count: results.length,
    activeCount: activeResults.length,
    ignoredCount: ignoredResults.length,
    persisted,
    summary: {
      hold: activeResults.filter((item) => item.recommendation === 'HOLD').length,
      adjust: activeResults.filter((item) => item.recommendation === 'ADJUST').length,
      exit: activeResults.filter((item) => item.recommendation === 'EXIT').length,
      ignored: ignoredResults.length,
    },
    rows: results,
  };
}
