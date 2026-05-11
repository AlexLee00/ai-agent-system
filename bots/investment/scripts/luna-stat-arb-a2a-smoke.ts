#!/usr/bin/env node

import assert from 'node:assert/strict';
import { handleTask } from '../a2a/handlers/task-handler.ts';
import { createStatArbShadowHandler, registerStatArbShadowSkill } from '../a2a/skills/stat-arb-shadow.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function fakeQuery(sql) {
  if (sql.includes('luna_stat_arb_shadow')) {
    return [{
      strategy_type: 'pairs_trading',
      symbols: ['BTC/USDT', 'ETH/USDT'],
      exchange: 'binance',
      market: 'crypto',
      pair_metrics: { samples: 40, hedgeRatio: 1.2 },
      mean_reversion_metrics: {},
      signal: 'pair_watch',
      z_score: 1.5,
      confidence: 0.58,
      data_health: 'ready',
      shadow_only: true,
      observed_at: '2026-05-12T00:00:00.000Z',
    }];
  }
  return [];
}

export async function runLunaStatArbA2ASmoke() {
  registerStatArbShadowSkill({ queryFn: fakeQuery });

  const result = await handleTask({
    id: 'stat-arb-a2a-smoke-1',
    skill: { id: 'stat-arb-shadow' },
    params: { strategyType: 'pairs_trading', symbol: 'BTC/USDT', exchange: 'binance' },
  });
  assert.equal(result.id, 'stat-arb-a2a-smoke-1');
  assert.equal(result.status, 'completed');
  assert.equal(result.output.ok, true);
  assert.equal(result.output.skill, 'stat-arb-shadow');
  assert.equal(result.output.strategyType, 'pairs_trading');
  assert.equal(result.output.symbols[0], 'BTC/USDT');
  assert.equal(result.output.dataHealth, 'ready');
  assert.equal(result.output.broadcastPlanned, false);

  const previous = process.env.LUNA_A2A_BROADCAST_ENABLED;
  process.env.LUNA_A2A_BROADCAST_ENABLED = 'true';
  const enabled = await createStatArbShadowHandler({ queryFn: fakeQuery })({
    strategyType: 'pairs_trading',
    symbol: 'BTC/USDT',
    exchange: 'binance',
  });
  assert.equal(enabled.output.broadcastPlanned, true);
  if (previous == null) delete process.env.LUNA_A2A_BROADCAST_ENABLED;
  else process.env.LUNA_A2A_BROADCAST_ENABLED = previous;

  const candidateOnly = await createStatArbShadowHandler({ queryFn: () => [] })({
    strategyType: 'mean_reversion',
    symbol: 'NVDA',
    exchange: 'kis_overseas',
    bars: [
      { close: 900 },
      { close: 910 },
      { close: 920 },
      { close: 915 },
      { close: 905 },
      { close: 895 },
      { close: 890 },
      { close: 885 },
      { close: 880 },
      { close: 875 },
      { close: 870 },
      { close: 865 },
      { close: 860 },
      { close: 855 },
      { close: 850 },
      { close: 845 },
      { close: 840 },
      { close: 835 },
      { close: 830 },
      { close: 825 },
    ],
  });
  assert.equal(candidateOnly.status, 'completed');
  assert.equal(candidateOnly.output.strategyType, 'mean_reversion');
  assert.equal(candidateOnly.output.market, 'overseas');
  assert.equal(candidateOnly.output.dataHealth, 'ready');

  return {
    ok: true,
    smoke: 'luna-stat-arb-a2a-phase6',
    skill: result.output.skill,
    broadcastDefault: result.output.broadcastPlanned,
    broadcastEnabled: enabled.output.broadcastPlanned,
    candidateOnly: candidateOnly.output.dataHealth,
  };
}

async function main() {
  const result = await runLunaStatArbA2ASmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna stat arb A2A smoke failed:',
  });
}
