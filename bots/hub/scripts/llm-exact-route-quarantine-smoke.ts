#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(__filename);
const routePolicy = require('../../../packages/core/lib/llm-provider-retirement.ts');
const selector = require('../../../packages/core/lib/llm-model-selector.ts');
const routingAdapter = require('../../../packages/core/lib/agent-llm-routing-adapter.ts');
const unifiedCaller = require('../lib/llm/unified-caller.ts');
const groqFallback = require('../lib/llm/groq-fallback.ts');

const unavailableRoute = 'groq/qwen/qwen3-32b';
const replacementRoute = 'groq/openai/gpt-oss-120b';
const backtestQualitySampler = fs.readFileSync(
  path.resolve(__dirname, '../../investment/scripts/backtest-llm-quality-sample.ts'),
  'utf8',
);

assert.equal(routePolicy.isQuarantinedExactLlmRoute(unavailableRoute), true);
assert.equal(routePolicy.getQuarantinedLlmRouteReplacement('groq', 'qwen/qwen3-32b'), replacementRoute);
assert.equal(routePolicy.isQuarantinedExactLlmRoute('local/qwen2.5-7b'), false);
assert.equal(routePolicy.isQuarantinedExactLlmRoute('local-embedding/qwen3-embed-0.6b'), false);
assert.equal(routePolicy.isQuarantinedExactLlmRoute('groq/openai/gpt-oss-120b'), false);
assert.equal(unifiedCaller._testOnly._normalizeRoute(unavailableRoute), replacementRoute);
assert.equal(groqFallback._testOnly.normalizeGroqRequestModel('qwen/qwen3-32b'), 'openai/gpt-oss-120b');
assert.equal(
  backtestQualitySampler.includes(unavailableRoute),
  false,
  'active backtest quality defaults must not advertise the quarantined route',
);

const tokenizedPolicy = routingAdapter.buildAgentYamlRoutingPolicy({
  name: 'nemesis',
  llm_routing: {
    primary: 'groq/@GROQ_DEEP_MODEL',
    fallbacks: ['openai-oauth/@OPENAI_MINI_MODEL'],
  },
}, {
  modelTokens: {
    '@GROQ_DEEP_MODEL': 'openai/gpt-oss-120b',
    '@OPENAI_MINI_MODEL': 'gpt-5.4-mini',
  },
});
assert.equal(tokenizedPolicy.primary.model, 'openai/gpt-oss-120b');
assert.equal(tokenizedPolicy.fallbacks[0].model, 'gpt-5.4-mini');

const envResolvedPolicy = routingAdapter.buildAgentYamlRoutingPolicy({
  name: 'nemesis',
  llm_routing: {
    primary: 'groq/@GROQ_DEEP_MODEL',
    fallbacks: ['openai-oauth/@OPENAI_MINI_MODEL'],
  },
}, {
  env: {
    LLM_GROQ_DEEP_MODEL: 'openai/gpt-oss-120b',
    LLM_OPENAI_MINI_MODEL: 'gpt-5.4-mini',
  },
});
assert.equal(envResolvedPolicy.primary.model, 'openai/gpt-oss-120b');
assert.equal(envResolvedPolicy.fallbacks[0].model, 'gpt-5.4-mini');

const nemesis = selector.describeLLMSelector('investment.nemesis', {
  agentName: 'nemesis',
  selectorVersion: 'v3.0_oauth_4',
  rolloutPercent: 100,
  rolloutKey: 'exact-route-quarantine-smoke',
});
const routes = nemesis.chain.map((entry: Record<string, unknown>) => `${entry.provider}/${entry.model}`);
assert(!routes.includes(unavailableRoute), 'selector chain must not expose the quarantined route');
assert(routes.includes(replacementRoute), 'selector chain must include the exact replacement route');

console.log(JSON.stringify({
  ok: true,
  unavailableRoute,
  replacementRoute,
  selectorRoutes: routes,
  liveMutation: false,
}));
