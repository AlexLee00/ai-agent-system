// @ts-nocheck

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
    const predictiveScore = clamp01(
      decision?.predictiveScore
      ?? decision?.strategy_route?.predictiveScore
      ?? decision?.strategyRoute?.predictiveScore
      ?? decision?.confidence
      ?? 0,
      0,
    );
    const threshold = clamp01(predictiveConfig?.threshold ?? 0.55, 0.55);
    if (predictiveScore >= threshold) {
      next.push({
        ...decision,
        predictiveScore,
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
            mode: 'hard_gate',
            threshold,
            score: predictiveScore,
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
          mode: 'advisory',
          threshold,
          score: predictiveScore,
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
