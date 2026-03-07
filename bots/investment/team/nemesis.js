/**
 * team/nemesis.js — 네메시스 (리스크 매니저)
 *
 * 역할: 신호 평가 — 하드 규칙(v1) + LLM 리스크 평가(v2)
 * LLM: Groq Scout (paper) / Claude Haiku (live)
 *
 * 실행: node team/nemesis.js (단독 실행 불가 — luna.js에서 호출)
 */

import * as db from '../shared/db.js';
import * as journalDb from '../shared/trade-journal-db.js';
import { callLLM, parseJSON } from '../shared/llm-client.js';
import { SIGNAL_STATUS, ACTIONS } from '../shared/signal.js';
import { notifyRiskRejection }    from '../shared/report.js';

// ─── 시스템 프롬프트 (v2 — 보수화) ──────────────────────────────────

const NEMESIS_SYSTEM = `
당신은 네메시스(Nemesis), 루나팀의 리스크 매니저다.

핵심 가치: 수익 극대화가 아니라 손실 최소화.
의심스러우면 REJECT. 확신 없으면 ADJUST. APPROVE는 엄격하게.

REJECT 조건 (하나라도 해당하면 즉시 REJECT):
1. 리스크 점수 7 이상
2. 수익/손실 비율 2:1 미만
3. 확신도(confidence) 0.55 미만
4. KST 01:00~07:00 심야 시간 + 포지션 크기 > 5%
5. 포지션 한도(5개) 도달 + 신규 BUY 신호

ADJUST 조건:
- 포지션 크기가 5% 초과 → 5%로 축소
- 심야 시간 → 포지션 크기 50% 강제 축소
- 동일 방향 상관 포지션 2개 이상 → 신규 크기 50% 축소

응답 형식 (JSON만, 다른 텍스트 없이):
{"decision":"APPROVE|ADJUST|REJECT","reasoning":"근거 (한국어, 2줄 이내)","adjusted_amount":숫자,"risk_score":0~10}
`.trim();

// ─── 하드 규칙 (v1) ─────────────────────────────────────────────────

export const RULES = {
  MAX_SINGLE_POSITION_PCT: 0.20,  // 단일 포지션 최대 20%
  MAX_DAILY_LOSS_PCT:      0.05,  // 일일 손실 한도 5%
  MAX_OPEN_POSITIONS:      5,     // 최대 동시 포지션
  STOP_LOSS_PCT:           0.03,  // 손절 3%
  MIN_ORDER_USDT:          10,    // 최소 주문 $10
  MAX_ORDER_USDT:          1000,  // 최대 주문 $1000
};

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

async function calcCorrelationFactor(symbol) {
  try {
    const positions = await db.getAllPositions();
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
  const kstHour = new Date(Date.now() + 9 * 3600 * 1000).getUTCHours();
  if (kstHour >= 1 && kstHour < 7) return 0.50; // KST 01:00~07:00 저유동성
  return 1.0;
}

// ─── v2: LLM 리스크 평가 ────────────────────────────────────────────

async function evaluateWithLLM({ signal, adjustedAmount, volFactor, corrFactor, timeFactor, todayPnl, positionCount }) {
  const userMsg = [
    `신호: ${signal.symbol} ${signal.action} $${adjustedAmount}`,
    `확신도: ${((signal.confidence || 0) * 100).toFixed(0)}%`,
    `근거: ${signal.reasoning?.slice(0, 120) || '없음'}`,
    ``,
    `포트폴리오:`,
    `  오늘 P&L: ${(todayPnl?.pnl || 0) >= 0 ? '+' : ''}$${(todayPnl?.pnl || 0).toFixed(2)}`,
    `  현재 포지션: ${positionCount}/${RULES.MAX_OPEN_POSITIONS}개`,
    `  조정 계수: vol×${volFactor.toFixed(2)} | corr×${corrFactor.toFixed(2)} | time×${timeFactor.toFixed(2)}`,
    ``,
    `최종 리스크 판단:`,
  ].join('\n');

  const raw    = await callLLM('nemesis', NEMESIS_SYSTEM, userMsg, 256);
  const parsed = parseJSON(raw);
  if (!parsed?.decision) {
    return { decision: 'APPROVE', adjusted_amount: adjustedAmount, reasoning: 'LLM 파싱 실패 — 기본 승인' };
  }
  return parsed;
}

// ─── Phase 1: 동적 TP/SL 산출 (로그만 — 실투자 미적용) ─────────────

/**
 * ATR 기반 동적 TP/SL 산출 (Phase 1 — 로그만, 실투자 미적용)
 *
 * 현재 고정값: TP +6%, SL -3% (헤파이스토스 설정)
 * Phase 1: ATR 기반 산출값을 로그만 출력하고 applied: false 고정
 * Phase 2 (향후): 마스터 승인 후 헤파이스토스에 동적 TP/SL 적용 가능
 *
 * R/R 비율 2:1 유지: TP = ATR × 2.5, SL = ATR × 1.25
 *
 * @param {string}      symbol
 * @param {number|null} entryPrice   현재가 (null 허용)
 * @param {number|null} atrRatio     ATR/현재가 비율 (예: 0.02 = 2%)
 * @returns {{ tpPct, slPct, tp, sl, source, applied }}
 */
export function calculateDynamicTPSL(symbol, entryPrice = null, atrRatio = null) {
  const FIXED_TP_PCT = 0.06;  // 고정 +6%
  const FIXED_SL_PCT = 0.03;  // 고정 -3%

  if (!atrRatio || atrRatio <= 0) {
    return {
      tpPct:   FIXED_TP_PCT,
      slPct:   FIXED_SL_PCT,
      tp:      entryPrice ? entryPrice * (1 + FIXED_TP_PCT) : null,
      sl:      entryPrice ? entryPrice * (1 - FIXED_SL_PCT) : null,
      source:  'fixed',
      applied: false,  // Phase 1: 항상 false
    };
  }

  // ATR 기반: 2:1 R/R (TP = ATR × 2.5, SL = ATR × 1.25) — 범위 클램프
  const tpPct = Math.min(Math.max(atrRatio * 2.5, 0.03), 0.15);   // 3%~15%
  const slPct = Math.min(Math.max(atrRatio * 1.25, 0.015), 0.075); // 1.5%~7.5%

  return {
    tpPct,
    slPct,
    tp:      entryPrice ? entryPrice * (1 + tpPct) : null,
    sl:      entryPrice ? entryPrice * (1 - slPct) : null,
    source:  'atr',
    applied: false,  // Phase 1: 항상 false
  };
}

// ─── 메인 신호 평가 ─────────────────────────────────────────────────

/**
 * 신호 평가 — v1 규칙 + v2 LLM
 * @param {object} signal  { id, symbol, action, amount_usdt, confidence, reasoning }
 * @param {object} [opts]  { atrRatio, totalUsdt }
 */
export async function evaluateSignal(signal, opts = {}) {
  const { symbol, action } = signal;
  let amountUsdt   = signal.amount_usdt || 100;
  const totalUsdt  = opts.totalUsdt || 10000;
  const traceId    = `NMS-${symbol?.replace('/', '')}-${Date.now()}`;

  // ── v1 하드 규칙 ──
  if (action === ACTIONS.BUY) {
    if (amountUsdt < RULES.MIN_ORDER_USDT) {
      const reason = `최소 주문 미달 ($${amountUsdt} < $${RULES.MIN_ORDER_USDT})`;
      await db.updateSignalStatus(signal.id, SIGNAL_STATUS.REJECTED);
      await notifyRiskRejection({ symbol, action, reason });
      return { approved: false, reason };
    }
    if (amountUsdt > RULES.MAX_ORDER_USDT) {
      amountUsdt = RULES.MAX_ORDER_USDT;
      console.log(`  📐 [네메시스] 최대 주문 초과 → $${amountUsdt} 로 조정`);
    }
    const pct = amountUsdt / totalUsdt;
    if (pct > RULES.MAX_SINGLE_POSITION_PCT) {
      amountUsdt = Math.floor(totalUsdt * RULES.MAX_SINGLE_POSITION_PCT);
      console.log(`  📐 [네메시스] 포지션 한도 조정 → $${amountUsdt} (20%)`);
    }
  }

  const todayPnl = await db.getTodayPnl();
  const lossPct  = (todayPnl.pnl || 0) < 0 ? Math.abs(todayPnl.pnl) / totalUsdt : 0;
  if (lossPct >= RULES.MAX_DAILY_LOSS_PCT) {
    const reason = `일일 손실 한도 초과 (${(lossPct * 100).toFixed(1)}%)`;
    await db.updateSignalStatus(signal.id, SIGNAL_STATUS.REJECTED);
    await notifyRiskRejection({ symbol, action, reason });
    return { approved: false, reason };
  }

  let positionCount = 0;
  if (action === ACTIONS.BUY) {
    const positions = await db.getAllPositions();
    positionCount   = positions.length;
    if (positionCount >= RULES.MAX_OPEN_POSITIONS) {
      const reason = `최대 포지션 초과 (${positionCount}/${RULES.MAX_OPEN_POSITIONS})`;
      await db.updateSignalStatus(signal.id, SIGNAL_STATUS.REJECTED);
      await notifyRiskRejection({ symbol, action, reason });
      return { approved: false, reason };
    }
  }

  // ── v2: 조정 계수 ──
  if (action === ACTIONS.BUY) {
    const [volFactor, corrFactor] = await Promise.all([
      calcVolatilityFactor(symbol, opts.atrRatio),
      calcCorrelationFactor(symbol),
    ]);
    const timeFactor   = calcTimeFactor();
    const combinedFact = volFactor * corrFactor * timeFactor;

    if (combinedFact < 1.0) {
      const prev = amountUsdt;
      amountUsdt = Math.max(RULES.MIN_ORDER_USDT, Math.floor(amountUsdt * combinedFact));
      console.log(`  📐 [네메시스] 금액 조정: $${prev} → $${amountUsdt} (vol×${volFactor} corr×${corrFactor} time×${timeFactor})`);
    }

    const llm = await evaluateWithLLM({ signal, adjustedAmount: amountUsdt, volFactor, corrFactor, timeFactor, todayPnl, positionCount });
    console.log(`  🤖 [네메시스 LLM] ${llm.decision}: ${llm.reasoning}`);

    if (llm.decision === 'REJECT') {
      await db.updateSignalStatus(signal.id, SIGNAL_STATUS.REJECTED);
      await notifyRiskRejection({ symbol, action, reason: `[LLM] ${llm.reasoning}` });
      await db.insertRiskLog({ traceId, symbol, exchange: signal.exchange, decision: 'REJECT', riskScore: llm.risk_score ?? null, reason: llm.reasoning }).catch(() => {});
      return { approved: false, reason: llm.reasoning };
    }
    if (llm.decision === 'ADJUST' && llm.adjusted_amount) {
      amountUsdt = Math.max(RULES.MIN_ORDER_USDT, Math.floor(llm.adjusted_amount));
    }

    await db.insertRiskLog({ traceId, symbol, exchange: signal.exchange, decision: llm.decision, riskScore: llm.risk_score ?? null, reason: llm.reasoning }).catch(() => {});

    // ── Phase 1: 동적 TP/SL 로그 (applied: false — 실투자 미적용) ──────
    const dynamicTPSL = calculateDynamicTPSL(symbol, null, opts.atrRatio);
    console.log(`  📐 [네메시스 TP/SL] ${symbol}: TP+${(dynamicTPSL.tpPct * 100).toFixed(1)}% / SL-${(dynamicTPSL.slPct * 100).toFixed(1)}% (${dynamicTPSL.source}, applied: false)`);

    // ── 매매일지 판단 근거 기록 (승인/수정된 BUY만) ───────────────────
    try {
      await journalDb.insertRationale({
        signal_id:             signal.id,
        luna_decision:         'enter',
        luna_reasoning:        signal.reasoning || '',
        luna_confidence:       signal.confidence ?? null,
        nemesis_verdict:       llm.decision === 'ADJUST' ? 'modified' : 'approved',
        nemesis_notes:         llm.reasoning ?? null,
        position_size_original: signal.amount_usdt,
        position_size_approved: amountUsdt,
      });
    } catch (e) {
      console.warn(`  ⚠️ 매매일지 rationale 기록 실패: ${e.message}`);
    }
  }

  await db.updateSignalStatus(signal.id, SIGNAL_STATUS.APPROVED);
  await db.updateSignalAmount(signal.id, amountUsdt);
  console.log(`  ✅ [네메시스] ${symbol} ${action} $${amountUsdt} 승인`);
  return { approved: true, adjustedAmount: amountUsdt, traceId };
}
