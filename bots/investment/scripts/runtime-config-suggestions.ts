#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/runtime-config-suggestions.js
 *
 * 최근 자동매매 운영 데이터를 바탕으로 runtime_config 변경 후보를 제안한다.
 * 실제 값을 자동 변경하지 않고, current -> suggested / 근거 / confidence 만 출력한다.
 */

import * as db from '../shared/db.ts';
import { getInvestmentExecutionRuntimeConfig, getInvestmentRuntimeConfig, getValidationSoftBudgetConfig } from '../shared/runtime-config.ts';
import { getCapitalConfig } from '../shared/capital-manager.ts';
import { annotateRuntimeSuggestions, buildParameterGovernanceReport } from '../shared/runtime-parameter-governance.ts';
import { loadCryptoLiveGateReview } from './crypto-live-gate-review.ts';
import { buildRuntimeCryptoSoftGuardReport } from './runtime-crypto-soft-guard-report.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find(arg => arg.startsWith('--days='));
  const days = Math.max(7, Number(daysArg?.split('=')[1] || 14));
  return {
    days,
    json: argv.includes('--json'),
    write: argv.includes('--write'),
  };
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toCount(rows, predicate) {
  return rows.filter(predicate).reduce((sum, row) => sum + Number(row.cnt || 0), 0);
}

async function loadSignalRows(fromDate, toDate) {
  return db.query(`
    SELECT
      exchange,
      action,
      status,
      COUNT(*) AS cnt
    FROM signals
    WHERE CAST(created_at AT TIME ZONE 'Asia/Seoul' AS DATE) BETWEEN '${fromDate}' AND '${toDate}'
    GROUP BY exchange, action, status
    ORDER BY exchange, action, status
  `);
}

async function loadBlockCodeRows(fromDate, toDate) {
  return db.query(`
    SELECT
      exchange,
      COALESCE(NULLIF(block_code, ''), 'legacy_unclassified') AS block_code,
      COUNT(*) AS cnt
    FROM signals
    WHERE CAST(created_at AT TIME ZONE 'Asia/Seoul' AS DATE) BETWEEN '${fromDate}' AND '${toDate}'
      AND status IN ('failed', 'rejected', 'expired')
    GROUP BY exchange, 2
    ORDER BY exchange, cnt DESC
  `);
}

async function loadAnalysisRows(fromDate, toDate) {
  return db.query(`
    SELECT
      exchange,
      analyst,
      signal,
      COUNT(*) AS cnt
    FROM analysis
    WHERE CAST(created_at AT TIME ZONE 'Asia/Seoul' AS DATE) BETWEEN '${fromDate}' AND '${toDate}'
    GROUP BY exchange, analyst, signal
    ORDER BY exchange, analyst, signal
  `);
}

async function loadPipelineRows(fromDate, toDate) {
  return db.query(`
    SELECT
      market,
      COALESCE(JSONB_AGG(meta) FILTER (WHERE meta IS NOT NULL), '[]'::jsonb) AS meta_rows
    FROM pipeline_runs
    WHERE pipeline = 'luna_pipeline'
      AND CAST(to_timestamp(started_at / 1000.0) AT TIME ZONE 'Asia/Seoul' AS DATE)
          BETWEEN '${fromDate}' AND '${toDate}'
    GROUP BY market
    ORDER BY market
  `);
}

async function loadTradeModeTradeRows(fromDate, toDate) {
  return db.query(`
    SELECT
      exchange,
      COALESCE(trade_mode, 'normal') AS trade_mode,
      COUNT(*) AS total,
      SUM(CASE WHEN paper THEN 1 ELSE 0 END) AS paper_trades,
      SUM(CASE WHEN paper THEN 0 ELSE 1 END) AS live_trades
    FROM trades
    WHERE CAST(executed_at AS DATE) BETWEEN '${fromDate}' AND '${toDate}'
    GROUP BY exchange, 2
    ORDER BY exchange, 2
  `);
}

async function loadTodayTradeModeTradeRows() {
  return db.query(`
    SELECT
      exchange,
      COALESCE(trade_mode, 'normal') AS trade_mode,
      COUNT(*) AS total,
      SUM(CASE WHEN paper THEN 1 ELSE 0 END) AS paper_trades,
      SUM(CASE WHEN paper THEN 0 ELSE 1 END) AS live_trades
    FROM trades
    WHERE CAST(executed_at AS DATE) = CURRENT_DATE
      AND LOWER(COALESCE(side, '')) = 'buy'
    GROUP BY exchange, 2
    ORDER BY exchange, 2
  `);
}

async function loadTodaySignalBlockRows() {
  return db.query(`
    SELECT
      exchange,
      COALESCE(trade_mode, 'normal') AS trade_mode,
      COALESCE(NULLIF(block_code, ''), 'legacy_unclassified') AS block_code,
      COUNT(*) AS total
    FROM signals
    WHERE CAST(created_at AT TIME ZONE 'Asia/Seoul' AS DATE) = CURRENT_DATE
      AND status IN ('failed', 'rejected', 'expired')
    GROUP BY exchange, 2, 3
    ORDER BY exchange, 2, 3
  `);
}

async function loadCapitalGuardTradeModeRows(fromDate, toDate) {
  return db.query(`
    SELECT
      COALESCE(trade_mode, 'normal') AS trade_mode,
      COALESCE(NULLIF(block_reason, ''), 'unknown') AS block_reason,
      COUNT(*) AS cnt
    FROM signals
    WHERE exchange = 'binance'
      AND CAST(created_at AT TIME ZONE 'Asia/Seoul' AS DATE) BETWEEN '${fromDate}' AND '${toDate}'
      AND status IN ('failed', 'rejected', 'expired')
      AND COALESCE(block_code, '') = 'capital_guard_rejected'
    GROUP BY 1, 2
    ORDER BY cnt DESC, trade_mode ASC, block_reason ASC
  `);
}

async function loadRegimeLaneRows(days = 90) {
  const safeDays = Math.max(14, Number(days || 90));
  const sinceEpochMs = Date.now() - safeDays * 24 * 60 * 60 * 1000;
  return db.query(`
    SELECT
      market_regime,
      COALESCE(trade_mode, 'normal') AS trade_mode,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'closed') AS closed,
      COUNT(*) FILTER (WHERE pnl_percent > 0) AS wins,
      ROUND(AVG(pnl_percent)::numeric, 4) AS avg_pnl_percent
    FROM investment.trade_journal
    WHERE created_at >= $1
      AND market_regime IS NOT NULL
      AND market_regime <> ''
    GROUP BY 1, 2
    ORDER BY market_regime, trade_mode
  `, [sinceEpochMs]).catch(() => []);
}

async function loadStrategyFamilyRows(days = 90) {
  const safeDays = Math.max(14, Number(days || 90));
  const sinceEpochMs = Date.now() - safeDays * 24 * 60 * 60 * 1000;
  return db.query(`
    SELECT
      exchange,
      COALESCE(NULLIF(strategy_family, ''), 'unknown') AS strategy_family,
      COALESCE(NULLIF(strategy_quality, ''), 'unknown') AS strategy_quality,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'closed' OR exit_time IS NOT NULL) AS closed,
      COUNT(*) FILTER (WHERE (status = 'closed' OR exit_time IS NOT NULL) AND COALESCE(pnl_net, pnl_amount, 0) > 0) AS wins,
      ROUND(AVG(CASE WHEN status = 'closed' OR exit_time IS NOT NULL THEN pnl_percent ELSE NULL END)::numeric, 4) AS avg_pnl_percent,
      ROUND(SUM(CASE WHEN status = 'closed' OR exit_time IS NOT NULL THEN COALESCE(pnl_net, pnl_amount, 0) ELSE 0 END)::numeric, 4) AS pnl_net
    FROM investment.trade_journal
    WHERE created_at >= $1
      AND COALESCE(exclude_from_learning, false) = false
      AND COALESCE(NULLIF(strategy_family, ''), 'unknown') <> 'unknown'
    GROUP BY 1, 2, 3
    ORDER BY closed DESC, total DESC, exchange ASC, strategy_family ASC
  `, [sinceEpochMs]).catch(() => []);
}

function buildDateRange(days) {
  const to = new Date();
  const from = new Date(Date.now() - (days - 1) * 86400000);
  const toDate = to.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const fromDate = from.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  return { fromDate, toDate };
}

function summarizeExchange(signalRows, blockRows, analysisRows, exchange) {
  const exchangeSignals = signalRows.filter(row => row.exchange === exchange);
  const exchangeBlocks = blockRows.filter(row => row.exchange === exchange);
  const exchangeAnalysis = analysisRows.filter(row => row.exchange === exchange);
  const totalBuy = toCount(exchangeSignals, row => row.action === 'BUY');
  const executed = toCount(exchangeSignals, row => row.status === 'executed');
  const failed = toCount(exchangeSignals, row => ['failed', 'rejected', 'expired'].includes(row.status));
  const topBlocks = exchangeBlocks
    .map(row => ({ code: row.block_code, count: Number(row.cnt || 0) }))
    .sort((a, b) => b.count - a.count);
  const taTotal = toCount(exchangeAnalysis, row => row.analyst === 'ta_mtf');
  const taHold = toCount(exchangeAnalysis, row => row.analyst === 'ta_mtf' && row.signal === 'HOLD');
  const sentimentTotal = toCount(exchangeAnalysis, row => row.analyst === 'sentiment');
  const sentimentHold = toCount(exchangeAnalysis, row => row.analyst === 'sentiment' && row.signal === 'HOLD');

  return {
    exchange,
    totalBuy,
    executed,
    failed,
    executionRate: totalBuy > 0 ? round((executed / totalBuy) * 100, 1) : 0,
    failureRate: totalBuy > 0 ? round((failed / totalBuy) * 100, 1) : 0,
    topBlocks,
    taHoldRate: taTotal > 0 ? round((taHold / taTotal) * 100, 1) : null,
    sentimentHoldRate: sentimentTotal > 0 ? round((sentimentHold / sentimentTotal) * 100, 1) : null,
  };
}

function getMarketBucket(exchange) {
  if (exchange === 'kis') return 'domestic';
  if (exchange === 'kis_overseas') return 'overseas';
  return 'crypto';
}

function summarizeValidationSignals(pipelineRows, tradeRows, market) {
  const row = pipelineRows.find(item => item.market === market);
  const summary = {
    decision: 0,
    buy: 0,
    hold: 0,
    approved: 0,
    executed: 0,
    weak: 0,
    risk: 0,
    weakReasons: {},
    strategyRouteCounts: {},
    strategyRouteQualityCounts: {},
    strategyRouteReadinessSum: 0,
    strategyRouteReadinessCount: 0,
  };
  for (const meta of (row?.meta_rows || [])) {
    const mode = String(meta?.investment_trade_mode || 'normal').toUpperCase();
    if (mode !== 'VALIDATION') continue;
    summary.decision += Number(meta?.decided_symbols || 0);
    summary.buy += Number(meta?.buy_decisions || 0);
    summary.hold += Number(meta?.hold_decisions || 0);
    summary.approved += Number(meta?.approved_signals || 0);
    summary.executed += Number(meta?.executed_symbols || 0);
    summary.weak += Number(meta?.weak_signal_skipped || 0);
    summary.risk += Number(meta?.risk_rejected || 0);
    const weakReasons = meta?.weak_signal_reasons || {};
    for (const [reason, count] of Object.entries(weakReasons)) {
      summary.weakReasons[reason] = (summary.weakReasons[reason] || 0) + Number(count || 0);
    }
    for (const [family, count] of Object.entries(meta?.strategy_route_counts || {})) {
      summary.strategyRouteCounts[family] = (summary.strategyRouteCounts[family] || 0) + Number(count || 0);
    }
    for (const [quality, count] of Object.entries(meta?.strategy_route_quality_counts || {})) {
      summary.strategyRouteQualityCounts[quality] = (summary.strategyRouteQualityCounts[quality] || 0) + Number(count || 0);
    }
    if (Number.isFinite(Number(meta?.strategy_route_avg_readiness))) {
      summary.strategyRouteReadinessSum += Number(meta.strategy_route_avg_readiness);
      summary.strategyRouteReadinessCount++;
    }
  }

  const trade = tradeRows.find(item =>
    getMarketBucket(item.exchange) === market &&
    String(item.trade_mode || 'normal').toUpperCase() === 'VALIDATION'
  );

  const tradeTotal = Number(trade?.total || 0);
  const liveTrades = Number(trade?.live_trades || 0);
  const paperTrades = Number(trade?.paper_trades || 0);
  const effectiveExecuted = Math.max(summary.executed, tradeTotal);

  return {
    ...summary,
    approved: Math.max(summary.approved, effectiveExecuted),
    executed: effectiveExecuted,
    tradeTotal,
    liveTrades,
    paperTrades,
    weakTopReason: Object.entries(summary.weakReasons).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    strategyRouteTop: Object.entries(summary.strategyRouteCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    strategyRouteQualityTop: Object.entries(summary.strategyRouteQualityCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    strategyRouteAvgReadiness: summary.strategyRouteReadinessCount > 0
      ? Number((summary.strategyRouteReadinessSum / summary.strategyRouteReadinessCount).toFixed(4))
      : null,
  };
}

function buildValidationBudgetSnapshot(exchange, tradeMode, todayTradeRows, todayBlockRows = []) {
  const softBudget = getValidationSoftBudgetConfig(exchange);
  const hardCap = getCapitalConfig(exchange, tradeMode)?.max_daily_trades || 0;
  const reserveSlots = Number(softBudget.reserveDailyBuySlots || 0);
  const softCap = hardCap > 0 ? Math.max(1, hardCap - reserveSlots) : 0;
  const trade = todayTradeRows.find((item) =>
    item.exchange === exchange &&
    String(item.trade_mode || 'normal').toLowerCase() === String(tradeMode || 'normal').toLowerCase()
  );
  const normalTrade = todayTradeRows.find((item) =>
    item.exchange === exchange &&
    String(item.trade_mode || 'normal').toLowerCase() === 'normal'
  );
  const softCapBlock = todayBlockRows.find((item) =>
    item.exchange === exchange &&
    String(item.trade_mode || 'normal').toLowerCase() === String(tradeMode || 'normal').toLowerCase() &&
    item.block_code === 'validation_daily_budget_soft_cap'
  );
  const capitalGuardBlock = todayBlockRows.find((item) =>
    item.exchange === exchange &&
    String(item.trade_mode || 'normal').toLowerCase() === String(tradeMode || 'normal').toLowerCase() &&
    item.block_code === 'capital_guard_rejected'
  );
  const count = Number(trade?.total || 0);
  const ratio = softCap > 0 ? round(count / softCap, 3) : 0;
  return {
    exchange,
    tradeMode,
    enabled: Boolean(softBudget.enabled),
    count,
    normalCount: Number(normalTrade?.total || 0),
    hardCap,
    reserveSlots,
    softCap,
    ratio,
    softCapBlocks: Number(softCapBlock?.total || 0),
    capitalGuardBlocks: Number(capitalGuardBlock?.total || 0),
    atSoftCap: softCap > 0 && count >= softCap,
    nearSoftCap: softCap > 0 && count < softCap && ratio >= 0.8,
  };
}

function buildCapitalGuardBiasSnapshot(rows = []) {
  const total = rows.reduce((sum, row) => sum + Number(row.cnt || 0), 0);
  const byTradeMode = new Map();
  const byReason = new Map();
  for (const row of rows) {
    const tradeMode = String(row.trade_mode || 'normal');
    const reason = String(row.block_reason || 'unknown');
    byTradeMode.set(tradeMode, (byTradeMode.get(tradeMode) || 0) + Number(row.cnt || 0));
    byReason.set(reason, (byReason.get(reason) || 0) + Number(row.cnt || 0));
  }
  const validationCount = Number(byTradeMode.get('validation') || 0);
  const normalCount = Number(byTradeMode.get('normal') || 0);
  const validationRatio = total > 0 ? round((validationCount / total) * 100, 1) : 0;
  const topReason = [...byReason.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, 'ko'))[0] || null;
  return {
    total,
    validationCount,
    normalCount,
    validationRatio,
    topReason,
  };
}

function buildValidationBudgetPolicySnapshot(
  cryptoValidationBudget = null,
  capitalGuardBias = null,
  cryptoLiveGateReview = null,
) {
  const validationRatio = Number(capitalGuardBias?.validationRatio || 0);
  const closedReviews = Number(cryptoLiveGateReview?.metrics?.closedReviews || 0);
  const weak = Number(cryptoLiveGateReview?.metrics?.pipeline?.weak || 0);
  const gateDecision = String(cryptoLiveGateReview?.liveGate?.decision || 'unknown');
  const softCapBlocks = Number(cryptoValidationBudget?.softCapBlocks || 0);

  let decision = 'hold_current_structure';
  let decisionLabel = '현 구조 유지';
  const reasons = [
    `soft cap 차단 ${softCapBlocks}건`,
    `validation capital guard ${validationRatio}%`,
    `LIVE gate ${gateDecision}`,
    `closed review ${closedReviews}건 / weak ${weak}건`,
  ];

  if (softCapBlocks > 0 && gateDecision !== 'blocked' && weak <= 20 && closedReviews >= 3) {
    decision = 'consider_raise_validation_budget';
    decisionLabel = '상향 검토 가능';
    reasons.unshift('validation daily budget 상향 검토 가능');
  } else if (validationRatio >= 80) {
    decision = 'consider_policy_split';
    decisionLabel = '정책 분리 검토';
    reasons.unshift('총량 상향보다 validation 전용 budget 구조 분리 검토 우선');
  } else {
    reasons.unshift('현재 값 유지 및 추가 관찰');
  }

  return {
    decision,
    decisionLabel,
    softCapBlocks,
    validationRatio,
    gateDecision,
    closedReviews,
    weak,
    reasons,
  };
}

function buildValidationBudgetPolicyTrend(currentPolicy = null, previousSnapshot = null) {
  const previousPolicy = previousSnapshot?.validationBudgetPolicy || null;
  if (!currentPolicy) return null;
  if (!previousPolicy) {
    return {
      status: 'no_history',
      label: '비교 이력 없음',
      lines: ['첫 policy snapshot이거나 직전 비교 대상이 아직 없습니다.'],
    };
  }

  const changed = previousPolicy.decision !== currentPolicy.decision;
  const previousRatio = Number(previousSnapshot?.capitalGuardBias?.validationRatio || 0);
  const currentRatio = Number(currentPolicy?.validationRatio || 0);
  const delta = round(currentRatio - previousRatio, 1);

  return {
    status: changed ? 'changed' : 'stable',
    label: changed ? '직전 대비 판단 변경' : '직전 대비 판단 유지',
    lines: [
      `이전 판단: ${previousPolicy.decisionLabel || previousPolicy.decision || 'n/a'}`,
      `현재 판단: ${currentPolicy.decisionLabel || currentPolicy.decision || 'n/a'}`,
      `validation capital guard 비중 변화: ${previousRatio}% → ${currentRatio}% (${delta >= 0 ? '+' : ''}${delta}%p)`,
    ],
  };
}

function buildCryptoSuggestions(config, crypto) {
  const suggestions = [];
  if (crypto.totalBuy >= 3 && crypto.executed === 0 && crypto.failed >= 3) {
    suggestions.push({
      key: 'runtime_config.luna.fastPathThresholds.minCryptoConfidence',
      current: config.luna.fastPathThresholds.minCryptoConfidence,
      suggested: round(clamp(config.luna.fastPathThresholds.minCryptoConfidence - 0.04, 0.42, 0.70), 2),
      action: 'adjust',
      confidence: 'medium',
      reason: `최근 ${crypto.totalBuy}건 BUY 중 실행 0건, 실패 ${crypto.failed}건으로 암호화폐 fast-path가 과도하게 보수적일 가능성이 있습니다.`,
    });
    suggestions.push({
      key: 'runtime_config.luna.debateThresholds.crypto.minAverageConfidence',
      current: config.luna.debateThresholds.crypto.minAverageConfidence,
      suggested: round(clamp(config.luna.debateThresholds.crypto.minAverageConfidence - 0.04, 0.50, 0.70), 2),
      action: 'adjust',
      confidence: 'medium',
      reason: `암호화폐 실행 전환이 0%라 debate 승격 기준을 소폭 완화해 비교할 가치가 있습니다.`,
    });
    suggestions.push({
      key: 'runtime_config.luna.debateThresholds.crypto.minAbsScore',
      current: config.luna.debateThresholds.crypto.minAbsScore,
      suggested: round(clamp(config.luna.debateThresholds.crypto.minAbsScore - 0.03, 0.15, 0.40), 2),
      action: 'adjust',
      confidence: 'low',
      reason: `암호화폐 신호가 BUY로 저장되더라도 실행으로 이어지지 않아 절대 점수 기준을 조금 완화해볼 후보입니다.`,
    });
  } else {
    suggestions.push({
      key: 'runtime_config.luna.fastPathThresholds.minCryptoConfidence',
      current: config.luna.fastPathThresholds.minCryptoConfidence,
      suggested: config.luna.fastPathThresholds.minCryptoConfidence,
      action: 'hold',
      confidence: 'medium',
      reason: '암호화폐 실행/실패 표본이 설정 조정까지 판단하기엔 아직 충분하지 않습니다.',
    });
  }
  if (crypto.taHoldRate != null && crypto.taHoldRate >= 95) {
    suggestions.push({
      key: 'runtime_config.luna.analystWeights.crypto.taMtf',
      current: config.luna.analystWeights.crypto.taMtf,
      suggested: round(clamp(config.luna.analystWeights.crypto.taMtf - 0.03, 0.10, 0.30), 2),
      action: 'adjust',
      confidence: 'low',
      reason: `암호화폐 ta_mtf HOLD 비율이 ${crypto.taHoldRate}%로 과도하게 높아 최종 승격을 누를 가능성이 있습니다.`,
    });
  }
  return suggestions;
}

function buildDomesticSuggestions(config, domestic) {
  const suggestions = [];
  if (domestic.totalBuy > 0 && domestic.executed === 0 && domestic.topBlocks[0]?.code === 'min_order_notional') {
    suggestions.push({
      key: 'runtime_config.luna.stockOrderDefaults.kis.min',
      current: config.luna.stockOrderDefaults.kis.min,
      suggested: config.luna.stockOrderDefaults.kis.min,
      action: 'hold',
      confidence: 'medium',
      reason: `국내장 실패는 최소 주문금액 미달 패턴이지만 현재 기본 주문금액은 이미 ${config.luna.stockOrderDefaults.kis.buyDefault.toLocaleString()} KRW라, 과거 레거시 실패 가능성이 커서 즉시 조정보다 신규 데이터 확인이 우선입니다.`,
    });
  }
  return suggestions;
}

function buildOverseasSuggestions(config, overseas) {
  const suggestions = [];
  if (overseas.totalBuy >= 8 && overseas.executed >= 3 && overseas.topBlocks[0]?.code === 'legacy_order_rejected') {
    suggestions.push({
      key: 'runtime_config.luna.stockOrderDefaults.kis_overseas.max',
      current: config.luna.stockOrderDefaults.kis_overseas.max,
      suggested: config.luna.stockOrderDefaults.kis_overseas.max,
      action: 'hold',
      confidence: 'medium',
      reason: `해외장은 실행 ${overseas.executed}건이 이미 나오고 있고, 주 실패 코드는 과거 legacy_order_rejected라 현재 한도보다는 원인 정제와 신규 데이터 관찰이 우선입니다.`,
    });
  }

  if (overseas.totalBuy >= 8 && overseas.executed > 0 && overseas.topBlocks[0]?.code === 'min_order_notional') {
    suggestions.push({
      key: 'runtime_config.luna.stockOrderDefaults.kis_overseas.min',
      current: config.luna.stockOrderDefaults.kis_overseas.min,
      suggested: round(clamp(config.luna.stockOrderDefaults.kis_overseas.min + 25, 200, 400), 0),
      action: 'adjust',
      confidence: 'medium',
      reason: `해외장 BUY 실패 상위가 최소 주문금액 미달 ${overseas.topBlocks[0]?.count || 0}건이라 주문 floor를 소폭 올려 실제 체결 전환을 비교할 수 있습니다.`,
    });
  } else if (overseas.totalBuy >= 8 && overseas.executed > 0 && overseas.executionRate < 50) {
    suggestions.push({
      key: 'runtime_config.luna.minConfidence.live.kis_overseas',
      current: config.luna.minConfidence.live.kis_overseas,
      suggested: round(clamp(config.luna.minConfidence.live.kis_overseas - 0.02, 0.12, 0.30), 2),
      action: 'adjust',
      confidence: 'low',
      reason: `해외장 LIVE 실행률이 ${overseas.executionRate}%로 아직 낮아 최소 confidence 기준을 소폭 완화해 비교할 수 있습니다.`,
    });
  }
  return suggestions;
}

function buildValidationPromotionSuggestions(config, validationSummaries) {
  const suggestions = [];
  const domesticValidation = validationSummaries.domestic;
  const overseasValidation = validationSummaries.overseas;
  const cryptoValidation = validationSummaries.crypto;

  if (cryptoValidation.strategyRouteQualityTop === 'thin') {
    suggestions.push({
      key: 'runtime_config.luna.strategyRouter.binance.validation.routeQuality',
      current: cryptoValidation.strategyRouteQualityTop,
      suggested: cryptoValidation.strategyRouteQualityTop,
      action: 'observe',
      confidence: 'medium',
      reason: `암호화폐 validation의 전략 라우팅 품질이 ${cryptoValidation.strategyRouteQualityTop} 중심이고 top family가 ${cryptoValidation.strategyRouteTop || 'none'}라, confidence threshold 완화보다 전략 패밀리 가중치와 입력 품질 보강을 먼저 보는 편이 좋습니다.`,
    });
  }

  if (domesticValidation.liveTrades > 0 || domesticValidation.executed > 0) {
    suggestions.push({
      key: 'runtime_config.nemesis.thresholds.stockStarterApproveDomestic',
      current: config.nemesis.thresholds.stockStarterApproveDomestic,
      suggested: Math.max(
        config.nemesis.thresholds.stockStarterApproveDomestic,
        config.nemesis.thresholds.byTradeMode?.validation?.stockStarterApproveDomestic || config.nemesis.thresholds.stockStarterApproveDomestic,
      ),
      action: 'promote_candidate',
      confidence: 'medium',
      reason: `국내장 validation에서 executed ${domesticValidation.executed}건 / LIVE ${domesticValidation.liveTrades}건이 확인됐고 전략 라우팅 top이 ${domesticValidation.strategyRouteTop || 'none'}라 starter 승인 한도 일부를 normal 후보로 승격 검토할 가치가 있습니다.`,
    });
    suggestions.push({
      key: 'runtime_config.luna.stockStrategyProfiles.aggressive.tradeModes.validation.minConfidence.live',
      current: config.luna.stockStrategyProfiles.aggressive.minConfidence?.live,
      suggested: config.luna.stockStrategyProfiles.aggressive.tradeModes?.validation?.minConfidence?.live ?? config.luna.stockStrategyProfiles.aggressive.minConfidence?.live,
      action: 'promote_candidate',
      confidence: 'low',
      reason: '국내장 validation에서 실제 LIVE 체결이 발생해 공격적 검증 모드의 live minConfidence 일부 승격을 비교할 수 있습니다.',
    });
  }

  if (overseasValidation.decision > 0 && overseasValidation.hold >= overseasValidation.decision) {
    suggestions.push({
      key: 'runtime_config.luna.stockStrategyProfiles.aggressive.tradeModes.validation.minConfidence.live',
      current: config.luna.stockStrategyProfiles.aggressive.minConfidence?.live,
      suggested: config.luna.stockStrategyProfiles.aggressive.tradeModes?.validation?.minConfidence?.live ?? config.luna.stockStrategyProfiles.aggressive.minConfidence?.live,
      action: 'observe',
      confidence: 'low',
      reason: `해외장 validation은 decision ${overseasValidation.decision}건이 대부분 HOLD라 추가 장중 표본 확인 후 승격 여부를 판단하는 것이 안전합니다.`,
    });
  }
  return suggestions;
}

function buildValidationBudgetSuggestions(
  validationBudgetSnapshots = {},
  validationBudgetPolicy = null,
) {
  const suggestions = [];
  const cryptoValidationBudget = validationBudgetSnapshots.cryptoValidation;
  if (cryptoValidationBudget?.enabled && (cryptoValidationBudget.nearSoftCap || cryptoValidationBudget.atSoftCap)) {
    suggestions.push({
      key: 'runtime_config.luna.validationSoftBudget.binance.reserveDailyBuySlots',
      current: cryptoValidationBudget.reserveSlots,
      suggested: cryptoValidationBudget.reserveSlots,
      action: 'observe',
      confidence: 'medium',
      reason: `오늘 crypto validation BUY가 ${cryptoValidationBudget.count}/${cryptoValidationBudget.softCap} soft cap (hard ${cryptoValidationBudget.hardCap})로 ${cryptoValidationBudget.atSoftCap ? '도달' : '근접'} 상태입니다. soft cap 발동 빈도와 capital_guard 감소 여부를 먼저 관찰하는 것이 안전합니다.`,
    });
  }

  if (cryptoValidationBudget?.enabled && cryptoValidationBudget.softCapBlocks > 0) {
    const relaxedReserve = Math.max(1, cryptoValidationBudget.reserveSlots - 1);
    const canRelaxReserve =
      cryptoValidationBudget.normalCount === 0 &&
      cryptoValidationBudget.capitalGuardBlocks === 0 &&
      cryptoValidationBudget.reserveSlots > 1;
    suggestions.push({
      key: 'runtime_config.luna.validationSoftBudget.binance.reserveDailyBuySlots',
      current: cryptoValidationBudget.reserveSlots,
      suggested: canRelaxReserve ? relaxedReserve : cryptoValidationBudget.reserveSlots,
      action: canRelaxReserve ? 'promote_candidate' : 'observe',
      confidence: 'medium',
      reason: canRelaxReserve
        ? `오늘 crypto validation soft cap 차단이 ${cryptoValidationBudget.softCapBlocks}건 발생했고 normal BUY는 0건이라 reserve ${cryptoValidationBudget.reserveSlots} 슬롯이 과보수적일 가능성이 있습니다. reserve를 ${relaxedReserve}로 낮추는 비교 실험 후보입니다.`
        : `오늘 crypto validation soft cap 차단이 ${cryptoValidationBudget.softCapBlocks}건 발생했습니다. 다만 normal BUY ${cryptoValidationBudget.normalCount}건 또는 validation capital_guard ${cryptoValidationBudget.capitalGuardBlocks}건이 함께 있어 reserve ${cryptoValidationBudget.reserveSlots} 슬롯은 우선 유지 관찰이 안전합니다.`,
    });
  }

  if (validationBudgetPolicy?.decision === 'consider_policy_split') {
    suggestions.push({
      key: 'capital_management.by_exchange.binance.trade_modes.validation.max_daily_trades',
      current: getCapitalConfig('binance', 'validation')?.max_daily_trades,
      suggested: getCapitalConfig('binance', 'validation')?.max_daily_trades,
      action: 'observe',
      confidence: 'medium',
      reason: `현재 정책 판단은 ${validationBudgetPolicy.decisionLabel}입니다. ${validationBudgetPolicy.reasons.join(' / ')} 기준으로, 지금은 max_daily_trades 총량 상향보다 validation 전용 daily budget 구조 분리 검토가 우선입니다.`,
    });
  } else if (validationBudgetPolicy?.decision === 'consider_raise_validation_budget') {
    suggestions.push({
      key: 'capital_management.by_exchange.binance.trade_modes.validation.max_daily_trades',
      current: getCapitalConfig('binance', 'validation')?.max_daily_trades,
      suggested: Number(getCapitalConfig('binance', 'validation')?.max_daily_trades || 0) + 2,
      action: 'promote_candidate',
      confidence: 'medium',
      reason: `현재 정책 판단은 ${validationBudgetPolicy.decisionLabel}입니다. ${validationBudgetPolicy.reasons.join(' / ')} 기준으로 validation daily budget 상향 비교 실험 후보입니다.`,
    });
  }
  return suggestions;
}

function summarizeRegimeLaneRows(rows = []) {
  const byRegime = new Map();
  for (const row of rows) {
    const regime = String(row.market_regime || 'unknown');
    const tradeMode = String(row.trade_mode || 'normal');
    const total = Number(row.total || 0);
    const closed = Number(row.closed || 0);
    const wins = Number(row.wins || 0);
    const avgPnlPercent = row.avg_pnl_percent != null ? Number(row.avg_pnl_percent) : null;
    const winRate = closed > 0 ? round((wins / closed) * 100, 1) : null;
    if (!byRegime.has(regime)) byRegime.set(regime, []);
    byRegime.get(regime).push({ regime, tradeMode, total, closed, wins, winRate, avgPnlPercent });
  }

  const ranked = [...byRegime.entries()].map(([regime, modes]) => {
    const bestMode = [...modes]
      .filter(item => item.avgPnlPercent != null)
      .sort((a, b) => Number(b.avgPnlPercent) - Number(a.avgPnlPercent))[0] || null;
    const worstMode = [...modes]
      .filter(item => item.avgPnlPercent != null)
      .sort((a, b) => Number(a.avgPnlPercent) - Number(b.avgPnlPercent))[0] || null;
    return {
      regime,
      modes,
      bestMode,
      worstMode,
      total: modes.reduce((sum, item) => sum + Number(item.total || 0), 0),
      closed: modes.reduce((sum, item) => sum + Number(item.closed || 0), 0),
    };
  });

  return {
    byRegime: ranked.sort((a, b) => Number(b.total || 0) - Number(a.total || 0)),
    weakestRegime: [...ranked]
      .filter(item => item.worstMode && item.worstMode.avgPnlPercent != null)
      .sort((a, b) => Number(a.worstMode.avgPnlPercent) - Number(b.worstMode.avgPnlPercent))[0] || null,
    strongestRegime: [...ranked]
      .filter(item => item.bestMode && item.bestMode.avgPnlPercent != null)
      .sort((a, b) => Number(b.bestMode.avgPnlPercent) - Number(a.bestMode.avgPnlPercent))[0] || null,
  };
}

function summarizeStrategyFamilyRows(rows = []) {
  const byFamily = new Map();
  for (const row of rows) {
    const exchange = String(row.exchange || 'unknown');
    const family = String(row.strategy_family || 'unknown');
    const quality = String(row.strategy_quality || 'unknown');
    const key = `${exchange}:${family}`;
    if (!byFamily.has(key)) {
      byFamily.set(key, {
        exchange,
        family,
        qualities: [],
        total: 0,
        closed: 0,
        wins: 0,
        pnlNet: 0,
      });
    }
    const bucket = byFamily.get(key);
    const total = Number(row.total || 0);
    const closed = Number(row.closed || 0);
    const wins = Number(row.wins || 0);
    const avgPnlPercent = row.avg_pnl_percent != null ? Number(row.avg_pnl_percent) : null;
    const pnlNet = row.pnl_net != null ? Number(row.pnl_net) : 0;
    bucket.total += total;
    bucket.closed += closed;
    bucket.wins += wins;
    bucket.pnlNet += pnlNet;
    bucket.qualities.push({
      exchange,
      family,
      quality,
      total,
      closed,
      wins,
      winRate: closed > 0 ? round((wins / closed) * 100, 1) : null,
      avgPnlPercent,
      pnlNet,
    });
  }

  const ranked = [...byFamily.values()].map((item) => {
    const weightedAvg = item.qualities.reduce((acc, row) => {
      if (row.avgPnlPercent == null || row.closed <= 0) return acc;
      acc.weight += row.closed;
      acc.sum += Number(row.avgPnlPercent) * row.closed;
      return acc;
    }, { sum: 0, weight: 0 });
    const avgPnlPercent = weightedAvg.weight > 0 ? round(weightedAvg.sum / weightedAvg.weight, 4) : null;
    const bestQuality = [...item.qualities]
      .filter(row => row.avgPnlPercent != null)
      .sort((a, b) => Number(b.avgPnlPercent) - Number(a.avgPnlPercent))[0] || null;
    const worstQuality = [...item.qualities]
      .filter(row => row.avgPnlPercent != null)
      .sort((a, b) => Number(a.avgPnlPercent) - Number(b.avgPnlPercent))[0] || null;
    return {
      ...item,
      winRate: item.closed > 0 ? round((item.wins / item.closed) * 100, 1) : null,
      avgPnlPercent,
      pnlNet: round(item.pnlNet, 4),
      bestQuality,
      worstQuality,
    };
  }).sort((a, b) => Number(b.closed || 0) - Number(a.closed || 0));

  return {
    byFamily: ranked,
    weakestFamily: [...ranked]
      .filter(item => item.closed >= 5 && item.avgPnlPercent != null)
      .sort((a, b) => Number(a.avgPnlPercent) - Number(b.avgPnlPercent))[0] || null,
    strongestFamily: [...ranked]
      .filter(item => item.closed >= 5 && item.avgPnlPercent != null)
      .sort((a, b) => Number(b.avgPnlPercent) - Number(a.avgPnlPercent))[0] || null,
  };
}

function buildRegimeLaneSuggestions(config, executionConfig, regimeLaneSummary = null) {
  const suggestions = [];
  const weakest = regimeLaneSummary?.weakestRegime || null;
  const strongest = regimeLaneSummary?.strongestRegime || null;

  if (weakest?.regime === 'trending_bear' && weakest?.worstMode?.tradeMode === 'validation') {
    const currentReduction = Number(
      executionConfig?.cryptoGuardSoftening?.byExchange?.binance?.tradeModes?.normal?.validationFallback?.reductionMultiplier
      || 0.35,
    );
    suggestions.push({
      key: 'runtime_config.execution.cryptoGuardSoftening.byExchange.binance.tradeModes.normal.validationFallback.reductionMultiplier',
      current: currentReduction,
      suggested: round(clamp(currentReduction - 0.05, 0.15, 0.5), 2),
      action: 'adjust',
      confidence: 'medium',
      reason: `${weakest.regime} 장세에서 validation fallback 비중을 현재 x${currentReduction.toFixed(2)}보다 더 작게 두고 손실 레인 노출을 줄이는 비교 실험 후보입니다.`,
    });
  }

  if (strongest?.regime === 'trending_bull' && strongest?.bestMode?.tradeMode === 'normal') {
    const currentMin = Number(config.luna?.fastPathThresholds?.minCryptoConfidence || 0);
    suggestions.push({
      key: 'runtime_config.luna.fastPathThresholds.minCryptoConfidence',
      current: currentMin,
      suggested: currentMin,
      action: 'hold',
      confidence: 'medium',
      reason: `${strongest.regime} 장세의 ${strongest.bestMode.tradeMode} 레인은 평균 손익 ${round(strongest.bestMode.avgPnlPercent, 2)}%로 상대적으로 강합니다. 이 레인은 유지하며 비교 기준선 표본을 더 누적하는 편이 좋습니다.`,
    });
  }

  return suggestions;
}

function buildStrategyFamilySuggestions(strategyFamilySummary = null) {
  const suggestions = [];
  const weakest = strategyFamilySummary?.weakestFamily || null;
  const strongest = strategyFamilySummary?.strongestFamily || null;

  if (weakest?.family && weakest.closed >= 5) {
    const weakByPnl = Number(weakest.avgPnlPercent) < -2;
    const weakByWinRate = Number(weakest.winRate) < 34;
    if (weakByPnl || weakByWinRate) {
      suggestions.push({
        key: `runtime_config.luna.strategyRouter.familyPerformanceFeedback.${weakest.exchange}.${weakest.family}`,
        current: 'auto_observed',
        suggested: weakByPnl ? 'downweight_by_pnl' : 'downweight_by_win_rate',
        action: 'observe',
        confidence: weakest.closed >= 20 ? 'medium' : 'low',
        reason: `${weakest.exchange}/${weakest.family} 패밀리는 최근 종료 ${weakest.closed}건 기준 평균 손익 ${weakest.avgPnlPercent}% / 승률 ${weakest.winRate}%입니다. 라우터는 이미 이 성과를 감점 피드백으로 반영하므로, 신규 config 변경보다 다음 표본에서 감점 효과를 관찰하는 편이 좋습니다.`,
      });
    }
  }

  if (
    strongest?.family &&
    strongest.closed >= 5 &&
    Number(strongest.avgPnlPercent) > 1 &&
    Number(strongest.winRate) >= 42
  ) {
    suggestions.push({
      key: `runtime_config.luna.strategyRouter.familyPerformanceFeedback.${strongest.exchange}.${strongest.family}`,
      current: 'auto_observed',
      suggested: 'upweight_candidate',
      action: 'promote_candidate',
      confidence: strongest.closed >= 20 ? 'medium' : 'low',
      reason: `${strongest.exchange}/${strongest.family} 패밀리는 최근 종료 ${strongest.closed}건 기준 평균 손익 ${strongest.avgPnlPercent}% / 승률 ${strongest.winRate}%입니다. 같은 regime에서 ranking 가중치 상향 후보로 비교할 수 있지만, 라우터 자동 피드백과 중복되지 않도록 관찰 후 승격하는 편이 좋습니다.`,
    });
  }

  return suggestions;
}

function buildCryptoSoftGuardSuggestions(config, executionConfig, softGuardSummary = null, summaries = {}) {
  const suggestions = [];
  const decision = softGuardSummary?.decision || {};
  const metrics = decision.metrics || {};
  const crypto = summaries.binance || {};
  const currentCircuitReduction = Number(
    executionConfig?.cryptoGuardSoftening?.byExchange?.binance?.tradeModes?.normal?.circuitBreaker?.reductionMultiplier ?? 0.6,
  );
  const currentCorrelationReduction = Number(
    executionConfig?.cryptoGuardSoftening?.byExchange?.binance?.tradeModes?.normal?.correlationGuard?.reductionMultiplier ?? 0.7,
  );
  const currentOverflowSlots = Number(
    executionConfig?.cryptoGuardSoftening?.byExchange?.binance?.tradeModes?.normal?.correlationGuard?.allowOverflowSlots ?? 1,
  );
  const currentCooldownWindow = Number(
    executionConfig?.cryptoGuardSoftening?.byExchange?.binance?.tradeModes?.normal?.circuitBreaker?.maxRemainingCooldownMinutes ?? 180,
  );
  const currentValidationLiveReentryReduction = Number(
    executionConfig?.cryptoGuardSoftening?.byExchange?.binance?.tradeModes?.validation?.livePositionReentry?.reductionMultiplier ?? 0.5,
  );
  const topKind = String(metrics.topKind || '');
  const topKindCount = Number(metrics.topKindCount || 0);
  const total = Number(metrics.total || 0);

  if ((crypto.failed || 0) >= 20 && Number(metrics.total || 0) === 0) {
    suggestions.push({
      key: 'runtime_config.execution.cryptoGuardSoftening.byExchange.binance.tradeModes.normal.circuitBreaker.maxRemainingCooldownMinutes',
      current: currentCooldownWindow,
      suggested: Math.min(240, currentCooldownWindow + 30),
      action: 'promote_candidate',
      confidence: 'medium',
      reason: `최근 crypto 실패 ${crypto.failed}건인데 soft guard 실행 표본이 아직 0건이라 loss-streak 완화 허용 구간을 조금 더 넓혀 비교할 가치가 있습니다.`,
    });
    suggestions.push({
      key: 'runtime_config.execution.cryptoGuardSoftening.byExchange.binance.tradeModes.normal.correlationGuard.allowOverflowSlots',
      current: currentOverflowSlots,
      suggested: Math.min(2, currentOverflowSlots + 1),
      action: currentOverflowSlots < 2 ? 'promote_candidate' : 'observe',
      confidence: 'medium',
      reason: `correlation guard 압력은 높은데 soft guard 표본이 아직 없어 overflow slot을 한 단계 더 열어 representative pass 이후 실제 체결 전환을 비교할 수 있습니다.`,
    });
  } else if (total >= 5) {
    suggestions.push({
      key: 'runtime_config.execution.cryptoGuardSoftening.byExchange.binance.tradeModes.normal.circuitBreaker.reductionMultiplier',
      current: currentCircuitReduction,
      suggested: topKind === 'circuit_breaker_softened' && topKindCount >= 3
        ? round(clamp(currentCircuitReduction + 0.1, 0.4, 0.9), 2)
        : currentCircuitReduction,
      action: topKind === 'circuit_breaker_softened' && topKindCount >= 3 ? 'promote_candidate' : 'observe',
      confidence: 'medium',
      reason: topKind === 'circuit_breaker_softened' && topKindCount >= 3
        ? `soft guard 실행 ${total}건 중 circuit 완화가 ${topKindCount}건으로 우세해, 감산 x${currentCircuitReduction.toFixed(2)} -> x${round(clamp(currentCircuitReduction + 0.1, 0.4, 0.9), 2).toFixed(2)} 비교가 가능합니다.`
        : `soft guard 실행이 ${total}건 누적돼 현재 서킷 감산 x${currentCircuitReduction.toFixed(2)} 유지 상태에서 체결 품질을 더 보는 편이 안전합니다.`,
    });
    suggestions.push({
      key: 'runtime_config.execution.cryptoGuardSoftening.byExchange.binance.tradeModes.normal.correlationGuard.reductionMultiplier',
      current: currentCorrelationReduction,
      suggested: topKind === 'correlation_guard_softened' && topKindCount >= 3
        ? round(clamp(currentCorrelationReduction + 0.1, 0.5, 0.95), 2)
        : currentCorrelationReduction,
      action: topKind === 'correlation_guard_softened' && topKindCount >= 3 ? 'promote_candidate' : 'observe',
      confidence: 'medium',
      reason: topKind === 'correlation_guard_softened' && topKindCount >= 3
        ? `soft guard 실행 ${total}건 중 correlation 완화가 ${topKindCount}건으로 우세해, 감산 x${currentCorrelationReduction.toFixed(2)} -> x${round(clamp(currentCorrelationReduction + 0.1, 0.5, 0.95), 2).toFixed(2)} 비교가 가능합니다.`
        : `현재 correlation soft guard 감산 x${currentCorrelationReduction.toFixed(2)}가 실제 실행으로 이어지고 있어 추가 완화보다 실행 품질 추세를 먼저 확인하는 것이 좋습니다.`,
    });
    suggestions.push({
      key: 'runtime_config.execution.cryptoGuardSoftening.byExchange.binance.tradeModes.validation.livePositionReentry.reductionMultiplier',
      current: currentValidationLiveReentryReduction,
      suggested: topKind === 'validation_live_reentry_softened' && topKindCount >= 3
        ? round(clamp(currentValidationLiveReentryReduction - 0.05, 0.2, 0.8), 2)
        : currentValidationLiveReentryReduction,
      action: topKind === 'validation_live_reentry_softened' && topKindCount >= 3 ? 'promote_candidate' : 'observe',
      confidence: 'medium',
      reason: topKind === 'validation_live_reentry_softened' && topKindCount >= 3
        ? `validation live reentry 완화가 ${topKindCount}건 누적돼, 감산 x${currentValidationLiveReentryReduction.toFixed(2)} -> x${round(clamp(currentValidationLiveReentryReduction - 0.05, 0.2, 0.8), 2).toFixed(2)} 비교 후보를 만들 수 있습니다.`
        : `validation live reentry 감산 x${currentValidationLiveReentryReduction.toFixed(2)}는 아직 표본을 더 쌓으면서 실행 품질을 보는 단계입니다.`,
    });
  }

  return suggestions;
}

function buildSuggestions(
  config,
  executionConfig,
  summaries,
  validationSummaries,
  validationBudgetSnapshots = {},
  capitalGuardBias = null,
  validationBudgetPolicy = null,
  cryptoSoftGuardSummary = null,
  regimeLaneSummary = null,
  strategyFamilySummary = null,
) {
  void capitalGuardBias;
  return [
    ...buildCryptoSuggestions(config, summaries.binance),
    ...buildDomesticSuggestions(config, summaries.kis),
    ...buildOverseasSuggestions(config, summaries.kis_overseas),
    ...buildValidationPromotionSuggestions(config, validationSummaries),
    ...buildValidationBudgetSuggestions(validationBudgetSnapshots, validationBudgetPolicy),
    ...buildCryptoSoftGuardSuggestions(config, executionConfig, cryptoSoftGuardSummary, summaries),
    ...buildRegimeLaneSuggestions(config, executionConfig, regimeLaneSummary),
    ...buildStrategyFamilySuggestions(strategyFamilySummary),
  ];
}

function buildReport(days, summaries, validationSummaries, validationBudgetSnapshots, capitalGuardBias, validationBudgetPolicy, validationBudgetPolicyTrend, cryptoSoftGuardSummary, regimeLaneSummary, strategyFamilySummary, suggestions) {
  const governance = buildParameterGovernanceReport();
  return {
    periodDays: days,
    marketSummary: summaries,
    validationSummary: validationSummaries,
    validationBudgetSnapshots,
    capitalGuardBias,
    validationBudgetPolicy,
    validationBudgetPolicyTrend,
    cryptoSoftGuardSummary,
    regimeLaneSummary,
    strategyFamilySummary,
    suggestions,
    parameterGovernance: governance.summary,
    actionableSuggestions: suggestions.filter(item => item.action === 'adjust').length,
  };
}

function normalizeAnnotatedSuggestions(items = []) {
  return items.map((item) => {
    if (item.current !== item.suggested) return item;
    if (item.action === 'hold' || item.action === 'observe') return item;
    const alreadyApplied = item.changeAllowed && !item.blockedByPolicy;
    return {
      ...item,
      action: alreadyApplied ? 'observe' : 'hold',
      reason: alreadyApplied
        ? `${item.reason} 현재 런타임 값과 제안값이 같아 추가 조정보다 반영 효과 관찰이 우선입니다.`
        : `${item.reason} 현재 값과 제안값이 같아 새 조정 작업은 필요하지 않습니다.`,
      alreadyApplied,
    };
  });
}

function printHuman(report) {
  const lines = [];
  lines.push(`🔧 투자 runtime_config 변경 제안 (${report.periodDays}일)`);
  if (report.aiSummary) lines.push(`🔍 AI: ${report.aiSummary}`);
  lines.push('');
  lines.push('시장 요약:');
  for (const summary of Object.values(report.marketSummary)) {
    lines.push(`- ${summary.exchange}: BUY ${summary.totalBuy}건 / 실행 ${summary.executed}건 / 실패 ${summary.failed}건 / 실행률 ${summary.executionRate}%`);
    if (summary.topBlocks[0]) {
      lines.push(`  주요 실패 코드: ${summary.topBlocks[0].code} (${summary.topBlocks[0].count}건)`);
    }
  }
  lines.push('');
  lines.push('validation 요약:');
  for (const [market, summary] of Object.entries(report.validationSummary || {})) {
    lines.push(`- ${market}: decision ${summary.decision} / BUY ${summary.buy} / approved ${summary.approved} / executed ${summary.executed} / trades ${summary.tradeTotal} (LIVE ${summary.liveTrades} / PAPER ${summary.paperTrades})${summary.weakTopReason ? ` / weakTop ${summary.weakTopReason}` : ''}${summary.strategyRouteTop ? ` / routeTop ${summary.strategyRouteTop}` : ''}${summary.strategyRouteQualityTop ? ` / routeQuality ${summary.strategyRouteQualityTop}` : ''}${summary.strategyRouteAvgReadiness == null ? '' : ` / readiness ${summary.strategyRouteAvgReadiness}`}`);
  }
  if (Object.keys(report.validationBudgetSnapshots || {}).length > 0) {
    lines.push('');
    lines.push('validation budget 스냅샷(오늘):');
    for (const snapshot of Object.values(report.validationBudgetSnapshots)) {
      lines.push(`- ${snapshot.exchange}/${snapshot.tradeMode}: BUY ${snapshot.count}/${snapshot.softCap} soft cap (hard ${snapshot.hardCap}, reserve ${snapshot.reserveSlots}, normal ${snapshot.normalCount}, soft-cap blocks ${snapshot.softCapBlocks})`);
    }
  }
  if (report.capitalGuardBias?.total > 0) {
    lines.push('');
    lines.push('crypto capital guard 편중(최근 기간):');
    lines.push(`- 총 ${report.capitalGuardBias.total}건 / validation ${report.capitalGuardBias.validationCount}건 (${report.capitalGuardBias.validationRatio}%) / normal ${report.capitalGuardBias.normalCount}건`);
    if (report.capitalGuardBias.topReason) {
      lines.push(`  dominant reason: ${report.capitalGuardBias.topReason.reason} (${report.capitalGuardBias.topReason.count}건)`);
    }
  }
  if (report.validationBudgetPolicy) {
    lines.push('');
    lines.push('crypto validation budget 정책 판단:');
    lines.push(`- ${report.validationBudgetPolicy.decisionLabel}`);
    for (const reason of report.validationBudgetPolicy.reasons || []) {
      lines.push(`  ${reason}`);
    }
  }
  if (report.validationBudgetPolicyTrend) {
    lines.push('');
    lines.push(`crypto validation budget 판단 추세:`);
    lines.push(`- ${report.validationBudgetPolicyTrend.label}`);
    for (const line of report.validationBudgetPolicyTrend.lines || []) {
      lines.push(`  ${line}`);
    }
  }
  if (report.cryptoSoftGuardSummary?.decision) {
    lines.push('');
    lines.push('crypto soft guard:');
    lines.push(`- ${report.cryptoSoftGuardSummary.decision.status}`);
    lines.push(`  ${report.cryptoSoftGuardSummary.decision.headline}`);
  }
  if (report.regimeLaneSummary?.weakestRegime || report.regimeLaneSummary?.strongestRegime) {
    lines.push('');
    lines.push('regime lane 요약:');
    if (report.regimeLaneSummary?.weakestRegime?.worstMode) {
      const weakest = report.regimeLaneSummary.weakestRegime;
      lines.push(`- weakest: ${weakest.regime} / ${weakest.worstMode.tradeMode} / avg pnl ${weakest.worstMode.avgPnlPercent}%`);
    }
    if (report.regimeLaneSummary?.strongestRegime?.bestMode) {
      const strongest = report.regimeLaneSummary.strongestRegime;
      lines.push(`- strongest: ${strongest.regime} / ${strongest.bestMode.tradeMode} / avg pnl ${strongest.bestMode.avgPnlPercent}%`);
    }
  }
  if (report.strategyFamilySummary?.weakestFamily || report.strategyFamilySummary?.strongestFamily) {
    lines.push('');
    lines.push('strategy family 요약:');
    if (report.strategyFamilySummary?.weakestFamily) {
      const weakest = report.strategyFamilySummary.weakestFamily;
      lines.push(`- watch: ${weakest.exchange}/${weakest.family} / closed ${weakest.closed} / win ${weakest.winRate}% / avg pnl ${weakest.avgPnlPercent}%`);
    }
    if (report.strategyFamilySummary?.strongestFamily) {
      const strongest = report.strategyFamilySummary.strongestFamily;
      lines.push(`- strongest: ${strongest.exchange}/${strongest.family} / closed ${strongest.closed} / win ${strongest.winRate}% / avg pnl ${strongest.avgPnlPercent}%`);
    }
  }
  lines.push('');
  lines.push('설정 제안:');
  for (const item of report.suggestions) {
    const marker = item.action === 'adjust' ? '•' : '◦';
    lines.push(`${marker} ${item.key}`);
    lines.push(`  current: ${item.current}`);
    lines.push(`  suggested: ${item.suggested}`);
    lines.push(`  action: ${item.action} / confidence: ${item.confidence}`);
    if (item.governance?.tier) {
      lines.push(`  governance: ${item.governance.tier}${item.governance.min != null && item.governance.max != null ? ` [${item.governance.min}~${item.governance.max}]` : ''}`);
    }
    lines.push(`  reason: ${item.reason}`);
  }
  return lines.join('\n');
}

async function main() {
  const { days, json, write } = parseArgs();
  const report = await buildRuntimeConfigSuggestionsReport({ days, write });
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const human = printHuman(report);
  if (!report.saved) {
    process.stdout.write(`${human}\n`);
    return;
  }
  process.stdout.write(`${human}\n\n저장:\n- suggestion_log_id: ${report.saved.id}\n- captured_at: ${report.saved.captured_at}\n`);
}

export async function buildRuntimeConfigSuggestionsReport({ days = 14, write = false } = {}) {
  await db.initSchema();
  const { fromDate, toDate } = buildDateRange(days);
  const [signalRows, blockRows, analysisRows] = await Promise.all([
    loadSignalRows(fromDate, toDate),
    loadBlockCodeRows(fromDate, toDate),
    loadAnalysisRows(fromDate, toDate),
  ]);
  const capitalGuardTradeModeRows = await loadCapitalGuardTradeModeRows(fromDate, toDate);
  const [pipelineRows, tradeModeTradeRows] = await Promise.all([
    loadPipelineRows(fromDate, toDate),
    loadTradeModeTradeRows(fromDate, toDate),
  ]);
  const [todayTradeModeTradeRows, todaySignalBlockRows] = await Promise.all([
    loadTodayTradeModeTradeRows(),
    loadTodaySignalBlockRows(),
  ]);
  const [regimeLaneRows, strategyFamilyRows] = await Promise.all([
    loadRegimeLaneRows(Math.max(days * 3, 90)),
    loadStrategyFamilyRows(Math.max(days * 3, 90)),
  ]);
  const config = getInvestmentRuntimeConfig();
  const executionConfig = getInvestmentExecutionRuntimeConfig();
  const summaries = {
    binance: summarizeExchange(signalRows, blockRows, analysisRows, 'binance'),
    kis: summarizeExchange(signalRows, blockRows, analysisRows, 'kis'),
    kis_overseas: summarizeExchange(signalRows, blockRows, analysisRows, 'kis_overseas'),
  };
  const validationSummaries = {
    crypto: summarizeValidationSignals(pipelineRows, tradeModeTradeRows, 'crypto'),
    domestic: summarizeValidationSignals(pipelineRows, tradeModeTradeRows, 'domestic'),
    overseas: summarizeValidationSignals(pipelineRows, tradeModeTradeRows, 'overseas'),
  };
  const validationBudgetSnapshots = {
    cryptoValidation: buildValidationBudgetSnapshot('binance', 'validation', todayTradeModeTradeRows, todaySignalBlockRows),
  };
  const capitalGuardBias = buildCapitalGuardBiasSnapshot(capitalGuardTradeModeRows);
  const cryptoLiveGateReview = await loadCryptoLiveGateReview();
  const recentLogs = await db.getRecentRuntimeConfigSuggestionLogs(2).catch(() => []);
  const previousPolicySnapshot = recentLogs?.[0]?.policy_snapshot || null;
  const validationBudgetPolicy = buildValidationBudgetPolicySnapshot(
    validationBudgetSnapshots.cryptoValidation,
    capitalGuardBias,
    cryptoLiveGateReview,
  );
  const cryptoSoftGuardSummary = await buildRuntimeCryptoSoftGuardReport({ days, json: true }).catch(() => null);
  const regimeLaneSummary = summarizeRegimeLaneRows(regimeLaneRows);
  const strategyFamilySummary = summarizeStrategyFamilyRows(strategyFamilyRows);
  const validationBudgetPolicyTrend = buildValidationBudgetPolicyTrend(
    validationBudgetPolicy,
    previousPolicySnapshot,
  );
  const suggestions = normalizeAnnotatedSuggestions(
    annotateRuntimeSuggestions(
      buildSuggestions(config, executionConfig, summaries, validationSummaries, validationBudgetSnapshots, capitalGuardBias, validationBudgetPolicy, cryptoSoftGuardSummary, regimeLaneSummary, strategyFamilySummary),
    ),
  );
  const report = buildReport(
    days,
    summaries,
    validationSummaries,
    validationBudgetSnapshots,
    capitalGuardBias,
    validationBudgetPolicy,
    validationBudgetPolicyTrend,
    cryptoSoftGuardSummary,
    regimeLaneSummary,
    strategyFamilySummary,
    suggestions,
  );
  report.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-config-suggestions',
    requestType: 'runtime-config-suggestions',
    title: '투자 runtime config suggestion 리포트 요약',
    data: {
      periodDays: report.periodDays,
      actionableSuggestions: report.actionableSuggestions,
      parameterGovernance: report.parameterGovernance,
      topSuggestions: report.suggestions.slice(0, 8),
      validationBudgetPolicy: report.validationBudgetPolicy,
      capitalGuardBias: report.capitalGuardBias,
      cryptoSoftGuard: report.cryptoSoftGuardSummary?.decision || null,
      regimeLaneSummary: report.regimeLaneSummary,
      strategyFamilySummary: {
        weakestFamily: report.strategyFamilySummary?.weakestFamily || null,
        strongestFamily: report.strategyFamilySummary?.strongestFamily || null,
        byFamily: (report.strategyFamilySummary?.byFamily || []).slice(0, 5),
      },
    },
    fallback:
      report.actionableSuggestions > 0
        ? `runtime config 제안 ${report.suggestions.length}건 중 조정 후보 ${report.actionableSuggestions}건이 있어 governance tier를 먼저 확인하는 편이 좋습니다.`
        : `runtime config 제안은 ${report.suggestions.length}건이지만 현재는 observe 위주라 추세 누적을 더 보는 편이 좋습니다.`,
  });

  let saved = null;
  if (write) {
    saved = await db.insertRuntimeConfigSuggestionLog({
      periodDays: report.periodDays,
      actionableCount: report.actionableSuggestions,
      marketSummary: report.marketSummary,
      suggestions: report.suggestions,
      policySnapshot: {
        validationBudgetPolicy: report.validationBudgetPolicy,
        capitalGuardBias: report.capitalGuardBias,
        validationBudgetSnapshots: report.validationBudgetSnapshots,
        cryptoSoftGuardSummary: report.cryptoSoftGuardSummary,
        strategyFamilySummary: report.strategyFamilySummary,
      },
    });
    report.saved = saved;
  }
  return report;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-config-suggestions 오류:',
  });
}
