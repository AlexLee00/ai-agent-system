// @ts-nocheck
import { classifySignalFailure } from './signal-failure-classifier.ts';

export function buildFailedSignalRecoveryPlan(signal = {}, opts = {}) {
  const classification = classifySignalFailure(signal);
  const now = opts.now ? new Date(opts.now) : new Date();
  const retryAt = classification.delayMs == null ? null : new Date(now.getTime() + classification.delayMs).toISOString();
  return {
    dryRun: opts.dryRun !== false,
    signalId: signal.id ?? signal.signalId ?? null,
    symbol: signal.symbol ?? null,
    action: signal.action ?? null,
    classification,
    recoveryState: classification.retryable ? 'queued' : 'blocked',
    retryAt,
    requiresConfirm: !classification.retryable,
    operations: classification.retryable
      ? [{ type: 'defer_signal', retryAt, reason: classification.kind }]
      : [{ type: 'create_manual_review', reason: classification.kind }],
  };
}

export function summarizeRecoveryPlans(signals = [], opts = {}) {
  const plans = signals.map((signal) => buildFailedSignalRecoveryPlan(signal, opts));
  return {
    ok: true,
    total: plans.length,
    queued: plans.filter((plan) => plan.recoveryState === 'queued').length,
    blocked: plans.filter((plan) => plan.recoveryState === 'blocked').length,
    plans,
  };
}

export default { buildFailedSignalRecoveryPlan, summarizeRecoveryPlans };
