#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function main() {
  const unifiedSource = read('bots/hub/lib/llm/unified-caller.ts');
  const routeSource = read('bots/hub/lib/routes/llm.ts');

  assert(unifiedSource.includes('providerRegistry.canCall'), 'unified caller must consult provider circuit before provider calls');
  assert(unifiedSource.includes('providerRegistry.recordSuccess'), 'unified caller must record provider successes');
  assert(unifiedSource.includes('providerRegistry.recordFailure'), 'unified caller must record provider failures');
  assert(routeSource.includes('provider_circuits'), '/hub/llm/circuit must expose provider circuit state');
  assert(routeSource.includes('direct_llm_provider_route_disabled'), 'direct provider routes must be disabled by default');

  const unified = require('../lib/llm/unified-caller.ts');
  assert.equal(
    unified._testOnly._providerCircuitKey('groq', 'groq/llama-3.1-8b-instant'),
    'groq/llama-3.1-8b-instant',
    'Groq circuit keys should be model-aware so a 70B TPD outage does not block 8B fallback',
  );
  assert.equal(
    unified._testOnly._providerCircuitKey('openai-oauth', 'openai-oauth/gpt-5.4-mini'),
    'openai-oauth',
    'non-Groq provider circuits should remain provider-scoped',
  );
  assert.equal(
    unified._testOnly._shouldRecordProviderCircuitFailure('openai-oauth', 'openai_codex_oauth_bad_request:Unsupported parameter: max_output_tokens'),
    false,
    'OpenAI Codex bad-request contract errors must not open the provider circuit',
  );
  assert.equal(
    unified._testOnly._shouldRecordProviderCircuitFailure('openai-oauth', 'openai_codex_oauth_timeout_or_abort:This operation was aborted'),
    true,
    'OpenAI Codex timeout/abort failures should still be counted by provider circuit health',
  );
  assert.equal(
    unified._testOnly._shouldRecordProviderCircuitFailure('groq', 'Groq 429: rate limit reached, retry later'),
    false,
    'Groq 429/rate-limit should be handled by key cooldown rotation, not by opening the model circuit',
  );
  assert.equal(
    unified._testOnly._shouldRecordProviderCircuitFailure('groq', 'Groq 계정 풀 비어있음 또는 rate-limit cooldown 중'),
    false,
    'Groq pool cooldown should not open the route circuit because per-key retry-after already gates retries',
  );

  const registry = require('../lib/llm/provider-registry.ts');
  const provider = 'hub-provider-circuit-smoke';
  registry.resetProviderCircuit(provider);
  assert.equal(registry.canCall(provider), true, 'fresh provider circuit should allow calls');

  registry.recordFailure(provider, 'smoke_failure', 1);
  registry.recordFailure(provider, 'smoke_failure', 1);
  registry.recordFailure(provider, 'smoke_failure', 1);

  const stats = registry.getProviderStats();
  assert.equal(registry.canCall(provider), false, 'provider circuit should open after consecutive failures');
  assert.equal(stats[provider].state, 'OPEN', 'provider stats should report OPEN state');
  assert.equal(stats[provider].total_failures, 3, 'provider stats should retain failure count');

  registry.resetProviderCircuit(provider);
  assert.equal(registry.canCall(provider), true, 'provider circuit reset should allow calls');

  const groqModelProvider = 'groq/hub-provider-circuit-smoke-model';
  registry.resetProviderCircuit('groq');
  registry.recordFailure(groqModelProvider, 'smoke_failure', 1);
  registry.recordFailure(groqModelProvider, 'smoke_failure', 1);
  registry.recordFailure(groqModelProvider, 'smoke_failure', 1);
  assert.equal(registry.canCall(groqModelProvider), false, 'model-scoped Groq circuit should open after failures');
  const resetKeys = registry.resetProviderCircuit('groq');
  assert(resetKeys.includes(groqModelProvider), 'resetting provider=groq should clear model-scoped Groq circuits');
  assert.equal(registry.canCall(groqModelProvider), true, 'provider reset should reopen model-scoped Groq circuit');

  console.log(JSON.stringify({
    ok: true,
    provider_circuit: 'model_aware_for_groq',
    groq_rate_limit_circuit_recording: 'suppressed',
    direct_provider_routes_default: 'disabled',
  }));
}

main();
