#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { handleTask } from '../a2a/handlers/task-handler.ts';
import { createDynamicTpSlShadowHandler, registerDynamicTpSlShadowSkill } from '../a2a/skills/dynamic-tpsl-shadow.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function fakeQuery(sql) {
  if (sql.includes('luna_dynamic_tpsl_shadow')) {
    return [{
      trigger_id: 'trigger-BTC/USDT',
      symbol: 'BTC/USDT',
      exchange: 'binance',
      market: 'crypto',
      entry_price: 100,
      side: 'BUY',
      rule_tp_pct: 0.055,
      rule_sl_pct: 0.0275,
      rule_tp_price: 105.5,
      rule_sl_price: 97.25,
      llm_tp_pct: 0.06,
      llm_sl_pct: 0.03,
      llm_tp_price: 106,
      llm_sl_price: 97,
      rr_ratio: 2,
      reasoning: 'smoke tpsl shadow valid',
      risk_assessment: { risk_level: 'medium' },
      rule_tpsl: { source: 'atr_regime_policy' },
      context_evidence: { openPositions: { sameSymbolOpen: 0 } },
      match: true,
      observed_at: '2026-05-11T00:00:00.000Z',
    }];
  }
  return [];
}

export async function runLunaDynamicTpSlA2ASmoke() {
  registerDynamicTpSlShadowSkill({ queryFn: fakeQuery });

  const result = await handleTask({
    id: 'dynamic-tpsl-a2a-smoke-1',
    skill: { id: 'dynamic-tpsl-shadow' },
    params: { symbol: 'BTC/USDT', exchange: 'binance' },
  });
  assert.equal(result.id, 'dynamic-tpsl-a2a-smoke-1');
  assert.equal(result.status, 'completed');
  assert.equal(result.output.ok, true);
  assert.equal(result.output.skill, 'dynamic-tpsl-shadow');
  assert.equal(result.output.dataHealth, 'shadow_ready');
  assert.equal(result.output.ruleTpSl.tpPct, 0.055);
  assert.equal(result.output.llmTpSl.tpPct, 0.06);
  assert.equal(result.output.rrRatio, 2);
  assert.equal(result.output.match, true);
  assert.equal(result.output.broadcastPlanned, false);

  const previous = process.env.LUNA_A2A_BROADCAST_ENABLED;
  process.env.LUNA_A2A_BROADCAST_ENABLED = 'true';
  const enabled = await createDynamicTpSlShadowHandler({ queryFn: fakeQuery })({
    symbol: 'BTC/USDT',
    exchange: 'binance',
  });
  assert.equal(enabled.output.broadcastPlanned, true);
  if (previous == null) delete process.env.LUNA_A2A_BROADCAST_ENABLED;
  else process.env.LUNA_A2A_BROADCAST_ENABLED = previous;

  const candidateOnly = await createDynamicTpSlShadowHandler({ queryFn: () => [] })({
    symbol: 'ETH/USDT',
    exchange: 'binance',
    entryPrice: 100,
    atr: 2,
    setupType: 'breakout',
  });
  assert.equal(candidateOnly.status, 'completed');
  assert.equal(candidateOnly.output.dataHealth, 'candidate_only');
  assert.equal(candidateOnly.output.llmTpSl, null);
  assert(candidateOnly.output.ruleTpSl.tpPct > candidateOnly.output.ruleTpSl.slPct);

  return {
    ok: true,
    smoke: 'luna-dynamic-tpsl-a2a-phase3',
    skill: result.output.skill,
    broadcastDefault: result.output.broadcastPlanned,
    broadcastEnabled: enabled.output.broadcastPlanned,
    candidateOnly: candidateOnly.output.dataHealth,
  };
}

async function main() {
  const result = await runLunaDynamicTpSlA2ASmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna dynamic TP/SL A2A smoke 실패:',
  });
}
