// @ts-nocheck
/**
 * team/hard-rule.js — 네메시스 하드 규칙
 */

import { ACTIONS, SIGNAL_STATUS } from '../shared/signal.ts';

async function reject({ persist, signal, symbol, action, reason, db, notifyRiskRejection, traceId }) {
  if (persist && signal?.id) await db.updateSignalStatus(signal.id, SIGNAL_STATUS.REJECTED);
  if (persist) await notifyRiskRejection({ symbol, action, reason });
  if (persist) {
    await db.insertRiskLog({
      traceId,
      symbol,
      exchange: signal.exchange,
      decision: 'REJECT',
      riskScore: null,
      reason,
    }).catch(() => {});
  }
  return { approved: false, reason };
}

export async function check(signal, context, deps) {
  const {
    totalUsdt,
    traceId,
    rules,
    persist,
    isStockExchange,
    isCryptoExchange,
    signalTradeMode,
    stockThresholds,
  } = context;
  const {
    db,
    notifyRiskRejection,
    isKisPaper,
    getMockUntradableSymbolCooldownMinutes,
    getInvestmentTradeMode,
    getValidationSoftBudgetConfig,
    getCapitalConfig,
    getDailyTradeCount,
    getInvestmentExecutionRuntimeConfig,
  } = deps;

  const { symbol, action } = signal;
  let amountUsdt = signal.amount_usdt ?? 100;

  if (action === ACTIONS.BUY) {
    if (amountUsdt < rules.MIN_ORDER_USDT) {
      if (isCryptoExchange && totalUsdt >= rules.MIN_ORDER_USDT) {
        amountUsdt = rules.MIN_ORDER_USDT;
      } else {
        return reject({ persist, signal, symbol, action, reason: `최소 주문 미달 ($${amountUsdt} < $${rules.MIN_ORDER_USDT})`, db, notifyRiskRejection, traceId });
      }
    }
    if (amountUsdt > rules.MAX_ORDER_USDT) amountUsdt = rules.MAX_ORDER_USDT;
    const pct = amountUsdt / totalUsdt;
    if (pct > rules.MAX_SINGLE_POSITION_PCT) {
      amountUsdt = Math.floor(totalUsdt * rules.MAX_SINGLE_POSITION_PCT);
    }
  }

  if (action === ACTIONS.BUY && isStockExchange && (signal.confidence ?? 0) < stockThresholds.stockRejectConfidence) {
    return reject({
      persist,
      signal,
      symbol,
      action,
      reason: `주식 공격적 모드 최소 확신도 미달 (${(signal.confidence ?? 0).toFixed(2)} < ${stockThresholds.stockRejectConfidence.toFixed(2)})`,
      db,
      notifyRiskRejection,
      traceId,
    });
  }

  if (action === ACTIONS.BUY && signal.exchange === 'kis' && isKisPaper()) {
    const cooldownMinutes = getMockUntradableSymbolCooldownMinutes();
    const recent = await db.getRecentBlockedSignalByCode({
      symbol,
      action: ACTIONS.BUY,
      exchange: 'kis',
      tradeMode: signal.trade_mode || getInvestmentTradeMode(),
      blockCode: 'mock_untradable_symbol',
      minutesBack: cooldownMinutes,
    });
    if (recent) {
      return reject({
        persist,
        signal,
        symbol,
        action,
        reason: `${symbol} 최근 KIS mock 주문 불가 종목으로 확인됨 — ${(cooldownMinutes / 60).toFixed(cooldownMinutes % 60 === 0 ? 0 : 1)}시간 승인 쿨다운`,
        db,
        notifyRiskRejection,
        traceId,
      });
    }
  }

  if (action === ACTIONS.BUY && isCryptoExchange && signalTradeMode === 'validation') {
    const livePosition = await db.getLivePosition(symbol, signal.exchange).catch(() => null);
    if (livePosition && livePosition.paper === false) {
      const executionRuntime = getInvestmentExecutionRuntimeConfig?.() || {};
      const liveReentryPolicy = executionRuntime?.cryptoGuardSoftening?.byExchange?.binance?.tradeModes?.validation?.livePositionReentry || {};
      const reductionMultiplier = Number(liveReentryPolicy?.reductionMultiplier || 0);
      if (!(liveReentryPolicy?.enabled !== false && reductionMultiplier > 0 && reductionMultiplier < 1)) {
        return reject({
          persist,
          signal,
          symbol,
          action,
          reason: '동일 LIVE 포지션 보유 중 — validation BUY 사전 차단',
          db,
          notifyRiskRejection,
          traceId,
        });
      }
    }
  }

  if (action === ACTIONS.BUY && isCryptoExchange && signalTradeMode === 'validation') {
    const softBudget = getValidationSoftBudgetConfig('binance');
    if (softBudget.enabled && softBudget.reserveDailyBuySlots > 0) {
      const policy = getCapitalConfig('binance', 'validation');
      const softCap = Math.max(1, policy.max_daily_trades - softBudget.reserveDailyBuySlots);
      const validationDailyBuys = await getDailyTradeCount({ exchange: 'binance', tradeMode: 'validation', side: 'buy' }).catch(() => 0);
      if (validationDailyBuys >= softCap) {
        return reject({
          persist,
          signal,
          symbol,
          action,
          reason: `crypto validation 일간 예산 soft cap 도달: 현재 ${validationDailyBuys}건 / soft cap ${softCap}건`,
          db,
          notifyRiskRejection,
          traceId,
        });
      }
    }
  }

  const todayPnl = await db.getTodayPnl();
  const lossPct = (todayPnl.pnl || 0) < 0 ? Math.abs(todayPnl.pnl) / totalUsdt : 0;
  if (action === ACTIONS.BUY && lossPct >= rules.MAX_DAILY_LOSS_PCT) {
    return reject({ persist, signal, symbol, action, reason: `일일 손실 한도 초과 (${(lossPct * 100).toFixed(1)}%)`, db, notifyRiskRejection, traceId });
  }

  let positionCount = 0;
  if (action === ACTIONS.BUY) {
    const positions = await db.getAllPositions(signal.exchange, false);
    positionCount = positions.length;
    if (positionCount >= rules.MAX_OPEN_POSITIONS) {
      return reject({ persist, signal, symbol, action, reason: `최대 포지션 초과 (${positionCount}/${rules.MAX_OPEN_POSITIONS})`, db, notifyRiskRejection, traceId });
    }
  }

  return { amountUsdt, positionCount, todayPnl };
}
