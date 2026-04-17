// @ts-nocheck
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
 *   - kis_mode=paper → brokerAccountMode=mock
 *   - kis_mode=live  → brokerAccountMode=real
 *
 * ⚠️ 업비트는 거래 대상이 아님.
 *    업비트는 KRW↔암호화폐 입출금 게이트웨이 전용 (바이낸스 자금 이동).
 *
 * bots/invest/src/kis-executor.js 패턴 재사용
 *
 * 실행: node team/hanul.js [--symbol=005930] [--action=BUY] [--amount=500000]
 *       node team/hanul.js [--symbol=AAPL] [--action=BUY] [--amount=400]
 */

import * as db from '../shared/db.ts';
import * as journalDb from '../shared/trade-journal-db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  isPaperMode,
  isKisPaper,
  getInvestmentTradeMode,
  getKisMarketStatus,
  getKisOverseasMarketStatus,
} from '../shared/secrets.ts';
import { getMockUntradableSymbolCooldownMinutes, isSameDaySymbolReentryBlockEnabled } from '../shared/runtime-config.ts';
import { SIGNAL_STATUS, ACTIONS } from '../shared/signal.ts';
import { notifyTrade, notifyError, notifyJournalEntry, notifyKisSignal, notifyKisOverseasSignal, notifySettlement } from '../shared/report.ts';
import { getDynamicMinOrderAmount } from '../shared/capital-manager.ts';
import { getMarketOrderRule } from '../shared/order-rules.ts';
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
  MIN_ORDER_KRW: getMarketOrderRule('kis')?.minOrderAmount ?? 200_000,
  MAX_ORDER_KRW: getMarketOrderRule('kis')?.maxOrderAmount ?? 1_200_000,
};

const KIS_ORDER_CASH_BUFFER_KRW = 10_000;

const KIS_OVERSEAS_RULES = {
  MIN_ORDER_USD: getMarketOrderRule('kis_overseas')?.minOrderAmount ?? 200,
  MAX_ORDER_USD: getMarketOrderRule('kis_overseas')?.maxOrderAmount ?? 1_200,
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

async function failHanulSignal(signalId, {
  reason,
  code = null,
  market = 'domestic',
  symbol = null,
  action = null,
  amount = null,
  error = null,
} = {}) {
  await markSignalFailedDetailed(signalId, {
    reason,
    code,
    market,
    symbol,
    action,
    amount,
    error,
  });
  return { success: false, reason: reason || error || null, error: error || null };
}

async function enforceHanulNemesisApproval(signal, market = 'domestic') {
  const paperMode = isPaperMode();
  const { id: signalId, symbol, action } = signal;

  if (action === ACTIONS.SELL || paperMode) return { approved: true };

  const nemesisVerdict = signal.nemesis_verdict || signal.nemesisVerdict;
  const isApproved = ['approved', 'modified'].includes(String(nemesisVerdict || '').toLowerCase());
  const marketPrefix = market === 'overseas' ? 'sec015_overseas' : 'sec015';

  if (!isApproved) {
    const reason = `SEC-015: 네메시스 승인 없는 ${market} BUY signal 실행 차단 (verdict=${nemesisVerdict || 'null'})`;
    console.error(`  🛡️ [한울] ${reason}`);
    if (signalId) {
      await db.updateSignalBlock(signalId, {
        status: SIGNAL_STATUS.FAILED,
        reason: reason.slice(0, 180),
        code: `${marketPrefix}_nemesis_bypass_guard`,
        meta: {
          market,
          symbol,
          action,
          nemesis_verdict: nemesisVerdict || null,
          execution_blocked_by: 'hanul_entry_guard',
        },
      }).catch(() => {});
    }
    return failHanulSignal(signalId, {
      reason,
      code: `${marketPrefix}_nemesis_bypass_guard`,
      market,
      symbol,
      action,
      amount: signal.amount_usdt,
    });
  }

  if (signal.approved_at) {
    const ageMs = Date.now() - new Date(signal.approved_at).getTime();
    if (ageMs > 5 * 60 * 1000) {
      const reason = `SEC-015: 승인 후 ${Math.round(ageMs / 1000)}초 경과 (${market} stale signal)`;
      console.error(`  🛡️ [한울] ${reason}`);
      if (signalId) {
        await db.updateSignalBlock(signalId, {
          status: SIGNAL_STATUS.FAILED,
          reason: reason.slice(0, 180),
          code: `${marketPrefix}_stale_approval`,
          meta: {
            market,
            symbol,
            action,
            approved_at: signal.approved_at,
            age_seconds: Math.round(ageMs / 1000),
          },
        }).catch(() => {});
      }
      return failHanulSignal(signalId, {
        reason,
        code: `${marketPrefix}_stale_approval`,
        market,
        symbol,
        action,
        amount: signal.amount_usdt,
      });
    }
  }

  return { approved: true };
}

function inferHanulBlockCode(reason = '', market = 'domestic') {
  if (!reason) return market === 'overseas' ? 'overseas_order_rejected' : 'domestic_order_rejected';
  if (reason.includes('[90000000]') || reason.includes('모의투자에서는 해당업무가 제공되지 않습니다')) return 'mock_operation_unsupported';
  if (reason.includes('[40070000]') || reason.includes('매매불가 종목')) return 'mock_untradable_symbol';
  if (reason.includes('초당 거래건수를 초과')) return 'broker_rate_limited';
  if (reason.includes('장종료')) return 'market_closed';
  if (reason.includes('현재가 조회 실패')) return 'quote_lookup_failed';
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

async function recordHanulEntryJournal({
  market,
  exchange,
  signalId,
  symbol,
  trade,
  paperMode,
  confidence = null,
  reasoning = null,
}) {
  try {
    const execTime = Date.now();
    const tradeId = await journalDb.generateTradeId();
    await journalDb.insertJournalEntry({
      trade_id: tradeId,
      signal_id: signalId,
      market,
      exchange,
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
      market,
      entryPrice: trade.price,
      entryValue: trade.totalUsdt,
      isPaper: paperMode,
      confidence,
      reasoning,
    });
  } catch (journalErr) {
    const marketLabel = market === 'overseas' ? '해외주식' : '국내주식';
    console.warn(`  ⚠️ ${marketLabel} 매매일지 기록 실패: ${journalErr.message}`);
  }
}

async function finalizeHanulTrade({ trade, signalId, currency, tag }) {
  await db.insertTrade(trade);
  await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
  await notifyTrade({ ...trade, currency });
  const priceLabel = currency === 'KRW'
    ? `${trade.price?.toLocaleString()}원`
    : `$${trade.price}`;
  console.log(`  ✅ ${tag} 완료: ${trade.side} ${trade.amount}주 @ ${priceLabel}`);
  return { success: true, trade };
}

async function processPendingHanulSignals({ exchange, label, execute, delayMs = 1100 }) {
  const startedAt = Date.now();
  const tradeMode = getInvestmentTradeMode();
  console.log(`[한울] ${label} pending 조회 시작 ${JSON.stringify({ pool: getInvestmentPoolStats() })}`);
  const signals = await db.getPendingSignals(exchange, tradeMode);
  logHanulPhase(`${label} pending 조회 완료`, startedAt, { signal_count: signals.length, trade_mode: tradeMode });
  if (signals.length === 0) {
    console.log(`[한울] 대기 ${label} 신호 없음 (trade_mode=${tradeMode})`);
    return [];
  }
  console.log(`[한울] ${signals.length}개 ${label} 신호 처리 시작 (trade_mode=${tradeMode})`);
  const results = [];
  for (const signal of signals) {
    const signalStartedAt = Date.now();
    results.push(await execute(signal));
    logHanulPhase(`${label} 신호 처리 완료 ${signal.symbol}`, signalStartedAt, {
      signal_id: signal.id,
      action: signal.action,
    });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  logHanulPhase(`${label} pending 전체 처리 완료`, startedAt, {
    signal_count: signals.length,
    success_count: results.filter((result) => result?.success).length,
  });
  return results;
}

async function ensureHanulBuyEntryAllowed({
  signalId,
  signalTradeMode,
  paperMode,
  symbol,
  action,
  amount,
  exchange,
  market,
}) {
  const livePosition = await db.getLivePosition(symbol, exchange, signalTradeMode);
  const paperPosition = await db.getPaperPosition(symbol, exchange, signalTradeMode);
  const sameDayBuyTrade = isSameDaySymbolReentryBlockEnabled()
    ? await db.getSameDayTrade({ symbol, side: 'buy', exchange, tradeMode: signalTradeMode })
    : null;

  if (paperMode && livePosition) {
    return failHanulSignal(signalId, {
      reason: '실포지션 보유 중에는 PAPER 추가매수로 혼합 포지션을 만들 수 없음',
      code: 'position_mode_conflict',
      market,
      symbol,
      action,
      amount,
    });
  }
  if (paperMode && paperPosition) {
    return failHanulSignal(signalId, {
      reason: `동일 ${signalTradeMode.toUpperCase()} PAPER 포지션 보유 중 — 추가매수 차단`,
      code: 'paper_position_reentry_blocked',
      market,
      symbol,
      action,
      amount,
    });
  }
  if (!paperMode && livePosition) {
    return failHanulSignal(signalId, {
      reason: '동일 LIVE 포지션 보유 중 — 추가매수 차단',
      code: 'live_position_reentry_blocked',
      market,
      symbol,
      action,
      amount,
    });
  }
  if (!livePosition && !paperPosition && sameDayBuyTrade) {
    return failHanulSignal(signalId, {
      reason: `동일 ${signalTradeMode.toUpperCase()} 심볼 당일 재진입 차단`,
      code: 'same_day_reentry_blocked',
      market,
      symbol,
      action,
      amount,
    });
  }

  return { success: true };
}

async function prepareHanulSellExecution({
  signalId,
  signalTradeMode,
  paperMode,
  symbol,
  action,
  amount,
  exchange,
  market,
  missingReason,
}) {
  const livePosition = await db.getLivePosition(symbol, exchange, signalTradeMode);
  const paperPosition = await db.getPaperPosition(symbol, exchange, signalTradeMode);

  if (paperMode && livePosition && !paperPosition) {
    return failHanulSignal(signalId, {
      reason: '실포지션 보유 중에는 PAPER SELL로 혼합 청산을 실행할 수 없음',
      code: 'position_mode_conflict',
      market,
      symbol,
      action,
      amount,
    });
  }

  const position = paperPosition || livePosition;
  const sellPaperMode = paperMode || (!livePosition && !!paperPosition);
  const qty = position?.amount;
  if (!qty || qty < 1) {
    return failHanulSignal(signalId, {
      reason: missingReason,
      market,
      symbol,
      action,
      amount,
    });
  }

  return {
    success: true,
    livePosition,
    paperPosition,
    position,
    sellPaperMode,
    qty,
    effectiveTradeMode: getPositionTradeMode(position, signalTradeMode),
  };
}

async function getKisExecutionPreflight({ market = 'domestic', action = ACTIONS.HOLD }) {
  if (market === 'domestic') {
    const status = await getKisMarketStatus();
    if (!status.isOpen) {
      return {
        ok: false,
        reason: `국내주식 ${status.reason} — 장중에만 주문 실행 가능`,
        code: 'market_closed',
      };
    }
    return { ok: true };
  }

  const status = getKisOverseasMarketStatus();
  if (!status.isOpen) {
    return {
      ok: false,
      reason: `해외주식 ${status.reason} — 장중에만 주문 실행 가능`,
      code: 'market_closed',
    };
  }
  return { ok: true };
}

async function closeOpenJournalForSymbol(symbol, market, isPaper, exitPrice, exitValue, exitReason, tradeMode = null) {
  const openEntries = await journalDb.getOpenJournalEntries(market);
  const scopedEntries = openEntries.filter((e) =>
    e.symbol === symbol
      && Boolean(e.is_paper) === Boolean(isPaper),
  );
  const effectiveTradeMode = tradeMode || null;
  let entry = null;
  if (effectiveTradeMode) {
    entry = scopedEntries.find((e) => (e.trade_mode || 'normal') === effectiveTradeMode) || null;
  } else if (scopedEntries.length === 1) {
    entry = scopedEntries[0];
  } else if (scopedEntries.length > 1) {
    const tradeModes = [...new Set(scopedEntries.map((e) => e.trade_mode || 'normal'))];
    console.warn(`[한울] ${market} ${symbol} journal close 스킵 - trade_mode 불명확 (${tradeModes.join(',')})`);
  }
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

async function closeStaleOpenJournalForSymbol(symbol, market, isPaper, exitReason, tradeMode = null) {
  const openEntries = await journalDb.getOpenJournalEntries(market);
  const scopedEntries = openEntries.filter((e) =>
    e.symbol === symbol
      && Boolean(e.is_paper) === Boolean(isPaper),
  );
  const effectiveTradeMode = tradeMode || null;
  let entry = null;
  if (effectiveTradeMode) {
    entry = scopedEntries.find((e) => (e.trade_mode || 'normal') === effectiveTradeMode) || null;
  } else if (scopedEntries.length === 1) {
    entry = scopedEntries[0];
  } else if (scopedEntries.length > 1) {
    const tradeModes = [...new Set(scopedEntries.map((e) => e.trade_mode || 'normal'))];
    console.warn(`[한울] ${market} ${symbol} stale journal close 스킵 - trade_mode 불명확 (${tradeModes.join(',')})`);
  }
  if (!entry) return;

  await journalDb.closeJournalEntry(entry.trade_id, {
    exitReason,
    exitPrice: null,
    exitValue: null,
    pnlAmount: null,
    pnlPercent: null,
    pnlNet: null,
  });
  await journalDb.ensureAutoReview(entry.trade_id).catch(() => {});
}

function getPositionTradeMode(position, fallbackTradeMode = null) {
  return position?.trade_mode || fallbackTradeMode || 'normal';
}

async function checkKisRisk(signal) {
  const { action, amount_usdt: amountKrw, symbol } = signal;
  const signalTradeMode = signal.trade_mode || getInvestmentTradeMode();
  if (!isKisSymbol(symbol)) return { approved: false, reason: `KIS 국내 심볼 아님: ${symbol}` };
  if (action === ACTIONS.HOLD)  return { approved: true };
  if (action === ACTIONS.BUY) {
    const minOrderKrw = await getDynamicMinOrderAmount('kis', signalTradeMode);
    const kisPaperMode = isKisPaper();
    const accountModeLabel = kisPaperMode ? 'mock' : 'real';
    if (isKisPaper()) {
      const cooldownMinutes = getMockUntradableSymbolCooldownMinutes();
      const recentBlocked = await db.getRecentBlockedSignalByCode({
        symbol,
        action: ACTIONS.BUY,
        exchange: 'kis',
        tradeMode: signalTradeMode,
        blockCode: 'mock_untradable_symbol',
        minutesBack: cooldownMinutes,
      });
      if (recentBlocked) {
        const cooldownHours = (cooldownMinutes / 60).toFixed(cooldownMinutes % 60 === 0 ? 0 : 1);
        return {
          approved: false,
          reason: `${symbol} 최근 KIS mock 매매불가 종목으로 확인됨 — ${cooldownHours}시간 쿨다운`,
          code: 'mock_untradable_symbol_cooldown',
        };
      }
    }
    if (!amountKrw || amountKrw < minOrderKrw)
      return { approved: false, reason: `최소 주문금액 미달 (${amountKrw?.toLocaleString()}원 < ${minOrderKrw.toLocaleString()}원)` };
    if (amountKrw > KIS_RULES.MAX_ORDER_KRW)
      return { approved: false, reason: `최대 주문금액 초과 (${amountKrw?.toLocaleString()}원)` };
    try {
      const kis = await getKis();
      if (typeof kis.getDomesticPrice === 'function') {
        const currentPrice = Number(await kis.getDomesticPrice(symbol, kisPaperMode));
        if (!(currentPrice > 0)) {
          return { approved: false, reason: `${symbol} 국내 현재가 0원 응답 — 거래불가 종목으로 판단 (${accountModeLabel})` };
        }
        if (amountKrw < currentPrice) {
          return {
            approved: false,
            reason: `1주 가격 미달 (${amountKrw?.toLocaleString()}원 < ${currentPrice.toLocaleString()}원, ${accountModeLabel})`,
          };
        }
      }
      if (typeof kis.getDomesticBalance === 'function') {
        const balance = await kis.getDomesticBalance(kisPaperMode);
        const depositKrw = Number(balance?.dnca_tot_amt || 0);
        const spendableKrw = Math.max(0, depositKrw - KIS_ORDER_CASH_BUFFER_KRW);
        if (depositKrw <= 0) {
          return {
            approved: false,
            reason: `국내 예수금 확인 실패 또는 0원 (${depositKrw?.toLocaleString?.() || depositKrw}원, ${accountModeLabel})`,
          };
        }
        if (amountKrw > spendableKrw) {
          return {
            approved: false,
            reason: `주문가능금액 초과 (${amountKrw?.toLocaleString()}원 > 가용 ${spendableKrw.toLocaleString()}원, 예수금 ${depositKrw.toLocaleString()}원, ${accountModeLabel})`,
          };
        }
      }
    } catch (e) {
      return {
        approved: false,
        reason: `${symbol} 국내 현재가 사전검증 실패 (${accountModeLabel}) — ${e.message}`,
      };
    }
  }
  if (action === ACTIONS.SELL) {
    const pos = await db.getLivePosition(symbol, 'kis', signalTradeMode)
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
    const minOrderUsd = await getDynamicMinOrderAmount('kis_overseas', signalTradeMode);
    if (!amountUsd || amountUsd < minOrderUsd)
      return { approved: false, reason: `최소 주문금액 미달 ($${amountUsd} < $${minOrderUsd})` };
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
    if (isKisPaper()) {
      return {
        approved: false,
        reason: `${symbol} 해외 모의투자 계좌는 SELL 주문을 지원하지 않음`,
        code: 'mock_operation_unsupported',
      };
    }
    const pos = await db.getLivePosition(symbol, 'kis_overseas', signalTradeMode)
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
    _kisPromise = import('../shared/kis-client.ts')
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
    const approvalGuard = await enforceHanulNemesisApproval(signal, 'domestic');
    if (approvalGuard?.success === false) return approvalGuard;

    const preflight = await getKisExecutionPreflight({ market: 'domestic', action });
    if (!preflight.ok) {
      console.log(`  ⛔ 실행 사전 차단: ${preflight.reason}`);
      return failHanulSignal(signalId, {
        reason: preflight.reason,
        code: preflight.code,
        market: 'domestic',
        symbol,
        action,
        amount: amountKrw,
      });
    }

    const risk = await checkKisRisk(signal);
    if (!risk.approved) {
      console.log(`  ❌ 리스크 거부: ${risk.reason}`);
      return failHanulSignal(signalId, {
        reason: risk.reason,
        code: risk.code || null,
        market: 'domestic',
        symbol,
        action,
        amount: amountKrw,
      });
    }

    // 신호 알람 (BUY/SELL만, HOLD 제외)
    if (action !== ACTIONS.HOLD) {
      notifyKisSignal({ symbol, action, amountKrw, confidence: signal.confidence, reasoning: signal.reasoning, paper: paperMode || kisPaper });
    }

    const kis = await getKis();
    let trade;

    if (action === ACTIONS.BUY) {
      const buyEntryState = await ensureHanulBuyEntryAllowed({
        signalId,
        signalTradeMode,
        paperMode,
        symbol,
        action,
        amount: amountKrw,
        exchange: 'kis',
        market: 'domestic',
      });
      if (buyEntryState?.success === false) return buyEntryState;

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

      await recordHanulEntryJournal({
        market: 'domestic',
        exchange: 'kis',
        signalId,
        symbol,
        trade,
        paperMode,
        confidence: signal.confidence,
        reasoning: signal.reasoning,
      });

    } else if (action === ACTIONS.SELL) {
      const sellState = await prepareHanulSellExecution({
        signalId,
        signalTradeMode,
        paperMode,
        symbol,
        action,
        amount: amountKrw,
        exchange: 'kis',
        market: 'domestic',
        missingReason: '포지션 없음',
      });
      if (sellState?.success === false) return sellState;

      const order = await kis.marketSell(symbol, Math.floor(sellState.qty), sellState.sellPaperMode);
      trade = {
        signalId, symbol, side: 'sell',
        amount:    order.qty,
        price:     order.price,
        totalUsdt: order.totalKrw,
        paper:     sellState.sellPaperMode,
        exchange:  'kis',
        tradeMode: sellState.effectiveTradeMode,
      };

      await db.deletePosition(symbol, {
        exchange: 'kis',
        paper: sellState.sellPaperMode,
        tradeMode: sellState.effectiveTradeMode,
      });
      await closeOpenJournalForSymbol(symbol, 'domestic', sellState.sellPaperMode, trade.price, trade.totalUsdt, exitReasonOverride || 'sell', trade.tradeMode).catch(() => {});

    } else {
      console.log(`  ⏸️ HOLD — 실행 없음`);
      await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
      return { success: true };
    }

    return finalizeHanulTrade({ trade, signalId, currency: 'KRW', tag });

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
    const approvalGuard = await enforceHanulNemesisApproval(signal, 'overseas');
    if (approvalGuard?.success === false) return approvalGuard;

    const preflight = await getKisExecutionPreflight({ market: 'overseas', action });
    if (!preflight.ok) {
      console.log(`  ⛔ 실행 사전 차단: ${preflight.reason}`);
      return failHanulSignal(signalId, {
        reason: preflight.reason,
        code: preflight.code,
        market: 'overseas',
        symbol,
        action,
        amount: amountUsd,
      });
    }

    const risk = await checkKisOverseasRisk(signal);
    if (!risk.approved) {
      console.log(`  ❌ 리스크 거부: ${risk.reason}`);
      return failHanulSignal(signalId, {
        reason: risk.reason,
        code: risk.code || null,
        market: 'overseas',
        symbol,
        action,
        amount: amountUsd,
      });
    }

    // 신호 알람 (BUY/SELL만, HOLD 제외)
    if (action !== ACTIONS.HOLD) {
      notifyKisOverseasSignal({ symbol, action, amountUsdt: amountUsd, confidence: signal.confidence, reasoning: signal.reasoning, paper: paperMode || kisPaper });
    }

    const kis = await getKis();
    let trade;

    if (action === ACTIONS.BUY) {
      const buyEntryState = await ensureHanulBuyEntryAllowed({
        signalId,
        signalTradeMode,
        paperMode,
        symbol,
        action,
        amount: amountUsd,
        exchange: 'kis_overseas',
        market: 'overseas',
      });
      if (buyEntryState?.success === false) return buyEntryState;

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

      await recordHanulEntryJournal({
        market: 'overseas',
        exchange: 'kis_overseas',
        signalId,
        symbol,
        trade,
        paperMode,
        confidence: signal.confidence,
        reasoning: signal.reasoning,
      });

    } else if (action === ACTIONS.SELL) {
      const sellState = await prepareHanulSellExecution({
        signalId,
        signalTradeMode,
        paperMode,
        symbol,
        action,
        amount: amountUsd,
        exchange: 'kis_overseas',
        market: 'overseas',
        missingReason: '해외 포지션 없음',
      });
      if (sellState?.success === false) return sellState;

      const order = await kis.marketSellOverseas(symbol, Math.floor(sellState.qty), sellState.sellPaperMode);
      trade = {
        signalId, symbol, side: 'sell',
        amount:    order.qty,
        price:     order.price,
        totalUsdt: order.totalUsd,
        paper:     sellState.sellPaperMode,
        exchange:  'kis_overseas',
        tradeMode: sellState.effectiveTradeMode,
      };

      await db.deletePosition(symbol, {
        exchange: 'kis_overseas',
        paper: sellState.sellPaperMode,
        tradeMode: sellState.effectiveTradeMode,
      });
      await closeOpenJournalForSymbol(symbol, 'overseas', sellState.sellPaperMode, trade.price, trade.totalUsdt, exitReasonOverride || 'sell', trade.tradeMode).catch(() => {});

    } else {
      console.log(`  ⏸️ HOLD — 실행 없음`);
      await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
      return { success: true };
    }

    return finalizeHanulTrade({ trade, signalId, currency: 'USD', tag });

  } catch (e) {
    if (e?.message && e.message.includes('APBK1526')) {
      const livePosition = await db.getLivePosition(symbol, 'kis_overseas', signalTradeMode).catch(() => null);
      const paperPosition = await db.getPaperPosition(symbol, 'kis_overseas', signalTradeMode).catch(() => null);
      const position = paperPosition || livePosition;
      const cleanupPaperMode = paperMode || (!livePosition && !!paperPosition);
      const effectiveTradeMode = getPositionTradeMode(position, signalTradeMode);
      console.warn(`  ⚠️ ${symbol} KIS 해외잔고 미존재 → DB 포지션 삭제 정리`);
      await db.deletePosition(symbol, {
        exchange: 'kis_overseas',
        paper: cleanupPaperMode,
        tradeMode: effectiveTradeMode,
      });
      await closeStaleOpenJournalForSymbol(
        symbol,
        'overseas',
        cleanupPaperMode,
        'broker_no_balance_cleanup',
        effectiveTradeMode,
      ).catch(() => {});
      await markSignalFailedDetailed(signalId, {
        reason: 'KIS 해외잔고 미존재 — DB 포지션 삭제 정리',
        code: 'kis_overseas_no_balance_cleaned',
        market: 'overseas',
        symbol,
        action,
        amount: amountUsd,
      });
      return { success: false, reason: 'KIS 해외잔고 미존재 — 정리됨' };
    }

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
  return processPendingHanulSignals({
    exchange: 'kis',
    label: 'KIS 국내',
    execute: executeSignal,
  });
}

/**
 * 대기 중인 KIS 해외주식 신호 전체 처리
 */
export async function processAllPendingKisOverseasSignals() {
  return processPendingHanulSignals({
    exchange: 'kis_overseas',
    label: 'KIS 해외',
    execute: executeOverseasSignal,
  });
}

// CLI 실행
if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: async () => {
      const args      = process.argv.slice(2);
      const actionArg = args.find(a => a.startsWith('--action='))?.split('=')[1];
      const symbolArg = args.find(a => a.startsWith('--symbol='))?.split('=')[1];
      const amountArg = args.find(a => a.startsWith('--amount='))?.split('=')[1];

      if (actionArg && symbolArg) {
        const sym        = symbolArg.toUpperCase();
        const isOverseas = isKisOverseasSymbol(sym);
        const isDomestic = isKisSymbol(sym);
        if (!isDomestic && !isOverseas) {
          throw new Error(`KIS 심볼 아님: ${sym} (국내: 6자리 숫자, 해외: 알파벳 1~5자)`);
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
        return isOverseas ? executeOverseasSignal(mockSignal) : executeSignal(mockSignal);
      }

      const [domestic, overseas] = await Promise.all([
        processAllPendingKisSignals(),
        processAllPendingKisOverseasSignals(),
      ]);
      return { domestic, overseas };
    },
    onSuccess: async (result) => {
      console.log('완료:', JSON.stringify(result));
    },
    errorPrefix: '❌ 한울 오류:',
  });
}
