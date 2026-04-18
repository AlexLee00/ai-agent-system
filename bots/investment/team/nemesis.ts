// @ts-nocheck
/**
 * team/nemesis.js — 네메시스 (리스크 매니저)
 *
 * 역할: 신호 평가 — 하드 규칙(v1) + LLM 리스크 평가(v2)
 * LLM: Groq Scout (paper) / Claude Haiku (live)
 *
 * 실행: node team/nemesis.js (단독 실행 불가 — luna.js에서 호출)
 */

import { createRequire } from 'module';
import * as db from '../shared/db.ts';
import { getInvestmentTradeMode, isKisPaper } from '../shared/secrets.ts';
import { getCapitalConfig, getDailyTradeCount, getDynamicMinOrderAmount } from '../shared/capital-manager.ts';
import { getMarketRegime } from '../shared/market-regime.ts';
import { loadLatestScoutIntel, getScoutSignalForSymbol } from '../shared/scout-intel.ts';

const _require = createRequire(import.meta.url);
const kst = _require('../../../packages/core/lib/kst');
const eventLake = _require('../../../packages/core/lib/event-lake');
const { AgentMemory } = _require('../../../packages/core/lib/agent-memory.legacy.js');
import * as journalDb from '../shared/trade-journal-db.ts';
import { callLLM, parseJSON } from '../shared/llm-client.ts';
import { callLLMWithHub } from '../shared/hub-llm-client.ts';
import { SIGNAL_STATUS, ACTIONS } from '../shared/signal.ts';
import { notifyRiskRejection }    from '../shared/report.ts';
import {
  getMockUntradableSymbolCooldownMinutes,
  getNemesisRuntimeConfig,
  getValidationSoftBudgetConfig,
  isDynamicTpSlEnabled,
} from '../shared/runtime-config.ts';
import { check as checkHardRule } from './hard-rule.ts';
import { calculate as calculateBudget, calcKellyPosition } from './budget.ts';
import { evaluate as evaluateAdaptiveRisk } from './adaptive-risk.ts';
const NEMESIS_RUNTIME = getNemesisRuntimeConfig();
function getCryptoRiskThresholds() {
  const base = {
    cryptoRejectConfidence: NEMESIS_RUNTIME.thresholds?.cryptoRejectConfidence ?? 0.42,
    cryptoStarterApproveConfidence: NEMESIS_RUNTIME.thresholds?.cryptoStarterApproveConfidence ?? 0.44,
    cryptoStarterApproveMaxRisk: NEMESIS_RUNTIME.thresholds?.cryptoStarterApproveMaxRisk ?? 6,
    cryptoStarterScale: NEMESIS_RUNTIME.thresholds?.cryptoStarterScale ?? 0.60,
  };
  const tradeMode = getInvestmentTradeMode();
  const modeOverride = NEMESIS_RUNTIME.thresholds?.byTradeMode?.[tradeMode] || {};
  return {
    ...base,
    ...modeOverride,
  };
}

function getStockRiskThresholds() {
  const base = {
    stockRejectConfidence: NEMESIS_RUNTIME.thresholds?.stockRejectConfidence ?? 0.20,
    stockAutoApproveDomestic: NEMESIS_RUNTIME.thresholds?.stockAutoApproveDomestic ?? 500000,
    stockAutoApproveOverseas: NEMESIS_RUNTIME.thresholds?.stockAutoApproveOverseas ?? 400,
    stockStarterApproveConfidence: NEMESIS_RUNTIME.thresholds?.stockStarterApproveConfidence ?? 0.24,
    stockStarterApproveDomestic: NEMESIS_RUNTIME.thresholds?.stockStarterApproveDomestic ?? 350000,
    stockStarterApproveOverseas: NEMESIS_RUNTIME.thresholds?.stockStarterApproveOverseas ?? 280,
  };
  const tradeMode = getInvestmentTradeMode();
  const modeOverride = NEMESIS_RUNTIME.thresholds?.byTradeMode?.[tradeMode] || {};
  return {
    ...base,
    ...modeOverride,
  };
}

function isDynamicTPSLEnabled() {
  return isDynamicTpSlEnabled();
}

function applyRegimeGuideToTPSL(dynamicTPSL, guide, entryEstimate = null) {
  if (!dynamicTPSL || !guide) return dynamicTPSL;

  const nextTpPct = Number(dynamicTPSL.tpPct || 0) * Number(guide.tpMultiplier || 1);
  const nextSlPct = Number(dynamicTPSL.slPct || 0) * Number(guide.slMultiplier || 1);
  if (!validateDynamicTPSL(nextTpPct, nextSlPct)) return dynamicTPSL;

  return {
    ...dynamicTPSL,
    tpPct: nextTpPct,
    slPct: nextSlPct,
    tpPrice: entryEstimate ? entryEstimate * (1 + nextTpPct) : dynamicTPSL.tpPrice,
    slPrice: entryEstimate ? entryEstimate * (1 - nextSlPct) : dynamicTPSL.slPrice,
    source: `${dynamicTPSL.source}_regime`,
  };
}

// ─── 시스템 프롬프트 (마켓별 분기) ──────────────────────────────────

function getNemesisStockSystem() {
  const stockThresholds = getStockRiskThresholds();
  return `
당신은 네메시스(Nemesis), 루나팀의 리스크 매니저다. (국내/해외 주식 — 공격적 모드)

핵심 가치: 기본적으로 APPROVE. 명백한 위험만 차단한다.
소규모 신호는 자동 APPROVE. 심각한 위험만 REJECT.

REJECT 조건 (명백한 위험만):
1. 리스크 점수 9 이상 (극도의 위험만)
2. 확신도(confidence) ${stockThresholds.stockRejectConfidence.toFixed(2)} 미만 (매우 낮은 확신도만)
3. 포지션 한도(6개) 도달 + 신규 BUY 신호

APPROVE 우선 원칙:
- 국내장 소규모 신호(${stockThresholds.stockAutoApproveDomestic} KRW 이하): 별도 검토 없이 자동 APPROVE
- 해외장 소규모 신호(${stockThresholds.stockAutoApproveOverseas} USD 이하): 별도 검토 없이 자동 APPROVE
- 리스크 점수 9 미만: 기본 APPROVE
- 분할 진입 권장: 큰 금액은 절반으로 나눠 ADJUST

ADJUST 조건:
- 포지션 크기 30% 초과 → 30%로 축소
- 동일 종목 이미 보유 → 추가 매수 금액 50% 축소

응답 형식 (JSON만, 다른 텍스트 없이):
{"decision":"APPROVE|ADJUST|REJECT","reasoning":"근거 (한국어, 2줄 이내)","adjusted_amount":숫자,"risk_score":0~10}
`.trim();
}

function getNemesisSystem(exchange) {
  const cryptoThresholds = getCryptoRiskThresholds();
  const cryptoSystem = `
당신은 네메시스(Nemesis), 루나팀의 리스크 매니저다.

핵심 가치: 손실 통제는 유지하되, 과도한 보수성으로 기회를 놓치지 않는다.
의심스러우면 ADJUST. REJECT는 명백한 위험에만 사용한다.

REJECT 조건 (하나라도 해당하면 즉시 REJECT):
1. 리스크 점수 7 이상
2. 수익/손실 비율 2:1 미만
3. 확신도(confidence) ${cryptoThresholds.cryptoRejectConfidence.toFixed(2)} 미만
4. KST 01:00~07:00 심야 시간 + 포지션 크기 > 5%
5. 포지션 한도(6개) 도달 + 신규 BUY 신호

ADJUST 조건:
- 포지션 크기가 6% 초과 → 6%로 축소
- 심야 시간 → 포지션 크기 50% 강제 축소
- 동일 방향 상관 포지션 2개 이상 → 신규 크기 50% 축소
- 확신도 ${cryptoThresholds.cryptoStarterApproveConfidence.toFixed(2)}~0.48 구간은 전면 REJECT보다 소액 starter position을 우선 검토

응답 형식 (JSON만, 다른 텍스트 없이):
{"decision":"APPROVE|ADJUST|REJECT","reasoning":"근거 (한국어, 2줄 이내)","adjusted_amount":숫자,"risk_score":0~10}
`.trim();
  if (exchange === 'kis' || exchange === 'kis_overseas') return getNemesisStockSystem();
  return cryptoSystem;
}

// ─── 하드 규칙 (마켓별 분기) ─────────────────────────────────────────

const RULES_CRYPTO = {
  MAX_SINGLE_POSITION_PCT: NEMESIS_RUNTIME.crypto.maxSinglePositionPct,
  MAX_DAILY_LOSS_PCT:      NEMESIS_RUNTIME.crypto.maxDailyLossPct,
  MAX_OPEN_POSITIONS:      NEMESIS_RUNTIME.crypto.maxOpenPositions,
  STOP_LOSS_PCT:           NEMESIS_RUNTIME.crypto.stopLossPct,
  MIN_ORDER_USDT:          NEMESIS_RUNTIME.crypto.minOrderUsdt,
  MAX_ORDER_USDT:          NEMESIS_RUNTIME.crypto.maxOrderUsdt,
};

const RULES_STOCK_DOMESTIC = {
  MAX_SINGLE_POSITION_PCT: NEMESIS_RUNTIME.stockDomestic.maxSinglePositionPct,
  MAX_DAILY_LOSS_PCT:      NEMESIS_RUNTIME.stockDomestic.maxDailyLossPct,
  MAX_OPEN_POSITIONS:      NEMESIS_RUNTIME.stockDomestic.maxOpenPositions,
  STOP_LOSS_PCT:           NEMESIS_RUNTIME.stockDomestic.stopLossPct,
  MIN_ORDER_USDT:          NEMESIS_RUNTIME.stockDomestic.minOrderUsdt,
  MAX_ORDER_USDT:          NEMESIS_RUNTIME.stockDomestic.maxOrderUsdt,
};

const RULES_STOCK_OVERSEAS = {
  MAX_SINGLE_POSITION_PCT: NEMESIS_RUNTIME.stockOverseas.maxSinglePositionPct,
  MAX_DAILY_LOSS_PCT:      NEMESIS_RUNTIME.stockOverseas.maxDailyLossPct,
  MAX_OPEN_POSITIONS:      NEMESIS_RUNTIME.stockOverseas.maxOpenPositions,
  STOP_LOSS_PCT:           NEMESIS_RUNTIME.stockOverseas.stopLossPct,
  MIN_ORDER_USDT:          NEMESIS_RUNTIME.stockOverseas.minOrderUsdt,
  MAX_ORDER_USDT:          NEMESIS_RUNTIME.stockOverseas.maxOrderUsdt,
};

// 하위 호환성 — 암호화폐 기본값
export const RULES = RULES_CRYPTO;

/**
 * @typedef {Object} AdaptiveResult
 * @property {boolean} [approved]
 * @property {number} [adjustedAmount]
 * @property {number} [amountUsdt]
 * @property {number} [positionCount]
 * @property {number} [todayPnl]
 * @property {string} [reason]
 * @property {{ decision?: string, reasoning?: string }} [llm]
 * @property {number} [tpPrice]
 * @property {number} [slPrice]
 * @property {string} [tpslSource]
 * @property {string} [traceId]
 */

/**
 * @typedef {Object} EvaluateSignalOptions
 * @property {number} [totalUsdt]
 * @property {number|null} [atrRatio]
 * @property {number|null} [currentPrice]
 * @property {boolean} [persist]
 * @property {string|null} [traceId]
 */

function getRules(exchange) {
  if (exchange === 'kis') return RULES_STOCK_DOMESTIC;
  if (exchange === 'kis_overseas') return RULES_STOCK_OVERSEAS;
  return RULES_CRYPTO;
}

// ─── v2: 변동성 조정 ────────────────────────────────────────────────

async function calcVolatilityFactor(symbol, atrRatio = null) {
  if (atrRatio === null) return 1.0;
  if (atrRatio > 0.05) return 0.50;
  if (atrRatio > 0.03) return 0.75;
  return 1.0;
}

// ─── v2: 상관관계 가드 ──────────────────────────────────────────────

const CORRELATED_GROUPS = [
  ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'],
];

async function calcCorrelationFactor(symbol, exchange = 'binance') {
  try {
    const positions = await db.getAllPositions(exchange, false);
    const held = new Set(positions.map(p => p.symbol));
    for (const group of CORRELATED_GROUPS) {
      if (!group.includes(symbol)) continue;
      const heldInGroup = group.filter(s => s !== symbol && held.has(s)).length;
      if (heldInGroup >= 2) return 0.50;
      if (heldInGroup >= 1) return 0.75;
    }
    return 1.0;
  } catch { return 1.0; }
}

// ─── v2: 시간대 가드 ────────────────────────────────────────────────

function calcTimeFactor() {
  const kstHour = kst.currentHour();
  if (kstHour >= 1 && kstHour < 7) return 0.50; // KST 01:00~07:00 저유동성
  return 1.0;
}

async function calcReviewAdjustment(symbol, exchange, amountUsdt) {
  try {
    const insight = await journalDb.getTradeReviewInsight(symbol, exchange, 60);
    if (!insight || insight.closedTrades < 3) {
      return { adjustedAmount: amountUsdt, factor: 1, notes: [], insight };
    }

    let factor = 1;
    const notes = [];

    if (insight.winRate != null && insight.winRate < 0.4) {
      factor *= 0.75;
      notes.push(`최근 승률 ${(insight.winRate * 100).toFixed(0)}%`);
    }
    if (insight.avgPnlPercent != null && insight.avgPnlPercent < 0) {
      factor *= 0.85;
      notes.push(`평균 실현손익 ${insight.avgPnlPercent.toFixed(2)}%`);
    }
    if (
      insight.avgMaxFavorable != null &&
      insight.avgMaxAdverse != null &&
      Math.abs(insight.avgMaxAdverse) > Math.max(insight.avgMaxFavorable, 0.01)
    ) {
      factor *= 0.9;
      notes.push(`불리구간 우세 (${insight.avgMaxAdverse.toFixed(2)}% vs ${insight.avgMaxFavorable.toFixed(2)}%)`);
    }

    const analystValues = Object.values(insight.analystAccuracy).filter(value => value != null);
    if (analystValues.length > 0) {
      const analystAvg = analystValues.reduce((sum, value) => sum + value, 0) / analystValues.length;
      if (analystAvg < 0.5) {
        factor *= 0.9;
        notes.push(`분석팀 평균 정확도 ${(analystAvg * 100).toFixed(0)}%`);
      }
    }

    const adjustedAmount = Math.max(getRules(exchange).MIN_ORDER_USDT, Math.floor(amountUsdt * factor));
    return { adjustedAmount, factor, notes, insight };
  } catch (err) {
    console.warn('[nemesis] calcReviewAdjustment 실패 (무시):', err.message);
    return { adjustedAmount: amountUsdt, factor: 1, notes: [], insight: null };
  }
}

function applyReviewTpslAdjustment(dynamicTPSL, reviewInsight, entryEstimate = null) {
  if (!dynamicTPSL || !reviewInsight || reviewInsight.closedTrades < 3) return dynamicTPSL;

  let tpPct = dynamicTPSL.tpPct;
  let slPct = dynamicTPSL.slPct;

  if (
    reviewInsight.avgMaxFavorable != null &&
    reviewInsight.avgMaxAdverse != null &&
    reviewInsight.avgMaxFavorable > 0 &&
    Math.abs(reviewInsight.avgMaxAdverse) > 0
  ) {
    const mfe = reviewInsight.avgMaxFavorable / 100;
    const mae = Math.abs(reviewInsight.avgMaxAdverse) / 100;

    if (mfe > tpPct * 1.4) tpPct = Math.min(tpPct * 1.15, mfe * 0.85, TPSL_LIMITS.max_tp);
    if (mae < slPct * 0.6) slPct = Math.max(slPct * 0.85, mae * 1.15, TPSL_LIMITS.min_sl);
    if (mae > slPct * 1.2) slPct = Math.min(slPct * 1.1, TPSL_LIMITS.max_sl);
  }

  if (!validateDynamicTPSL(tpPct, slPct)) return dynamicTPSL;

  return {
    ...dynamicTPSL,
    tpPct,
    slPct,
    tpPrice: entryEstimate ? entryEstimate * (1 + tpPct) : dynamicTPSL.tpPrice,
    slPrice: entryEstimate ? entryEstimate * (1 - slPct) : dynamicTPSL.slPrice,
    source: `${dynamicTPSL.source}_review`,
  };
}

// ─── v2: LLM 리스크 평가 ────────────────────────────────────────────

async function evaluateWithLLM({ signal, adjustedAmount, volFactor, corrFactor, timeFactor, todayPnl, positionCount, exchange }) {
  const rules  = getRules(exchange);
  const userMsg = [
    `신호: ${signal.symbol} ${signal.action} $${adjustedAmount}`,
    `확신도: ${((signal.confidence || 0) * 100).toFixed(0)}%`,
    `근거: ${signal.reasoning?.slice(0, 120) || '없음'}`,
    ``,
    `포트폴리오:`,
    `  오늘 P&L: ${(todayPnl?.pnl || 0) >= 0 ? '+' : ''}$${(todayPnl?.pnl || 0).toFixed(2)}`,
    `  현재 포지션: ${positionCount}/${rules.MAX_OPEN_POSITIONS}개`,
    `  조정 계수: vol×${volFactor.toFixed(2)} | corr×${corrFactor.toFixed(2)} | time×${timeFactor.toFixed(2)}`,
    ``,
    `최종 리스크 판단:`,
  ].join('\n');

  const raw    = await callLLMWithHub('nemesis', getNemesisSystem(exchange), userMsg, callLLM, 256, { symbol: signal.symbol });
  const parsed = parseJSON(raw);
  if (!parsed?.decision) {
    return { decision: 'APPROVE', adjusted_amount: adjustedAmount, reasoning: 'LLM 파싱 실패 — 기본 승인' };
  }
  return parsed;
}

// ─── Phase 2: 동적 TP/SL (ATR 기반, 마스터 승인 후 활성화) ──────────

// 동적 TP/SL 범위 제한 (폭주 방지)
export const TPSL_LIMITS = {
  min_tp: 0.02,   // 최소 TP 2%
  max_tp: 0.15,   // 최대 TP 15%
  min_sl: 0.01,   // 최소 SL 1%
  max_sl: 0.08,   // 최대 SL 8%
  min_rr: 2.0,    // 최소 R/R 2:1
};

/**
 * 동적 TP/SL 범위 검증
 * @returns {boolean} true: 유효, false: 범위 초과 → 고정 폴백
 */
export function validateDynamicTPSL(tpPct, slPct) {
  if (tpPct < TPSL_LIMITS.min_tp || tpPct > TPSL_LIMITS.max_tp) return false;
  if (slPct < TPSL_LIMITS.min_sl || slPct > TPSL_LIMITS.max_sl) return false;
  if (slPct <= 0) return false;
  if (tpPct / slPct < TPSL_LIMITS.min_rr) return false;
  return true;
}

/**
 * 매매 실적 기반 동적 R/R 조회 (Phase 3)
 *
 * trade_journal 과거 실적에서 심볼별 평균 승/패를 계산하여 R/R 제안.
 * 데이터 부족(10건 미만) 시 null 반환 → 고정/ATR 폴백.
 *
 * @param {string} symbol
 * @param {number} [minSamples=10]
 * @returns {Promise<{suggested_tp_pct, suggested_sl_pct, rr_ratio, win_rate, sample_size, source}|null>}
 */
export async function getDynamicRR(symbol, minSamples = 10) {
  try {
    const row = await db.get(`
      SELECT
        COUNT(*)                                                                        AS trades,
        ROUND(AVG(CASE WHEN pnl_percent > 0 THEN pnl_percent END)::numeric, 4)        AS avg_win,
        ROUND(ABS(AVG(CASE WHEN pnl_percent <= 0 THEN pnl_percent END))::numeric, 4)  AS avg_loss,
        ROUND((COUNT(CASE WHEN pnl_percent > 0 THEN 1 END) * 1.0 / NULLIF(COUNT(*), 0))::numeric, 4) AS win_rate
      FROM trade_journal
      WHERE symbol = ? AND status = 'closed' AND exit_time IS NOT NULL
    `, [symbol]);

    if (!row || parseInt(row.trades || 0) < minSamples) return null;

    const avgWin  = parseFloat(row.avg_win  || 0);
    const avgLoss = parseFloat(row.avg_loss || 0);
    const winRate = parseFloat(row.win_rate || 0);

    if (!avgWin || !avgLoss || avgLoss === 0) return null;

    // 제안 값은 TPSL_LIMITS 범위 내로 클램프
    const suggestedTp = Math.min(Math.max(avgWin  / 100, TPSL_LIMITS.min_tp), TPSL_LIMITS.max_tp);
    const suggestedSl = Math.min(Math.max(avgLoss / 100, TPSL_LIMITS.min_sl), TPSL_LIMITS.max_sl);

    if (!validateDynamicTPSL(suggestedTp, suggestedSl)) return null;

    return {
      suggested_tp_pct: suggestedTp,
      suggested_sl_pct: suggestedSl,
      rr_ratio:         (suggestedTp / suggestedSl).toFixed(2),
      win_rate:         (winRate * 100).toFixed(1),
      sample_size:      parseInt(row.trades),
      source:           'data_driven',
    };
  } catch (e) {
    console.warn('[nemesis] getDynamicRR 실패 (무시):', e.message);
    return null;
  }
}

/**
 * ATR 기반 동적 TP/SL 산출
 *
 * Phase 1: applied: false (로그만)
 * Phase 2: dynamic_tp_sl_enabled=true 시 applied: true → 헤파이스토스 실적용
 *
 * R/R 비율 2:1 유지: TP = ATR × 2.5, SL = ATR × 1.25
 *
 * @param {string}      symbol
 * @param {number|null} entryPrice   현재가 (null 허용)
 * @param {number|null} atrRatio     ATR/현재가 비율 (예: 0.02 = 2%)
 * @returns {{ tpPct, slPct, tpPrice, slPrice, source, applied }}
 */
export function calculateDynamicTPSL(symbol, entryPrice = null, atrRatio = null) {
  const capitalConfig = getCapitalConfig();
  const FIXED_TP_PCT = Number(capitalConfig.rr_fallback?.tp_pct ?? 0.06);  // 고정 +6%
  const FIXED_SL_PCT = Number(capitalConfig.rr_fallback?.sl_pct ?? 0.03);  // 고정 -3%
  const enabled      = isDynamicTPSLEnabled();

  if (!atrRatio || atrRatio <= 0) {
    return {
      tpPct:    FIXED_TP_PCT,
      slPct:    FIXED_SL_PCT,
      tpPrice:  entryPrice ? entryPrice * (1 + FIXED_TP_PCT) : null,
      slPrice:  entryPrice ? entryPrice * (1 - FIXED_SL_PCT) : null,
      source:   'fixed',
      applied:  false,
    };
  }

  // ATR 기반: 2:1 R/R (TP = ATR × 2.5, SL = ATR × 1.25) — 범위 클램프
  const rawTpPct = atrRatio * 2.5;
  const rawSlPct = atrRatio * 1.25;
  const tpPct    = Math.min(Math.max(rawTpPct, TPSL_LIMITS.min_tp), TPSL_LIMITS.max_tp);
  const slPct    = Math.min(Math.max(rawSlPct, TPSL_LIMITS.min_sl), TPSL_LIMITS.max_sl);

  // 범위 검증 실패 → 고정 폴백
  if (!validateDynamicTPSL(tpPct, slPct)) {
    console.warn(`  ⚠️ [네메시스] ${symbol} 동적 TP/SL 범위 초과 → 고정 폴백`);
    return {
      tpPct:    FIXED_TP_PCT,
      slPct:    FIXED_SL_PCT,
      tpPrice:  entryPrice ? entryPrice * (1 + FIXED_TP_PCT) : null,
      slPrice:  entryPrice ? entryPrice * (1 - FIXED_SL_PCT) : null,
      source:   'fixed_fallback',
      applied:  false,
    };
  }

  return {
    tpPct,
    slPct,
    tpPrice: entryPrice ? entryPrice * (1 + tpPct) : null,
    slPrice: entryPrice ? entryPrice * (1 - slPct) : null,
    source:  'atr',
    applied: enabled,  // Phase 2: enabled=true 시 헤파이스토스 실적용
  };
}

// ─── Phase 3-A: 시장상황별 R/R 분화 (변동성 적응형) ─────────────────

// atr_at_entry 컬럼 1회 마이그레이션 (없는 경우 추가)
let _atrColumnReady = false;
async function ensureAtrColumn() {
  if (_atrColumnReady) return;
  try { await db.run('ALTER TABLE trade_journal ADD COLUMN IF NOT EXISTS atr_at_entry DOUBLE PRECISION'); } catch { /* 이미 존재 */ }
  _atrColumnReady = true;
}

/**
 * 시장 상황(변동성 레짐)별 동적 R/R
 * ATR 퍼센타일 3분위: low_vol / mid_vol / high_vol
 * 데이터 부족(5건 미만) 또는 atr_at_entry 미기록 시 null 반환
 *
 * @param {string} symbol
 * @param {number} currentATR  현재 ATR 비율 (예: 0.02 = 2%)
 * @param {number} [minSamples=5]
 * @returns {Promise<{suggested_tp_pct, suggested_sl_pct, rr_ratio, win_rate, sample_size, regime, source}|null>}
 */
export async function getDynamicRRByRegime(symbol, currentATR, minSamples = 5) {
  await ensureAtrColumn();
  try {
    const allRows = await db.query(`
      SELECT atr_at_entry, pnl_percent
      FROM trade_journal
      WHERE symbol = ? AND status = 'closed' AND exit_time IS NOT NULL
        AND atr_at_entry IS NOT NULL AND atr_at_entry > 0
      ORDER BY atr_at_entry ASC
    `, [symbol]);

    if (allRows.length < minSamples) return null;

    const sorted = allRows.map(r => parseFloat(r.atr_at_entry));
    const p33    = sorted[Math.floor(sorted.length * 0.33)];
    const p66    = sorted[Math.floor(sorted.length * 0.66)];

    // 현재 ATR 레짐 분류
    let regime, regimeRows;
    if (currentATR <= p33) {
      regime     = 'low_vol';
      regimeRows = allRows.filter(r => parseFloat(r.atr_at_entry) <= p33);
    } else if (currentATR >= p66) {
      regime     = 'high_vol';
      regimeRows = allRows.filter(r => parseFloat(r.atr_at_entry) >= p66);
    } else {
      regime     = 'mid_vol';
      regimeRows = allRows.filter(r => { const a = parseFloat(r.atr_at_entry); return a > p33 && a < p66; });
    }

    if (regimeRows.length < minSamples) return null;

    const pnls   = regimeRows.map(r => parseFloat(r.pnl_percent));
    const wins   = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p <= 0);
    if (!wins.length || !losses.length) return null;

    const avgWin  = wins.reduce((s, p) => s + p, 0) / wins.length;
    const avgLoss = Math.abs(losses.reduce((s, p) => s + p, 0) / losses.length);
    const winRate = wins.length / pnls.length;

    const suggestedTp = Math.min(Math.max(avgWin / 100, TPSL_LIMITS.min_tp), TPSL_LIMITS.max_tp);
    const suggestedSl = Math.min(Math.max(avgLoss / 100, TPSL_LIMITS.min_sl), TPSL_LIMITS.max_sl);
    if (!validateDynamicTPSL(suggestedTp, suggestedSl)) return null;

    return {
      suggested_tp_pct: suggestedTp,
      suggested_sl_pct: suggestedSl,
      rr_ratio:    (suggestedTp / suggestedSl).toFixed(2),
      win_rate:    (winRate * 100).toFixed(1),
      sample_size: regimeRows.length,
      regime,
      source: 'regime',
    };
  } catch (e) {
    console.warn('[nemesis] getDynamicRRByRegime 실패 (무시):', e.message);
    return null;
  }
}

// ─── Phase 3-B: 시간 가중 R/R (최근 매매 비중 UP) ───────────────────

/**
 * 시간 가중 동적 R/R — 최근 30일 ×3, 30~60일 ×2, 이전 ×1
 * 데이터 부족(10건 미만) 시 null 반환
 *
 * @param {string} symbol
 * @param {number} [minSamples=10]
 * @returns {Promise<{suggested_tp_pct, suggested_sl_pct, rr_ratio, win_rate, sample_size, source}|null>}
 */
export async function getDynamicRRWeighted(symbol, minSamples = 10) {
  try {
    const now = Date.now();
    const d30 = now - 30 * 24 * 3600 * 1000;
    const d60 = now - 60 * 24 * 3600 * 1000;

    const rows = await db.query(`
      SELECT pnl_percent, created_at
      FROM trade_journal
      WHERE symbol = ? AND status = 'closed' AND exit_time IS NOT NULL
      ORDER BY created_at DESC
    `, [symbol]);

    if (rows.length < minSamples) return null;

    // 시간 가중 복제: 30일 이내 ×3, 30~60일 ×2, 60일 초과 ×1
    const weighted = [];
    for (const r of rows) {
      const t = parseInt(r.created_at);
      const w = t >= d30 ? 3 : t >= d60 ? 2 : 1;
      const p = parseFloat(r.pnl_percent);
      for (let i = 0; i < w; i++) weighted.push(p);
    }

    const wins   = weighted.filter(p => p > 0);
    const losses = weighted.filter(p => p <= 0);
    if (!wins.length || !losses.length) return null;

    const avgWin  = wins.reduce((s, p) => s + p, 0) / wins.length;
    const avgLoss = Math.abs(losses.reduce((s, p) => s + p, 0) / losses.length);
    const winRate = wins.length / weighted.length;

    const suggestedTp = Math.min(Math.max(avgWin / 100, TPSL_LIMITS.min_tp), TPSL_LIMITS.max_tp);
    const suggestedSl = Math.min(Math.max(avgLoss / 100, TPSL_LIMITS.min_sl), TPSL_LIMITS.max_sl);
    if (!validateDynamicTPSL(suggestedTp, suggestedSl)) return null;

    return {
      suggested_tp_pct: suggestedTp,
      suggested_sl_pct: suggestedSl,
      rr_ratio:    (suggestedTp / suggestedSl).toFixed(2),
      win_rate:    (winRate * 100).toFixed(1),
      sample_size: rows.length,
      source: 'weighted',
    };
  } catch (e) {
    console.warn('[nemesis] getDynamicRRWeighted 실패 (무시):', e.message);
    return null;
  }
}

// ─── Phase 3-C: 켈리 기준 포지션 사이징 ────────────────────────────

/**
 * 켈리 기준 포지션 비율 산출
 * f* = (p×b − q) / b  →  Half Kelly 권장, 최대 5% 캡
 *
 * @param {number} winRate   승률 (0~1)
 * @param {number} rrRatio   수익/손실 비율 (R/R, 예: 2.0)
 * @param {'half'|'full'} [mode='half']
 * @returns {number} 포지션 비율 (0.01 ~ 0.05)
 */
// ─── 메인 신호 평가 ─────────────────────────────────────────────────

/**
 * 신호 평가 — v1 규칙 + v2 LLM
 * @param {object} signal  { id, symbol, action, amount_usdt, confidence, reasoning }
 * @param {object} [opts]  { atrRatio, totalUsdt }
 */
/**
 * @param {any} signal
 * @param {EvaluateSignalOptions} [opts]
 * @returns {Promise<AdaptiveResult>}
 */
export async function evaluateSignal(signal, opts = {}) {
  const { symbol, action } = signal;
  const totalUsdt  = opts.totalUsdt || 10000;
  const traceId    = `NMS-${symbol?.replace('/', '')}-${Date.now()}`;
  const persist    = opts.persist !== false;
  const isStockExchange = signal.exchange === 'kis' || signal.exchange === 'kis_overseas';
  const isCryptoExchange = signal.exchange === 'binance';
  const signalTradeMode = signal.trade_mode || getInvestmentTradeMode();
  const rules      = {
    ...getRules(signal.exchange),
    MIN_ORDER_USDT: await getDynamicMinOrderAmount(signal.exchange, signalTradeMode),
  };
  const stockThresholds = getStockRiskThresholds();
  const hardRuleResult = await checkHardRule(signal, {
    totalUsdt, traceId, rules, persist, isStockExchange, isCryptoExchange, signalTradeMode, stockThresholds,
  }, {
    db,
    notifyRiskRejection,
    isKisPaper,
    getMockUntradableSymbolCooldownMinutes,
    getInvestmentTradeMode,
    getValidationSoftBudgetConfig,
    getCapitalConfig,
    getDailyTradeCount,
  });
  if (hardRuleResult?.approved === false) {
    try {
      const nemesisMemory = new AgentMemory({ agentId: 'investment.nemesis', team: 'investment' });
      await nemesisMemory.remember(
        `[하드룰 거절] ${symbol} ${action} | ${hardRuleResult.reason || '규칙 위반'}`,
        'episodic',
        {
          keywords: [symbol, action, 'REJECT', 'hard_rule'].filter(Boolean),
          importance: 0.8,
          metadata: { decision: 'REJECT', source: 'hard_rule', symbol, action, reason: hardRuleResult.reason },
        }
      );
    } catch { /* 무시 */ }
    return { ...hardRuleResult, nemesis_verdict: 'rejected' };
  }

  let amountUsdt = hardRuleResult.amountUsdt;
  let positionCount = hardRuleResult.positionCount;
  let todayPnl = hardRuleResult.todayPnl;
  let dynamicTPSL;
  let marketRegime = null;
  let adaptiveResult: any = null; // SEC-004: finalVerdict 계산을 위해 스코프 상단 선언

  // ── v2: 조정 계수 ──
  if (action === ACTIONS.BUY) {
    try {
      const scoutIntel = await loadLatestScoutIntel({ minutes: 24 * 60 });
      const scoutSignal = getScoutSignalForSymbol(scoutIntel, symbol);
      marketRegime = await getMarketRegime(signal.exchange, {
        scout: scoutSignal
          ? {
              source: scoutSignal.source,
              score: scoutSignal.score,
              aiSignal: scoutSignal.evidence || scoutSignal.label,
            }
          : (signal.scoutData || {}),
      });
      console.log(`  🌍 [네메시스] 시장 체제: ${marketRegime.regime} (${marketRegime.reason})`);
      eventLake.record({
        eventType: 'market_regime_detected',
        team: 'luna',
        botName: 'nemesis',
        severity: marketRegime.regime === 'volatile' ? 'warn' : 'info',
        title: `시장 체제 ${marketRegime.regime}`,
        message: `${signal.exchange}/${symbol} → ${marketRegime.reason}`,
        tags: [
          `market:${signal.exchange}`,
          `regime:${marketRegime.regime}`,
          `style:${marketRegime.guide?.tradingStyle || 'unknown'}`,
          'trigger:signal',
        ],
        metadata: {
          symbol,
          market: signal.exchange,
          confidence: marketRegime.confidence,
          reason: marketRegime.reason,
          bias: marketRegime.bias,
          guide: marketRegime.guide || null,
        },
      }).catch(() => {});
    } catch (error) {
      console.warn(`  ⚠️ [네메시스] 시장 체제 감지 실패: ${error.message}`);
    }

    await ensureAtrColumn();
    const budgetResult = await calculateBudget(signal, {
      totalUsdt,
      rules,
      traceId,
      persist,
      isStockExchange,
      isCryptoExchange,
      stockThresholds,
      amountUsdt,
      atrRatio: opts.atrRatio,
      entryEstimate: opts.currentPrice || null,
    }, {
      db,
      calcVolatilityFactor,
      calcCorrelationFactor,
      calcTimeFactor,
      getDynamicRRByRegime,
      getDynamicRRWeighted,
      getDynamicRR,
      calculateDynamicTPSL,
      applyReviewTpslAdjustment,
      calcReviewAdjustment,
      isDynamicTPSLEnabled,
    });

    if (budgetResult.autoApproval) return budgetResult.autoApproval;
    amountUsdt = budgetResult.amountUsdt;
    dynamicTPSL = budgetResult.dynamicTPSL;
    if (marketRegime?.guide) {
      amountUsdt = Math.max(rules.MIN_ORDER_USDT, Math.floor(amountUsdt * Number(marketRegime.guide.positionSizeMultiplier || 1)));
      dynamicTPSL = applyRegimeGuideToTPSL(dynamicTPSL, marketRegime.guide, opts.currentPrice || null);
    }

    adaptiveResult = await evaluateAdaptiveRisk(signal, {
      amountUsdt,
      rules,
      persist,
      traceId,
      isCryptoExchange,
      todayPnl,
      positionCount,
      volFactor: budgetResult.volFactor,
      corrFactor: budgetResult.corrFactor,
      timeFactor: budgetResult.timeFactor,
    }, {
      evaluateWithLLM,
      getCryptoRiskThresholds,
      notifyRiskRejection,
      db,
    });

    if (!adaptiveResult.approved) {
      try {
        const nemesisMemory = new AgentMemory({ agentId: 'investment.nemesis', team: 'investment' });
        await nemesisMemory.remember(
          `[LLM 거절] ${symbol} ${action} | ${adaptiveResult.llm?.reasoning || adaptiveResult.reason || 'LLM 거절'}`,
          'episodic',
          {
            keywords: [symbol, action, 'REJECT', 'llm'].filter(Boolean),
            importance: 0.7,
            metadata: { decision: 'REJECT', source: 'llm', symbol, action, llmReasoning: adaptiveResult.llm?.reasoning },
          }
        );
      } catch { /* 무시 */ }
      return adaptiveResult;
    }
    amountUsdt = adaptiveResult.adjustedAmount;

    if (persist && signal.id) {
      try {
        const shadowHiring = await journalDb.hireAnalystForSignal(signal.exchange, symbol, {
          regimeGuide: marketRegime?.guide || null,
        }).catch(() => null);
        await journalDb.insertRationale({
          signal_id: signal.id,
          luna_decision: 'enter',
          luna_reasoning: signal.reasoning || '',
          luna_confidence: signal.confidence ?? null,
          nemesis_verdict: adaptiveResult.llm.decision === 'ADJUST' ? 'modified' : 'approved',
          nemesis_notes: adaptiveResult.llm.reasoning ?? null,
          position_size_original: signal.amount_usdt,
          position_size_approved: amountUsdt,
          strategy_config: {
            ...(shadowHiring ? { shadow_hiring: shadowHiring } : {}),
            ...(marketRegime ? {
              market_regime: {
                regime: marketRegime.regime,
                confidence: marketRegime.confidence,
                reason: marketRegime.reason,
                tradingStyle: marketRegime.guide?.tradingStyle || null,
                tpMultiplier: marketRegime.guide?.tpMultiplier || 1,
                slMultiplier: marketRegime.guide?.slMultiplier || 1,
                positionSizeMultiplier: marketRegime.guide?.positionSizeMultiplier || 1,
              },
            } : {}),
          },
        });
      } catch (e) {
        console.warn(`  ⚠️ 매매일지 rationale 기록 실패: ${e.message}`);
      }
    }
  }

  if (persist && signal.id) {
    await db.updateSignalStatus(signal.id, SIGNAL_STATUS.APPROVED);
    await db.updateSignalAmount(signal.id, amountUsdt);
  }
  console.log(`  ✅ [네메시스] ${symbol} ${action} $${amountUsdt} 승인`);

  // ── 에이전트 메모리 기록 (승인) ────────────────────────────────────
  try {
    const nemesisMemory = new AgentMemory({ agentId: 'investment.nemesis', team: 'investment' });
    await nemesisMemory.remember(
      `[리스크 승인] ${symbol} ${action} $${amountUsdt} | 확신도 ${((signal.confidence || 0) * 100).toFixed(0)}%`,
      'episodic',
      {
        keywords: [symbol, action, signal.exchange, 'APPROVE'].filter(Boolean),
        importance: signal.confidence || 0.5,
        metadata: { decision: 'APPROVE', symbol, action, amountUsdt, exchange: signal.exchange },
      }
    );
  } catch {
    // 메모리 저장 실패 무시
  }

  // dynamicTPSL이 applied=true면 헤파이스토스에 전달할 tp/sl 가격 포함
  const tpslResult = (action === ACTIONS.BUY && dynamicTPSL?.applied)
    ? { tpPrice: dynamicTPSL.tpPrice, slPrice: dynamicTPSL.slPrice, tpslSource: dynamicTPSL.source }
    : {};

  // SEC-004: LLM이 ADJUST(금액 조정)한 경우 'modified', 그 외 'approved'
  const finalVerdict = adaptiveResult?.llm?.decision === 'ADJUST' ? 'modified' : 'approved';
  return { approved: true, adjustedAmount: amountUsdt, traceId, nemesis_verdict: finalVerdict, approved_at: new Date().toISOString(), ...tpslResult };
}
