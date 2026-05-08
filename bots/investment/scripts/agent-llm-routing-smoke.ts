#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHubRoutingPlan, resolveAgentLLMRoute } from '../shared/agent-llm-routing.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runSmoke() {
  const sourcePath = path.resolve(__dirname, '..', 'shared', 'agent-llm-routing.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.equal(
    /(?:openai-oauth|groq|gemini-cli-oauth|claude-code)\/[a-z0-9_.\-/]+/i.test(source),
    false,
    'investment agent routing must not hardcode provider/model routes',
  );

  const prevEnabled = process.env.LUNA_AGENT_LLM_ROUTING_ENABLED;

  process.env.LUNA_AGENT_LLM_ROUTING_ENABLED = 'false';
  const legacy = resolveHubRoutingPlan('luna', 'binance', 'final_decision', 300);
  assert.equal(legacy.enabled, false, 'routing disabled by default');
  assert.equal(legacy.selectorKey, 'investment.luna', 'disabled routing still resolves through selector key');
  assert.ok(Array.isArray(legacy.chain) && legacy.chain.length > 0, 'selector chain exists');

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
    disabledSelectorKey: legacy.selectorKey,
    enabledSelectorKey: enabled.selectorKey,
    zeusProviders: zeus.chain.map((entry) => entry.provider),
    chainLength: enabled.chain.length,
    selectorSourceOnly: true,
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
