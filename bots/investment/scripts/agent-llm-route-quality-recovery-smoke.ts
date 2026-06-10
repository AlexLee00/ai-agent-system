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
  const fallbackAgentName = `route-fallback-smoke-${Date.now()}`;
  const fallbackIncidentKey = `hub-llm-client-payload-smoke:${Date.now()}`;
  const market = `smoke_route_recovery_${Date.now()}`;
  const routeChain = [{ provider: 'openai-oauth', model: 'gpt-5.4-mini' }];
  try {
    await recordInvestmentLlmRouteLog({
      agentName,
      provider: 'failed',
      ok: false,
      market,
      taskType: 'final_decision',
      latencyMs: 25,
      incidentKey,
      error: 'synthetic_provider_failure',
      routeChain,
    });
    await recordInvestmentLlmRouteLog({
      agentName,
      provider: 'failed',
      ok: false,
      market,
      taskType: 'final_decision',
      latencyMs: 30,
      incidentKey,
      error: 'synthetic_provider_failure',
      routeChain,
    });
    await delay(25);
    await recordInvestmentLlmRouteLog({
      agentName,
      provider: 'openai-oauth',
      ok: true,
      market,
      taskType: 'final_decision',
      latencyMs: 2400,
      incidentKey,
      routeChain,
    });

    const report = await buildAgentLlmRouteQualityReport({
      days: 1,
      market,
      minCalls: 2,
    });
    const suggestion = report.suggestions.find((item) => item.agent === agentName);
    assert.ok(suggestion, 'recovery suggestion should be present');
    assert.equal(suggestion.type, 'route_failure_resolved_by_success', 'failure should be downgraded when later success exists');
    assert.equal(suggestion.severity, 'low', 'resolved failure must not block operator');
    assert.equal(suggestion.providerLabel, 'failed(openai-oauth)', 'failed provider should retain route provider label');
    assert.equal(report.ok, true, 'resolved route failure should not make route quality fail');

    for (let i = 0; i < 3; i += 1) {
      await recordInvestmentLlmRouteLog({
        agentName: fallbackAgentName,
        provider: 'direct_fallback',
        ok: true,
        taskType: 'default',
        incidentKey: fallbackIncidentKey,
        fallbackUsed: true,
        fallbackCount: 1,
        error: 'hub_disabled',
      });
    }
    const fallbackReport = await buildAgentLlmRouteQualityReport({
      days: 1,
      market: 'all',
      minCalls: 3,
    });
    const fallbackSuggestion = fallbackReport.suggestions.find((item) => item.agent === fallbackAgentName);
    assert.ok(fallbackSuggestion, 'hub-disabled fallback smoke suggestion should be present');
    assert.equal(
      fallbackSuggestion.type,
      'direct_fallback_smoke_artifact',
      'hub-disabled smoke incidents must not be reported as real direct fallback usage',
    );
    assert.equal(fallbackSuggestion.severity, 'low', 'hub-disabled smoke artifacts should be low severity');

    return {
      ok: true,
      smoke: 'agent-llm-route-quality-recovery',
      suggestion,
      fallbackSuggestion,
    };
  } finally {
    await db.run(`DELETE FROM investment.llm_routing_log WHERE incident_key = $1`, [incidentKey]).catch(() => null);
    await db.run(`DELETE FROM investment.llm_routing_log WHERE incident_key = $1`, [fallbackIncidentKey]).catch(() => null);
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
