/**
 * team/hanul.js — 한울 (KIS 실행봇)
 *
 * 역할: 루나가 승인한 신호를 한국투자증권(KIS) API로 실행
 *   - 국내주식 (KOSPI/KOSDAQ, exchange='kis')
 *   - 해외주식 (미국 NYSE/NASDAQ, exchange='kis_overseas')
 * LLM: 없음 (규칙 기반)
 * PAPER_MODE: true → 모의투자 (실주문 없음, DB + 텔레그램만)
 *
 * ⚠️ 업비트는 거래 대상이 아님.
 *    업비트는 KRW↔암호화폐 입출금 게이트웨이 전용 (바이낸스 자금 이동).
 *
 * bots/invest/src/kis-executor.js 패턴 재사용
 *
 * 실행: node team/hanul.js [--symbol=005930] [--action=BUY] [--amount=500000]
 *       node team/hanul.js [--symbol=AAPL] [--action=BUY] [--amount=100]
 */

import { fileURLToPath } from 'url';
import * as db from '../shared/db.js';
import { loadSecrets, isPaperMode, isKisPaper } from '../shared/secrets.js';
import { SIGNAL_STATUS, ACTIONS } from '../shared/signal.js';
import { notifyTrade, notifyError } from '../shared/report.js';

// ─── 심볼 유효성 ────────────────────────────────────────────────────

/** 국내주식 심볼: 6자리 숫자 (예: 005930) */
export function isKisSymbol(symbol) {
  return /^\d{6}$/.test(symbol);
}

/** 해외주식 심볼: 알파벳 1~5자 (예: AAPL, TSLA) */
export function isKisOverseasSymbol(symbol) {
  return /^[A-Z]{1,5}$/.test(symbol);
}

// ─── KIS 리스크 규칙 ─────────────────────────────────────────────────

const KIS_RULES = {
  MIN_ORDER_KRW:   10_000,
  MAX_ORDER_KRW: 5_000_000,
};

const KIS_OVERSEAS_RULES = {
  MIN_ORDER_USD:    10,
  MAX_ORDER_USD: 1_000,
};

async function checkKisRisk(signal) {
  const { action, amount_usdt: amountKrw, symbol } = signal;
  if (!isKisSymbol(symbol)) return { approved: false, reason: `KIS 국내 심볼 아님: ${symbol}` };
  if (action === ACTIONS.HOLD)  return { approved: true };
  if (action === ACTIONS.BUY) {
    if (!amountKrw || amountKrw < KIS_RULES.MIN_ORDER_KRW)
      return { approved: false, reason: `최소 주문금액 미달 (${amountKrw?.toLocaleString()}원)` };
    if (amountKrw > KIS_RULES.MAX_ORDER_KRW)
      return { approved: false, reason: `최대 주문금액 초과 (${amountKrw?.toLocaleString()}원)` };
  }
  if (action === ACTIONS.SELL) {
    const pos = await db.getPosition(symbol);
    if (!pos || pos.amount <= 0) return { approved: false, reason: `${symbol} 포지션 없음` };
  }
  return { approved: true };
}

async function checkKisOverseasRisk(signal) {
  const { action, amount_usdt: amountUsd, symbol } = signal;
  if (!isKisOverseasSymbol(symbol)) return { approved: false, reason: `KIS 해외 심볼 아님: ${symbol}` };
  if (action === ACTIONS.HOLD)   return { approved: true };
  if (action === ACTIONS.BUY) {
    if (!amountUsd || amountUsd < KIS_OVERSEAS_RULES.MIN_ORDER_USD)
      return { approved: false, reason: `최소 주문금액 미달 ($${amountUsd})` };
    if (amountUsd > KIS_OVERSEAS_RULES.MAX_ORDER_USD)
      return { approved: false, reason: `최대 주문금액 초과 ($${amountUsd})` };
  }
  if (action === ACTIONS.SELL) {
    const pos = await db.getPosition(symbol);
    if (!pos || pos.amount <= 0) return { approved: false, reason: `${symbol} 해외 포지션 없음` };
  }
  return { approved: true };
}

// ─── KIS API (lazy load) ─────────────────────────────────────────────

let _kisPromise = null;

/** kis-client.js 동적 로드 (ESM). 실패 시 mock 반환 */
function getKis() {
  if (!_kisPromise) {
    _kisPromise = import('../shared/kis-client.js')
      .then(m => {
        console.log('  ℹ️ [한울] KIS 클라이언트 로드 완료 (kis-client.js)');
        return m;
      })
      .catch(() => {
        console.log('  ⚠️ [한울] KIS 클라이언트 로드 실패 — mock 사용');
        return {
          marketBuy:         async (s, a, dry) => ({ qty: 1, price: a, totalKrw: a, dryRun: true }),
          marketSell:        async (s, q, dry) => ({ qty: q, price: 0, totalKrw: 0, dryRun: true }),
          marketBuyOverseas:  async (s, a, dry) => ({ qty: 1, price: a, totalUsd: a, dryRun: true }),
          marketSellOverseas: async (s, q, dry) => ({ qty: q, price: 0, totalUsd: 0, dryRun: true }),
        };
      });
  }
  return _kisPromise;
}

// ─── 국내주식 신호 실행 ──────────────────────────────────────────────

/**
 * KIS 국내주식 단일 신호 실행
 * @param {object} signal  { id, symbol, action, amount_usdt(=amountKrw), confidence }
 */
export async function executeSignal(signal) {
  const paperMode = isPaperMode();
  const kisPaper  = isKisPaper();
  const { id: signalId, symbol, action, amount_usdt: amountKrw } = signal;

  const tag = paperMode ? '[PAPER]' : kisPaper ? '[모의투자]' : '[실전]';
  console.log(`\n⚡ [한울] ${symbol} ${action} ${amountKrw?.toLocaleString()}원 ${tag}`);

  try {
    const risk = await checkKisRisk(signal);
    if (!risk.approved) {
      console.log(`  ❌ 리스크 거부: ${risk.reason}`);
      await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
      return { success: false, reason: risk.reason };
    }

    const kis = await getKis();
    let trade;

    if (action === ACTIONS.BUY) {
      // paperMode=true → dryRun(API 호출 없음) / false → 모의투자 또는 실전 API 호출
      const order = await kis.marketBuy(symbol, amountKrw, paperMode);
      trade = {
        signalId, symbol, side: 'buy',
        amount:    order.qty,
        price:     order.price,
        totalUsdt: order.totalKrw,
        paper:     paperMode,
        exchange:  'kis',
      };

      const existing    = await db.getPosition(symbol);
      const newQty      = (existing?.amount || 0) + (order.qty || 0);
      const newAvgPrice = existing && existing.amount > 0
        ? ((existing.amount * existing.avg_price) + amountKrw) / newQty
        : order.price || 0;

      await db.upsertPosition({ symbol, amount: newQty, avgPrice: newAvgPrice, unrealizedPnl: 0 });

    } else if (action === ACTIONS.SELL) {
      const position = await db.getPosition(symbol);
      const qty = position?.amount;
      if (!qty || qty < 1) {
        console.warn(`  ⚠️ ${symbol} 포지션 없음 — SELL 스킵`);
        await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
        return { success: false, reason: '포지션 없음' };
      }

      const order = await kis.marketSell(symbol, Math.floor(qty), paperMode);
      trade = {
        signalId, symbol, side: 'sell',
        amount:    order.qty,
        price:     order.price,
        totalUsdt: order.totalKrw,
        paper:     paperMode,
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
    await notifyTrade({ ...trade, currency: 'KRW' });

    console.log(`  ✅ ${tag} 완료: ${trade.side} ${trade.amount}주 @ ${trade.price?.toLocaleString()}원`);
    return { success: true, trade };

  } catch (e) {
    console.error(`  ❌ 실행 오류: ${e.message}`);
    await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED).catch(() => {});
    await notifyError(`한울(KIS) - ${symbol} ${action}`, e);
    return { success: false, error: e.message };
  }
}

// ─── 해외주식 신호 실행 ──────────────────────────────────────────────

/**
 * KIS 해외주식 단일 신호 실행
 * @param {object} signal  { id, symbol, action, amount_usdt(=amountUsd), confidence }
 */
export async function executeOverseasSignal(signal) {
  const paperMode = isPaperMode();
  const kisPaper  = isKisPaper();
  const { id: signalId, symbol, action, amount_usdt: amountUsd } = signal;

  const tag = paperMode ? '[PAPER]' : kisPaper ? '[모의투자]' : '[실전]';
  console.log(`\n⚡ [한울] 해외 ${symbol} ${action} $${amountUsd} ${tag}`);

  try {
    const risk = await checkKisOverseasRisk(signal);
    if (!risk.approved) {
      console.log(`  ❌ 리스크 거부: ${risk.reason}`);
      await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
      return { success: false, reason: risk.reason };
    }

    const kis = await getKis();
    let trade;

    if (action === ACTIONS.BUY) {
      const order = await kis.marketBuyOverseas(symbol, amountUsd, paperMode);
      trade = {
        signalId, symbol, side: 'buy',
        amount:    order.qty,
        price:     order.price,
        totalUsdt: order.totalUsd,
        paper:     paperMode,
        exchange:  'kis_overseas',
      };

      const existing    = await db.getPosition(symbol);
      const newQty      = (existing?.amount || 0) + (order.qty || 0);
      const newAvgPrice = existing && existing.amount > 0
        ? ((existing.amount * existing.avg_price) + amountUsd) / newQty
        : order.price || 0;

      await db.upsertPosition({ symbol, amount: newQty, avgPrice: newAvgPrice, unrealizedPnl: 0 });

    } else if (action === ACTIONS.SELL) {
      const position = await db.getPosition(symbol);
      const qty = position?.amount;
      if (!qty || qty < 1) {
        console.warn(`  ⚠️ ${symbol} 해외 포지션 없음 — SELL 스킵`);
        await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED);
        return { success: false, reason: '해외 포지션 없음' };
      }

      const order = await kis.marketSellOverseas(symbol, Math.floor(qty), paperMode);
      trade = {
        signalId, symbol, side: 'sell',
        amount:    order.qty,
        price:     order.price,
        totalUsdt: order.totalUsd,
        paper:     paperMode,
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
    await notifyTrade({ ...trade, currency: 'USD' });

    console.log(`  ✅ ${tag} 완료: ${trade.side} ${trade.amount}주 @ $${trade.price}`);
    return { success: true, trade };

  } catch (e) {
    console.error(`  ❌ 해외 실행 오류: ${e.message}`);
    await db.updateSignalStatus(signalId, SIGNAL_STATUS.FAILED).catch(() => {});
    await notifyError(`한울(KIS해외) - ${symbol} ${action}`, e);
    return { success: false, error: e.message };
  }
}

/**
 * 대기 중인 KIS 국내주식 신호 전체 처리
 */
export async function processAllPendingKisSignals() {
  const signals = await db.getPendingSignals('kis');
  if (signals.length === 0) { console.log('[한울] 대기 KIS 국내 신호 없음'); return []; }
  console.log(`[한울] ${signals.length}개 KIS 국내 신호 처리 시작`);
  const results = [];
  for (const signal of signals) {
    results.push(await executeSignal(signal));
    await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

/**
 * 대기 중인 KIS 해외주식 신호 전체 처리
 */
export async function processAllPendingKisOverseasSignals() {
  const signals = await db.getPendingSignals('kis_overseas');
  if (signals.length === 0) { console.log('[한울] 대기 KIS 해외 신호 없음'); return []; }
  console.log(`[한울] ${signals.length}개 KIS 해외 신호 처리 시작`);
  const results = [];
  for (const signal of signals) {
    results.push(await executeOverseasSignal(signal));
    await new Promise(r => setTimeout(r, 500));
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
      const sym        = symbolArg.toUpperCase();
      const isOverseas = isKisOverseasSymbol(sym);
      const isDomestic = isKisSymbol(sym);
      if (!isDomestic && !isOverseas) {
        console.error(`❌ KIS 심볼 아님: ${sym} (국내: 6자리 숫자, 해외: 알파벳 1~5자)`);
        process.exit(1);
      }
      const mockSignal = {
        id:          `CLI-HAN-${Date.now()}`,
        symbol:      sym,
        action:      actionArg.toUpperCase(),
        amount_usdt: parseFloat(amountArg || (isOverseas ? '100' : '500000')),
        confidence:  0.7,
        reasoning:   'CLI 수동 실행',
        exchange:    isOverseas ? 'kis_overseas' : 'kis',
      };
      r = isOverseas ? await executeOverseasSignal(mockSignal) : await executeSignal(mockSignal);
    } else {
      const [domestic, overseas] = await Promise.all([
        processAllPendingKisSignals(),
        processAllPendingKisOverseasSignals(),
      ]);
      r = { domestic, overseas };
    }
    console.log('완료:', JSON.stringify(r));
    process.exit(0);
  } catch (e) {
    console.error('❌ 한울 오류:', e.message);
    process.exit(1);
  }
}
