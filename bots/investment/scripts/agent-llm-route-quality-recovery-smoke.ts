#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { recordInvestmentLlmRouteLog } from '../shared/hub-llm-client.ts';
import { buildAgentLlmRouteQualityReport } from '../shared/agent-memory-operational-policy.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSmoke() {
  const agentName = `route-recovery-smoke-${Date.now()}`;
  const incidentKey = `route-recovery:${Date.now()}`;
  try {
    await recordInvestmentLlmRouteLog({
      agentName,
      provider: 'failed',
      ok: false,
      market: 'binance',
      taskType: 'final_decision',
      latencyMs: 25,
      incidentKey,
      error: 'synthetic_provider_failure',
    });
    await recordInvestmentLlmRouteLog({
      agentName,
      provider: 'failed',
      ok: false,
      market: 'binance',
      taskType: 'final_decision',
      latencyMs: 30,
      incidentKey,
      error: 'synthetic_provider_failure',
    });
    await delay(25);
    await recordInvestmentLlmRouteLog({
      agentName,
      provider: 'openai-oauth',
      ok: true,
      market: 'binance',
      taskType: 'final_decision',
      latencyMs: 2400,
      incidentKey,
      routeChain: [{ provider: 'openai-oauth', model: 'gpt-5.4-mini' }],
    });

    const report = await buildAgentLlmRouteQualityReport({
      days: 1,
      market: 'binance',
      minCalls: 2,
    });
    const suggestion = report.suggestions.find((item) => item.agent === agentName);
    assert.ok(suggestion, 'recovery suggestion should be present');
    assert.equal(suggestion.type, 'route_failure_resolved_by_success', 'failure should be downgraded when later success exists');
    assert.equal(suggestion.severity, 'low', 'resolved failure must not block operator');
    assert.equal(report.ok, true, 'resolved route failure should not make route quality fail');

    return {
      ok: true,
      smoke: 'agent-llm-route-quality-recovery',
      suggestion,
    };
  } finally {
    await db.run(`DELETE FROM investment.llm_routing_log WHERE incident_key = $1`, [incidentKey]).catch(() => null);
  }
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('agent-llm-route-quality-recovery-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ agent-llm-route-quality-recovery-smoke 실패:',
  });
}

