#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { handleTask } from '../a2a/handlers/task-handler.ts';
import { createFactorModelShadowHandler, registerFactorModelShadowSkill } from '../a2a/skills/factor-model-shadow.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function fakeQuery(sql) {
  if (sql.includes('luna_factor_model_shadow')) {
    return [{
      symbol: 'BTC/USDT',
      exchange: 'binance',
      market: 'crypto',
      factor_scores: {
        momentum: { score: 0.78, available: true, source: 'ohlcv_return' },
        liquidity: { score: 0.83, available: true, source: 'quote_volume' },
      },
      composite_score: 0.74,
      rank: 1,
      allocation_hint: { tier: 'medium_shadow_candidate', suggestedPositionSizePct: 0.078 },
      data_health: 'ready',
      shadow_only: true,
      observed_at: '2026-05-12T00:00:00.000Z',
    }];
  }
  return [];
}

export async function runLunaFactorModelA2ASmoke() {
  registerFactorModelShadowSkill({ queryFn: fakeQuery });

  const result = await handleTask({
    id: 'factor-model-a2a-smoke-1',
    skill: { id: 'factor-model-shadow' },
    params: { symbol: 'BTC/USDT', exchange: 'binance' },
  });
  assert.equal(result.id, 'factor-model-a2a-smoke-1');
  assert.equal(result.status, 'completed');
  assert.equal(result.output.ok, true);
  assert.equal(result.output.skill, 'factor-model-shadow');
  assert.equal(result.output.dataHealth, 'shadow_ready');
  assert.equal(result.output.symbols[0], 'BTC/USDT');
  assert.equal(result.output.ranks[0].rank, 1);
  assert.equal(result.output.allocationHints['BTC/USDT'].tier, 'medium_shadow_candidate');
  assert.equal(result.output.broadcastPlanned, false);

  const previous = process.env.LUNA_A2A_BROADCAST_ENABLED;
  process.env.LUNA_A2A_BROADCAST_ENABLED = 'true';
  const enabled = await createFactorModelShadowHandler({ queryFn: fakeQuery })({
    symbol: 'BTC/USDT',
    exchange: 'binance',
  });
  assert.equal(enabled.output.broadcastPlanned, true);
  if (previous == null) delete process.env.LUNA_A2A_BROADCAST_ENABLED;
  else process.env.LUNA_A2A_BROADCAST_ENABLED = previous;

  const candidateOnly = await createFactorModelShadowHandler({ queryFn: () => [] })({
    symbol: 'NVDA',
    exchange: 'kis_overseas',
    confidence: 0.72,
    fundamentals: { pe: 18, pb: 2, roe: 0.16, margin: 0.18, debtToEquity: 0.4 },
    bars: [
      { close: 900, high: 910, low: 890, volume: 1000 },
      { close: 920, high: 930, low: 905, volume: 1200 },
      { close: 940, high: 950, low: 925, volume: 1500 },
      { close: 960, high: 970, low: 945, volume: 1800 },
      { close: 990, high: 1000, low: 970, volume: 2100 },
    ],
  });
  assert.equal(candidateOnly.status, 'completed');
  assert.equal(candidateOnly.output.dataHealth, 'ready');
  assert.equal(candidateOnly.output.market, 'overseas');
  assert.equal(candidateOnly.output.ranks[0].rank, null);

  return {
    ok: true,
    smoke: 'luna-factor-model-a2a-phase5',
    skill: result.output.skill,
    broadcastDefault: result.output.broadcastPlanned,
    broadcastEnabled: enabled.output.broadcastPlanned,
    candidateOnly: candidateOnly.output.dataHealth,
  };
}

async function main() {
  const result = await runLunaFactorModelA2ASmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna factor model A2A smoke 실패:',
  });
}
