// @ts-nocheck

import { resolvePositionLifecycleFlags } from './position-lifecycle-flags.ts';

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function round(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round(Number(value || 0) * scale) / scale;
}

function computeHalfKelly({ winRate = 0.5, rewardRisk = 1.5 } = {}) {
  const p = clamp(winRate, 0.01, 0.99);
  const b = Math.max(0.1, Number(rewardRisk || 1.5));
  const rawKelly = ((p * (b + 1)) - 1) / b;
  return clamp(rawKelly / 2, -1, 1);
}

export function computeDynamicPositionSizing(input = {}) {
  const flags = resolvePositionLifecycleFlags();
  const enabled = flags.shouldApplyDynamicSizing();
  const shadowMode = !enabled;
  const pnlPct = n(input.pnlPct, 0);
  const currentWeight = clamp(n(input.currentWeightPct, 0.12), 0, 1);
  const targetVolatility = Math.max(0.0001, n(input.targetVolatility, 0.03));
  const realizedVolatility = Math.max(0, n(input.realizedVolatility, targetVolatility));
  const rewardRisk = Math.max(0.1, n(input.rewardRisk, 1.6));
  const winRate = clamp(n(input.winRate, 0.5), 0.01, 0.99);
  const halfKelly = computeHalfKelly({ winRate, rewardRisk });
  const kellyTargetWeight = clamp(halfKelly * flags.phaseE.kellyHalfCap, 0, 1);
  const momentumBoost = clamp((pnlPct - 1) / 20, 0, flags.phaseE.maxPyramidRatio);
  const defensiveFloor = clamp(currentWeight * 0.85, 0, 1);
  const targetWeight = clamp(Math.max(kellyTargetWeight + momentumBoost, defensiveFloor), 0, 1);

  const volatilityRatio = targetVolatility > 0 ? realizedVolatility / targetVolatility : 1;
  const sizingGap = targetWeight - currentWeight;

  const base = {
    enabled,
    shadowMode,
    reasonCode: 'sizing_hold',
    mode: 'hold',
    executionAction: 'HOLD',
    runnerHint: null,
    adjustmentRatio: 0,
    targetWeight,
    currentWeight,
    realizedVolatility,
    targetVolatility,
    volatilityRatio: round(volatilityRatio, 4),
    halfKelly: round(halfKelly, 4),
    details: {
      winRate: round(winRate, 4),
      rewardRisk: round(rewardRisk, 4),
      sizingGap: round(sizingGap, 4),
    },
  };

  if (!enabled) {
    return {
      ...base,
      reasonCode: 'dynamic_position_sizing_shadow',
      details: {
        ...base.details,
        note: 'dynamic position sizing disabled/shadow',
      },
    };
  }

  if (volatilityRatio >= 1.35) {
    const ratio = clamp((volatilityRatio - 1) * 0.5, 0.1, flags.phaseE.maxTrimRatio);
    return {
      ...base,
      mode: 'trim',
      executionAction: 'SELL',
      runnerHint: 'runtime:partial-adjust',
      reasonCode: 'volatility_target_trim',
      adjustmentRatio: round(ratio, 4),
    };
  }

  if (Math.abs(sizingGap) >= 0.04) {
    if (sizingGap < 0) {
      return {
        ...base,
        mode: 'trim',
        executionAction: 'SELL',
        runnerHint: 'runtime:partial-adjust',
        reasonCode: 'kelly_size_correction',
        adjustmentRatio: round(clamp(Math.abs(sizingGap), 0.05, flags.phaseE.maxTrimRatio), 4),
      };
    }

    if (pnlPct >= 1.5 && volatilityRatio <= 1.15) {
      return {
        ...base,
        mode: 'pyramid',
        executionAction: 'BUY',
        runnerHint: 'runtime:pyramid-adjust',
        reasonCode: 'pyramid_continuation',
        adjustmentRatio: round(clamp(sizingGap, 0.05, flags.phaseE.maxPyramidRatio), 4),
      };
    }
  }

  return base;
}

export default {
  computeDynamicPositionSizing,
};
