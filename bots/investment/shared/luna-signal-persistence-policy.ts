// @ts-nocheck
/**
 * Luna signal persistence and existing-position bias policy.
 *
 * Extracted from team/luna.ts to keep orchestration separate from the
 * deterministic decision-to-signal contract.
 */

import { ACTIONS, SIGNAL_STATUS } from './signal.ts';
import { buildSignalApprovalUpdate } from './signal-approval.ts';

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
