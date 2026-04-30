// @ts-nocheck
import { classifySignalFailure } from './signal-failure-classifier.ts';

export function buildFailedSignalReflexion(signal = {}, context = {}) {
  const classification = classifySignalFailure(signal);
  const lesson = {
    symbol: signal.symbol ?? null,
    failureKind: classification.kind,
    rootCause: classification.kind,
    correctiveAction: classification.retryable ? 'defer_and_retry_with_guard' : 'manual_review_before_retry',
    promptHint: `Avoid repeating ${classification.kind} without fresh evidence.`,
    confidence: classification.confidence,
  };
  return {
    ok: true,
    dryRun: context.dryRun !== false,
    classification,
    lesson,
    memoryEvent: {
      type: 'failed_signal_reflexion',
      payload: lesson,
    },
  };
}

export default { buildFailedSignalReflexion };
