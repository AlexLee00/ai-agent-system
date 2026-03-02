'use strict';

/**
 * src/binance-executor.js — 바이낸스 실행봇
 *
 * 승인된 신호를 바이낸스 Spot API로 실행.
 * 드라이런: 실제 주문 없이 DB + 텔레그램만.
 *
 * 실행: node src/binance-executor.js [--dry-run] [--action=BUY] [--symbol=BTC/USDT] [--amount=100]
 */

const db = require('../lib/db');
const { marketBuy, marketSell, fetchTicker } = require('../lib/binance');
const { isDryRun } = require('../lib/secrets');
const { SIGNAL_STATUS, ACTIONS } = require('../lib/signal');
const { notifyTrade, notifyError } = require('../lib/telegram');
const { evaluateSignal } = require('./risk-manager');
const { guardRealOrder, printModeBanner } = require('../lib/mode');

// ─── 신호 실행 ─────────────────────────────────────────────────────

/**
 * 단일 신호 실행
 * @param {object} signal  DB의 signals 행
 * @returns {{ success: boolean, trade?: object }}
 */
async function executeSignal(signal) {
  const dryRun = isDryRun();
  const { id: signalId, symbol, action, amount_usdt: amountUsdt } = signal;

  console.log(`\n⚡ [실행봇] ${symbol} ${action} $${amountUsdt} ${dryRun ? '[드라이런]' : ''}`);

  try {
    // 리스크 승인
    const approval = await evaluateSignal(signal);
    if (!approval.approved) {
      console.log(`  ❌ 리스크 거부: ${approval.reason}`);
      return { success: false, reason: approval.reason };
    }

    let trade;

    // 실주문 직전 최종 가드 (DEV 환경에서 실수 방지)
    if (!dryRun) guardRealOrder(symbol, action, amountUsdt);

    if (action === ACTIONS.BUY) {
      const order = await marketBuy(symbol, amountUsdt, dryRun);
      trade = {
        signalId,
        symbol,
        side:      'buy',
        amount:    order.filled,
        price:     order.price,
        totalUsdt: amountUsdt,
        dryRun:    order.dryRun,
      };

      // 포지션 업데이트
      const existing = await db.getPosition(symbol);
      const newAmount   = (existing?.amount || 0) + order.filled;
      const newAvgPrice = existing
        ? ((existing.amount * existing.avg_price) + amountUsdt) / newAmount
        : order.price;

      await db.upsertPosition({
        symbol,
        amount:         newAmount,
        avgPrice:       newAvgPrice,
        unrealizedPnl:  0,
      });

    } else if (action === ACTIONS.SELL) {
      // 보유 포지션에서 수량 계산
      const position = await db.getPosition(symbol);
      const amount = position?.amount;
      if (!amount || amount <= 0) {
        console.warn(`  ⚠️ ${symbol} 포지션 없음 — SELL 스킵`);
        await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
        return { success: false, reason: '포지션 없음' };
      }

      const order = await marketSell(symbol, amount, dryRun);
      trade = {
        signalId,
        symbol,
        side:      'sell',
        amount:    order.amount,
        price:     order.price,
        totalUsdt: order.totalUsdt,
        dryRun:    order.dryRun,
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

    // 텔레그램 알림
    await notifyTrade(trade);

    console.log(`  ✅ 실행 완료: ${trade.side} ${trade.amount?.toFixed(6)} @ $${trade.price?.toLocaleString()}`);
    return { success: true, trade };

  } catch (e) {
    console.error(`  ❌ 실행 오류: ${e.message}`);
    await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
    await notifyError(`실행봇 - ${symbol} ${action}`, e);
    return { success: false, error: e.message };
  }
}

/**
 * 대기 중인 신호 전체 처리
 */
async function processAllPendingSignals() {
  const signals = await db.getPendingSignals();
  if (signals.length === 0) {
    console.log('[실행봇] 대기 신호 없음');
    return;
  }

  console.log(`[실행봇] ${signals.length}개 신호 처리 시작`);
  for (const signal of signals) {
    await executeSignal(signal);
    // 신호 간 대기 (API rate limit 방어)
    await new Promise(r => setTimeout(r, 500));
  }
}

// CLI 실행
if (require.main === module) {
  const { registerShutdownHandlers } = require('../lib/health');
  // 종료 1중: SIGTERM/SIGINT graceful shutdown 핸들러 등록
  registerShutdownHandlers([]);

  const args = process.argv.slice(2);
  const forceDryRun = args.includes('--dry-run');
  if (forceDryRun) process.env.DRY_RUN = 'true';

  const actionArg = args.find(a => a.startsWith('--action='))?.split('=')[1];
  const symbolArg = args.find(a => a.startsWith('--symbol='))?.split('=')[1];
  const amountArg = args.find(a => a.startsWith('--amount='))?.split('=')[1];

  if (actionArg && symbolArg) {
    // 수동 실행 모드
    const mockSignal = {
      id:         `CLI-${Date.now()}`,
      symbol:     symbolArg,
      action:     actionArg.toUpperCase(),
      amount_usdt: parseFloat(amountArg || '100'),
      confidence: 0.7,
      reasoning:  'CLI 수동 실행',
    };
    executeSignal(mockSignal)
      .then(r => { console.log(r.success ? '✅ 완료' : `❌ 실패: ${r.reason}`); process.exit(0); })
      .catch(e => { console.error(e.message); process.exit(1); });
  } else {
    // 자동 처리 모드
    processAllPendingSignals()
      .then(() => process.exit(0))
      .catch(e => { console.error(e.message); process.exit(1); });
  }
}

module.exports = { executeSignal, processAllPendingSignals };
