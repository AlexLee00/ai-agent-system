// @ts-nocheck
/**
 * Luna signal persistence and existing-position bias policy.
 *
 * Extracted from team/luna.ts to keep orchestration separate from the
 * deterministic decision-to-signal contract.
 */

import { ACTIONS, SIGNAL_STATUS } from './signal.ts';
import { buildSignalApprovalUpdate } from './signal-approval.ts';
import { preTradeCheck } from './capital-manager.ts';
import { preFilterSignal } from './signal-pre-filter.ts';

const PREFILTER_BLOCK_ENV = 'LUNA_SIGNAL_PREFILTER_PERSISTENCE_BLOCK_ENABLED';
const CAPITAL_PREFLIGHT_BLOCK_ENV = 'LUNA_SIGNAL_CAPITAL_PREFLIGHT_PERSISTENCE_BLOCK_ENABLED';
const CAPITAL_PREFLIGHT_TRADE_MODES_ENV = 'LUNA_SIGNAL_CAPITAL_PREFLIGHT_TRADE_MODES';

function boolEnv(name, fallback = false, env = process.env) {
  const raw = String(env?.[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(raw)) return false;
  return fallback;
}

function csvSetEnv(name, fallback = [], env = process.env) {
  const raw = String(env?.[name] ?? '').trim();
  const values = raw
    ? raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
    : fallback;
  return new Set(values);
}

function normalizeTradeMode(value = null, fallback = 'normal') {
  const mode = String(value || '').trim().toLowerCase();
  return mode || fallback;
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeResponsibilityPlan(strategyProfile = null) {
  return strategyProfile?.strategy_context?.responsibilityPlan
    || strategyProfile?.strategyContext?.responsibilityPlan
    || strategyProfile?.responsibilityPlan
    || null;
}

function normalizeExecutionPlan(strategyProfile = null) {
  return strategyProfile?.strategy_context?.executionPlan
    || strategyProfile?.strategyContext?.executionPlan
    || strategyProfile?.executionPlan
    || null;
}

export function applyExistingPositionStrategyBias(signalData, existingStrategyProfile = null) {
  if (!existingStrategyProfile || signalData?.action !== ACTIONS.BUY) {
    return {
      signalData,
      applied: false,
      note: null,
      existingStrategyProfile,
    };
  }

  const responsibilityPlan = normalizeResponsibilityPlan(existingStrategyProfile) || {};
  const executionPlan = normalizeExecutionPlan(existingStrategyProfile) || {};
  const ownerMode = String(responsibilityPlan?.ownerMode || '').trim().toLowerCase();
  const setupType = String(existingStrategyProfile?.setup_type || '').trim() || 'unknown';
  const lifecycleStatus = String(existingStrategyProfile?.strategy_state?.lifecycleStatus || '').trim() || 'holding';
  const originalAmount = Number(signalData.amountUsdt || 0);
  const originalConfidence = Number(signalData.confidence || 0);
  let adjustedAmount = originalAmount;
  let adjustedConfidence = originalConfidence;
  let note = null;

  if (ownerMode === 'capital_preservation') {
    adjustedAmount = Math.max(0, Math.floor(originalAmount * 0.88));
    adjustedConfidence = Math.max(0, Math.min(1, originalConfidence * 0.97));
    note = `기존 전략 ${setupType}/${lifecycleStatus}가 capital_preservation이라 추가진입 크기를 더 보수적으로 조절`;
  } else if (ownerMode === 'balanced_rotation') {
    adjustedAmount = Math.max(0, Math.floor(originalAmount * 0.95));
    adjustedConfidence = Math.max(0, Math.min(1, originalConfidence * 0.99));
    note = `기존 전략 ${setupType}/${lifecycleStatus}가 balanced_rotation이라 추가진입을 소폭 완화`;
  } else if (ownerMode === 'equity_rotation') {
    adjustedAmount = Math.max(0, Math.floor(originalAmount * 0.96));
    note = `기존 전략 ${setupType}/${lifecycleStatus}가 equity_rotation이라 추가진입 크기를 소폭 완화`;
  } else if (ownerMode === 'opportunity_capture' && originalConfidence >= 0.74) {
    adjustedAmount = Math.max(0, Math.floor(originalAmount * 1.08));
    adjustedConfidence = Math.max(0, Math.min(1, originalConfidence * 1.01));
    note = `기존 전략 ${setupType}/${lifecycleStatus}가 opportunity_capture라 강한 추가진입 후보로 간주`;
  }

  const nextSignalData = {
    ...signalData,
    amountUsdt: adjustedAmount || signalData.amountUsdt,
    confidence: adjustedConfidence || signalData.confidence,
    existingStrategyProfileId: existingStrategyProfile?.id || null,
    existingStrategyState: existingStrategyProfile?.strategy_state || null,
    existingResponsibilityPlan: responsibilityPlan,
    existingExecutionPlan: executionPlan,
  };
  if (note) {
    nextSignalData.reasoning = `${signalData.reasoning} | ${note}`.slice(0, 500);
  }

  return {
    signalData: nextSignalData,
    applied: adjustedAmount !== originalAmount || adjustedConfidence !== originalConfidence,
    note,
    existingStrategyProfile,
  };
}

export function buildLunaRiskEvaluationSignal(signalData = {}) {
  return {
    ...signalData,
    amount_usdt: signalData.amount_usdt ?? signalData.amountUsdt ?? null,
    trade_mode: signalData.trade_mode ?? signalData.tradeMode ?? null,
  };
}

export function evaluateLunaSignalPersistencePreFilter(signalData = {}, context = {}) {
  const env = context.env || process.env;
  if (!boolEnv(PREFILTER_BLOCK_ENV, false, env)) {
    return { enabled: false, blocked: false, filter: null, blockers: [] };
  }

  const filter = preFilterSignal({
    ...signalData,
    exchange: context.exchange || signalData.exchange,
    market: context.market || signalData.market,
    action: context.action || signalData.action,
  }, {
    env,
    minConfidence: 0,
    deferOnMarketClosed: false,
  });
  const tradeDataBlockers = Array.isArray(filter?.tradeDataGuard?.blockers)
    ? filter.tradeDataGuard.blockers
    : [];
  return {
    enabled: true,
    blocked: tradeDataBlockers.length > 0,
    filter,
    blockers: tradeDataBlockers,
  };
}

export async function evaluateLunaSignalCapitalPersistencePreflight(signalData = {}, riskResult = null, context = {}) {
  const env = context.env || process.env;
  if (!boolEnv(CAPITAL_PREFLIGHT_BLOCK_ENV, false, env)) {
    return { enabled: false, blocked: false, skipped: true, reason: `${CAPITAL_PREFLIGHT_BLOCK_ENV}=false`, blockUpdate: null, check: null };
  }

  const action = String(context.action || signalData.action || '').toUpperCase();
  const exchange = String(context.exchange || signalData.exchange || '').trim().toLowerCase();
  const symbol = context.symbol || signalData.symbol || null;
  const tradeMode = normalizeTradeMode(
    context.tradeMode
      || context.decision?.trade_mode
      || context.decision?.tradeMode
      || signalData.tradeMode
      || signalData.trade_mode,
    'normal',
  );
  const scopedModes = csvSetEnv(CAPITAL_PREFLIGHT_TRADE_MODES_ENV, ['validation'], env);

  if (action !== ACTIONS.BUY || exchange !== 'binance' || riskResult?.approved !== true) {
    return { enabled: true, blocked: false, skipped: true, reason: 'not_applicable', blockUpdate: null, check: null };
  }
  if (!scopedModes.has('*') && !scopedModes.has(tradeMode)) {
    return { enabled: true, blocked: false, skipped: true, reason: `trade_mode_not_in_scope:${tradeMode}`, blockUpdate: null, check: null };
  }

  const amount = numberOrNull(
    riskResult.adjustedAmount
      ?? riskResult.adjusted_amount
      ?? context.decision?.amount_usdt
      ?? signalData.amountUsdt
      ?? signalData.amount_usdt,
  );
  if (!(amount > 0)) {
    return { enabled: true, blocked: false, skipped: true, reason: 'amount_unavailable', blockUpdate: null, check: null };
  }

  const preTradeCheckFn = context.deps?.preTradeCheck || preTradeCheck;
  const check = await Promise.resolve(preTradeCheckFn(symbol, ACTIONS.BUY, amount, 'binance', tradeMode)).catch((error) => ({
    allowed: true,
    error: String(error?.message || error),
  }));
  if (check?.allowed !== false) {
    return { enabled: true, blocked: false, skipped: false, reason: 'capital_preflight_allowed', blockUpdate: null, check };
  }

  const reason = check.reason || 'pre_trade_check_blocked';
  const code = check.circuit ? 'capital_circuit_breaker' : 'capital_guard_rejected';
  return {
    enabled: true,
    blocked: true,
    skipped: false,
    reason,
    check,
    blockUpdate: {
      status: 'blocked',
      reason,
      code,
      meta: {
        exchange: 'binance',
        symbol,
        action,
        amount,
        tradeMode,
        circuit: Boolean(check.circuit),
        circuitType: check.circuitType ?? null,
        dailyNotional: check.dailyNotional ?? null,
        maxDailyNotional: check.maxDailyNotional ?? null,
        execution_blocked_by: 'signal_persistence_capital_preflight',
        pressureSource: 'pre_trade_check',
      },
    },
  };
}

export async function buildLunaSignalPersistencePlanWithCapitalPreflight(signalData = {}, riskResult = null, riskError = null, context = {}) {
  const capitalPreflight = await evaluateLunaSignalCapitalPersistencePreflight(signalData, riskResult, context);
  if (capitalPreflight.blocked) {
    return {
      status: 'blocked',
      signalData: { ...signalData },
      approvalUpdate: null,
      blockUpdate: capitalPreflight.blockUpdate,
      outcome: 'blocked_by_capital_prefilter',
    };
  }
  return buildLunaSignalPersistencePlan(signalData, riskResult, riskError, context);
}

export function buildLunaSignalPersistencePlan(signalData = {}, riskResult = null, riskError = null, context = {}) {
  const symbol = context.symbol || signalData.symbol || null;
  const action = context.action || signalData.action || null;
  const exchange = context.exchange || signalData.exchange || null;
  const decision = context.decision || {};

  if (riskError) {
    return {
      status: SIGNAL_STATUS.FAILED,
      signalData: { ...signalData },
      approvalUpdate: null,
      blockUpdate: {
        status: SIGNAL_STATUS.FAILED,
        reason: `nemesis_error:${String(riskError.message || 'unknown').slice(0, 180)}`,
        code: 'nemesis_error',
        meta: {
          exchange,
          symbol,
          action,
          amount: decision.amount_usdt ?? signalData.amountUsdt ?? null,
          confidence: decision.confidence ?? signalData.confidence ?? null,
        },
      },
      outcome: 'failed',
    };
  }

  if (riskResult?.approved) {
    const prefilter = action === ACTIONS.BUY
      ? evaluateLunaSignalPersistencePreFilter(signalData, context)
      : { enabled: false, blocked: false, filter: null, blockers: [] };
    if (prefilter.blocked) {
      return {
        status: 'blocked',
        signalData: { ...signalData },
        approvalUpdate: null,
        blockUpdate: {
          status: 'blocked',
          reason: `trade-data entry guard blocked: ${prefilter.blockers.join(', ')}`,
          code: 'trade_data_entry_guard_rejected',
          meta: {
            exchange,
            symbol,
            action,
            amount: decision.amount_usdt ?? signalData.amountUsdt ?? null,
            confidence: decision.confidence ?? signalData.confidence ?? null,
            execution_blocked_by: 'signal_persistence_prefilter',
            prefilter: {
              decision: prefilter.filter?.decision || null,
              blockers: prefilter.blockers,
              warnings: prefilter.filter?.warnings || [],
              tradeDataGuard: prefilter.filter?.tradeDataGuard || null,
            },
          },
        },
        outcome: 'blocked_by_prefilter',
      };
    }

    const approvalUpdate = buildSignalApprovalUpdate({
      ...riskResult,
      status: SIGNAL_STATUS.APPROVED,
    });
    return {
      status: SIGNAL_STATUS.APPROVED,
      signalData: {
        ...signalData,
        amountUsdt: riskResult.adjustedAmount ?? signalData.amountUsdt,
        nemesisVerdict: approvalUpdate.nemesisVerdict,
        approvedAt: approvalUpdate.approvedAt,
      },
      approvalUpdate,
      blockUpdate: null,
      outcome: 'approved',
    };
  }

  return {
    status: SIGNAL_STATUS.REJECTED,
    signalData: { ...signalData },
    approvalUpdate: null,
    blockUpdate: {
      status: SIGNAL_STATUS.REJECTED,
      reason: riskResult?.reason || 'risk_rejected',
      code: 'risk_rejected',
      meta: {
        exchange,
        symbol,
        action,
        amount: decision.amount_usdt ?? signalData.amountUsdt ?? null,
        adjustedAmount: riskResult?.adjustedAmount ?? null,
      },
    },
    outcome: 'rejected',
  };
}
