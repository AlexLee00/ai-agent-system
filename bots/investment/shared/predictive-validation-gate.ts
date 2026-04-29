// @ts-nocheck

import { buildPredictiveValidationEvidence } from './predictive-validation.ts';

const ACTION_BUY = 'BUY';
const ACTION_HOLD = 'HOLD';

function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export function applyPredictiveValidationGate(decisions = [], predictiveConfig = { mode: 'advisory', threshold: 0.55 }) {
  const next = [];
  let blocked = 0;
  let advisory = 0;
  for (const decision of decisions || []) {
    if (decision?.action !== ACTION_BUY) {
      next.push(decision);
      continue;
    }
    const evidence = buildPredictiveValidationEvidence(decision, {}, predictiveConfig || {});
    const predictiveScore = clamp01(evidence?.score, 0);
    const threshold = clamp01(evidence?.threshold ?? predictiveConfig?.threshold ?? 0.55, 0.55);
    if (predictiveScore >= threshold) {
      next.push({
        ...decision,
        predictiveScore,
        block_meta: {
          ...(decision?.block_meta || {}),
          predictiveValidation: {
            ...(decision?.block_meta?.predictiveValidation || {}),
            ...evidence,
            blocked: false,
          },
        },
      });
      continue;
    }
    if (predictiveConfig?.mode === 'hard_gate') {
      blocked++;
      next.push({
        ...decision,
        action: ACTION_HOLD,
        amount_usdt: 0,
        predictiveScore,
        reasoning: `predictive_gate_blocked(${predictiveScore.toFixed(2)} < ${threshold.toFixed(2)}) | ${decision.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(decision?.block_meta || {}),
          event_type: 'predictive_gate_blocked',
          predictiveValidation: {
            ...evidence,
            mode: 'hard_gate',
            blocked: true,
          },
        },
      });
      continue;
    }
    advisory++;
    next.push({
      ...decision,
      predictiveScore,
      reasoning: `predictive_advisory(${predictiveScore.toFixed(2)} < ${threshold.toFixed(2)}) | ${decision.reasoning || ''}`.slice(0, 220),
      block_meta: {
        ...(decision?.block_meta || {}),
        predictiveValidation: {
          ...evidence,
          mode: 'advisory',
          blocked: false,
        },
      },
    });
  }
  return {
    decisions: next,
    blocked,
    advisory,
  };
}

export default applyPredictiveValidationGate;
