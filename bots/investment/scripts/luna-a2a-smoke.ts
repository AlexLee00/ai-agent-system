#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { handleTask } from '../a2a/handlers/task-handler.ts';
import { createMarketRegimeAnalysisHandler, registerMarketRegimeAnalysisSkill } from '../a2a/skills/market-regime-analysis.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function fakeQuery(sql, params = []) {
  const market = params[0] || 'crypto';
  if (sql.includes('market_regime_snapshots')) {
    return [{
      market,
      regime: 'trending_bull',
      confidence: 0.72,
      indicators: { source: 'smoke' },
      captured_at: '2026-05-11T00:00:00.000Z',
    }];
  }
  if (sql.includes('luna_regime_llm_shadow')) {
    return [{
      rule_regime: 'trending_bull',
      rule_confidence: 0.72,
      llm_regime: 'trending_bull',
      llm_confidence: 0.81,
      llm_rationale: 'smoke shadow agreement',
      llm_duration: '단기',
      llm_key_signals: ['rule_align', 'confidence_high'],
      match: true,
      captured_at: '2026-05-11T00:01:00.000Z',
    }];
  }
  return [];
}

export async function runLunaA2ASmoke() {
  registerMarketRegimeAnalysisSkill({ queryFn: fakeQuery });

  const result = await handleTask({
    id: 'smoke-task-1',
    skill: { id: 'market-regime-analysis' },
    params: { market: 'crypto' },
  });

  assert.equal(result.id, 'smoke-task-1');
  assert.equal(result.status, 'completed');
  assert.equal(result.output.ok, true);
  assert.equal(result.output.skill, 'market-regime-analysis');
  assert.equal(result.output.market, 'crypto');
  assert.equal(result.output.shadowMode, true);
  assert.equal(result.output.dataHealth, 'shadow_ready');
  assert.equal(result.output.ruleRegime, 'trending_bull');
  assert.equal(result.output.llmRegime, 'trending_bull');
  assert.equal(result.output.confidence, 0.81);
  assert.equal(result.output.match, true);
  assert.equal(result.output.broadcastPlanned, false);

  const previous = process.env.LUNA_A2A_BROADCAST_ENABLED;
  process.env.LUNA_A2A_BROADCAST_ENABLED = 'true';
  const enabled = await createMarketRegimeAnalysisHandler({ queryFn: fakeQuery })({ market: 'overseas' });
  assert.equal(enabled.output.broadcastPlanned, true);
  assert.equal(enabled.output.market, 'overseas');
  if (previous == null) delete process.env.LUNA_A2A_BROADCAST_ENABLED;
  else process.env.LUNA_A2A_BROADCAST_ENABLED = previous;

  return {
    ok: true,
    smoke: 'luna-a2a-phase1',
    skill: result.output.skill,
    dataHealth: result.output.dataHealth,
    broadcastDefault: result.output.broadcastPlanned,
    broadcastEnabled: enabled.output.broadcastPlanned,
  };
}

async function main() {
  const result = await runLunaA2ASmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna A2A smoke 실패:',
  });
}
