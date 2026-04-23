// @ts-nocheck

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as db from './db.ts';
import { refreshInvestmentAgentRoles } from './agent-role-state.ts';
import { getInvestmentSyncRuntimeConfig, getPositionReevaluationRuntimeConfig } from './runtime-config.ts';

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
  minutesBack = 180,
  persist = true,
  liveIndicators = true,
} = {}) {
  const positions = await db.getOpenPositions(exchange, paper, tradeMode);
  const results = [];

  for (const position of positions) {
    const dustDecision = classifyDustPosition(position);
    if (dustDecision) {
      results.push({
        exchange: position.exchange,
        symbol: position.symbol,
        paper: position.paper === true,
        tradeMode: position.trade_mode || 'normal',
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
        tradeMode: position.trade_mode || 'normal',
      }).catch(() => null),
      db.getLatestVectorbtBacktestForSymbol(position.symbol, position.exchange === 'binance' ? 45 : 180).catch(() => null),
    ]);
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
    if (strategyProfile?.id) {
      const attentionAt = decision.decision.recommendation === 'HOLD' ? null : new Date().toISOString();
      await db.updatePositionStrategyProfileState(position.symbol, {
        exchange: position.exchange,
        tradeMode: position.trade_mode || 'normal',
        strategyState: buildStrategyStateUpdate({
          position,
          recommendation: decision.decision.recommendation,
          reasonCode: decision.decision.reasonCode,
          reason: decision.decision.reason,
          analysisSummary,
          driftContext: decision.driftContext,
        }),
        lastEvaluationAt: new Date().toISOString(),
        lastAttentionAt: attentionAt,
      }).catch(() => null);
    }
    results.push({
      exchange: position.exchange,
      symbol: position.symbol,
      paper: position.paper === true,
      tradeMode: position.trade_mode || 'normal',
      pnlPct: calcPnlPct(position),
      recommendation: decision.decision.recommendation,
      reasonCode: decision.decision.reasonCode,
      reason: decision.decision.reason,
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
        } : null,
      },
      analysisSnapshot: {
        ...analysisSummary,
        backtestDrift: decision.driftContext,
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
