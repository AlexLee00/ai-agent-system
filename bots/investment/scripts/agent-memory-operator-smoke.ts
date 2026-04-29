#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { recordInvestmentLlmRouteLog } from '../shared/hub-llm-client.ts';
import { buildAgentLlmRouteQualityReport } from '../shared/agent-memory-operational-policy.ts';
import { runAgentMemoryOperator } from './runtime-agent-memory-operator.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  const agentName = `operator-smoke-${Date.now()}`;
  try {
    await recordInvestmentLlmRouteLog({
      agentName,
      provider: 'smoke-provider',
      ok: false,
      fallbackUsed: true,
      market: 'crypto',
      taskType: 'final_decision',
      latencyMs: 25,
      error: 'smoke_failure',
    });
    await recordInvestmentLlmRouteLog({
      agentName,
      provider: 'smoke-provider',
      ok: false,
      fallbackUsed: true,
      market: 'crypto',
      taskType: 'final_decision',
      latencyMs: 35,
      error: 'smoke_failure',
    });

    const quality = await buildAgentLlmRouteQualityReport({ days: 1, market: 'crypto', minCalls: 2 });
    assert.ok(quality.suggestions.some((item) => item.agent === agentName), 'route quality suggestion created');

    const report = await runAgentMemoryOperator({
      days: 1,
      market: 'crypto',
      staleHours: 1,
      dryRun: true,
    });
    assert.ok(Array.isArray(report.suggestions), 'operator suggestions array');
    assert.ok(report.activationPlan?.nextPhase !== undefined, 'activation plan present');
    assert.ok(report.dashboardSummary, 'dashboard summary present');
    assert.ok(report.routeQuality?.rows?.length >= 1, 'route quality included');

    return {
      ok: true,
      status: report.status,
      suggestions: report.suggestions.length,
      routeSuggestions: report.routeQuality.suggestions.length,
    };
  } finally {
    await db.run(`DELETE FROM investment.llm_routing_log WHERE agent_name = $1`, [agentName]).catch(() => null);
  }
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('agent-memory-operator-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ agent-memory-operator-smoke 실패:',
  });
}
