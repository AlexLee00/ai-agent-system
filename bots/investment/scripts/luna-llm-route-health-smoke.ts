#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  classifyRouteFailure,
  deriveAvoidProvidersFromHealth,
  reorderChainForRouteHealth,
  summarizeRouteHealth,
} from '../shared/agent-llm-route-health.ts';
import { buildHubLlmCallPayload } from '../shared/hub-llm-client.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runLunaLlmRouteHealthSmoke() {
  assert.equal(classifyRouteFailure('provider_cooldown'), 'cooldown');
  assert.equal(classifyRouteFailure('HTTP 429 quota exceeded'), 'quota');
  assert.equal(classifyRouteFailure('oauth token expired'), 'auth');
  assert.equal(classifyRouteFailure('request timeout'), 'timeout');

  const health = summarizeRouteHealth([
    {
      provider: 'failed',
      response_ok: false,
      error: 'provider_cooldown',
      route_chain: JSON.stringify([
        { provider: 'claude-code', model: 'sonnet' },
        { provider: 'openai-oauth', model: 'gpt-5.4' },
      ]),
      created_at: new Date().toISOString(),
    },
    {
      provider: 'failed',
      response_ok: false,
      error: 'provider_cooldown',
      route_chain: JSON.stringify([
        { provider: 'claude-code', model: 'sonnet' },
        { provider: 'openai-oauth', model: 'gpt-5.4' },
      ]),
      created_at: new Date().toISOString(),
    },
  ], { minCalls: 2, failThreshold: 0.5 });

  const avoidProviders = deriveAvoidProvidersFromHealth(health);
  assert.ok(avoidProviders.includes('claude-code'), 'failed route chain should mark claude-code as avoid candidate');
  assert.ok(avoidProviders.includes('openai-oauth'), 'failed route chain should mark openai-oauth as avoid candidate');

  const chain = [
    { provider: 'claude-code', model: 'sonnet' },
    { provider: 'gemini-cli-oauth', model: 'gemini-2.5-flash' },
    { provider: 'openai-oauth', model: 'gpt-5.4' },
  ];
  const reordered = reorderChainForRouteHealth(chain, ['claude-code']);
  assert.equal(reordered[0].provider, 'gemini-cli-oauth', 'healthy provider should move ahead of cooldown provider');
  assert.equal(reordered.at(-1).provider, 'claude-code', 'avoided provider should remain as last-resort fallback');

  const previousRoutingEnabled = process.env.LUNA_AGENT_LLM_ROUTING_ENABLED;
  process.env.LUNA_AGENT_LLM_ROUTING_ENABLED = 'true';
  let payload;
  try {
    payload = buildHubLlmCallPayload('luna', 'system', 'user', {
      market: 'binance',
      taskType: 'final_decision',
      avoidProviders: ['claude-code'],
    });
  } finally {
    if (previousRoutingEnabled == null) delete process.env.LUNA_AGENT_LLM_ROUTING_ENABLED;
    else process.env.LUNA_AGENT_LLM_ROUTING_ENABLED = previousRoutingEnabled;
  }
  assert.ok(Array.isArray(payload.chain), 'payload should include route chain');
  assert.notEqual(payload.chain[0].provider, 'claude-code', 'payload chain should honor route-health reordering');

  return {
    ok: true,
    smoke: 'luna-llm-route-health',
    avoidProviders,
    firstProviderAfterReorder: reordered[0].provider,
    payloadFirstProvider: payload.chain[0].provider,
  };
}

async function main() {
  const result = await runLunaLlmRouteHealthSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-llm-route-health-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-llm-route-health-smoke 실패:',
  });
}
