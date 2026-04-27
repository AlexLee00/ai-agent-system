#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const opsReadiness = read('bots/hub/scripts/hub-oauth-operational-readiness.ts');
const packageJson = JSON.parse(read('bots/hub/package.json'));
const runTests = read('bots/hub/scripts/run-tests.ts');

assert(opsReadiness.includes('team-oauth-readiness-report.ts'), 'OAuth ops readiness must include team OAuth readiness');
assert(opsReadiness.includes('gemini-cli-oauth-readiness.ts'), 'OAuth ops readiness must include Gemini CLI readiness');
assert(opsReadiness.includes('steward-gemini-model-drill.ts'), 'OAuth ops readiness must include Steward Gemini drill');
assert(opsReadiness.includes('public_api_tokens_are_optional'), 'OAuth ops readiness must document public API optional mode');
assert(opsReadiness.includes('No provider token'), 'OAuth ops readiness must explicitly avoid raw secret output');
assert(!opsReadiness.includes('access_token:'), 'OAuth ops readiness must not project raw access_token fields');
assert(!opsReadiness.includes('refresh_token:'), 'OAuth ops readiness must not project raw refresh_token fields');
assert.equal(packageJson.scripts['oauth:ops-readiness'], 'tsx scripts/hub-oauth-operational-readiness.ts');
assert(runTests.includes('steward-gemini-model-drill-smoke.ts'), 'Unit chain must cover Steward Gemini mock report contract');
assert(runTests.includes('oauth-ops-readiness-smoke.ts'), 'Unit chain must cover OAuth ops readiness contract');

console.log(JSON.stringify({
  ok: true,
  oauth_ops_readiness_script: true,
  public_api_optional_contract: true,
  secret_projection_guard: true,
}));
