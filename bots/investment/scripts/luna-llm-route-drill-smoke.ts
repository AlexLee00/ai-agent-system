#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildLunaLlmRouteDrill } from './luna-llm-route-drill.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runLunaLlmRouteDrillSmoke() {
  const previousRoutingEnabled = process.env.LUNA_AGENT_LLM_ROUTING_ENABLED;
  process.env.LUNA_AGENT_LLM_ROUTING_ENABLED = 'true';
  let report;
  try {
    report = buildLunaLlmRouteDrill({
      market: 'binance',
      tasks: ['discovery', 'validation', 'final_decision', 'posttrade_feedback'],
      avoidProviders: ['claude-code'],
      maxTokens: 256,
    });
  } finally {
    if (previousRoutingEnabled == null) delete process.env.LUNA_AGENT_LLM_ROUTING_ENABLED;
    else process.env.LUNA_AGENT_LLM_ROUTING_ENABLED = previousRoutingEnabled;
  }

  assert.equal(report.ok, true, 'route drill should be ready');
  assert.equal(report.routes.length, 4, 'route drill should cover four Luna task families');
  const finalDecision = report.routes.find((route) => route.taskType === 'final_decision');
  assert.ok(finalDecision, 'final_decision route should exist');
  assert.ok(finalDecision.chain.length >= 2, 'final_decision should keep fallback chain');
  assert.notEqual(finalDecision.chain[0].provider, 'claude-code', 'avoid provider should not remain first');
  assert.ok(
    finalDecision.chainProviders.includes('openai-oauth') || finalDecision.chainProviders.includes('gemini-oauth') || finalDecision.chainProviders.includes('groq'),
    'final_decision should retain at least one non-Claude fallback',
  );

  return {
    ok: true,
    smoke: 'luna-llm-route-drill',
    finalDecisionProviders: finalDecision.chainProviders,
  };
}

async function main() {
  const result = await runLunaLlmRouteDrillSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-llm-route-drill-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-llm-route-drill-smoke 실패:',
  });
}
