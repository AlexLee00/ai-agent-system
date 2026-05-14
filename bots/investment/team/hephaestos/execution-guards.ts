// @ts-nocheck

import { evaluateTradeDataEntryGuard } from '../../shared/trade-data-derived-guards.ts';
import { evaluateCandidateBacktestEntryGate } from '../../shared/candidate-backtest-gate.ts';
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
}) {
  const tradeDataGuard = evaluateTradeDataEntryGuard({
    ...signal,
    symbol,
    action,
    exchange: signal.exchange || 'binance',
    market: signal.market || 'crypto',
  }, process.env);
  if (tradeDataGuard.blocked) {
    const blockers = Array.isArray(tradeDataGuard.blockers) && tradeDataGuard.blockers.length > 0
      ? tradeDataGuard.blockers.join(', ')
      : 'trade_data_policy';
    const reason = `trade-data entry guard blocked: ${blockers}`;
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
