#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.LLM_TEAM_SELECTOR_VERSION = 'v3.0_oauth_4';
process.env.LLM_TEAM_SELECTOR_AB_PERCENT = '100';
process.env.LLM_OPENAI_PERF_MODEL = 'openai-oauth/runtime-env-perf';
process.env.LLM_OPENAI_MINI_MODEL = 'openai-oauth/runtime-env-mini';
process.env.LLM_GROQ_FAST_MODEL = 'groq/runtime-env-fast';
process.env.LLM_GROQ_DEEP_MODEL = 'groq/runtime-env-deep';
process.env.LLM_GEMINI_FLASH_MODEL = 'gemini-cli-oauth/runtime-env-flash';
process.env.LLM_GEMINI_FLASH_LITE_MODEL = 'gemini-cli-oauth/runtime-env-lite';
process.env.HUB_BUDGET_GUARDIAN_ENABLED = 'false';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const runtimeProfilesPath = path.join(repoRoot, 'bots', 'hub', 'lib', 'runtime-profiles.ts');
const source = fs.readFileSync(runtimeProfilesPath, 'utf8');

assert(!new RegExp('primary_routes\\s*:\\s*\\[', 'm').test(source), 'runtime profile source must not hardcode primary_routes');
assert(!new RegExp('fallback_routes\\s*:\\s*\\[', 'm').test(source), 'runtime profile source must not hardcode fallback_routes');
assert(!new RegExp('LLM_(OPENAI|GROQ|GEMINI)_', 'm').test(source), 'runtime profile source must not read model env directly');
assert(!new RegExp('claude-code/', 'm').test(source), 'runtime profile source must not hardcode Claude Code model routes');

const { PROFILES, selectRuntimeProfile } = require('../lib/runtime-profiles.ts');
const unifiedCaller = require('../lib/llm/unified-caller.ts');
const selector = require('../../../packages/core/lib/llm-model-selector.js');

const llmProfiles: string[] = [];
for (const [team, profiles] of Object.entries(PROFILES || {})) {
  for (const [profileName, profile] of Object.entries(profiles as Record<string, any>)) {
    if (!profile.selector_key) continue;
    llmProfiles.push(`${team}.${profileName}`);
    assert(Array.isArray(profile.primary_routes), `${team}.${profileName} must materialize primary_routes from selector`);
    assert(profile.primary_routes.length === 1, `${team}.${profileName} must have exactly one selector primary route`);
    assert(Array.isArray(profile.fallback_routes), `${team}.${profileName} must materialize fallback_routes from selector`);
  }
}

assert(llmProfiles.length >= 40, `expected selector-backed runtime profiles, got ${llmProfiles.length}`);

const claudeLead = selectRuntimeProfile('claude', 'lead');
assert.equal(claudeLead.selector_key, 'claude.lead.system_issue_triage');
assert.equal(claudeLead.primary_routes[0], 'openai-oauth/runtime-env-perf');
assert(claudeLead.fallback_routes.includes('groq/runtime-env-deep'));
assert(!claudeLead.fallback_routes.some((route: string) => route.startsWith('gemini-cli-oauth/')));

const lunaDefault = selectRuntimeProfile('luna', 'default');
assert.equal(lunaDefault.selector_key, 'investment._default');
assert.equal(lunaDefault.primary_routes[0], 'groq/runtime-env-deep');
assert(lunaDefault.fallback_routes.includes('openai-oauth/runtime-env-mini'));
assert(!lunaDefault.fallback_routes.some((route: string) => route.startsWith('gemini-cli-oauth/')));

const orchestratorSummary = selectRuntimeProfile('orchestrator', 'summary');
assert.equal(orchestratorSummary.selector_key, 'orchestrator.jay.summary');
assert.equal(orchestratorSummary.primary_routes[0], 'groq/runtime-env-fast');
assert(orchestratorSummary.fallback_routes.includes('openai-oauth/runtime-env-mini'));

const justinStage3 = selectRuntimeProfile('justin', 'stage-3');
assert.equal(justinStage3.selector_key, 'justin.stage-3');
assert.equal(justinStage3.primary_routes[0], 'openai-oauth/runtime-env-perf');
assert(justinStage3.fallback_routes.includes('groq/runtime-env-deep'));
assert(!justinStage3.fallback_routes.some((route: string) => route.startsWith('gemini-cli-oauth/')));

const resolveSelectorChain = unifiedCaller._testOnly._resolveSelectorChain;
const blogDefaultChain = resolveSelectorChain({ callerTeam: 'blog', agent: 'default' }, 'blog');
assert.equal(blogDefaultChain.selectorKey, 'blog._default');
assert.equal(blogDefaultChain.runtimeProfile, 'blog.default');
assert.equal(blogDefaultChain.chain[0]?.provider, 'openai-oauth');

const blogCommenterProfile = selectRuntimeProfile('blog', 'commenter');
assert.equal(blogCommenterProfile.selector_key, 'blog.commenter.reply');
assert(Array.isArray(blogCommenterProfile.primary_routes) && blogCommenterProfile.primary_routes.length === 1);
assert(Array.isArray(blogCommenterProfile.fallback_routes) && blogCommenterProfile.fallback_routes.length >= 1);
const blogCommenterChain = resolveSelectorChain({ callerTeam: 'blog', runtimePurpose: 'commenter' }, 'blog');
assert.equal(blogCommenterChain.selectorKey, 'blog.commenter.reply');
assert.equal(blogCommenterChain.runtimeProfile, 'blog.commenter');
assert.equal(blogCommenterChain.chain.length >= 2, true);

const hubDefaultChain = resolveSelectorChain({ callerTeam: 'hub' }, 'hub');
assert.equal(hubDefaultChain.selectorKey, 'hub._default');
assert.equal(hubDefaultChain.runtimeProfile, 'hub.default');

const runtimeSelectorKeys = [
  'hub.control.planner',
  'hub.session.compaction',
  'hub.oauth.gemini_cli.expiry_probe',
  'hub.alarm.classifier',
  'hub.alarm.interpreter.work',
  'hub.alarm.interpreter.report',
  'hub.alarm.interpreter.error',
  'hub.alarm.interpreter.critical',
  'hub.roundtable.jay',
  'hub.roundtable.claude_lead',
  'hub.roundtable.team_commander',
  'hub.roundtable.judge',
  'hub.gemini.cli.adapter.smoke',
  'hub.gemini.cli.readiness.live',
  'hub.unified.oauth.openai.smoke',
  'hub.unified.oauth.gemini.smoke',
  'justin._default',
  'justin.stage-3',
  'justin.analysis',
  'justin.citation',
  'justin.opinion',
  'justin.simple-qa',
];
for (const key of runtimeSelectorKeys) {
  const chain = selector.selectLLMChain(key);
  assert(Array.isArray(chain) && chain.length > 0, `${key} must resolve through the selector registry`);
}

const selectorOnlyRuntimeFiles = [
  path.join(repoRoot, 'bots', 'hub', 'lib', 'control', 'planner.ts'),
  path.join(repoRoot, 'bots', 'hub', 'scripts', 'run-oauth-monitor.ts'),
  path.join(repoRoot, 'bots', 'hub', 'lib', 'alarm', 'classify-alarm-llm.ts'),
  path.join(repoRoot, 'bots', 'hub', 'lib', 'alarm', 'alarm-interpreter-router.ts'),
  path.join(repoRoot, 'bots', 'hub', 'lib', 'alarm', 'alarm-roundtable-engine.ts'),
];
for (const filePath of selectorOnlyRuntimeFiles) {
  const fileSource = fs.readFileSync(filePath, 'utf8');
  assert(!new RegExp('callWithFallback\\s*\\(\\s*{[\\s\\S]{0,240}chain\\s*:', 'm').test(fileSource), `${filePath} must not pass ad-hoc chain to callWithFallback`);
  assert(!fileSource.includes("packages/core/lib/llm-fallback"), `${filePath} must use Hub unified caller`);
  assert(!new RegExp('\\bselectLLMChain\\b', 'm').test(fileSource), `${filePath} must not materialize selector chains locally`);
}

async function main() {
  delete process.env.HUB_LLM_ALLOW_ADHOC_CHAIN;
  const blockedAdhoc = await unifiedCaller.callWithFallback({
    callerTeam: 'hub',
    abstractModel: 'anthropic_haiku',
    prompt: 'ad-hoc chain should be rejected before provider call',
    chain: [{ provider: 'openai-oauth', model: 'manual' }],
  });
  assert.equal(blockedAdhoc.ok, false);
  assert.equal(blockedAdhoc.error, 'llm_adhoc_chain_blocked');
  assert.equal(
    resolveSelectorChain({ callerTeam: 'hub', chain: [{ provider: 'openai-oauth', model: 'manual' }] }, 'hub'),
    null,
    'ad-hoc request chain must be blocked by default',
  );
  process.env.HUB_LLM_ALLOW_ADHOC_CHAIN = 'true';
  const adhocChain = resolveSelectorChain({ callerTeam: 'hub', chain: [{ provider: 'openai-oauth', model: 'manual' }] }, 'hub');
  assert.equal(adhocChain.selectorKey, 'hub.adhoc.chain');
  assert.equal(adhocChain.chain[0]?.provider, 'openai-oauth');

  const selectorWinsOverAdhoc = resolveSelectorChain({
    callerTeam: 'justin',
    agent: 'stage-3',
    selectorKey: 'justin.stage-3',
    chain: [{ provider: 'openai-oauth', model: 'manual-single-route' }],
  }, 'justin');
  assert.equal(selectorWinsOverAdhoc.selectorKey, 'justin.stage-3');
  assert(selectorWinsOverAdhoc.chain.length >= 2, 'justin.stage-3 must preserve managed fallback routes');
  assert.notEqual(selectorWinsOverAdhoc.chain[0]?.model, 'manual-single-route');
  delete process.env.HUB_LLM_ALLOW_ADHOC_CHAIN;

  console.log(JSON.stringify({
    ok: true,
    selector_backed_profiles: llmProfiles.length,
    source_of_truth: 'packages/core/lib/llm-model-selector.ts',
    runtime_profiles_model_env_direct_reads: 0,
    runtime_profiles_hardcoded_primary_routes: 0,
    runtime_selector_keys_checked: runtimeSelectorKeys.length,
    selector_only_runtime_files_checked: selectorOnlyRuntimeFiles.length,
    adhoc_chain_default: 'blocked',
    selector_key_precedence: 'managed_selector_over_adhoc_chain',
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
