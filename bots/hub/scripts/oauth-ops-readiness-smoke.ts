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
const monitor = read('bots/hub/scripts/run-oauth-monitor.ts');
const opsEvents = read('bots/hub/lib/oauth/ops-events.ts');
const toolRegistry = read('bots/hub/lib/control/tool-registry.ts');
const oauthOpsSkill = read('skills/oauth-ops/SKILL.md');
const packageJson = JSON.parse(read('bots/hub/package.json'));
const runTests = read('bots/hub/scripts/run-tests.ts');

assert(opsReadiness.includes('team-oauth-readiness-report.ts'), 'OAuth ops readiness must include team OAuth readiness');
assert(opsReadiness.includes('gemini-cli-oauth-readiness.ts'), 'OAuth ops readiness must include Gemini CLI readiness');
assert(opsReadiness.includes('steward-gemini-model-drill.ts'), 'OAuth ops readiness must include Steward Gemini drill');
assert(opsReadiness.includes('public_api_tokens_are_optional'), 'OAuth ops readiness must document public API optional mode');
assert(opsReadiness.includes('No provider token'), 'OAuth ops readiness must explicitly avoid raw secret output');
assert(!opsReadiness.includes('access_token:'), 'OAuth ops readiness must not project raw access_token fields');
assert(!opsReadiness.includes('refresh_token:'), 'OAuth ops readiness must not project raw refresh_token fields');
assert(monitor.includes('publishOAuthMonitorEvents'), 'OAuth monitor must publish standard ops events');
assert(opsEvents.includes("eventType: 'hub_oauth_monitor'"), 'OAuth ops events must use event_lake standard event type');
assert(opsEvents.includes('SECRET_KEY_PATTERN'), 'OAuth ops events must redact secret-like fields');
assert(toolRegistry.includes("name: 'oauth.ops.status'"), 'Hub control tools must expose OAuth ops status');
assert(toolRegistry.includes("name: 'oauth.ops.events'"), 'Hub control tools must expose OAuth monitor events');
assert(toolRegistry.includes("name: 'oauth.ops.lock_janitor_plan'"), 'Hub control tools must expose refresh lock dry-run plan');
assert(oauthOpsSkill.toLowerCase().includes('refresh 자동화 자체는'), 'oauth-ops skill must keep refresh automation in Hub runtime');
assert(oauthOpsSkill.includes('oauth.ops.status'), 'oauth-ops skill must document Hub OAuth ops tools');
assert.equal(packageJson.scripts['oauth:ops-readiness'], 'tsx scripts/hub-oauth-operational-readiness.ts');
assert.equal(packageJson.scripts['oauth:ops-events-smoke'], 'tsx scripts/oauth-ops-events-smoke.ts');
assert(runTests.includes('steward-gemini-model-drill-smoke.ts'), 'Unit chain must cover Steward Gemini mock report contract');
assert(runTests.includes('oauth-ops-readiness-smoke.ts'), 'Unit chain must cover OAuth ops readiness contract');
assert(runTests.includes('oauth-ops-events-smoke.ts'), 'Unit chain must cover OAuth ops event/redaction contract');

console.log(JSON.stringify({
  ok: true,
  oauth_ops_readiness_script: true,
  oauth_monitor_event_hook: true,
  oauth_ops_control_tools: true,
  oauth_ops_skill: true,
  public_api_optional_contract: true,
  secret_projection_guard: true,
}));
