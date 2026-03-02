'use strict';

/**
 * src/risk-manager.js — 리스크 매니저 v2 (LU-036)
 *
 * v1 규칙 기반 + v2 LLM 강화:
 *   1. 하드 규칙 (v1): 포지션 크기·일손실·포지션 수·손절
 *   2. 변동성 조정 (v2): ATR 기반 포지션 크기 자동 축소
 *   3. 상관관계 가드 (v2): BTC/ETH 동시 보유 시 신규 크기 축소
 *   4. 시간대 가드 (v2): 저유동성 시간(KST 01:00~07:00) 포지션 50% 축소
 *   5. LLM 리스크 평가 (v2): haiku가 거부·조정·승인 결정
 *
 * 규칙은 LLM보다 우선 — 규칙이 거부하면 LLM도 승인 불가
 *
 * 실행: node src/risk-manager.js [--signal-id=<uuid>]
 */

const https  = require('https');
const db     = require('../lib/db');
const { fetchBalance, fetchOHLCV } = require('../lib/binance');
const { logUsage }   = require('../lib/api-usage');
const { loadSecrets } = require('../lib/secrets');
const { SIGNAL_STATUS, ACTIONS } = require('../lib/signal');
const { notifyRiskRejection }    = require('../lib/telegram');

// ─── 하드 규칙 (v1 유지) ────────────────────────────────────────────

const RULES = {
  MAX_SINGLE_POSITION_PCT: 0.20,
  MAX_DAILY_LOSS_PCT:      0.05,
  MAX_OPEN_POSITIONS:      5,
  STOP_LOSS_PCT:           0.03,
  MIN_ORDER_USDT:          10,
  MAX_ORDER_USDT:          1000,
};

// ─── v2: 변동성 조정 ────────────────────────────────────────────────

/**
 * ATR 기반 변동성 조정 계수 계산
 * ATR/Price > 5% → 고변동성 → 포지션 50% 축소
 * ATR/Price 3~5% → 중변동성 → 포지션 75% 유지
 * ATR/Price < 3% → 정상 → 100%
 */
async function calcVolatilityFactor(symbol) {
  try {
    const ohlcv = await fetchOHLCV(symbol, '1d', 20);
    if (!ohlcv || ohlcv.length < 14) return 1.0;

    const highs  = ohlcv.map(c => c[2]);
    const lows   = ohlcv.map(c => c[3]);
    const closes = ohlcv.map(c => c[4]);

    // ATR(14)
    let trSum = 0;
    for (let i = 1; i < closes.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i]  - closes[i - 1])
      );
      trSum += tr;
    }
    const atr       = trSum / (closes.length - 1);
    const lastPrice = closes[closes.length - 1];
    const atrPct    = atr / lastPrice;

    if (atrPct > 0.05) return 0.50;   // 고변동성
    if (atrPct > 0.03) return 0.75;   // 중변동성
    return 1.0;                         // 정상
  } catch {
    return 1.0; // 실패 시 패널티 없음
  }
}

// ─── v2: 상관관계 가드 ──────────────────────────────────────────────

const CORRELATED_GROUPS = [
  ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'],  // 주요 코인 (높은 상관)
];

/**
 * 이미 보유 중인 상관 자산 수 확인
 * 같은 그룹 2개 이상 보유 중이면 포지션 75% 축소
 */
async function calcCorrelationFactor(symbol) {
  try {
    const positions = await db.getAllPositions();
    const held = new Set(positions.map(p => p.symbol));
    for (const group of CORRELATED_GROUPS) {
      if (!group.includes(symbol)) continue;
      const heldInGroup = group.filter(s => s !== symbol && held.has(s)).length;
      if (heldInGroup >= 2) return 0.50;  // 동일 그룹 2개 이상 보유
      if (heldInGroup >= 1) return 0.75;  // 동일 그룹 1개 보유
    }
    return 1.0;
  } catch {
    return 1.0;
  }
}

// ─── v2: 시간대 가드 ────────────────────────────────────────────────

/**
 * KST 01:00~07:00 저유동성 시간 → 포지션 50% 축소
 */
function calcTimeFactor() {
  const kstHour = new Date(Date.now() + 9 * 3600 * 1000).getUTCHours();
  if (kstHour >= 1 && kstHour < 7) return 0.50;
  return 1.0;
}

// ─── v2: LLM 리스크 평가 ────────────────────────────────────────────

const RISK_LLM_PROMPT = `당신은 퀀트 리스크 매니저입니다.
주어진 매매 신호와 포트폴리오 상황을 검토해 리스크 판단을 내립니다.

응답 형식 (JSON만):
{"decision":"APPROVE"|"ADJUST"|"REJECT","adjusted_amount":숫자,"reasoning":"근거 1문장 (한국어)"}

규칙:
- APPROVE: 제안 금액 그대로 승인
- ADJUST: 금액 조정 후 승인 (adjusted_amount에 조정값 명시)
- REJECT: 리스크가 너무 높아 거부 (조건: 명백한 시장 위험 또는 과도한 집중)
- 확신도 0.5~0.6 구간: ADJUST로 50% 축소 권장
- 확신도 0.6 이상: 시황에 따라 APPROVE 가능`;

async function evaluateWithLLM({ signal, adjustedAmount, volFactor, corrFactor, timeFactor, todayPnl, positionCount }) {
  const secrets = loadSecrets();
  const apiKey  = secrets.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { decision: 'APPROVE', adjusted_amount: adjustedAmount, reasoning: 'API 키 없음 — 규칙 기반만 적용' };

  const userMsg = [
    `신호: ${signal.symbol} ${signal.action} $${adjustedAmount}`,
    `확신도: ${((signal.confidence || 0) * 100).toFixed(0)}%`,
    `근거: ${signal.reasoning?.slice(0, 120) || '없음'}`,
    ``,
    `포트폴리오 상황:`,
    `  오늘 P&L: ${(todayPnl?.pnl || 0) >= 0 ? '+' : ''}$${(todayPnl?.pnl || 0).toFixed(2)}`,
    `  현재 포지션: ${positionCount}/${RULES.MAX_OPEN_POSITIONS}개`,
    `  변동성 조정: ×${volFactor.toFixed(2)} | 상관관계: ×${corrFactor.toFixed(2)} | 시간대: ×${timeFactor.toFixed(2)}`,
    ``,
    `최종 리스크 판단을 내려주세요.`,
  ].join('\n');

  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({
      model:       'claude-haiku-4-5-20251001',
      max_tokens:  256,
      temperature: 0.0,
      system:      RISK_LLM_PROMPT,
      messages:    [{ role: 'user', content: userMsg }],
    }));

    const start = Date.now();
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'content-length':    body.length,
      },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        const latencyMs = Date.now() - start;
        try {
          const parsed = JSON.parse(raw);
          logUsage({
            provider: 'anthropic', model: 'claude-haiku-4-5-20251001',
            promptTokens: parsed.usage?.input_tokens || 0,
            completionTokens: parsed.usage?.output_tokens || 0,
            latencyMs, caller: 'risk-manager-v2',
            success: !!parsed.content?.[0]?.text,
          });
          const text   = parsed.content?.[0]?.text || '';
          // JSON 객체를 텍스트에서 추출 (마크다운·추가 텍스트 무시)
          const jsonMatch = text.match(/\{[\s\S]*?"decision"[\s\S]*?\}/);
          const result = JSON.parse(jsonMatch ? jsonMatch[0] : text.replace(/```json?\n?|\n?```/g, '').trim());
          resolve(result);
        } catch {
          resolve({ decision: 'APPROVE', adjusted_amount: adjustedAmount, reasoning: 'LLM 파싱 실패 — 기본 승인' });
        }
      });
    });

    req.on('error', () => resolve({ decision: 'APPROVE', adjusted_amount: adjustedAmount, reasoning: 'LLM 오류 — 기본 승인' }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ decision: 'APPROVE', adjusted_amount: adjustedAmount, reasoning: 'LLM 타임아웃 — 기본 승인' }); });
    req.write(body);
    req.end();
  });
}

// ─── v1 규칙 체크 ───────────────────────────────────────────────────

function checkPositionSize(amountUsdt, totalUsdt) {
  if (amountUsdt < RULES.MIN_ORDER_USDT)
    return { ok: false, reason: `최소 주문 금액 미달 ($${amountUsdt} < $${RULES.MIN_ORDER_USDT})` };
  if (amountUsdt > RULES.MAX_ORDER_USDT)
    return { ok: false, reason: `최대 주문 금액 초과 ($${amountUsdt} > $${RULES.MAX_ORDER_USDT})` };
  const pct = amountUsdt / totalUsdt;
  if (pct > RULES.MAX_SINGLE_POSITION_PCT)
    return { ok: false, reason: `단일 포지션 ${(pct * 100).toFixed(1)}% > 최대 ${RULES.MAX_SINGLE_POSITION_PCT * 100}%` };
  return { ok: true };
}

async function checkDailyLoss(totalUsdt) {
  const { pnl } = await db.getTodayPnl();
  const lossPct = pnl < 0 ? Math.abs(pnl) / totalUsdt : 0;
  if (lossPct >= RULES.MAX_DAILY_LOSS_PCT)
    return { ok: false, reason: `일일 손실 한도 초과: ${(lossPct * 100).toFixed(1)}% (한도 ${RULES.MAX_DAILY_LOSS_PCT * 100}%)` };
  return { ok: true };
}

async function checkMaxPositions() {
  const positions = await db.getAllPositions();
  if (positions.length >= RULES.MAX_OPEN_POSITIONS)
    return { ok: false, reason: `최대 포지션 초과 (현재 ${positions.length}개, 한도 ${RULES.MAX_OPEN_POSITIONS}개)` };
  return { ok: true, count: positions.length };
}

async function checkStopLoss(symbol) {
  const position = await db.getPosition(symbol);
  if (!position || position.amount <= 0) return { needsStopLoss: false };
  const pnlPct = position.unrealized_pnl / (position.amount * position.avg_price);
  if (pnlPct <= -RULES.STOP_LOSS_PCT)
    return { needsStopLoss: true, position, pnlPct, reason: `손절 조건: ${(pnlPct * 100).toFixed(1)}% ≤ -${RULES.STOP_LOSS_PCT * 100}%` };
  return { needsStopLoss: false };
}

// ─── 메인 승인/거부 (v2) ────────────────────────────────────────────

/**
 * 신호 평가 — v1 규칙 + v2 LLM 강화
 * @param {object} signal  { id, symbol, action, amount_usdt, confidence, reasoning }
 * @returns {{ approved: boolean, adjustedAmount?: number, reason?: string, llmReasoning?: string }}
 */
async function evaluateSignal(signal) {
  const { symbol, action } = signal;
  let amountUsdt = signal.amount_usdt || 100;

  // ── 잔고 조회 ──
  let totalUsdt = 10000;
  try {
    const bal = await fetchBalance();
    totalUsdt = bal?.USDT?.total || bal?.total?.USDT || 10000;
  } catch (e) {
    console.warn(`⚠️ 잔고 조회 실패 (기본값): ${e.message}`);
  }

  // ── v1 하드 규칙 ──
  if (action === ACTIONS.BUY) {
    const r1 = checkPositionSize(amountUsdt, totalUsdt);
    if (!r1.ok) {
      await db.updateSignalStatus(signal.id, SIGNAL_STATUS.REJECTED);
      await notifyRiskRejection({ symbol, action, reason: r1.reason });
      return { approved: false, reason: r1.reason };
    }
  }

  const r2 = await checkDailyLoss(totalUsdt);
  if (!r2.ok) {
    await db.updateSignalStatus(signal.id, SIGNAL_STATUS.REJECTED);
    await notifyRiskRejection({ symbol, action, reason: r2.reason });
    return { approved: false, reason: r2.reason };
  }

  let positionCount = 0;
  if (action === ACTIONS.BUY) {
    const r3 = await checkMaxPositions();
    if (!r3.ok) {
      await db.updateSignalStatus(signal.id, SIGNAL_STATUS.REJECTED);
      await notifyRiskRejection({ symbol, action, reason: r3.reason });
      return { approved: false, reason: r3.reason };
    }
    positionCount = r3.count;
  }

  // ── v2: 변동성·상관관계·시간대 조정 ──
  if (action === ACTIONS.BUY) {
    const [volFactor, corrFactor] = await Promise.all([
      calcVolatilityFactor(symbol),
      calcCorrelationFactor(symbol),
    ]);
    const timeFactor   = calcTimeFactor();
    const combinedFact = volFactor * corrFactor * timeFactor;

    if (combinedFact < 1.0) {
      const prev = amountUsdt;
      amountUsdt = Math.max(RULES.MIN_ORDER_USDT, Math.floor(amountUsdt * combinedFact));
      console.log(`  📐 [리스크v2] 금액 조정: $${prev} → $${amountUsdt} (vol×${volFactor} corr×${corrFactor} time×${timeFactor})`);
    }

    // ── v2: LLM 평가 ──
    const todayPnl = await db.getTodayPnl();
    const llm = await evaluateWithLLM({
      signal, adjustedAmount: amountUsdt,
      volFactor, corrFactor, timeFactor, todayPnl, positionCount,
    });

    console.log(`  🤖 [LLM리스크] ${llm.decision}: ${llm.reasoning}`);

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
  console.log(`✅ [리스크v2] ${symbol} ${action} $${amountUsdt} 승인`);
  return { approved: true, adjustedAmount: amountUsdt };
}

async function checkStopLossAll(symbols) {
  const stopList = [];
  for (const symbol of symbols) {
    const result = await checkStopLoss(symbol);
    if (result.needsStopLoss) {
      console.log(`🛑 [손절] ${symbol}: ${result.reason}`);
      stopList.push({ symbol, ...result });
    }
  }
  return stopList;
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const signalIdArg = args.find(a => a.startsWith('--signal-id='));

  if (!signalIdArg) {
    const { getSymbols } = require('../lib/secrets');
    checkStopLossAll(getSymbols())
      .then(list => {
        console.log(list.length === 0 ? '손절 필요 포지션 없음' : `손절 필요: ${list.map(p => p.symbol).join(', ')}`);
        process.exit(0);
      })
      .catch(e => { console.error('오류:', e.message); process.exit(1); });
  } else {
    const signalId = signalIdArg.split('=')[1];
    db.getPendingSignals()
      .then(signals => {
        const signal = signals.find(s => s.id === signalId);
        if (!signal) { console.error(`신호 없음: ${signalId}`); process.exit(1); }
        return evaluateSignal(signal);
      })
      .then(r => { console.log(r.approved ? `✅ 승인 ($${r.adjustedAmount})` : `❌ 거부: ${r.reason}`); process.exit(0); })
      .catch(e => { console.error('오류:', e.message); process.exit(1); });
  }
}

module.exports = { evaluateSignal, checkStopLossAll, RULES };
