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
import * as journalDb from '../shared/trade-journal-db.js';
import { loadSecrets, isPaperMode } from '../shared/secrets.js';
import { SIGNAL_STATUS, ACTIONS } from '../shared/signal.js';
import { notifyTrade, notifyError, notifyJournalEntry, notifyTradeSkip, notifyCircuitBreaker } from '../shared/report.js';
import { preTradeCheck, calculatePositionSize, getAvailableBalance, getOpenPositions, getDailyPnL, config as cmConfig } from '../shared/capital-manager.js';

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
 * 바이낸스 USDT 가용 잔고 조회 (LU-004: 잔고 부족 알림용)
 */
export async function fetchUsdtBalance() {
  const ex  = getExchange();
  const bal = await ex.fetchBalance();
  return bal.free?.USDT || 0;
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
      // ── 자본 관리 게이트 ────────────────────────────────────────────
      const check = await preTradeCheck(symbol, 'BUY', amountUsdt);
      if (!check.allowed) {
        console.log(`  ⛔ [자본관리] 매매 스킵: ${check.reason}`);
        await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
        await db.run('UPDATE signals SET block_reason = $1 WHERE id = $2', [check.reason, signalId]);
        if (check.circuit) {
          notifyCircuitBreaker({ reason: check.reason, type: check.circuitType }).catch(() => {});
        } else {
          const openPos = await getOpenPositions().catch(() => []);
          notifyTradeSkip({ symbol, action, reason: check.reason, openPositions: openPos.length, maxPositions: cmConfig.max_concurrent_positions }).catch(() => {});
        }
        return { success: false, reason: check.reason };
      }

      // ── 동적 포지션 사이징 ──────────────────────────────────────────
      const slPrice = signal.slPrice || 0;
      const currentPrice = await fetchTicker(symbol).catch(() => 0);
      const sizing  = await calculatePositionSize(symbol, currentPrice, slPrice);
      if (sizing.skip) {
        console.log(`  ⛔ [자본관리] 포지션 크기 부족: ${sizing.reason}`);
        await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
        await db.run('UPDATE signals SET block_reason = $1 WHERE id = $2', [sizing.reason, signalId]);
        notifyTradeSkip({ symbol, action, reason: sizing.reason }).catch(() => {});
        return { success: false, reason: sizing.reason };
      }
      const actualAmount = sizing.size;
      console.log(`  📐 [자본관리] 포지션 ${actualAmount.toFixed(2)} USDT (자본의 ${sizing.capitalPct}% | 리스크 ${sizing.riskPercent}%)`);

      const order = await marketBuy(symbol, actualAmount, paperMode);
      trade = {
        signalId,
        symbol,
        side:      'buy',
        amount:    order.filled,
        price:     order.price,
        totalUsdt: actualAmount,
        paper:     paperMode,
        exchange:  'binance',
      };

      const existing    = await db.getPosition(symbol);
      const newAmount   = (existing?.amount || 0) + (order.filled || 0);
      const newAvgPrice = existing && existing.amount > 0
        ? ((existing.amount * existing.avg_price) + amountUsdt) / newAmount
        : order.price || 0;

      await db.upsertPosition({ symbol, amount: newAmount, avgPrice: newAvgPrice, unrealizedPnl: 0 });

      // ── TP/SL 가격 결정 (동적/고정, PAPER_MODE 포함) ────────────────
      // 우선순위: 1) 네메시스 동적 TP/SL (signal.tpPrice/slPrice, applied=true)
      //           2) 고정 TP +6%, SL -3% 폴백
      const fillPrice = order.price || order.average || 0;
      if (fillPrice > 0 && order.filled > 0) {
        const hasDynamic  = !!(signal.tpPrice && signal.slPrice);
        trade.tpPrice     = hasDynamic
          ? parseFloat(signal.tpPrice.toFixed(2))
          : parseFloat((fillPrice * 1.06).toFixed(2));
        trade.slPrice     = hasDynamic
          ? parseFloat(signal.slPrice.toFixed(2))
          : parseFloat((fillPrice * 0.97).toFixed(2));
        trade.tpslSource  = hasDynamic ? (signal.tpslSource || 'atr') : 'fixed';
        const tpslTag     = hasDynamic ? '[동적 TP/SL]' : '[고정 TP/SL]';
        console.log(`  📐 ${tpslTag} TP=${trade.tpPrice} SL=${trade.slPrice} (${trade.tpslSource})`);

        // OCO 주문은 실투자 모드에서만 거래소에 실제 전송
        if (!paperMode) {
          try {
            const ex      = getExchange();
            const slLimit = parseFloat((trade.slPrice * 0.999).toFixed(2));
            const ocoOrder = await ex.createOrder(symbol, 'oco_sell', 'sell', order.filled, trade.tpPrice, {
              stopPrice:            trade.slPrice,
              stopLimitPrice:       slLimit,
              stopLimitTimeInForce: 'GTC',
            });
            // Binance OCO 응답: orderReports[0]=LIMIT_MAKER(TP), [1]=STOP_LOSS_LIMIT(SL)
            trade.tpOrderId = ocoOrder?.info?.orderReports?.[0]?.orderId?.toString() ?? null;
            trade.slOrderId = ocoOrder?.info?.orderReports?.[1]?.orderId?.toString() ?? null;
            trade.tpSlSet   = true;
            console.log(`  🛡️ TP/SL OCO 설정 완료: TP=${trade.tpPrice} SL=${trade.slPrice}`);
          } catch (tpslErr) {
            console.error(`  ⚠️ TP/SL 설정 실패: ${tpslErr.message}`);
            trade.tpSlSet = false;
            await notifyError(`헤파이스토스 TP/SL 설정 실패 — ${symbol}`, tpslErr);
          }
        }
      }

    } else if (action === ACTIONS.SELL) {
      // DB 포지션 우선, 없으면 실제 바이낸스 잔고 조회 (외부 매수 코인도 매도 가능)
      const position = await db.getPosition(symbol);
      let amount = position?.amount;
      if (!amount || amount <= 0) {
        const base = symbol.split('/')[0];
        const bal  = await getExchange().fetchBalance();
        amount = bal.free[base] || 0;
        if (amount <= 0) {
          console.warn(`  ⚠️ ${symbol} 보유량 없음 (DB+바이낸스 모두 0) — SELL 스킵`);
          await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
          return { success: false, reason: '보유량 없음' };
        }
        console.log(`  ℹ️ DB 포지션 없음 → 바이낸스 실잔고 사용: ${amount} ${base}`);
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

    // 자본 관리 정보 포함 알림
    const [curBalance, curPositions, curDailyPnl] = await Promise.all([
      getAvailableBalance().catch(() => null),
      getOpenPositions().catch(() => []),
      getDailyPnL().catch(() => null),
    ]);
    await notifyTrade({
      ...trade,
      capitalInfo: {
        balance:       curBalance,
        openPositions: curPositions.length,
        maxPositions:  cmConfig.max_concurrent_positions,
        dailyPnL:      curDailyPnl,
      },
    });

    // ── 매매일지 기록 (기존 기능에 영향 없도록 try-catch 감쌈) ────────
    try {
      if (trade.side === 'buy') {
        const execTime = Date.now();
        const tradeId  = await journalDb.generateTradeId();
        await journalDb.insertJournalEntry({
          trade_id:      tradeId,
          signal_id:     signalId,
          market:        'crypto',
          exchange:      trade.exchange,
          symbol:        trade.symbol,
          is_paper:      trade.paper,
          entry_time:    execTime,
          entry_price:   trade.price || 0,
          entry_size:    trade.amount || 0,
          entry_value:   trade.totalUsdt || 0,
          direction:     'long',
          tp_price:      trade.tpPrice ?? null,
          sl_price:      trade.slPrice ?? null,
          tp_order_id:   trade.tpOrderId ?? null,
          sl_order_id:   trade.slOrderId ?? null,
          tp_sl_set:     trade.tpSlSet ?? false,
        });
        await journalDb.linkRationaleToTrade(tradeId, signalId);
        notifyJournalEntry({
          tradeId,
          symbol:    trade.symbol,
          direction: 'long',
          market:    'crypto',
          entryPrice: trade.price,
          entryValue: trade.totalUsdt,
          isPaper:   trade.paper,
          tpPrice:   trade.tpPrice,
          slPrice:   trade.slPrice,
          tpSlSet:   trade.tpSlSet,
        });
      } else if (trade.side === 'sell') {
        // 열린 일지 항목 찾아서 청산 처리
        const openEntries = await journalDb.getOpenJournalEntries('crypto');
        const entry = openEntries.find(e => e.symbol === trade.symbol);
        if (entry) {
          const pnlAmount  = (trade.totalUsdt || 0) - (entry.entry_value || 0);
          const pnlPercent = entry.entry_value > 0 ? pnlAmount / entry.entry_value : null;
          await journalDb.closeJournalEntry(entry.trade_id, {
            exitPrice:  trade.price,
            exitValue:  trade.totalUsdt,
            exitReason: 'signal_reverse',
            pnlAmount,
            pnlPercent,
          });
        }
      }
    } catch (journalErr) {
      console.warn(`  ⚠️ 매매일지 기록 실패 (거래는 정상 완료): ${journalErr.message}`);
    }

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
