#!/usr/bin/env node
/**
 * scripts/runtime-config-suggestions.js
 *
 * 최근 자동매매 운영 데이터를 바탕으로 runtime_config 변경 후보를 제안한다.
 * 실제 값을 자동 변경하지 않고, current -> suggested / 근거 / confidence 만 출력한다.
 */

import * as db from '../shared/db.js';
import { getInvestmentRuntimeConfig, getValidationSoftBudgetConfig } from '../shared/runtime-config.js';
import { getCapitalConfig } from '../shared/capital-manager.js';
import { loadCryptoLiveGateReview } from './crypto-live-gate-review.js';

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
  const summary = { decision: 0, buy: 0, hold: 0, approved: 0, executed: 0, weak: 0, risk: 0, weakReasons: {} };
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

function buildSuggestions(
  config,
  summaries,
  validationSummaries,
  validationBudgetSnapshots = {},
  capitalGuardBias = null,
  validationBudgetPolicy = null,
) {
  const suggestions = [];
  const crypto = summaries.binance;
  const domestic = summaries.kis;
  const overseas = summaries.kis_overseas;
  const domesticValidation = validationSummaries.domestic;
  const overseasValidation = validationSummaries.overseas;
  const cryptoValidationBudget = validationBudgetSnapshots.cryptoValidation;

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

  if (overseas.totalBuy >= 8 && overseas.executed > 0 && overseas.executionRate < 50) {
    suggestions.push({
      key: 'runtime_config.luna.minConfidence.paper.kis_overseas',
      current: config.luna.minConfidence.paper.kis_overseas,
      suggested: round(clamp(config.luna.minConfidence.paper.kis_overseas - 0.02, 0.18, 0.30), 2),
      action: 'adjust',
      confidence: 'low',
      reason: `해외장 실행률이 ${overseas.executionRate}%로 아직 낮아 최소 confidence 기준을 소폭 완화해 비교할 수 있습니다.`,
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
      reason: `국내장 validation에서 executed ${domesticValidation.executed}건 / LIVE ${domesticValidation.liveTrades}건이 확인돼 starter 승인 한도 일부를 normal 후보로 승격 검토할 가치가 있습니다.`,
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

function buildReport(days, summaries, validationSummaries, validationBudgetSnapshots, capitalGuardBias, validationBudgetPolicy, suggestions) {
  return {
    periodDays: days,
    marketSummary: summaries,
    validationSummary: validationSummaries,
    validationBudgetSnapshots,
    capitalGuardBias,
    validationBudgetPolicy,
    suggestions,
    actionableSuggestions: suggestions.filter(item => item.action === 'adjust').length,
  };
}

function printHuman(report) {
  const lines = [];
  lines.push(`🔧 투자 runtime_config 변경 제안 (${report.periodDays}일)`);
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
    lines.push(`- ${market}: decision ${summary.decision} / BUY ${summary.buy} / approved ${summary.approved} / executed ${summary.executed} / trades ${summary.tradeTotal} (LIVE ${summary.liveTrades} / PAPER ${summary.paperTrades})${summary.weakTopReason ? ` / weakTop ${summary.weakTopReason}` : ''}`);
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
  lines.push('');
  lines.push('설정 제안:');
  for (const item of report.suggestions) {
    const marker = item.action === 'adjust' ? '•' : '◦';
    lines.push(`${marker} ${item.key}`);
    lines.push(`  current: ${item.current}`);
    lines.push(`  suggested: ${item.suggested}`);
    lines.push(`  action: ${item.action} / confidence: ${item.confidence}`);
    lines.push(`  reason: ${item.reason}`);
  }
  return lines.join('\n');
}

async function main() {
  const { days, json, write } = parseArgs();
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
  const config = getInvestmentRuntimeConfig();
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
  const cryptoLiveGateReview = await loadCryptoLiveGateReview(3);
  const validationBudgetPolicy = buildValidationBudgetPolicySnapshot(
    validationBudgetSnapshots.cryptoValidation,
    capitalGuardBias,
    cryptoLiveGateReview,
  );
  const suggestions = buildSuggestions(config, summaries, validationSummaries, validationBudgetSnapshots, capitalGuardBias, validationBudgetPolicy);
  const report = buildReport(days, summaries, validationSummaries, validationBudgetSnapshots, capitalGuardBias, validationBudgetPolicy, suggestions);

  let saved = null;
  if (write) {
    saved = await db.insertRuntimeConfigSuggestionLog({
      periodDays: report.periodDays,
      actionableCount: report.actionableSuggestions,
      marketSummary: report.marketSummary,
      suggestions: report.suggestions,
    });
    report.saved = saved;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const human = printHuman(report);
  if (!saved) {
    process.stdout.write(`${human}\n`);
    return;
  }
  process.stdout.write(`${human}\n\n저장:\n- suggestion_log_id: ${saved.id}\n- captured_at: ${saved.captured_at}\n`);
}

main().catch((error) => {
  process.stderr.write(`❌ ${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
