#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { computeRegimePolicy } from '../shared/regime-strategy-policy.ts';
import { resolveRegimeExpansionPolicy } from '../shared/regime-expansion-policy.ts';

export function runLunaRegimeExpansionSmoke() {
  const previous = process.env.LUNA_REGIME_8WAY_ENABLED;
  try {
    delete process.env.LUNA_REGIME_8WAY_ENABLED;
    const disabled = computeRegimePolicy({
      market: 'crypto',
      regime: 'high_volatility_bull',
      setupType: 'momentum_breakout',
    });
    assert.equal(disabled.regime, 'trending_bull');

    process.env.LUNA_REGIME_8WAY_ENABLED = 'true';
    const highBull = computeRegimePolicy({
      market: 'crypto',
      regime: 'high_volatility_bull',
      setupType: 'momentum_breakout',
    });
    const lowBull = computeRegimePolicy({
      market: 'crypto',
      regime: 'low_volatility_bull',
      setupType: 'momentum_breakout',
    });
    const expansion = resolveRegimeExpansionPolicy('high_volatility_bear', { enabled: true });

    assert.equal(highBull.regime, 'high_volatility_bull');
    assert.equal(lowBull.regime, 'low_volatility_bull');
    assert.ok(highBull.positionSizeMultiplier < lowBull.positionSizeMultiplier, 'high volatility should size smaller');
    assert.ok(highBull.monitorProfile.includes('high_vol'), 'high volatility profile marker');
    assert.ok(lowBull.monitorProfile.includes('low_vol'), 'low volatility profile marker');
    assert.equal(expansion.baseRegime, 'trending_bear');

    return {
      ok: true,
      disabled: {
        input: 'high_volatility_bull',
        effective: disabled.regime,
      },
      enabled: {
        highBull: {
          regime: highBull.regime,
          positionSizeMultiplier: highBull.positionSizeMultiplier,
          cadenceMs: highBull.cadenceMs,
          monitorProfile: highBull.monitorProfile,
        },
        lowBull: {
          regime: lowBull.regime,
          positionSizeMultiplier: lowBull.positionSizeMultiplier,
          cadenceMs: lowBull.cadenceMs,
          monitorProfile: lowBull.monitorProfile,
        },
      },
    };
  } finally {
    if (previous == null) delete process.env.LUNA_REGIME_8WAY_ENABLED;
    else process.env.LUNA_REGIME_8WAY_ENABLED = previous;
  }
}

async function main() {
  const result = runLunaRegimeExpansionSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna regime expansion smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna regime expansion smoke 실패:',
  });
}
