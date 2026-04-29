#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { recordInvestmentLlmRouteLog } from '../shared/hub-llm-client.ts';
import { buildAgentLlmRouteQualityReport } from '../shared/agent-memory-operational-policy.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runLunaLlmRouteQualityReportSmoke() {
  const agentName = `luna-route-quality-smoke-${Date.now()}`;
  const incidentKey = `luna-route-quality:${Date.now()}`;
  try {
    for (let i = 0; i < 2; i += 1) {
      await recordInvestmentLlmRouteLog({
        agentName,
        provider: 'failed',
        ok: false,
        market: 'binance',
        taskType: 'final_decision',
        latencyMs: 100,
        incidentKey,
        error: 'provider_cooldown',
        routeChain: [{ provider: 'openai-oauth', model: 'gpt-5.4' }],
      });
    }

    const report = await buildAgentLlmRouteQualityReport({
      days: 1,
      market: 'binance',
      minCalls: 2,
    });
    const suggestion = report.suggestions.find((item) => item.agent === agentName);
    assert.ok(suggestion, 'route quality suggestion should be present');
    assert.equal(suggestion.providerLabel, 'failed(openai-oauth)', 'failed provider should expose route-chain provider label');
    assert.equal(suggestion.failureKind, 'cooldown', 'failure kind should classify cooldown');
    assert.deepEqual(suggestion.routeProviders, ['openai-oauth'], 'route providers should be extracted from failed chain');

    return {
      ok: true,
      smoke: 'luna-llm-route-quality-report',
      suggestion,
    };
  } finally {
    await db.run(`DELETE FROM investment.llm_routing_log WHERE incident_key = $1`, [incidentKey]).catch(() => null);
  }
}

async function main() {
  const result = await runLunaLlmRouteQualityReportSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-llm-route-quality-report-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-llm-route-quality-report-smoke 실패:',
  });
}

