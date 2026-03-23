/**
 * team/hanul.js — 한울 (KIS 실행봇)
 *
 * 역할: 루나가 승인한 신호를 한국투자증권(KIS) API로 실행
 *   - 국내주식 (KOSPI/KOSDAQ, exchange='kis')
 *   - 해외주식 (미국 NYSE/NASDAQ, exchange='kis_overseas')
 * LLM: 없음 (규칙 기반)
 * executionMode / brokerAccountMode 기준:
 *   - PAPER_MODE=true  → executionMode=paper (실제 주문 차단)
 *   - PAPER_MODE=false → executionMode=live  (브로커 계좌로 주문 실행)
 *   - kis.paper_trading=true  → brokerAccountMode=mock
 *   - kis.paper_trading=false → brokerAccountMode=real
 *
 * ⚠️ 업비트는 거래 대상이 아님.
 *    업비트는 KRW↔암호화폐 입출금 게이트웨이 전용 (바이낸스 자금 이동).
 *
 * bots/invest/src/kis-executor.js 패턴 재사용
 *
 * 실행: node team/hanul.js [--symbol=005930] [--action=BUY] [--amount=500000]
 *       node team/hanul.js [--symbol=AAPL] [--action=BUY] [--amount=400]
 */

import { fileURLToPath } from 'url';
import * as db from '../shared/db.js';
import * as journalDb from '../shared/trade-journal-db.js';
import { loadSecrets, isPaperMode, isKisPaper, getInvestmentTradeMode } from '../shared/secrets.js';
import { isSameDaySymbolReentryBlockEnabled } from '../shared/runtime-config.js';
import { SIGNAL_STATUS, ACTIONS } from '../shared/signal.js';
import { notifyTrade, notifyError, notifyJournalEntry, notifyKisSignal, notifyKisOverseasSignal, notifySettlement } from '../shared/report.js';
import pgPool from '../../../packages/core/lib/pg-pool.js';

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
  MIN_ORDER_KRW:   200_000,
  MAX_ORDER_KRW: 1_200_000,
};

const KIS_OVERSEAS_RULES = {
  MIN_ORDER_USD:   300,
  MAX_ORDER_USD: 1_200,
};

function getInvestmentPoolStats() {
  try {
    return pgPool.getPoolStats('investment');
  } catch {
    return null;
  }
}

function logHanulPhase(label, startedAt, extra = {}) {
  const elapsedMs = Date.now() - startedAt;
  const pool = getInvestmentPoolStats();
  const payload = {
    elapsed_ms: elapsedMs,
    pool,
    ...extra,
  };
  console.log(`[한울] ${label} ${JSON.stringify(payload)}`);
}

async function markSignalFailed(signalId, reason) {
  return markSignalFailedDetailed(signalId, { reason });
}

function inferHanulBlockCode(reason = '', market = 'domestic') {
  if (!reason) return market === 'overseas' ? 'overseas_order_rejected' : 'domestic_order_rejected';
  if (reason.includes('최소 주문금액 미달')) return 'min_order_notional';
  if (reason.includes('최대 주문금액 초과')) return 'max_order_notional';
  if (reason.includes('포지션 없음')) return 'missing_position';
  if (reason.includes('심볼 아님')) return 'invalid_symbol';
  return market === 'overseas' ? 'overseas_order_rejected' : 'domestic_order_rejected';
}

async function markSignalFailedDetailed(signalId, {
  reason = null,
  code = null,
  market = 'domestic',
  symbol = null,
  action = null,
  amount = null,
  error = null,
} = {}) {
  const normalizedReason = reason ? String(reason).slice(0, 180) : null;
  await db.updateSignalBlock(signalId, {
    status: SIGNAL_STATUS.FAILED,
    reason: normalizedReason,
    code: code || inferHanulBlockCode(normalizedReason || '', market),
    meta: {
      market,
      symbol,
      action,
      amount,
      error: error ? String(error).slice(0, 240) : null,
    },
  }).catch(() => {});
}

async function closeOpenJournalForSymbol(symbol, market, isPaper, exitPrice, exitValue, exitReason) {
  const openEntries = await journalDb.getOpenJournalEntries(market);
  const entry = openEntries.find(e => e.symbol === symbol && Boolean(e.is_paper) === Boolean(isPaper));
  if (!entry) return;

  const pnlAmount = (exitValue || 0) - (entry.entry_value || 0);
  const pnlPercent = entry.entry_value > 0
    ? journalDb.ratioToPercent(pnlAmount / entry.entry_value)
    : null;
  await journalDb.closeJournalEntry(entry.trade_id, {
    exitPrice,
    exitValue,
    exitReason,
    pnlAmount,
    pnlPercent,
    pnlNet: pnlAmount,
  });
  await journalDb.ensureAutoReview(entry.trade_id).catch(() => {});
  const review = await journalDb.getReviewByTradeId(entry.trade_id).catch(() => null);
  const exchange = market === 'domestic' ? 'kis' : 'kis_overseas';
  const weekly = await db.get(`
    SELECT
      COALESCE(SUM(pnl_net), 0) AS pnl,
      COUNT(*) AS total_trades,
      COUNT(*) FILTER (WHERE pnl_net > 0) AS wins
    FROM trade_journal
    WHERE exchange = ?
      AND status = 'closed'
      AND exit_time IS NOT NULL
      AND exit_time >= ?
  `, [exchange, Date.now() - 7 * 24 * 60 * 60 * 1000]).catch(() => null);
  const settledAt = Date.now();
  const holdHours = entry.entry_time ? Math.max(0, ((settledAt - Number(entry.entry_time)) / 3600000)) : null;
  await notifySettlement({
    symbol,
    side: 'buy',
    market,
    entryPrice: entry.entry_price,
    exitPrice,
    pnl: pnlAmount,
    pnlPercent,
    holdDuration: holdHours != null ? `${holdHours.toFixed(1)}시간` : null,
    weeklyPnl: weekly?.pnl != null ? Number(weekly.pnl) : null,
    totalTrades: weekly?.total_trades != null ? Number(weekly.total_trades) : null,
    wins: weekly?.wins != null ? Number(weekly.wins) : null,
    winRate: weekly?.total_trades ? Number(weekly.wins || 0) / Number(weekly.total_trades) : null,
    paper: isPaper,
    maxFavorable: review?.max_favorable ?? null,
    maxAdverse: review?.max_adverse ?? null,
    signalAccuracy: review?.signal_accuracy ?? null,
    executionSpeed: review?.execution_speed ?? null,
  }).catch(() => {});
}

async function checkKisRisk(signal) {
  const { action, amount_usdt: amountKrw, symbol } = signal;
  const signalTradeMode = signal.trade_mode || getInvestmentTradeMode();
  if (!isKisSymbol(symbol)) return { approved: false, reason: `KIS 국내 심볼 아님: ${symbol}` };
  if (action === ACTIONS.HOLD)  return { approved: true };
  if (action === ACTIONS.BUY) {
    if (!amountKrw || amountKrw < KIS_RULES.MIN_ORDER_KRW)
      return { approved: false, reason: `최소 주문금액 미달 (${amountKrw?.toLocaleString()}원)` };
    if (amountKrw > KIS_RULES.MAX_ORDER_KRW)
      return { approved: false, reason: `최대 주문금액 초과 (${amountKrw?.toLocaleString()}원)` };
    try {
      const kis = await getKis();
      if (typeof kis.getDomesticPrice === 'function') {
        const currentPrice = Number(await kis.getDomesticPrice(symbol, isKisPaper()));
        if (!(currentPrice > 0)) {
          return { approved: false, reason: `${symbol} 국내 현재가 0원 응답 — 거래불가 종목으로 판단` };
        }
        if (amountKrw < currentPrice) {
          return {
            approved: false,
            reason: `1주 가격 미달 (${amountKrw?.toLocaleString()}원 < ${currentPrice.toLocaleString()}원)`,
          };
        }
      }
    } catch (e) {
      return {
        approved: false,
        reason: `${symbol} 국내 현재가 사전검증 실패 — ${e.message}`,
      };
    }
  }
  if (action === ACTIONS.SELL) {
    const pos = await db.getLivePosition(symbol, 'kis')
      || await db.getPaperPosition(symbol, 'kis', signalTradeMode);
    if (!pos || pos.amount <= 0) return { approved: false, reason: `${symbol} 포지션 없음` };
  }
  return { approved: true };
}

async function checkKisOverseasRisk(signal) {
  const { action, amount_usdt: amountUsd, symbol } = signal;
  const signalTradeMode = signal.trade_mode || getInvestmentTradeMode();
  if (!isKisOverseasSymbol(symbol)) return { approved: false, reason: `KIS 해외 심볼 아님: ${symbol}` };
  if (action === ACTIONS.HOLD)   return { approved: true };
  if (action === ACTIONS.BUY) {
    if (!amountUsd || amountUsd < KIS_OVERSEAS_RULES.MIN_ORDER_USD)
      return { approved: false, reason: `최소 주문금액 미달 ($${amountUsd})` };
    if (amountUsd > KIS_OVERSEAS_RULES.MAX_ORDER_USD)
      return { approved: false, reason: `최대 주문금액 초과 ($${amountUsd})` };
    try {
      const kis = await getKis();
      if (typeof kis.getOverseasQuote === 'function') {
        const quote = await kis.getOverseasQuote(symbol);
        const currentPrice = Number(quote?.price || 0);
        if (currentPrice > 0 && amountUsd < currentPrice) {
          return {
            approved: false,
            reason: `1주 가격 미달 ($${amountUsd} < $${currentPrice.toFixed(2)})`,
          };
        }
      }
    } catch (e) {
      console.warn(`  ⚠️ [한울] 해외 현재가 사전검증 실패 (${symbol}): ${e.message}`);
    }
  }
  if (action === ACTIONS.SELL) {
    const pos = await db.getLivePosition(symbol, 'kis_overseas')
      || await db.getPaperPosition(symbol, 'kis_overseas', signalTradeMode);
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
  const signalTradeMode = signal.trade_mode || getInvestmentTradeMode();
  const exitReasonOverride = signal.exit_reason_override || null;

  const tag = paperMode ? '[PAPER]' : kisPaper ? '[LIVE/MOCK]' : '[LIVE/REAL]';
  console.log(`\n⚡ [한울] ${symbol} ${action} ${amountKrw?.toLocaleString()}원 ${tag}`);

  try {
    const risk = await checkKisRisk(signal);
    if (!risk.approved) {
      console.log(`  ❌ 리스크 거부: ${risk.reason}`);
      await markSignalFailedDetailed(signalId, {
        reason: risk.reason,
        market: 'domestic',
        symbol,
        action,
        amount: amountKrw,
      });
      return { success: false, reason: risk.reason };
    }

    // 신호 알람 (BUY/SELL만, HOLD 제외)
    if (action !== ACTIONS.HOLD) {
      notifyKisSignal({ symbol, action, amountKrw, confidence: signal.confidence, reasoning: signal.reasoning, paper: paperMode || kisPaper });
    }

    const kis = await getKis();
    let trade;

    if (action === ACTIONS.BUY) {
      const livePosition = await db.getLivePosition(symbol, 'kis');
      const paperPosition = await db.getPaperPosition(symbol, 'kis', signalTradeMode);
      const sameDayBuyTrade = isSameDaySymbolReentryBlockEnabled()
        ? await db.getSameDayTrade({ symbol, side: 'buy', exchange: 'kis', tradeMode: signalTradeMode })
        : null;

      if (paperMode && livePosition) {
        const reason = '실포지션 보유 중에는 PAPER 추가매수로 혼합 포지션을 만들 수 없음';
        console.warn(`  ⚠️ ${reason}`);
        await markSignalFailedDetailed(signalId, {
          reason,
          code: 'position_mode_conflict',
          market: 'domestic',
          symbol,
          action,
          amount: amountKrw,
        });
        return { success: false, reason };
      }
      if (paperMode && paperPosition) {
        const reason = `동일 ${signalTradeMode.toUpperCase()} PAPER 포지션 보유 중 — 추가매수 차단`;
        console.warn(`  ⚠️ ${reason}`);
        await markSignalFailedDetailed(signalId, {
          reason,
          code: 'paper_position_reentry_blocked',
          market: 'domestic',
          symbol,
          action,
          amount: amountKrw,
        });
        return { success: false, reason };
      }
      if (!paperMode && livePosition) {
        const reason = '동일 LIVE 포지션 보유 중 — 추가매수 차단';
        console.warn(`  ⚠️ ${reason}`);
        await markSignalFailedDetailed(signalId, {
          reason,
          code: 'live_position_reentry_blocked',
          market: 'domestic',
          symbol,
          action,
          amount: amountKrw,
        });
        return { success: false, reason };
      }
      if (!livePosition && !paperPosition && sameDayBuyTrade) {
        const reason = `동일 ${signalTradeMode.toUpperCase()} 심볼 당일 재진입 차단`;
        console.warn(`  ⚠️ ${reason}`);
        await markSignalFailedDetailed(signalId, {
          reason,
          code: 'same_day_reentry_blocked',
          market: 'domestic',
          symbol,
          action,
          amount: amountKrw,
        });
        return { success: false, reason };
      }

      // paperMode=true → dryRun(API 호출 없음) / false → brokerAccountMode(mock/real)에 따라 실제 주문 API 호출
      const order = await kis.marketBuy(symbol, amountKrw, paperMode);
      trade = {
        signalId, symbol, side: 'buy',
        amount:    order.qty,
        price:     order.price,
        totalUsdt: order.totalKrw,
        paper:     paperMode,
        exchange:  'kis',
        tradeMode: signalTradeMode,
      };

      await db.upsertPosition({
        symbol,
        amount: order.qty || 0,
        avgPrice: order.price || 0,
        unrealizedPnl: 0,
        exchange: 'kis',
        paper: paperMode,
        tradeMode: signalTradeMode,
      });

      try {
        const execTime = Date.now();
        const tradeId = await journalDb.generateTradeId();
        await journalDb.insertJournalEntry({
          trade_id: tradeId,
          signal_id: signalId,
          market: 'domestic',
          exchange: 'kis',
          symbol,
          is_paper: paperMode,
          entry_time: execTime,
          entry_price: trade.price || 0,
          entry_size: trade.amount || 0,
          entry_value: trade.totalUsdt || 0,
          direction: 'long',
        });
        await journalDb.linkRationaleToTrade(tradeId, signalId).catch(() => {});
        notifyJournalEntry({
          tradeId,
          symbol,
          direction: 'long',
          market: 'domestic',
          entryPrice: trade.price,
          entryValue: trade.totalUsdt,
          isPaper: paperMode,
          confidence: signal.confidence,
          reasoning: signal.reasoning,
        });
      } catch (journalErr) {
        console.warn(`  ⚠️ 국내주식 매매일지 기록 실패: ${journalErr.message}`);
      }

    } else if (action === ACTIONS.SELL) {
      const livePosition = await db.getLivePosition(symbol, 'kis');
      const paperPosition = await db.getPaperPosition(symbol, 'kis', signalTradeMode);
      const position = livePosition || paperPosition;
      const sellPaperMode = !livePosition && !!paperPosition;
      const qty = position?.amount;
      if (!qty || qty < 1) {
        console.warn(`  ⚠️ ${symbol} 포지션 없음 — SELL 스킵`);
        await markSignalFailedDetailed(signalId, {
          reason: '포지션 없음',
          market: 'domestic',
          symbol,
          action,
          amount: amountKrw,
        });
        return { success: false, reason: '포지션 없음' };
      }

      const order = await kis.marketSell(symbol, Math.floor(qty), paperMode);
      trade = {
        signalId, symbol, side: 'sell',
        amount:    order.qty,
        price:     order.price,
        totalUsdt: order.totalKrw,
        paper:     sellPaperMode,
        exchange:  'kis',
        tradeMode: sellPaperMode ? signalTradeMode : null,
      };

      await db.deletePosition(symbol, {
        exchange: 'kis',
        paper: sellPaperMode,
        tradeMode: sellPaperMode ? signalTradeMode : null,
      });
      await closeOpenJournalForSymbol(symbol, 'domestic', sellPaperMode, trade.price, trade.totalUsdt, exitReasonOverride || 'sell').catch(() => {});

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
    await markSignalFailedDetailed(signalId, {
      reason: e.message,
      market: 'domestic',
      symbol,
      action,
      amount: amountKrw,
      error: e.message,
    });
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
  const signalTradeMode = signal.trade_mode || getInvestmentTradeMode();
  const exitReasonOverride = signal.exit_reason_override || null;

  const tag = paperMode ? '[PAPER]' : kisPaper ? '[LIVE/MOCK]' : '[LIVE/REAL]';
  console.log(`\n⚡ [한울] 해외 ${symbol} ${action} $${amountUsd} ${tag}`);

  try {
    const risk = await checkKisOverseasRisk(signal);
    if (!risk.approved) {
      console.log(`  ❌ 리스크 거부: ${risk.reason}`);
      await markSignalFailedDetailed(signalId, {
        reason: risk.reason,
        market: 'overseas',
        symbol,
        action,
        amount: amountUsd,
      });
      return { success: false, reason: risk.reason };
    }

    // 신호 알람 (BUY/SELL만, HOLD 제외)
    if (action !== ACTIONS.HOLD) {
      notifyKisOverseasSignal({ symbol, action, amountUsdt: amountUsd, confidence: signal.confidence, reasoning: signal.reasoning, paper: paperMode || kisPaper });
    }

    const kis = await getKis();
    let trade;

    if (action === ACTIONS.BUY) {
      const livePosition = await db.getLivePosition(symbol, 'kis_overseas');
      const paperPosition = await db.getPaperPosition(symbol, 'kis_overseas', signalTradeMode);
      const sameDayBuyTrade = isSameDaySymbolReentryBlockEnabled()
        ? await db.getSameDayTrade({ symbol, side: 'buy', exchange: 'kis_overseas', tradeMode: signalTradeMode })
        : null;

      if (paperMode && livePosition) {
        const reason = '실포지션 보유 중에는 PAPER 추가매수로 혼합 포지션을 만들 수 없음';
        console.warn(`  ⚠️ ${reason}`);
        await markSignalFailedDetailed(signalId, {
          reason,
          code: 'position_mode_conflict',
          market: 'overseas',
          symbol,
          action,
          amount: amountUsd,
        });
        return { success: false, reason };
      }
      if (paperMode && paperPosition) {
        const reason = `동일 ${signalTradeMode.toUpperCase()} PAPER 포지션 보유 중 — 추가매수 차단`;
        console.warn(`  ⚠️ ${reason}`);
        await markSignalFailedDetailed(signalId, {
          reason,
          code: 'paper_position_reentry_blocked',
          market: 'overseas',
          symbol,
          action,
          amount: amountUsd,
        });
        return { success: false, reason };
      }
      if (!paperMode && livePosition) {
        const reason = '동일 LIVE 포지션 보유 중 — 추가매수 차단';
        console.warn(`  ⚠️ ${reason}`);
        await markSignalFailedDetailed(signalId, {
          reason,
          code: 'live_position_reentry_blocked',
          market: 'overseas',
          symbol,
          action,
          amount: amountUsd,
        });
        return { success: false, reason };
      }
      if (!livePosition && !paperPosition && sameDayBuyTrade) {
        const reason = `동일 ${signalTradeMode.toUpperCase()} 심볼 당일 재진입 차단`;
        console.warn(`  ⚠️ ${reason}`);
        await markSignalFailedDetailed(signalId, {
          reason,
          code: 'same_day_reentry_blocked',
          market: 'overseas',
          symbol,
          action,
          amount: amountUsd,
        });
        return { success: false, reason };
      }

      const order = await kis.marketBuyOverseas(symbol, amountUsd, paperMode);
      trade = {
        signalId, symbol, side: 'buy',
        amount:    order.qty,
        price:     order.price,
        totalUsdt: order.totalUsd,
        paper:     paperMode,
        exchange:  'kis_overseas',
        tradeMode: signalTradeMode,
      };

      await db.upsertPosition({
        symbol,
        amount: order.qty || 0,
        avgPrice: order.price || 0,
        unrealizedPnl: 0,
        exchange: 'kis_overseas',
        paper: paperMode,
        tradeMode: signalTradeMode,
      });

      try {
        const execTime = Date.now();
        const tradeId = await journalDb.generateTradeId();
        await journalDb.insertJournalEntry({
          trade_id: tradeId,
          signal_id: signalId,
          market: 'overseas',
          exchange: 'kis_overseas',
          symbol,
          is_paper: paperMode,
          entry_time: execTime,
          entry_price: trade.price || 0,
          entry_size: trade.amount || 0,
          entry_value: trade.totalUsdt || 0,
          direction: 'long',
        });
        await journalDb.linkRationaleToTrade(tradeId, signalId).catch(() => {});
        notifyJournalEntry({
          tradeId,
          symbol,
          direction: 'long',
          market: 'overseas',
          entryPrice: trade.price,
          entryValue: trade.totalUsdt,
          isPaper: paperMode,
          confidence: signal.confidence,
          reasoning: signal.reasoning,
        });
      } catch (journalErr) {
        console.warn(`  ⚠️ 해외주식 매매일지 기록 실패: ${journalErr.message}`);
      }

    } else if (action === ACTIONS.SELL) {
      const livePosition = await db.getLivePosition(symbol, 'kis_overseas');
      const paperPosition = await db.getPaperPosition(symbol, 'kis_overseas', signalTradeMode);
      const position = livePosition || paperPosition;
      const sellPaperMode = !livePosition && !!paperPosition;
      const qty = position?.amount;
      if (!qty || qty < 1) {
        console.warn(`  ⚠️ ${symbol} 해외 포지션 없음 — SELL 스킵`);
        await markSignalFailedDetailed(signalId, {
          reason: '해외 포지션 없음',
          market: 'overseas',
          symbol,
          action,
          amount: amountUsd,
        });
        return { success: false, reason: '해외 포지션 없음' };
      }

      const order = await kis.marketSellOverseas(symbol, Math.floor(qty), paperMode);
      trade = {
        signalId, symbol, side: 'sell',
        amount:    order.qty,
        price:     order.price,
        totalUsdt: order.totalUsd,
        paper:     sellPaperMode,
        exchange:  'kis_overseas',
        tradeMode: sellPaperMode ? signalTradeMode : null,
      };

      await db.deletePosition(symbol, {
        exchange: 'kis_overseas',
        paper: sellPaperMode,
        tradeMode: sellPaperMode ? signalTradeMode : null,
      });
      await closeOpenJournalForSymbol(symbol, 'overseas', sellPaperMode, trade.price, trade.totalUsdt, exitReasonOverride || 'sell').catch(() => {});

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
    await markSignalFailedDetailed(signalId, {
      reason: e.message,
      market: 'overseas',
      symbol,
      action,
      amount: amountUsd,
      error: e.message,
    });
    await notifyError(`한울(KIS해외) - ${symbol} ${action}`, e);
    return { success: false, error: e.message };
  }
}

/**
 * 대기 중인 KIS 국내주식 신호 전체 처리
 */
export async function processAllPendingKisSignals() {
  const startedAt = Date.now();
  const tradeMode = getInvestmentTradeMode();
  console.log(`[한울] KIS 국내 pending 조회 시작 ${JSON.stringify({ pool: getInvestmentPoolStats() })}`);
  const signals = await db.getPendingSignals('kis', tradeMode);
  logHanulPhase('KIS 국내 pending 조회 완료', startedAt, { signal_count: signals.length, trade_mode: tradeMode });
  if (signals.length === 0) { console.log(`[한울] 대기 KIS 국내 신호 없음 (trade_mode=${tradeMode})`); return []; }
  console.log(`[한울] ${signals.length}개 KIS 국내 신호 처리 시작 (trade_mode=${tradeMode})`);
  const results = [];
  for (const signal of signals) {
    const signalStartedAt = Date.now();
    results.push(await executeSignal(signal));
    logHanulPhase(`KIS 국내 신호 처리 완료 ${signal.symbol}`, signalStartedAt, {
      signal_id: signal.id,
      action: signal.action,
    });
    await new Promise(r => setTimeout(r, 500));
  }
  logHanulPhase('KIS 국내 pending 전체 처리 완료', startedAt, {
    signal_count: signals.length,
    success_count: results.filter(r => r?.success).length,
  });
  return results;
}

/**
 * 대기 중인 KIS 해외주식 신호 전체 처리
 */
export async function processAllPendingKisOverseasSignals() {
  const startedAt = Date.now();
  const tradeMode = getInvestmentTradeMode();
  console.log(`[한울] KIS 해외 pending 조회 시작 ${JSON.stringify({ pool: getInvestmentPoolStats() })}`);
  const signals = await db.getPendingSignals('kis_overseas', tradeMode);
  logHanulPhase('KIS 해외 pending 조회 완료', startedAt, { signal_count: signals.length, trade_mode: tradeMode });
  if (signals.length === 0) { console.log(`[한울] 대기 KIS 해외 신호 없음 (trade_mode=${tradeMode})`); return []; }
  console.log(`[한울] ${signals.length}개 KIS 해외 신호 처리 시작 (trade_mode=${tradeMode})`);
  const results = [];
  for (const signal of signals) {
    const signalStartedAt = Date.now();
    results.push(await executeOverseasSignal(signal));
    logHanulPhase(`KIS 해외 신호 처리 완료 ${signal.symbol}`, signalStartedAt, {
      signal_id: signal.id,
      action: signal.action,
    });
    await new Promise(r => setTimeout(r, 500));
  }
  logHanulPhase('KIS 해외 pending 전체 처리 완료', startedAt, {
    signal_count: signals.length,
    success_count: results.filter(r => r?.success).length,
  });
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
        amount_usdt: parseFloat(amountArg || (isOverseas ? '400' : '500000')),
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
