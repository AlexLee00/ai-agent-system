#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.LLM_TEAM_SELECTOR_VERSION = 'v3.0_oauth_4';
process.env.LLM_TEAM_SELECTOR_AB_PERCENT = '100';
process.env.HUB_BUDGET_GUARDIAN_ENABLED = 'false';

const require = createRequire(import.meta.url);
const hubSelector = require('../src/llm-selector.ts');
const { AGENTS } = require('../../orchestrator/scripts/seed-agent-registry.ts');

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
assert(Array.isArray(blogWriter.chain) && blogWriter.chain.length >= 3, 'blog writer must resolve managed fallback chain');
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

console.log(JSON.stringify({
  ok: true,
  seed_agents: AGENTS.length,
  runtime_managed: runtimeManaged.length,
  non_llm: nonLlmAgents.length,
  blog_writer_selector: blogWriter.selectorKey,
  blog_writer_chain: blogWriter.providerTiers,
  hub_runtime_selector: hubRuntime.selectorKey,
}, null, 2));
