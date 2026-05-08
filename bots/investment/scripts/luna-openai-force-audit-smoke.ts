#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHubLlmCallPayload, isDirectFallbackEnabled } from '../shared/hub-llm-client.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const require = createRequire(import.meta.url);
const { selectLLMChain } = require('../../../packages/core/lib/llm-model-selector.ts');

function readRepoFile(...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8');
}

function providersFor(agentName, taskType = 'final_decision') {
  const prevHubEnabled = process.env.INVESTMENT_LLM_HUB_ENABLED;
  const prevRoutingEnabled = process.env.LUNA_AGENT_LLM_ROUTING_ENABLED;
  process.env.INVESTMENT_LLM_HUB_ENABLED = 'true';
  process.env.LUNA_AGENT_LLM_ROUTING_ENABLED = 'true';
  try {
    const payload = buildHubLlmCallPayload(agentName, 'system', 'user', {
      market: 'binance',
      symbol: 'BTC/USDT',
      taskType,
      maxTokens: 64,
    });
    return (Array.isArray(payload.chain) ? payload.chain : []).map((entry) => entry.provider);
  } finally {
    if (prevHubEnabled == null) delete process.env.INVESTMENT_LLM_HUB_ENABLED;
    else process.env.INVESTMENT_LLM_HUB_ENABLED = prevHubEnabled;
    if (prevRoutingEnabled == null) delete process.env.LUNA_AGENT_LLM_ROUTING_ENABLED;
    else process.env.LUNA_AGENT_LLM_ROUTING_ENABLED = prevRoutingEnabled;
  }
}

function main() {
  const prevHubPublicOpenAi = process.env.HUB_LLM_PUBLIC_OPENAI_ENABLED;
  const prevPublicOpenAi = process.env.LLM_PUBLIC_OPENAI_ENABLED;
  delete process.env.HUB_LLM_PUBLIC_OPENAI_ENABLED;
  delete process.env.LLM_PUBLIC_OPENAI_ENABLED;

  try {
    const llmClient = readRepoFile('bots/investment/shared/llm-client.ts');
    const chartVision = readRepoFile('bots/investment/scripts/chart-vision.ts');
    const coreFallback = readRepoFile('packages/core/lib/llm-fallback.ts');
    const commanderPlist = readRepoFile('bots/investment/launchd/ai.investment.commander.plist');

    assert.equal(isDirectFallbackEnabled(), false, 'direct LLM fallback must be disabled by default');
    assert.match(commanderPlist, /<key>INVESTMENT_LLM_DIRECT_FALLBACK<\/key>\s*<string>false<\/string>/, 'commander launchd must keep direct fallback disabled');
    assert.match(llmClient, /INVESTMENT_LLM_PUBLIC_OPENAI_ENABLED/, 'direct public OpenAI LLM path must require explicit env');
    assert.match(llmClient, /Public OpenAI direct LLM path disabled/, 'direct public OpenAI LLM path must fail closed by default');
    assert.match(chartVision, /LUNA_CHART_VISION_PUBLIC_OPENAI_ENABLED/, 'chart vision public OpenAI path must require explicit env');
    assert.match(chartVision, /public_openai_disabled/, 'chart vision must return a no-call disabled result by default');
    assert.match(coreFallback, /HUB_LLM_PUBLIC_OPENAI_ENABLED/, 'core public OpenAI provider must require explicit env');
    assert.match(coreFallback, /Public OpenAI direct provider disabled/, 'core public OpenAI provider must fail closed by default');

    const guardedOpenAiChain = selectLLMChain('investment._default', {
      policyOverride: [{ provider: 'openai', model: 'gpt-4o-mini', maxTokens: 64, temperature: 0.1 }],
    });
    assert.equal(guardedOpenAiChain[0]?.provider, 'openai-oauth', 'selector must rewrite direct public OpenAI provider to openai-oauth by default');

    const checkedChains = {
      luna: providersFor('luna', 'final_decision'),
      hermes: providersFor('hermes', 'sentiment'),
      nemesis: providersFor('nemesis', 'risk'),
    };
    for (const [agent, providers] of Object.entries(checkedChains)) {
      assert.ok(providers.length > 0, `${agent} must resolve a Hub selector chain`);
      assert.equal(providers.includes('openai'), false, `${agent} must not use direct public OpenAI provider in selector chain`);
    }

    const payload = {
      ok: true,
      smoke: 'luna-openai-force-audit',
      directFallbackDefault: isDirectFallbackEnabled(),
      checkedChains,
      publicOpenAiDirectEnv: 'INVESTMENT_LLM_PUBLIC_OPENAI_ENABLED',
      chartVisionDirectEnv: 'LUNA_CHART_VISION_PUBLIC_OPENAI_ENABLED',
      corePublicOpenAiDirectEnv: 'HUB_LLM_PUBLIC_OPENAI_ENABLED',
      selectorDirectOpenAiRewrittenTo: guardedOpenAiChain[0]?.provider,
    };
    if (process.argv.includes('--json')) console.log(JSON.stringify(payload, null, 2));
    else console.log('luna-openai-force-audit-smoke ok');
  } finally {
    if (prevHubPublicOpenAi == null) delete process.env.HUB_LLM_PUBLIC_OPENAI_ENABLED;
    else process.env.HUB_LLM_PUBLIC_OPENAI_ENABLED = prevHubPublicOpenAi;
    if (prevPublicOpenAi == null) delete process.env.LLM_PUBLIC_OPENAI_ENABLED;
    else process.env.LLM_PUBLIC_OPENAI_ENABLED = prevPublicOpenAi;
  }
}

main();
