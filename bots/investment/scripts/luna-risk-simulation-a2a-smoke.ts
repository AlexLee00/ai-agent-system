#!/usr/bin/env node

import assert from 'node:assert/strict';
import { handleTask } from '../a2a/handlers/task-handler.ts';
import {
  createRiskSimulationShadowHandler,
  registerRiskSimulationShadowSkills,
} from '../a2a/skills/risk-simulation-shadow.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function fakeQuery(sql) {
  if (sql.includes('luna_risk_simulation_shadow')) {
    return [{
      analysis_type: 'stress_test',
      symbols: ['BTC/USDT'],
      exchange: 'binance',
      market: 'crypto',
      scenario: '2022_luna_ftx',
      simulations: 1,
      var_95: 0.45,
      var_99: 0.55,
      cvar_95: 0.53,
      cvar_99: 0.62,
      max_loss_estimate: 0.7,
      recovery_days_estimate: 90,
      risk_limits: { dailyLossPct: 0.05 },
      scenario_metrics: { riskLevel: 'critical' },
      data_health: 'ready',
      context_evidence: { source: 'fixture' },
      shadow_only: true,
      observed_at: '2026-05-12T00:00:00.000Z',
    }];
  }
  return [];
}

export async function runLunaRiskSimulationA2ASmoke() {
  registerRiskSimulationShadowSkills({ queryFn: fakeQuery });

  const result = await handleTask({
    id: 'risk-sim-a2a-smoke-1',
    skill: { id: 'risk-simulation-shadow' },
    params: {
      analysisType: 'stress_test',
      symbol: 'BTC/USDT',
      exchange: 'binance',
      scenario: '2022_luna_ftx',
    },
  });
  assert.equal(result.id, 'risk-sim-a2a-smoke-1');
  assert.equal(result.status, 'completed');
  assert.equal(result.output.ok, true);
  assert.equal(result.output.skill, 'risk-simulation-shadow');
  assert.equal(result.output.analysisType, 'stress_test');
  assert.equal(result.output.symbols[0], 'BTC/USDT');
  assert.equal(result.output.dataHealth, 'ready');
  assert.equal(result.output.broadcastPlanned, false);

  const previous = process.env.LUNA_A2A_BROADCAST_ENABLED;
  process.env.LUNA_A2A_BROADCAST_ENABLED = 'true';
  const enabled = await createRiskSimulationShadowHandler({ queryFn: fakeQuery })({
    analysisType: 'stress_test',
    symbol: 'BTC/USDT',
    exchange: 'binance',
    scenario: '2022_luna_ftx',
  });
  assert.equal(enabled.output.broadcastPlanned, true);
  if (previous == null) delete process.env.LUNA_A2A_BROADCAST_ENABLED;
  else process.env.LUNA_A2A_BROADCAST_ENABLED = previous;

  const candidateOnly = await createRiskSimulationShadowHandler({
    queryFn: () => [],
    skillId: 'monte-carlo-shadow',
  })({
    analysisType: 'monte_carlo',
    symbols: ['NVDA'],
    exchange: 'kis_overseas',
    barsBySymbol: {
      NVDA: Array.from({ length: 90 }, (_, index) => ({ close: 800 + index * 2 })),
    },
    simulations: 200,
  });
  assert.equal(candidateOnly.status, 'completed');
  assert.equal(candidateOnly.output.skill, 'monte-carlo-shadow');
  assert.equal(candidateOnly.output.analysisType, 'monte_carlo');
  assert.equal(candidateOnly.output.market, 'overseas');
  assert.equal(candidateOnly.output.dataHealth, 'ready');

  const stressAliasCandidateOnly = await createRiskSimulationShadowHandler({
    queryFn: () => [],
    skillId: 'stress-test-shadow',
    defaultAnalysisType: 'stress_test',
  })({
    symbols: ['BTC/USDT'],
    exchange: 'binance',
    scenario: '2022_luna_ftx',
    barsBySymbol: {
      'BTC/USDT': Array.from({ length: 90 }, (_, index) => ({ close: 100 - index * 0.5 })),
    },
  });
  assert.equal(stressAliasCandidateOnly.status, 'completed');
  assert.equal(stressAliasCandidateOnly.output.skill, 'stress-test-shadow');
  assert.equal(stressAliasCandidateOnly.output.analysisType, 'stress_test');
  assert.equal(stressAliasCandidateOnly.output.market, 'crypto');
  assert.equal(stressAliasCandidateOnly.output.dataHealth, 'ready');

  return {
    ok: true,
    smoke: 'luna-risk-simulation-a2a-phase8',
    skill: result.output.skill,
    broadcastDefault: result.output.broadcastPlanned,
    broadcastEnabled: enabled.output.broadcastPlanned,
    candidateOnly: candidateOnly.output.dataHealth,
    stressAliasDefault: stressAliasCandidateOnly.output.analysisType,
  };
}

async function main() {
  const result = await runLunaRiskSimulationA2ASmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna risk simulation A2A smoke failed:',
  });
}
