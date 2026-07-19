#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLM_TEAM_SELECTOR_VERSION = 'v3.0_oauth_4';
process.env.LLM_TEAM_SELECTOR_AB_PERCENT = '100';
process.env.HUB_BUDGET_GUARDIAN_ENABLED = 'false';

const require = createRequire(import.meta.url);
const hubSelector = require('../src/llm-selector.ts');
const coreSelector = require('../../../packages/core/lib/llm-model-selector.ts');
const unifiedCaller = require('../lib/llm/unified-caller.ts');
const { AGENTS } = require('../../orchestrator/scripts/seed-agent-registry.ts');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SELECTOR_OPTIONS = { selectorVersion: 'v3.0_oauth_4', rolloutPercent: 100, rolloutKey: 'stage-a-selector-smoke' };
const tsResults: Array<{ id: string; method: string; status: string; evidence: string }> = [];

function recordTs(id: string, method: string, evidence: string): void {
  tsResults.push({ id, method, status: 'PASS', evidence });
}

function withEnv(overrides: Record<string, string>, fn: () => void): void {
  const backup: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    backup[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (backup[key] == null) delete process.env[key];
      else process.env[key] = backup[key];
    }
  }
}

function chainFor(selectorKey: string, extra: Record<string, unknown> = {}): any[] {
  return coreSelector.selectLLMChain(selectorKey, { ...SELECTOR_OPTIONS, ...extra });
}

function providers(chain: any[]): string[] {
  return chain.map((entry) => String(entry?.provider || ''));
}

function hasProvider(chain: any[], provider: string): boolean {
  return providers(chain).includes(provider);
}

function isGemini(entry: any): boolean {
  const provider = String(entry?.provider || '');
  const model = String(entry?.model || '');
  return provider.startsWith('gemini') || model.startsWith('gemini');
}

function assertNoGeminiLocal(chain: any[], label: string): void {
  assert(!chain.some(isGemini), `${label} must not include Gemini`);
  assert(!hasProvider(chain, 'local'), `${label} must not include local generative provider`);
}

function routeLabels(chain: any[]): string[] {
  return chain.map((entry) => `${entry.provider}/${entry.model}/${entry.maxTokens ?? ''}`);
}

function runCodexHReliabilitySmoke(): void {
  const test = unifiedCaller._testOnly;
  test._clearRateLimitCooldowns();
  withEnv(
    { HUB_LLM_RATELIMIT_COOLDOWN_ENABLED: 'true', HUB_LLM_RATELIMIT_COOLDOWN_MIN_MS: '30000' },
    () => {
      test.noteRateLimitCooldown('groq', 60_000);
      const plan = test._rateLimitCooldownPlan([
        { provider: 'openai-oauth', model: 'gpt-5.4-mini' },
        { provider: 'groq', model: 'llama-3.1-8b-instant' },
      ], 'anthropic_haiku');
      assert.equal(test.isRateLimitCoolingDown('groq'), true);
      assert(!plan.chain.some((entry: any) => entry.provider === 'groq'), 'cooling Groq must be skipped when other providers are available');
      recordTs('TS-1', 'cooldown helper', 'groq skipped before call while openai remains available');
    },
  );

  test._clearRateLimitCooldowns();
  withEnv(
    { HUB_LLM_RATELIMIT_COOLDOWN_ENABLED: 'true', HUB_LLM_RATELIMIT_COOLDOWN_MIN_MS: '30000' },
    () => {
      test.noteRateLimitCooldown('groq', 120_000);
      const retryAfterDelta = test._rateLimitCooldownUntil.groq - Date.now();
      assert(retryAfterDelta > 110_000, `Retry-After cooldown too small: ${retryAfterDelta}`);
      test._clearRateLimitCooldowns();
      test.noteRateLimitCooldown('groq');
      const defaultDelta = test._rateLimitCooldownUntil.groq - Date.now();
      assert(defaultDelta > 25_000 && defaultDelta <= 35_000, `default cooldown outside expected range: ${defaultDelta}`);
      recordTs('TS-2', 'cooldown duration', 'retryAfterMs overrides minimum; missing retryAfter uses 30s minimum');
    },
  );

  test._clearRateLimitCooldowns();
  withEnv(
    { HUB_LLM_RATELIMIT_COOLDOWN_ENABLED: 'true', HUB_LLM_RATELIMIT_COOLDOWN_MIN_MS: '30000' },
    () => {
      test.noteRateLimitCooldown('openai-oauth', 60_000);
      test.noteRateLimitCooldown('groq', 60_000);
      const plan = test._rateLimitCooldownPlan([
        { provider: 'openai-oauth', model: 'gpt-5.4-mini' },
        { provider: 'groq', model: 'llama-3.1-8b-instant' },
      ], 'anthropic_haiku');
      assert.equal(plan.ignoreCooldown, true);
      assert.deepEqual(providers(plan.chain), ['groq']);
      recordTs('TS-3', 'all-cooldown fallback', 'last chain entry is retained with cooldown override');
    },
  );

  test._clearRateLimitCooldowns();
  test._rateLimitCooldownUntil.groq = Date.now() + 60_000;
  withEnv({ HUB_LLM_RATELIMIT_COOLDOWN_ENABLED: 'false' }, () => {
    const plan = test._rateLimitCooldownPlan([
      { provider: 'openai-oauth', model: 'gpt-5.4-mini' },
      { provider: 'groq', model: 'llama-3.1-8b-instant' },
    ], 'anthropic_haiku');
    assert.equal(test.isRateLimitCoolingDown('groq'), false);
    assert.deepEqual(providers(plan.chain), ['openai-oauth', 'groq']);
    recordTs('TS-4', 'cooldown kill switch', 'HUB_LLM_RATELIMIT_COOLDOWN_ENABLED=false ignores cooldown registry');
  });
  test._clearRateLimitCooldowns();

  const darwinPlanner = chainFor('darwin.agent_policy', { agentName: 'darwin.planner' });
  assert.equal(darwinPlanner[0]?.provider, 'openai-oauth');
  assert(hasProvider(darwinPlanner, 'groq'), 'darwin planner must keep Groq Scout fallback by default');
  assertNoGeminiLocal(darwinPlanner, 'darwin planner');
  withEnv({ HUB_DARWIN_SIGMA_GROQ_FALLBACK_ENABLED: 'false' }, () => {
    const openAiOnly = chainFor('darwin.agent_policy', { agentName: 'darwin.planner' });
    assert.deepEqual(providers(openAiOnly), ['openai-oauth']);
  });
  recordTs('TS-5', 'selector chain', `darwin planner=${routeLabels(darwinPlanner).join(' > ')}; env false=openai-only`);

  for (const agentName of ['darwin.planner', 'darwin.evaluator', 'darwin.scanner']) {
    const chain = chainFor('darwin.agent_policy', { agentName });
    assert(Number(chain[0]?.maxTokens || 0) <= 1024, `${agentName} primary maxTokens must be <=1024`);
  }
  const synthesis = chainFor('darwin.agent_policy', { agentName: 'darwin.synthesis' });
  assert.equal(Number(synthesis[0]?.maxTokens), 2048, 'darwin synthesis must keep 2048 maxTokens');
  recordTs('TS-6', 'selector maxTokens', 'planner/evaluator/scanner <=1024; synthesis primary=2048');

  for (const { agentName, route } of [
    { agentName: 'darwin.edison', route: 'anthropic_sonnet' },
    { agentName: 'darwin.verifier', route: 'anthropic_sonnet' },
    { agentName: 'darwin.commander', route: 'anthropic_opus' },
  ]) {
    const policy = coreSelector.selectLLMPolicy('darwin.agent_policy', { ...SELECTOR_OPTIONS, agentName });
    assert.equal(policy.route, route, `${agentName} abstract route must remain unchanged`);
  }
  recordTs('TS-7', 'selector policy route', 'darwin edison/verifier/commander abstract routes unchanged');

  for (const agentName of ['skill.causal', 'mapek.monitor']) {
    const chain = chainFor('sigma.agent_policy', { agentName });
    assert.equal(chain[0]?.provider, 'openai-oauth', `${agentName} must use OpenAI primary`);
    assert(hasProvider(chain, 'groq'), `${agentName} must include Groq fallback`);
    assertNoGeminiLocal(chain, `sigma ${agentName}`);
  }
  recordTs('TS-8', 'selector chain', 'sigma agent policy shares OpenAI primary + Groq fallback path');

  const alarmExpectedMaxTokens: Record<string, number> = {
    'hub.alarm.interpreter.work': 160,
    'hub.alarm.interpreter.report': 220,
    'hub.alarm.interpreter.error': 320,
    'hub.alarm.interpreter.critical': 320,
  };
  for (const [selectorKey, maxTokens] of Object.entries(alarmExpectedMaxTokens)) {
    const chain = chainFor(selectorKey);
    assert.deepEqual(providers(chain), ['groq', 'openai-oauth'], `${selectorKey} must be groq/openai`);
    assert.deepEqual(chain.map((entry) => Number(entry.maxTokens)), [maxTokens, maxTokens], `${selectorKey} maxTokens must be preserved`);
  }
  const selectorSource = fs.readFileSync(path.join(REPO_ROOT, 'packages/core/lib/llm-model-selector.ts'), 'utf8');
  const legacySource = selectorSource.split('const TEAM_SELECTOR_DEFAULTS_OAUTH4')[0];
  assert(legacySource.includes("'alarm.interpreter.work':") && legacySource.includes("provider: 'groq'"), 'legacy alarm work route must remain groq-based');
  assert(legacySource.includes("'alarm.interpreter.error':") && legacySource.includes("provider: 'claude-code'"), 'legacy alarm error route must remain claude-code-based');
  recordTs('TS-9', 'selector chain + source guard', 'active alarm interpreters groq/openai; legacy table source unchanged');

  const classifier = chainFor('hub.alarm.classifier');
  assert.deepEqual(providers(classifier), ['groq', 'openai-oauth'], 'alarm classifier optimized runtime chain must stay groq/openai');
  recordTs('TS-10', 'selector chain', `alarm classifier=${routeLabels(classifier).join(' > ')}`);

  const localOverride = [
    { provider: 'local', model: 'qwen2.5-7b', maxTokens: 128, temperature: 0.1 },
    { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 128, temperature: 0.1 },
  ];
  const localBlocked = chainFor('orchestrator.jay.summary', { policyOverride: localOverride });
  assert(!hasProvider(localBlocked, 'local'), 'general task must remove local generative provider');
  recordTs('TS-11', 'local guard', 'general policyOverride local entry removed');

  const localAllowed = chainFor('orchestrator.jay.summary', { policyOverride: localOverride, taskType: 'backtest_judgment' });
  assert(hasProvider(localAllowed, 'local'), 'backtest task must retain local generative provider');
  recordTs('TS-12', 'local guard', 'backtest_judgment retains local entry');

  const chronosEmbedding = chainFor('chronos.backtest', { taskType: 'backtest_embedding' });
  assert.deepEqual(routeLabels(chronosEmbedding), ['local-embedding/qwen3-embed-0.6b/0']);
  recordTs('TS-13', 'chronos matrix', 'chronos backtest embedding remains local-embedding only');

  withEnv({ HUB_LLM_LOCAL_BACKTEST_ONLY: 'false' }, () => {
    const unguarded = chainFor('orchestrator.jay.summary', { policyOverride: localOverride });
    assert(hasProvider(unguarded, 'local'), 'local guard env false must leave local generative provider in chain');
  });
  recordTs('TS-14', 'local guard kill switch', 'HUB_LLM_LOCAL_BACKTEST_ONLY=false disables local filtering');

  let darwinHubCallFilesChecked = 0;
  for (const file of [
    'bots/darwin/lib/research-evaluator.ts',
    'bots/darwin/lib/applicator.ts',
    'bots/darwin/lib/implementor.ts',
    'bots/darwin/lib/verifier.ts',
    'bots/darwin/lib/research-tasks.ts',
  ]) {
    const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    if (!/\bcallHubLlm\s*\(/.test(source)) continue;
    darwinHubCallFilesChecked += 1;
    assert(source.includes('runtimePurpose:'), `${file} must tag Darwin Hub calls with runtimePurpose`);
  }
  assert.equal(darwinHubCallFilesChecked, 4, 'expected four Darwin files with Hub LLM call sites');
  recordTs('TS-15', 'source grep', `${darwinHubCallFilesChecked} Darwin Hub call files include runtimePurpose tags`);
}

runCodexHReliabilitySmoke();

assert(AGENTS.length >= 35, 'seed-agent-registry must expose the Stage A 35+ agent runtime map');
assert.equal(
  new Set(AGENTS.map((agent: any) => `${agent.team}.${agent.name}`)).size,
  AGENTS.length,
  'seed-agent-registry must not contain duplicate team.agent entries',
);

const nonLlmAgents = AGENTS.filter((agent: any) => agent.config?.llm_management === 'non-llm');
assert.equal(nonLlmAgents.length, 5, 'seed-agent-registry must explicitly mark exactly five non-LLM agents');
assert.deepEqual(
  nonLlmAgents.map((agent: any) => `${agent.team}.${agent.name}`).sort(),
  ['blog.maestro', 'blog.publ', 'jay.steward', 'luna.chronos', 'luna.sweeper'].sort(),
);
assert(nonLlmAgents.every((agent: any) => agent.config?.llm_selector_key === null), 'non-LLM agents must not carry selector keys');

const runtimeManaged = AGENTS.filter((agent: any) => agent.config?.llm_management === 'runtime-managed');
assert(runtimeManaged.length > 0, 'runtime-managed seed agents must exist');
assert(runtimeManaged.every((agent: any) => agent.config?.runtime_team), 'runtime-managed agents need runtime_team');
assert(runtimeManaged.every((agent: any) => agent.config?.runtime_purpose), 'runtime-managed agents need runtime_purpose');
assert(runtimeManaged.every((agent: any) => agent.config?.llm_selector_key), 'runtime-managed agents need llm_selector_key');

const blogWriter = hubSelector.resolveHubLlmSelection({ callerTeam: 'blog', agent: 'pos', maxTokens: 16 });
assert.equal(blogWriter.ok, true);
assert.equal(blogWriter.selectorKey, 'blog.pos.writer');
assert.equal(blogWriter.routeTargetKind, 'visible_agent');
assert(Array.isArray(blogWriter.chain) && blogWriter.chain.length >= 2, 'blog writer must resolve managed fallback chain');
assert.equal(blogWriter.chain[0]?.provider, 'claude-code-oauth', 'blog writer must use Claude-first long-form route');
assert(blogWriter.providerTiers.some((tier: any) => tier.provider === 'openai-oauth'), 'OpenAI OAuth tier must be present');
assert(blogWriter.providerTiers.every((tier: any) => Number.isFinite(Number(tier.tier))), 'provider tiers must be numeric');

const hubRuntime = hubSelector.resolveHubLlmSelection({ callerTeam: 'hub', runtimePurpose: 'control.planner', maxTokens: 16 });
assert.equal(hubRuntime.ok, true);
assert.equal(hubRuntime.selectorKey, 'hub.control.planner');
assert.equal(hubRuntime.runtimeProfile, 'hub.control.planner');

for (const target of [
  { callerTeam: 'blog', agent: 'publ' },
  { callerTeam: 'blog', agent: 'maestro' },
  { callerTeam: 'luna', agent: 'chronos' },
  { callerTeam: 'luna', agent: 'sweeper' },
  { callerTeam: 'jay', agent: 'steward' },
]) {
  const resolved = hubSelector.resolveHubLlmSelection(target);
  assert.equal(resolved.ok, false, `${target.callerTeam}.${target.agent} must be blocked`);
  assert.equal(resolved.error, 'llm_non_llm_target_blocked');
  assert.equal(hubSelector.isHubLlmRouteTargetAllowed(target).ok, false);
}

const chronosBacktestEmbedding = hubSelector.resolveHubLlmSelection({
  callerTeam: 'investment',
  agent: 'chronos',
  selectorKey: 'chronos.backtest',
  taskType: 'backtest_embedding',
});
assert.equal(chronosBacktestEmbedding.ok, true, 'chronos backtest embedding route must be allowed');
assert.deepEqual(
  chronosBacktestEmbedding.chain.map((entry: any) => `${entry.provider}/${entry.model}`),
  ['local-embedding/qwen3-embed-0.6b'],
  'chronos backtest embedding route must stay local-embedding only',
);

const chronosBacktestJudgment = hubSelector.resolveHubLlmSelection({
  callerTeam: 'investment',
  agent: 'chronos',
  selectorKey: 'investment.chronos',
  taskType: 'backtest_judgment',
});
assert.equal(chronosBacktestJudgment.ok, true, 'chronos backtest judgment route must be allowed');
assert.notEqual(
  chronosBacktestJudgment.chain[0]?.provider,
  'local-embedding',
  'chronos backtest judgment route must stay generative and not reuse embedding route',
);

const chronosJudgmentLuna = hubSelector.resolveHubLlmSelection({
  callerTeam: 'luna',
  agent: 'chronos',
  taskType: 'backtest_judgment',
});
assert.equal(chronosJudgmentLuna.ok, true, 'luna-team chronos backtest judgment must be allowed');
assert.notEqual(
  chronosJudgmentLuna.chain[0]?.provider,
  'local-embedding',
  'luna-team chronos backtest judgment must stay generative and not reuse embedding route',
);

const chronosPlainInvestment = hubSelector.resolveHubLlmSelection({
  callerTeam: 'investment',
  agent: 'chronos',
});
assert.equal(chronosPlainInvestment.ok, false, 'plain investment.chronos must stay non-LLM blocked');
assert.equal(chronosPlainInvestment.error, 'llm_non_llm_target_blocked');
assert.equal(hubSelector.isHubLlmRouteTargetAllowed({
  callerTeam: 'luna',
  agent: 'chronos',
  taskType: 'backtest_judgment',
}).ok, true, 'luna-team chronos backtest judgment route target must be allowed');
assert.equal(hubSelector.isHubLlmRouteTargetAllowed({
  callerTeam: 'investment',
  agent: 'chronos',
}).ok, false, 'plain investment.chronos route target must stay non-LLM blocked');

console.log(JSON.stringify({
  ok: true,
  seed_agents: AGENTS.length,
  runtime_managed: runtimeManaged.length,
  non_llm: nonLlmAgents.length,
  chronos_matrix: {
    luna_plain_blocked: true,
    investment_plain_blocked: true,
    luna_judgment_allowed: chronosJudgmentLuna.ok,
    investment_judgment_allowed: chronosBacktestJudgment.ok,
    embedding_provider: chronosBacktestEmbedding.chain[0]?.provider,
  },
  blog_writer_selector: blogWriter.selectorKey,
  blog_writer_chain: blogWriter.providerTiers,
  hub_runtime_selector: hubRuntime.selectorKey,
  codex_h_reliability_ts: tsResults,
  codex_h_regression_ts: {
    id: 'TS-16',
    method: 'existing stage-a selector smoke',
    status: 'PASS',
    evidence: 'seed/runtime/non-LLM/chronos/blog/hub runtime assertions completed in this process',
  },
}, null, 2));
