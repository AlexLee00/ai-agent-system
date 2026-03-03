/**
 * team/hephaestos.js — 헤파이스토스 (바이낸스 실행봇)
 *
 * 역할: 루나가 승인한 신호를 바이낸스 Spot API로 실행
 * LLM: 없음 (규칙 기반)
 * PAPER_MODE: true → DB 저장 + 텔레그램만 (실주문 없음)
 *
 * bots/invest/src/binance-executor.js 패턴 재사용
 * (Phase 3-A: PAPER_MODE 기본값 — 실주문은 Phase 3-C에서 활성화)
 *
 * 실행: node team/hephaestos.js [--symbol=BTC/USDT] [--action=BUY] [--amount=100]
 */

import ccxt from 'ccxt';
import { fileURLToPath } from 'url';
import * as db from '../shared/db.js';
import { loadSecrets, isPaperMode } from '../shared/secrets.js';
import { SIGNAL_STATUS, ACTIONS } from '../shared/signal.js';
import { notifyTrade, notifyError } from '../shared/report.js';

// ─── 심볼 유효성 ────────────────────────────────────────────────────

const BINANCE_SYMBOL_RE = /^[A-Z0-9]+\/USDT$/;

function isBinanceSymbol(symbol) {
  return BINANCE_SYMBOL_RE.test(symbol);
}

// ─── CCXT 바이낸스 클라이언트 (lazy init) ──────────────────────────

let _exchange = null;

function getExchange() {
  if (_exchange) return _exchange;
  const secrets = loadSecrets();
  _exchange = new ccxt.binance({
    apiKey: secrets.binance_api_key || '',
    secret: secrets.binance_api_secret || '',
    options: { defaultType: 'spot' },
  });
  return _exchange;
}

/**
 * 현재가 조회 (PAPER_MODE에서도 사용)
 */
export async function fetchTicker(symbol) {
  const ex = getExchange();
  const ticker = await ex.fetchTicker(symbol);
  return ticker.last;
}

/**
 * 시장가 매수 (PAPER_MODE: 모의 주문)
 */
async function marketBuy(symbol, amountUsdt, paperMode) {
  if (paperMode) {
    const price  = await fetchTicker(symbol).catch(() => 0);
    const filled = price > 0 ? amountUsdt / price : 0;
    console.log(`  📄 [헤파이스토스] PAPER BUY ${symbol} $${amountUsdt} @ ~$${price?.toLocaleString()}`);
    return { filled, price, dryRun: true };
  }
  const ex = getExchange();
  return await ex.createOrder(symbol, 'market', 'buy', undefined, undefined, { quoteOrderQty: amountUsdt });
}

/**
 * 시장가 매도 (PAPER_MODE: 모의 주문)
 */
async function marketSell(symbol, amount, paperMode) {
  if (paperMode) {
    const price     = await fetchTicker(symbol).catch(() => 0);
    const totalUsdt = amount * price;
    console.log(`  📄 [헤파이스토스] PAPER SELL ${symbol} ${amount} @ ~$${price?.toLocaleString()}`);
    return { amount, price, totalUsdt, dryRun: true };
  }
  const ex = getExchange();
  return await ex.createOrder(symbol, 'market', 'sell', amount);
}

// ─── 신호 실행 ──────────────────────────────────────────────────────

/**
 * 단일 바이낸스 신호 실행
 * @param {object} signal  { id, symbol, action, amountUsdt, confidence, reasoning }
 */
export async function executeSignal(signal) {
  const paperMode  = isPaperMode();
  const { id: signalId, symbol, action } = signal;
  const amountUsdt = signal.amountUsdt || signal.amount_usdt || 100;

  if (!isBinanceSymbol(symbol)) {
    return { success: false, reason: `바이낸스 심볼이 아님: ${symbol}` };
  }

  const tag = paperMode ? '[PAPER]' : '[LIVE]';
  console.log(`\n⚡ [헤파이스토스] ${symbol} ${action} $${amountUsdt} ${tag}`);

  try {
    let trade;

    if (action === ACTIONS.BUY) {
      const order = await marketBuy(symbol, amountUsdt, paperMode);
      trade = {
        signalId,
        symbol,
        side:      'buy',
        amount:    order.filled,
        price:     order.price,
        totalUsdt: amountUsdt,
        paper:     paperMode,
        exchange:  'binance',
      };

      const existing    = await db.getPosition(symbol);
      const newAmount   = (existing?.amount || 0) + (order.filled || 0);
      const newAvgPrice = existing && existing.amount > 0
        ? ((existing.amount * existing.avg_price) + amountUsdt) / newAmount
        : order.price || 0;

      await db.upsertPosition({ symbol, amount: newAmount, avgPrice: newAvgPrice, unrealizedPnl: 0 });

    } else if (action === ACTIONS.SELL) {
      const position = await db.getPosition(symbol);
      const amount   = position?.amount;
      if (!amount || amount <= 0) {
        console.warn(`  ⚠️ ${symbol} 포지션 없음 — SELL 스킵`);
        await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
        return { success: false, reason: '포지션 없음' };
      }

      const order = await marketSell(symbol, amount, paperMode);
      trade = {
        signalId,
        symbol,
        side:      'sell',
        amount:    order.amount || amount,
        price:     order.price,
        totalUsdt: order.totalUsdt,
        paper:     paperMode,
        exchange:  'binance',
      };

      await db.deletePosition(symbol);

    } else {
      console.log(`  ⏸️ HOLD — 실행 없음`);
      await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
      return { success: true };
    }

    await db.insertTrade(trade);
    await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
    await notifyTrade(trade);

    console.log(`  ✅ ${tag} 완료: ${trade.side} ${trade.amount?.toFixed(6)} @ $${trade.price?.toLocaleString()}`);
    return { success: true, trade };

  } catch (e) {
    console.error(`  ❌ 실행 오류: ${e.message}`);
    await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED).catch(() => {});
    await notifyError(`헤파이스토스 - ${symbol} ${action}`, e);
    return { success: false, error: e.message };
  }
}

/**
 * 대기 중인 바이낸스 신호 전체 처리
 */
export async function processAllPendingSignals() {
  const signals = await db.getApprovedSignals('binance');
  if (signals.length === 0) {
    console.log('[헤파이스토스] 대기 신호 없음');
    return [];
  }

  console.log(`[헤파이스토스] ${signals.length}개 신호 처리 시작`);
  const results = [];
  for (const signal of signals) {
    const r = await executeSignal(signal);
    results.push(r);
    await new Promise(res => setTimeout(res, 500));
  }
  return results;
}

// CLI 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args      = process.argv.slice(2);
  const actionArg = args.find(a => a.startsWith('--action='))?.split('=')[1];
  const symbolArg = args.find(a => a.startsWith('--symbol='))?.split('=')[1];
  const amountArg = args.find(a => a.startsWith('--amount='))?.split('=')[1];

  await db.initSchema();
  try {
    let r;
    if (actionArg && symbolArg) {
      r = await executeSignal({
        id:         `CLI-${Date.now()}`,
        symbol:     symbolArg.toUpperCase(),
        action:     actionArg.toUpperCase(),
        amountUsdt: parseFloat(amountArg || '100'),
        confidence: 0.7,
        reasoning:  'CLI 수동 실행',
      });
    } else {
      r = await processAllPendingSignals();
    }
    console.log('완료:', JSON.stringify(r));
    process.exit(0);
  } catch (e) {
    console.error('❌ 헤파이스토스 오류:', e.message);
    process.exit(1);
  }
}
