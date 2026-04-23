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

function classifyRiskApprovalPreview(preview = null) {
  const decision = String(preview?.decision || '').toUpperCase();
  if (!preview || preview.approved == null || decision === 'PREVIEW_FAILED' || preview.error) {
    return 'unavailable';
  }
  if (preview.approved === false || decision === 'REJECT') return 'rejected';
  if (decision === 'ADJUST') return 'adjust';
  return 'pass';
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
  const previewStatus = classifyRiskApprovalPreview(riskApprovalPreview);

  const common = {
    mode,
    modeConfig: resolvedModeConfig,
    previewStatus,
    previewDecision: riskApprovalPreview?.decision || null,
    previewApproved: riskApprovalPreview?.approved ?? null,
  };

  if (!Number.isFinite(before) || before <= 0) {
    return {
      ...common,
      approved: false,
      amountUsdt: 0,
      adaptiveResult,
      applied: true,
      reason: 'risk approval chain invalid amount',
    };
  }

  if (mode === 'shadow') {
    return {
      ...common,
      approved: true,
      amountUsdt: before,
      adaptiveResult,
      applied: false,
      reason: 'shadow mode records preview only',
    };
  }

  if (previewStatus === 'unavailable') {
    return {
      ...common,
      approved: true,
      amountUsdt: before,
      adaptiveResult,
      applied: false,
      reason: `${mode} mode skipped because preview is unavailable`,
    };
  }

  if (mode === 'enforce' && previewRejected && resolvedModeConfig.enforce?.rejectOnPreviewReject) {
    return {
      ...common,
      approved: false,
      amountUsdt: before,
      adaptiveResult,
      applied: true,
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
      ...common,
      approved: true,
      amountUsdt: before,
      adaptiveResult,
      applied: false,
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
      ...common,
      approved: true,
      amountUsdt: before,
      adaptiveResult,
      applied: false,
      reason: `${mode} reduction bounded to original amount`,
    };
  }

  return {
    ...common,
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
    reason: `risk approval chain ${mode} amount reduction`,
  };
}
