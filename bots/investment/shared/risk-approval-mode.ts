// @ts-nocheck

import { getNemesisRuntimeConfig } from './runtime-config.ts';

export function normalizeRiskApprovalChainModeConfig(config = {}) {
  const mode = String(config.mode || 'shadow').toLowerCase();
  const assistMaxReductionPct = Number(config.assist?.maxReductionPct ?? 0.35);
  return {
    mode: ['shadow', 'assist', 'enforce'].includes(mode) ? mode : 'shadow',
    assist: {
      applyAmountReduction: config.assist?.applyAmountReduction !== false,
      maxReductionPct: Number.isFinite(assistMaxReductionPct) ? assistMaxReductionPct : 0.35,
    },
    enforce: {
      rejectOnPreviewReject: config.enforce?.rejectOnPreviewReject !== false,
      applyAmountReduction: config.enforce?.applyAmountReduction !== false,
    },
  };
}

export function getRiskApprovalChainModeConfig() {
  return normalizeRiskApprovalChainModeConfig(getNemesisRuntimeConfig()?.riskApprovalChain || {});
}

export function applyRiskApprovalChainMode({
  amountUsdt,
  adaptiveResult,
  riskApprovalPreview,
  modeConfig,
  rules,
} = {}) {
  const resolvedModeConfig = normalizeRiskApprovalChainModeConfig(modeConfig || {});
  const mode = resolvedModeConfig.mode || 'shadow';
  const before = Number(amountUsdt || 0);
  const previewAmount = Number(riskApprovalPreview?.finalAmount || 0);
  const minOrder = Number(rules?.MIN_ORDER_USDT || 0);
  const previewRejected = riskApprovalPreview?.approved === false || riskApprovalPreview?.decision === 'REJECT';

  if (mode === 'shadow') {
    return {
      approved: true,
      amountUsdt: before,
      adaptiveResult,
      applied: false,
      mode,
      reason: 'shadow mode records preview only',
    };
  }

  if (mode === 'enforce' && previewRejected && resolvedModeConfig.enforce?.rejectOnPreviewReject) {
    return {
      approved: false,
      amountUsdt: before,
      adaptiveResult,
      applied: true,
      mode,
      reason: riskApprovalPreview?.rejectReason || 'risk approval chain rejected',
    };
  }

  const shouldApplyAmount =
    previewAmount > 0 &&
    previewAmount < before &&
    (
      (mode === 'assist' && resolvedModeConfig.assist?.applyAmountReduction) ||
      (mode === 'enforce' && resolvedModeConfig.enforce?.applyAmountReduction)
    );

  if (!shouldApplyAmount) {
    return {
      approved: true,
      amountUsdt: before,
      adaptiveResult,
      applied: false,
      mode,
      reason: `${mode} mode found no amount reduction`,
    };
  }

  const maxReductionPct = mode === 'assist'
    ? Math.max(0, Math.min(0.95, Number(resolvedModeConfig.assist?.maxReductionPct ?? 0.35)))
    : 0.95;
  const maxReductionAmount = Math.floor(before * (1 - maxReductionPct));
  const boundedAmount = mode === 'assist'
    ? Math.max(minOrder, maxReductionAmount, Math.floor(previewAmount))
    : Math.max(minOrder, Math.floor(previewAmount));

  if (boundedAmount >= before) {
    return {
      approved: true,
      amountUsdt: before,
      adaptiveResult,
      applied: false,
      mode,
      reason: `${mode} reduction bounded to original amount`,
    };
  }

  return {
    approved: true,
    amountUsdt: boundedAmount,
    adaptiveResult: {
      ...adaptiveResult,
      llm: {
        ...(adaptiveResult?.llm || {}),
        decision: 'ADJUST',
        reasoning: `${adaptiveResult?.llm?.reasoning || '리스크 승인'} | risk approval chain ${mode} 감산 ${before} -> ${boundedAmount}`,
      },
    },
    applied: true,
    mode,
    reason: `risk approval chain ${mode} amount reduction`,
  };
}
