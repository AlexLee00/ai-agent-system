'use strict';

/**
 * team/nemesis.js — 네메시스 (리스크 매니저)
 *
 * 역할: 신호 평가 — 하드 규칙(v1) + LLM 리스크 평가(v2)
 * LLM: Claude Haiku
 *
 * bots/invest/src/risk-manager.js v2 재사용
 * (binance fetchBalance 의존 → binance 키 없으면 기본값 10000 USDT 사용)
 *
 * 실행: node team/nemesis.js (단독 실행 불가 — luna.js에서 호출)
 */

const db     = require('../shared/db');
const { callHaiku, parseJSON } = require('../shared/llm');
const { SIGNAL_STATUS, ACTIONS } = require('../shared/signal');
const { notifyRiskRejection }    = require('../shared/report');

// ─── 하드 규칙 (v1) ─────────────────────────────────────────────────

const RULES = {
  MAX_SINGLE_POSITION_PCT: 0.20,  // 단일 포지션 최대 20%
  MAX_DAILY_LOSS_PCT:      0.05,  // 일일 손실 한도 5%
  MAX_OPEN_POSITIONS:      5,     // 최대 동시 포지션
  STOP_LOSS_PCT:           0.03,  // 손절 3%
  MIN_ORDER_USDT:          10,    // 최소 주문 $10
  MAX_ORDER_USDT:          1000,  // 최대 주문 $1000
};

// ─── v2: 변동성 조정 ────────────────────────────────────────────────

/**
 * ATR 기반 변동성 조정 계수
 * aria.js의 4h 결과에서 ATR 가져오기 (없으면 1.0)
 */
async function calcVolatilityFactor(symbol, atrRatio = null) {
  if (atrRatio === null) return 1.0;
  if (atrRatio > 0.05) return 0.50;  // 고변동성
  if (atrRatio > 0.03) return 0.75;  // 중변동성
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

const RISK_PROMPT = `당신은 퀀트 리스크 매니저입니다.
주어진 매매 신호와 포트폴리오 상황을 검토해 리스크 판단을 내립니다.

응답 (JSON만):
{"decision":"APPROVE"|"ADJUST"|"REJECT","adjusted_amount":숫자,"reasoning":"근거 1문장 (한국어)"}

규칙:
- APPROVE: 제안 금액 그대로 승인
- ADJUST: 금액 조정 후 승인 (adjusted_amount에 조정값 명시)
- REJECT: 리스크가 너무 높아 거부
- 확신도 0.5~0.6: ADJUST 50% 축소 권장
- 확신도 0.6 이상: 시황에 따라 APPROVE 가능`;

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

  const raw    = await callHaiku(RISK_PROMPT, userMsg, 'nemesis', 256);
  const parsed = parseJSON(raw);
  if (!parsed?.decision) {
    return { decision: 'APPROVE', adjusted_amount: adjustedAmount, reasoning: 'LLM 파싱 실패 — 기본 승인' };
  }
  return parsed;
}

// ─── 메인 신호 평가 ─────────────────────────────────────────────────

/**
 * 신호 평가 — v1 규칙 + v2 LLM
 * @param {object} signal  { id, symbol, action, amount_usdt, confidence, reasoning }
 * @param {object} [opts]  { atrRatio, totalUsdt }
 */
async function evaluateSignal(signal, opts = {}) {
  const { symbol, action } = signal;
  let amountUsdt = signal.amount_usdt || 100;
  const totalUsdt = opts.totalUsdt || 10000; // 바이낸스 키 없으면 기본값

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

  // 일일 손실 한도
  const todayPnl = await db.getTodayPnl();
  const lossPct  = (todayPnl.pnl || 0) < 0 ? Math.abs(todayPnl.pnl) / totalUsdt : 0;
  if (lossPct >= RULES.MAX_DAILY_LOSS_PCT) {
    const reason = `일일 손실 한도 초과 (${(lossPct * 100).toFixed(1)}%)`;
    await db.updateSignalStatus(signal.id, SIGNAL_STATUS.REJECTED);
    await notifyRiskRejection({ symbol, action, reason });
    return { approved: false, reason };
  }

  // 최대 포지션
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
      return { approved: false, reason: llm.reasoning };
    }
    if (llm.decision === 'ADJUST' && llm.adjusted_amount) {
      amountUsdt = Math.max(RULES.MIN_ORDER_USDT, Math.floor(llm.adjusted_amount));
    }
  }

  await db.updateSignalStatus(signal.id, SIGNAL_STATUS.APPROVED);
  console.log(`  ✅ [네메시스] ${symbol} ${action} $${amountUsdt} 승인`);
  return { approved: true, adjustedAmount: amountUsdt };
}

module.exports = { evaluateSignal, RULES };
