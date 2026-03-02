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
// (기존 risk-manager는 USDT 기준이라 KRW/USD 거래에는 별도 규칙 적용)

const KIS_RULES = {
  MIN_ORDER_KRW:      10_000,       // 국내주식 최소 주문금액 (원)
  MAX_ORDER_KRW:   5_000_000,       // 국내주식 최대 단건 주문금액 (원)
  MAX_DAILY_LOSS_PCT:    0.05,      // 총자산 대비 일일 최대 손실 5%
};

const KIS_OVERSEAS_RULES = {
  MIN_ORDER_USD:    10,             // 해외주식 최소 주문금액 (USD)
  MAX_ORDER_USD: 1_000,             // 해외주식 최대 단건 주문금액 (USD)
};

/**
 * KIS 국내주식 리스크 체크
 * @returns {{ approved: boolean, reason?: string }}
 */
async function checkKisRisk(signal) {
  const { action, amount_usdt: amountKrw, symbol } = signal;

  // KIS 국내주식 심볼 검증
  if (!kis.isKisSymbol(symbol)) {
    return { approved: false, reason: `KIS 국내 심볼이 아님: ${symbol}` };
  }

  if (action === ACTIONS.HOLD) return { approved: true };

  if (action === ACTIONS.BUY) {
    if (!amountKrw || amountKrw < KIS_RULES.MIN_ORDER_KRW) {
      return { approved: false, reason: `최소 주문금액 미달 (${amountKrw?.toLocaleString()}원 < ${KIS_RULES.MIN_ORDER_KRW.toLocaleString()}원)` };
    }
    if (amountKrw > KIS_RULES.MAX_ORDER_KRW) {
      return { approved: false, reason: `최대 주문금액 초과 (${amountKrw?.toLocaleString()}원 > ${KIS_RULES.MAX_ORDER_KRW.toLocaleString()}원)` };
    }
  }

  if (action === ACTIONS.SELL) {
    const pos = await db.getPosition(symbol);
    if (!pos || pos.amount <= 0) {
      return { approved: false, reason: `${symbol} KIS 포지션 없음 — SELL 불가` };
    }
  }

  return { approved: true };
}

/**
 * KIS 해외주식 리스크 체크
 * @returns {{ approved: boolean, reason?: string }}
 */
async function checkKisOverseasRisk(signal) {
  const { action, amount_usdt: amountUsd, symbol } = signal;

  // 해외주식 심볼 검증
  if (!kis.isKisOverseasSymbol(symbol)) {
    return { approved: false, reason: `KIS 해외 심볼이 아님: ${symbol}` };
  }

  if (action === ACTIONS.HOLD) return { approved: true };

  if (action === ACTIONS.BUY) {
    if (!amountUsd || amountUsd < KIS_OVERSEAS_RULES.MIN_ORDER_USD) {
      return { approved: false, reason: `최소 주문금액 미달 ($${amountUsd} < $${KIS_OVERSEAS_RULES.MIN_ORDER_USD})` };
    }
    if (amountUsd > KIS_OVERSEAS_RULES.MAX_ORDER_USD) {
      return { approved: false, reason: `최대 주문금액 초과 ($${amountUsd} > $${KIS_OVERSEAS_RULES.MAX_ORDER_USD})` };
    }
  }

  if (action === ACTIONS.SELL) {
    const pos = await db.getPosition(symbol);
    if (!pos || pos.amount <= 0) {
      return { approved: false, reason: `${symbol} KIS 해외 포지션 없음 — SELL 불가` };
    }
  }

  return { approved: true };
}

// ─── 신호 실행 ──────────────────────────────────────────────────────

/**
 * 단일 KIS 국내주식 신호 실행
 * @param {object} signal  DB의 signals 행
 * @returns {{ success: boolean, trade?: object, reason?: string, error?: string }}
 */
async function executeSignal(signal) {
  const dryRun  = isDryRun();
  const paper   = isKisPaper();
  const { id: signalId, symbol, action, amount_usdt: amountKrw } = signal;

  console.log(`\n⚡ [${BOT_NAME}] ${symbol} ${action} ${amountKrw?.toLocaleString()}원 ${dryRun ? '[드라이런]' : paper ? '[모의투자]' : '[실전]'}`);

  try {
    const risk = await checkKisRisk(signal);
    if (!risk.approved) {
      console.log(`  ❌ 리스크 거부: ${risk.reason}`);
      await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
      return { success: false, reason: risk.reason };
    }

    if (!dryRun) guardRealOrder(symbol, action, amountKrw);

    let trade;

    if (action === ACTIONS.BUY) {
      const order = await kis.marketBuy(symbol, amountKrw, dryRun);
      trade = {
        signalId, symbol, side: 'buy',
        amount:    order.qty,
        price:     order.price,
        totalUsdt: order.totalKrw, // KRW 금액 (DB 컬럼 네이밍 재사용)
        dryRun:    order.dryRun,
        exchange:  'kis',
      };

      const existing    = await db.getPosition(symbol);
      const newQty      = (existing?.amount || 0) + order.qty;
      const newAvgPrice = existing && existing.amount > 0
        ? ((existing.amount * existing.avg_price) + order.totalKrw) / newQty
        : order.price;

      await db.upsertPosition({ symbol, amount: newQty, avgPrice: newAvgPrice, unrealizedPnl: 0, exchange: 'kis' });

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
        signalId, symbol, side: 'sell',
        amount:    order.qty,
        price:     order.price,
        totalUsdt: order.totalKrw,
        dryRun:    order.dryRun,
        exchange:  'kis',
      };

      await db.deletePosition(symbol);

    } else {
      console.log(`  ⏸️ HOLD — 실행 없음`);
      await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
      return { success: true };
    }

    await db.insertTrade(trade);
    await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);

    await notifyKisTrade({
      symbol, side: trade.side, qty: trade.amount,
      price: trade.price, totalKrw: trade.totalUsdt, dryRun: trade.dryRun,
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
 * 단일 KIS 해외주식 신호 실행
 * @param {object} signal  DB의 signals 행 (exchange='kis_overseas')
 */
async function executeOverseasSignal(signal) {
  const dryRun  = isDryRun();
  const paper   = isKisPaper();
  const { id: signalId, symbol, action, amount_usdt: amountUsd } = signal;

  console.log(`\n⚡ [${BOT_NAME}] 해외 ${symbol} ${action} $${amountUsd} ${dryRun ? '[드라이런]' : paper ? '[모의투자]' : '[실전]'}`);

  try {
    const risk = await checkKisOverseasRisk(signal);
    if (!risk.approved) {
      console.log(`  ❌ 리스크 거부: ${risk.reason}`);
      await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
      return { success: false, reason: risk.reason };
    }

    if (!dryRun) guardRealOrder(symbol, action, amountUsd);

    let trade;

    if (action === ACTIONS.BUY) {
      const order = await kis.marketBuyOverseas(symbol, amountUsd, dryRun);
      trade = {
        signalId, symbol, side: 'buy',
        amount:    order.qty,
        price:     order.price,
        totalUsdt: order.totalUsd, // USD 금액
        dryRun:    order.dryRun,
        exchange:  'kis_overseas',
      };

      const existing    = await db.getPosition(symbol);
      const newQty      = (existing?.amount || 0) + order.qty;
      const newAvgPrice = existing && existing.amount > 0
        ? ((existing.amount * existing.avg_price) + order.totalUsd) / newQty
        : order.price;

      await db.upsertPosition({ symbol, amount: newQty, avgPrice: newAvgPrice, unrealizedPnl: 0, exchange: 'kis_overseas' });

    } else if (action === ACTIONS.SELL) {
      const position = await db.getPosition(symbol);
      const qty = position?.amount;
      if (!qty || qty < 1) {
        console.warn(`  ⚠️ ${symbol} 해외 포지션 없음 — SELL 스킵`);
        await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
        return { success: false, reason: '해외 포지션 없음' };
      }

      const order = await kis.marketSellOverseas(symbol, Math.floor(qty), dryRun);
      trade = {
        signalId, symbol, side: 'sell',
        amount:    order.qty,
        price:     order.price,
        totalUsdt: order.totalUsd,
        dryRun:    order.dryRun,
        exchange:  'kis_overseas',
      };

      await db.deletePosition(symbol);

    } else {
      console.log(`  ⏸️ HOLD — 실행 없음`);
      await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
      return { success: true };
    }

    await db.insertTrade(trade);
    await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);

    // 텔레그램: KRW 포맷 재사용 (USD 금액으로 전달, totalKrw 필드에 USD 값)
    await notifyKisTrade({
      symbol: `🌏${symbol}(US)`, side: trade.side, qty: trade.amount,
      price: trade.price, totalKrw: trade.totalUsdt, dryRun: trade.dryRun,
    });

    const modeTag = dryRun ? ' [드라이런]' : paper ? ' [모의투자]' : '';
    console.log(`  ✅ 해외 실행 완료${modeTag}: ${trade.side} ${trade.amount}주 @ $${trade.price}`);
    return { success: true, trade };

  } catch (e) {
    console.error(`  ❌ 해외 실행 오류: ${e.message}`);
    await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
    await notifyError(`${BOT_NAME}(KIS해외) - ${symbol} ${action}`, e);
    return { success: false, error: e.message };
  }
}

/**
 * 대기 중인 KIS 국내주식 신호 전체 처리
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
    await new Promise(r => setTimeout(r, 500));
  }
}

/**
 * 대기 중인 KIS 해외주식 신호 전체 처리
 */
async function processAllPendingKisOverseasSignals() {
  const signals = await db.getPendingSignals('kis_overseas');
  if (signals.length === 0) {
    console.log(`[${BOT_NAME}] 대기 KIS 해외 신호 없음`);
    return;
  }

  console.log(`[${BOT_NAME}] ${signals.length}개 KIS 해외 신호 처리 시작`);
  for (const signal of signals) {
    await executeOverseasSignal(signal);
    await new Promise(r => setTimeout(r, 500));
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
    const isOverseas = kis.isKisOverseasSymbol(symbolArg);
    const isDomestic = kis.isKisSymbol(symbolArg);

    if (!isDomestic && !isOverseas) {
      console.error(`❌ KIS 심볼이 아닙니다: ${symbolArg} (국내: 6자리 숫자, 해외: 알파벳 1~5자)`);
      process.exit(1);
    }

    const mockSignal = {
      id:          `CLI-KIS-${Date.now()}`,
      symbol:      symbolArg,
      action:      actionArg.toUpperCase(),
      amount_usdt: parseFloat(amountArg || (isOverseas ? '100' : '500000')),
      confidence:  0.7,
      reasoning:   'CLI 수동 실행',
      exchange:    isOverseas ? 'kis_overseas' : 'kis',
    };

    const execFn = isOverseas ? executeOverseasSignal : executeSignal;
    execFn(mockSignal)
      .then(r => { console.log(r.success ? '✅ 완료' : `❌ 실패: ${r.reason || r.error}`); process.exit(0); })
      .catch(e => { console.error(e.message); process.exit(1); });
  } else {
    // 자동 처리 모드 (국내 + 해외 순차 처리)
    Promise.all([
      processAllPendingKisSignals(),
      processAllPendingKisOverseasSignals(),
    ])
      .then(() => process.exit(0))
      .catch(e => { console.error(e.message); process.exit(1); });
  }
}

module.exports = {
  executeSignal,
  executeOverseasSignal,
  processAllPendingKisSignals,
  processAllPendingKisOverseasSignals,
  checkKisRisk,
  checkKisOverseasRisk,
};
