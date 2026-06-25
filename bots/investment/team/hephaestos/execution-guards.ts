// @ts-nocheck

import {
  classifyTradeDataGuardDecision,
  evaluateTradeDataEntryGuard,
  resolveTradeDataGuardNotifySizingMultiplier,
} from '../../shared/trade-data-derived-guards.ts';
import { recordGuardEvents } from '../../shared/guard-event-recorder.ts';
import { evaluateCandidateBacktestEntryGate } from '../../shared/candidate-backtest-gate.ts';
import { logGateDecision, resolveBacktestGatePassed } from '../../shared/gate-decision-logger.ts';
import {
  BINANCE_TOP_VOLUME_BLOCK_REASON,
  evaluateBinanceTopVolumeUniverseGate,
  getCachedBinanceTopVolumeUniverse,
} from '../../shared/binance-top-volume-universe.ts';
import { rejectExecution } from './execution-failure.ts';

export function buildGuardTelemetryMeta(symbol, action, signalTradeMode, meta = {}, extras = {}) {
  return {
    symbol,
    side: String(action || 'BUY').toLowerCase(),
    tradeMode: signalTradeMode,
    guardKind: extras.guardKind || meta.guardKind || null,
    pressureSource: extras.pressureSource || meta.pressureSource || null,
    ...meta,
  };
}

export async function runBuySafetyGuards({
  persistFailure,
  symbol,
  action,
  signal = {},
  signalTradeMode,
  capitalPolicy,
  signalConfidence = null,
  checkCircuitBreaker,
  getOpenPositions,
  getMaxPositionsOverflowPolicy,
  getDailyTradeCount,
  formatDailyTradeLimitReason,
  notifyEnabled = true,
  binanceTopVolumeUniverse = null,
}) {
  if (String(signal.exchange || 'binance') === 'binance') {
    const topVolumeUniverse = binanceTopVolumeUniverse || await getCachedBinanceTopVolumeUniverse().catch((error) => ({
      source: 'binance_top30_unavailable',
      limit: 30,
      symbols: [],
      ranks: {},
      error: String(error?.message || error),
    }));
    const top30Gate = evaluateBinanceTopVolumeUniverseGate(symbol, topVolumeUniverse);
    if (top30Gate.blocked) {
      const reason = `Binance Top 30 universe blocked: ${BINANCE_TOP_VOLUME_BLOCK_REASON}`;
      console.log(`  ⛔ [Binance Top30] ${symbol} ${reason}`);
      return rejectExecution({
        persistFailure,
        symbol,
        action,
        reason,
        code: BINANCE_TOP_VOLUME_BLOCK_REASON,
        meta: buildGuardTelemetryMeta(symbol, action, signalTradeMode, {
          binanceTop30Gate: top30Gate,
        }, {
          guardKind: 'binance_top30_volume_universe',
          pressureSource: 'binance_market_liquidity',
        }),
        notify: notifyEnabled ? 'skip' : false,
      });
    }
  }

  const tradeDataGuard = evaluateTradeDataEntryGuard({
    ...signal,
    symbol,
    action,
    exchange: signal.exchange || 'binance',
    market: signal.market || 'crypto',
  }, process.env);
  const tradeDataGuardClass = classifyTradeDataGuardDecision(tradeDataGuard, process.env);
  if (tradeDataGuardClass === 'hard_block') {
    // 구조적 stablecoin 또는 strict confirmation → 거래 거부
    const blockers = Array.isArray(tradeDataGuard.blockers) && tradeDataGuard.blockers.length > 0
      ? tradeDataGuard.blockers.join(', ')
      : 'trade_data_policy';
    const reason = `trade-data entry guard hard-blocked: ${blockers}`;
    console.log(`  ⛔ [거래데이터 가드] ${reason}`);
    return rejectExecution({
      persistFailure,
      symbol,
      action,
      reason,
      code: 'trade_data_entry_guard_rejected',
      meta: buildGuardTelemetryMeta(symbol, action, signalTradeMode, {
        tradeDataGuard,
      }, {
        guardKind: 'trade_data_entry_guard',
        pressureSource: 'trade_data_policy',
      }),
      notify: notifyEnabled ? 'skip' : false,
    });
  }
  if (tradeDataGuardClass === 'notify') {
    // notify 모드: 거래 계속 + guard_events 기록 + 실행 직전 sizing 축소
    const blockers = Array.isArray(tradeDataGuard.blockers) ? tradeDataGuard.blockers : [];
    const notifySizingMultiplier = resolveTradeDataGuardNotifySizingMultiplier(tradeDataGuard, process.env);
    const requestedAmountUsdt = Number(signal.amount_usdt ?? signal.amountUsdt ?? 0);
    const adjustedAmountUsdt = requestedAmountUsdt > 0
      ? Number((requestedAmountUsdt * notifySizingMultiplier).toFixed(4))
      : requestedAmountUsdt;
    if (adjustedAmountUsdt > 0 && adjustedAmountUsdt < requestedAmountUsdt) {
      signal.amount_usdt = adjustedAmountUsdt;
      signal.amountUsdt = adjustedAmountUsdt;
    }
    console.log(`  ⚠️ [거래데이터 가드] notify 모드 통과: ${blockers.join(', ')} x${notifySizingMultiplier}`);
    recordGuardEvents(blockers.map((blocker) => ({
      guardName: 'trade_data_entry_guard',
      symbol,
      exchange: signal.exchange || 'binance',
      market: signal.market || 'crypto',
      reason: blocker,
      severity: 'warning',
      decisionBefore: { action, amount_usdt: requestedAmountUsdt || null },
      decisionAfter: { action, amount_usdt: adjustedAmountUsdt, notifyMode: true },
      guardMetadata: {
        blockers,
        guardClass: 'notify',
        sizingMultiplier: notifySizingMultiplier,
      },
    })));
    return {
      success: true,
      tradeDataGuardNotify: {
        blockers,
        sizingMultiplier: notifySizingMultiplier,
        requestedAmountUsdt,
        adjustedAmountUsdt,
      },
    };
  }

  const backtestGate = await evaluateCandidateBacktestEntryGate({
    ...signal,
    symbol,
    action,
    exchange: signal.exchange || 'binance',
    market: signal.market || 'crypto',
  }, process.env).catch((error) => ({
    ok: true,
    mode: 'shadow',
    blocked: false,
    wouldBlock: true,
    reason: `candidate_backtest_gate_error:${error?.message || error}`,
  }));
  if (backtestGate?.wouldBlock) {
    console.log(`  🧪 [백테스트 게이트] mode=${backtestGate.mode} reason=${backtestGate.reason || 'would_block'}`);
  }
  if (process.env.LUNA_GATE_DECISION_LOG_ENABLED !== 'false') {
    const backtestSnapshot = backtestGate?.row || null;
    const backtestReasons = Array.isArray(backtestGate?.reasons)
      ? backtestGate.reasons
      : (backtestGate?.reason ? [backtestGate.reason] : []);
    const backtestDecisionSnapshot = backtestSnapshot
      ? {
        ...backtestSnapshot,
        wouldBlock: backtestGate?.wouldBlock,
        gateStatus: backtestSnapshot?.gate_status ?? backtestSnapshot?.gateStatus ?? backtestGate?.reason ?? null,
        blockReasons: backtestReasons,
      }
      : null;
    await logGateDecision({
      exchange: signal.exchange || 'binance',
      market: signal.market || 'crypto',
      symbol,
      gatePassed: backtestDecisionSnapshot
        ? resolveBacktestGatePassed(backtestDecisionSnapshot)
        : backtestGate?.wouldBlock !== true,
      gateStatus: backtestDecisionSnapshot?.gateStatus ?? backtestGate?.reason ?? null,
      blockReasons: backtestReasons,
      backtest: backtestDecisionSnapshot,
      decisionMode: backtestGate?.mode ?? null,
      actuallyFired: false,
      confidence: Number(signal?.confidence ?? signalConfidence) || null,
      signalId: signal?.signal_id || signal?.signalId || signal?.id || null,
      triggerType: signal?.trigger_type || signal?.setup_type || signal?.setupType || null,
      shadowFlags: {
        wouldBlock: backtestGate?.wouldBlock === true,
        blocked: backtestGate?.blocked === true,
        mode: backtestGate?.mode ?? null,
      },
    });
  }
  if (backtestGate?.blocked) {
    const reason = `candidate backtest gate blocked: ${backtestGate.reason || 'candidate_backtest_gate'}`;
    return rejectExecution({
      persistFailure,
      symbol,
      action,
      reason,
      code: 'candidate_backtest_gate_rejected',
      meta: buildGuardTelemetryMeta(symbol, action, signalTradeMode, {
        candidateBacktestGate: backtestGate,
      }, {
        guardKind: 'candidate_backtest_gate',
        pressureSource: 'candidate_backtest_status',
      }),
      notify: notifyEnabled ? 'skip' : false,
    });
  }

  const circuit = await checkCircuitBreaker('binance', signalTradeMode);
  if (circuit.triggered) {
    console.log(`  ⛔ [서킷 브레이커] ${circuit.reason}`);
    return rejectExecution({
      persistFailure,
      symbol,
      action,
      reason: circuit.reason,
      code: 'capital_circuit_breaker',
      meta: { circuitType: circuit.type ?? null },
      notify: notifyEnabled ? 'circuit' : false,
    });
  }

  const [openPositionsSafe, dailyTradesSafe] = await Promise.all([
    getOpenPositions('binance', false, signalTradeMode).catch(() => []),
    getDailyTradeCount({ exchange: 'binance', tradeMode: signalTradeMode, side: 'buy' }).catch(() => 0),
  ]);
  if (openPositionsSafe.length >= capitalPolicy.max_concurrent_positions) {
    const overflowPolicy = getMaxPositionsOverflowPolicy(signalTradeMode);
    const overflowSlots = Math.max(0, Math.round(Number(overflowPolicy?.allowOverflowSlots || 0)));
    const minConfidence = Number(overflowPolicy?.minConfidence || 0);
    const signalConfidenceNum = Number(signalConfidence || 0);
    const overflowLimit = capitalPolicy.max_concurrent_positions + overflowSlots;
    if (
      overflowPolicy?.enabled === true
      && overflowSlots > 0
      && openPositionsSafe.length < overflowLimit
      && signalConfidenceNum >= minConfidence
    ) {
      console.log(`  ⚖️ [자본관리] 강한 BUY 신호로 max positions overflow 허용: ${openPositionsSafe.length}/${capitalPolicy.max_concurrent_positions} → ${overflowLimit} (confidence=${signalConfidenceNum.toFixed(2)})`);
      return null;
    }
    const reason = `최대 포지션 도달: ${openPositionsSafe.length}/${capitalPolicy.max_concurrent_positions}`;
    console.log(`  ⛔ [자본관리] ${reason}`);
    return rejectExecution({
      persistFailure,
      symbol,
      action,
      reason,
      code: 'capital_guard_rejected',
      meta: buildGuardTelemetryMeta(symbol, action, signalTradeMode, {
        openPositions: openPositionsSafe.length,
        maxPositions: capitalPolicy.max_concurrent_positions,
      }, {
        guardKind: 'max_positions',
        pressureSource: 'capital_policy',
      }),
      notify: notifyEnabled ? 'skip' : false,
    });
  }

  if (dailyTradesSafe >= capitalPolicy.max_daily_trades) {
    const reason = formatDailyTradeLimitReason(dailyTradesSafe, capitalPolicy.max_daily_trades);
    console.log(`  ⛔ [자본관리] ${reason}`);
    return rejectExecution({
      persistFailure,
      symbol,
      action,
      reason,
      code: 'capital_guard_rejected',
      meta: buildGuardTelemetryMeta(symbol, action, signalTradeMode, {
        dailyTrades: dailyTradesSafe,
        maxDailyTrades: capitalPolicy.max_daily_trades,
      }, {
        guardKind: 'daily_trade_limit',
        pressureSource: 'capital_policy',
      }),
      notify: notifyEnabled ? 'skip' : false,
    });
  }

  return null;
}

export default {
  buildGuardTelemetryMeta,
  runBuySafetyGuards,
};
