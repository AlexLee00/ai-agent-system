#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../../..');
const { buildHubStageBStabilityReport } = require('../lib/stage-b/stability.ts');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

async function main() {
  const report = await buildHubStageBStabilityReport({ skipDb: true, skipLaunchctl: true });
  assert.equal(report.selectorEnforcement.ok, true, 'Hub selector facade enforcement must pass');

  const llmRouteSource = read('bots/hub/lib/routes/llm.ts');
  assert.match(llmRouteSource, /isHubLlmRouteTargetAllowed/, 'LLM routes must validate active route target policy');
  assert.match(llmRouteSource, /direct_llm_provider_route_disabled/, 'Direct provider routes must remain disabled by default');
  assert.match(llmRouteSource, /Use \/hub\/llm\/call/, 'Direct provider route error must point callers to Hub control plane');

  const unifiedCallerSource = read('bots/hub/lib/llm/unified-caller.ts');
  assert.match(unifiedCallerSource, /llm_adhoc_chain_blocked/, 'Ad-hoc chains must be blocked unless explicitly enabled');
  assert.match(unifiedCallerSource, /resolveHubLlmSelection|selectRuntimeProfile/, 'Unified caller must use selector-backed routing');

  const routeRegistrySource = read('bots/hub/src/route-registry.ts');
  assert.match(routeRegistrySource, /app\.post\('\/hub\/llm\/call'/, 'Canonical sync LLM endpoint must exist');
  assert.match(routeRegistrySource, /app\.post\('\/hub\/llm\/jobs'/, 'Canonical async LLM endpoint must exist');

  console.log(JSON.stringify({
    ok: true,
    stage: 'hub_stage_b',
    control_plane: 'hub_selector_agent_enforced',
    selector_checks: report.selectorEnforcement.checks.length,
  }, null, 2));
}

main().catch((error) => {
  console.error('[llm-stage-b-control-plane-smoke] failed:', error?.message || error);
  process.exit(1);
});
