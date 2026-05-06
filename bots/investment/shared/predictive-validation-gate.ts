// @ts-nocheck

import { buildPredictiveValidationEvidence } from './predictive-validation.ts';

const ACTION_BUY = 'BUY';
const ACTION_HOLD = 'HOLD';

function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function isObservationEligible(evidence = {}, predictiveConfig = {}) {
  if (predictiveConfig?.observationLaneEnabled === false) return false;
  if (evidence?.decision !== 'hold') return false;
  const score = clamp01(evidence?.score, 0);
  const observationThreshold = clamp01(
    predictiveConfig?.observationThreshold ?? predictiveConfig?.holdThreshold ?? predictiveConfig?.discardThreshold ?? 0.40,
    0.40,
  );
  return score >= observationThreshold;
}

export function applyPredictiveValidationGate(decisions = [], predictiveConfig = { mode: 'advisory', threshold: 0.55 }) {
  const next = [];
  let blocked = 0;
  let advisory = 0;
  let observation = 0;
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
      if (isObservationEligible(evidence, predictiveConfig)) {
        observation++;
        next.push({
          ...decision,
          predictiveScore,
          reasoning: `predictive_observation(${predictiveScore.toFixed(2)} < ${threshold.toFixed(2)}) | ${decision.reasoning || ''}`.slice(0, 220),
          block_meta: {
            ...(decision?.block_meta || {}),
            event_type: 'predictive_observation_lane',
            predictiveValidation: {
              ...evidence,
              mode: 'hard_gate_observation',
              blocked: false,
              observation: true,
              sizeRatio: clamp01(predictiveConfig?.observationSizeRatio, 0.35),
            },
          },
        });
        continue;
      }
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
    observation,
  };
}

export default applyPredictiveValidationGate;
