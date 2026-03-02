'use strict';

/**
 * src/kis-executor.js — 크리스 (KIS 국내주식 실행봇)
 *
 * 승인된 KIS 신호를 한국투자증권 Open API로 실행.
 * kis_paper_trading: true (기본) → 모의투자 / false → 실전
 * 드라이런: 실제 주문 없이 DB + 텔레그램만.
 *
 * 실행: node src/kis-executor.js [--dry-run] [--action=BUY] [--symbol=005930] [--amount=500000]
 */

const db        = require('../lib/db');
const kis       = require('../lib/kis');
const { isDryRun, isKisPaper } = require('../lib/secrets');
const { SIGNAL_STATUS, ACTIONS } = require('../lib/signal');
const { notifyKisTrade, notifyError } = require('../lib/telegram');
const { guardRealOrder, printModeBanner } = require('../lib/mode');

// ── 봇 이름 (변경 시 이 상수만 수정)
const BOT_NAME = '크리스';

// ─── KIS 인라인 리스크 규칙 ─────────────────────────────────────────
// (기존 risk-manager는 USDT 기준이라 KRW 거래에는 별도 규칙 적용)

const KIS_RULES = {
  MIN_ORDER_KRW:      10_000,       // 최소 주문금액 (원)
  MAX_ORDER_KRW:   5_000_000,       // 최대 단건 주문금액 (원)
  MAX_DAILY_LOSS_PCT:    0.05,      // 총자산 대비 일일 최대 손실 5%
};

/**
 * KIS 리스크 체크
 * @returns {{ approved: boolean, reason?: string }}
 */
async function checkKisRisk(signal) {
  const { action, amount_usdt: amountKrw, symbol } = signal;

  // KIS 심볼 검증
  if (!kis.isKisSymbol(symbol)) {
    return { approved: false, reason: `KIS 심볼이 아님: ${symbol}` };
  }

  // HOLD는 리스크 체크 불필요
  if (action === ACTIONS.HOLD) {
    return { approved: true };
  }

  // 최소/최대 금액 체크 (BUY)
  if (action === ACTIONS.BUY) {
    if (!amountKrw || amountKrw < KIS_RULES.MIN_ORDER_KRW) {
      return { approved: false, reason: `최소 주문금액 미달 (${amountKrw?.toLocaleString()}원 < ${KIS_RULES.MIN_ORDER_KRW.toLocaleString()}원)` };
    }
    if (amountKrw > KIS_RULES.MAX_ORDER_KRW) {
      return { approved: false, reason: `최대 주문금액 초과 (${amountKrw?.toLocaleString()}원 > ${KIS_RULES.MAX_ORDER_KRW.toLocaleString()}원)` };
    }
  }

  // SELL: 보유 포지션 확인
  if (action === ACTIONS.SELL) {
    const pos = await db.getPosition(symbol);
    if (!pos || pos.amount <= 0) {
      return { approved: false, reason: `${symbol} KIS 포지션 없음 — SELL 불가` };
    }
  }

  return { approved: true };
}

// ─── 신호 실행 ──────────────────────────────────────────────────────

/**
 * 단일 KIS 신호 실행
 * @param {object} signal  DB의 signals 행
 * @returns {{ success: boolean, trade?: object, reason?: string, error?: string }}
 */
async function executeSignal(signal) {
  const dryRun  = isDryRun();
  const paper   = isKisPaper();
  const { id: signalId, symbol, action, amount_usdt: amountKrw } = signal;

  console.log(`\n⚡ [${BOT_NAME}] ${symbol} ${action} ${amountKrw?.toLocaleString()}원 ${dryRun ? '[드라이런]' : paper ? '[모의투자]' : '[실전]'}`);

  try {
    // 리스크 체크
    const risk = await checkKisRisk(signal);
    if (!risk.approved) {
      console.log(`  ❌ 리스크 거부: ${risk.reason}`);
      await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
      return { success: false, reason: risk.reason };
    }

    // 실주문 직전 최종 가드 (DEV 환경 보호)
    if (!dryRun) guardRealOrder(symbol, action, amountKrw);

    let trade;

    if (action === ACTIONS.BUY) {
      const order = await kis.marketBuy(symbol, amountKrw, dryRun);
      trade = {
        signalId,
        symbol,
        side:      'buy',
        amount:    order.qty,
        price:     order.price,
        // amount_usdt 필드를 KRW 금액으로 재사용 (DB 컬럼 네이밍 불일치 — KIS는 KRW)
        totalUsdt: order.totalKrw,
        dryRun:    order.dryRun,
        exchange:  'kis',
      };

      // 포지션 업데이트
      const existing = await db.getPosition(symbol);
      const newQty      = (existing?.amount || 0) + order.qty;
      const newAvgPrice = existing && existing.amount > 0
        ? ((existing.amount * existing.avg_price) + order.totalKrw) / newQty
        : order.price;

      await db.upsertPosition({
        symbol,
        amount:        newQty,
        avgPrice:      newAvgPrice,
        unrealizedPnl: 0,
        exchange:      'kis',
      });

    } else if (action === ACTIONS.SELL) {
      const position = await db.getPosition(symbol);
      const qty = position?.amount;
      if (!qty || qty < 1) {
        console.warn(`  ⚠️ ${symbol} 포지션 없음 — SELL 스킵`);
        await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
        return { success: false, reason: '포지션 없음' };
      }

      const order = await kis.marketSell(symbol, Math.floor(qty), dryRun);
      trade = {
        signalId,
        symbol,
        side:      'sell',
        amount:    order.qty,
        price:     order.price,
        totalUsdt: order.totalKrw, // KRW 금액 (네이밍 불일치 허용)
        dryRun:    order.dryRun,
        exchange:  'kis',
      };

      // 포지션 삭제
      await db.deletePosition(symbol);

    } else {
      console.log(`  ⏸️ HOLD — 실행 없음`);
      await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
      return { success: true };
    }

    // 거래 기록
    await db.insertTrade(trade);
    await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);

    // 텔레그램 알림 (KRW 포맷)
    await notifyKisTrade({
      symbol,
      side:     trade.side,
      qty:      trade.amount,
      price:    trade.price,
      totalKrw: trade.totalUsdt,
      dryRun:   trade.dryRun,
    });

    const modeTag = dryRun ? ' [드라이런]' : paper ? ' [모의투자]' : '';
    console.log(`  ✅ 실행 완료${modeTag}: ${trade.side} ${trade.amount}주 @ ${trade.price?.toLocaleString()}원`);
    return { success: true, trade };

  } catch (e) {
    console.error(`  ❌ 실행 오류: ${e.message}`);
    await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
    await notifyError(`${BOT_NAME}(KIS) - ${symbol} ${action}`, e);
    return { success: false, error: e.message };
  }
}

/**
 * 대기 중인 KIS 신호 전체 처리
 */
async function processAllPendingKisSignals() {
  const signals = await db.getPendingSignals('kis');
  if (signals.length === 0) {
    console.log(`[${BOT_NAME}] 대기 KIS 신호 없음`);
    return;
  }

  console.log(`[${BOT_NAME}] ${signals.length}개 KIS 신호 처리 시작`);
  for (const signal of signals) {
    await executeSignal(signal);
    await new Promise(r => setTimeout(r, 500)); // API rate limit 방어
  }
}

// CLI 실행
if (require.main === module) {
  const { registerShutdownHandlers } = require('../lib/health');
  registerShutdownHandlers([]);

  printModeBanner(`kis-executor (${BOT_NAME})`);

  const args        = process.argv.slice(2);
  const forceDryRun = args.includes('--dry-run');
  if (forceDryRun) process.env.DRY_RUN = 'true';

  const actionArg = args.find(a => a.startsWith('--action='))?.split('=')[1];
  const symbolArg = args.find(a => a.startsWith('--symbol='))?.split('=')[1];
  const amountArg = args.find(a => a.startsWith('--amount='))?.split('=')[1];

  if (actionArg && symbolArg) {
    // 수동 실행 모드
    const mockSignal = {
      id:         `CLI-KIS-${Date.now()}`,
      symbol:     symbolArg,
      action:     actionArg.toUpperCase(),
      amount_usdt: parseFloat(amountArg || '500000'), // KRW 금액 (필드명 재사용)
      confidence:  0.7,
      reasoning:   'CLI 수동 실행',
      exchange:    'kis',
    };

    if (!kis.isKisSymbol(mockSignal.symbol)) {
      console.error(`❌ KIS 심볼이 아닙니다: ${mockSignal.symbol} (6자리 숫자여야 함)`);
      process.exit(1);
    }

    executeSignal(mockSignal)
      .then(r => { console.log(r.success ? '✅ 완료' : `❌ 실패: ${r.reason || r.error}`); process.exit(0); })
      .catch(e => { console.error(e.message); process.exit(1); });
  } else {
    // 자동 처리 모드
    processAllPendingKisSignals()
      .then(() => process.exit(0))
      .catch(e => { console.error(e.message); process.exit(1); });
  }
}

module.exports = { executeSignal, processAllPendingKisSignals, checkKisRisk };
