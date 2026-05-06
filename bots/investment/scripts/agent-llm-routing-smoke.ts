#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { resolveHubRoutingPlan, resolveAgentLLMRoute } from '../shared/agent-llm-routing.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  const prevEnabled = process.env.LUNA_AGENT_LLM_ROUTING_ENABLED;

  process.env.LUNA_AGENT_LLM_ROUTING_ENABLED = 'false';
  const legacy = resolveHubRoutingPlan('luna', 'binance', 'final_decision', 300);
  assert.equal(legacy.enabled, false, 'routing disabled by default');
  assert.ok(legacy.route?.primary, 'legacy route exists');
  assert.equal(legacy.chain[0]?.provider, 'openai-oauth', 'disabled routing keeps OpenAI OAuth primary');

  const legacyZeus = resolveHubRoutingPlan('zeus', 'binance', 'debate_bull', 300);
  assert.equal(
    legacyZeus.chain.some((entry) => entry.provider === 'claude-code'),
    false,
    'disabled routing must not leak zeus debate calls to Claude Code',
  );

  process.env.LUNA_AGENT_LLM_ROUTING_ENABLED = 'true';
  const enabled = resolveHubRoutingPlan('luna', 'binance', 'final_decision', 300);
  assert.equal(enabled.enabled, true, 'routing enabled by explicit env');
  assert.ok(Array.isArray(enabled.chain) && enabled.chain.length >= 1, 'chain compiled');
  assert.ok(['anthropic_haiku', 'anthropic_sonnet', 'anthropic_opus'].includes(enabled.abstractModel), 'abstract model normalized');

  const onchainRoute = resolveAgentLLMRoute('oracle', 'crypto', 'onchain');
  assert.ok(String(onchainRoute.primary || '').length > 0, 'oracle onchain route exists');

  const zeus = resolveHubRoutingPlan('zeus', 'binance', 'debate_bull', 300);
  assert.equal(
    zeus.chain.some((entry) => entry.provider === 'claude-code'),
    false,
    'enabled routing must not include Claude Code for zeus hot path',
  );

  if (prevEnabled === undefined) delete process.env.LUNA_AGENT_LLM_ROUTING_ENABLED;
  else process.env.LUNA_AGENT_LLM_ROUTING_ENABLED = prevEnabled;

  return {
    ok: true,
    legacyPrimary: legacy.route.primary,
    enabledPrimary: enabled.route.primary,
    zeusProviders: zeus.chain.map((entry) => entry.provider),
    chainLength: enabled.chain.length,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('agent-llm-routing-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ agent-llm-routing-smoke 실패:',
  });
}
