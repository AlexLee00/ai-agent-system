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

  console.log(JSON.stringify({
    ok: true,
    provider_circuit: 'centralized',
    direct_provider_routes_default: 'disabled',
  }));
}

main();
