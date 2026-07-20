#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');
const { TEAMS, RETIRED_TEAMS, distributeTask } = require('../../../packages/core/lib/skills/team-orchestrator.ts');
const { AGENTS } = require('./seed-agent-registry.ts');
const {
  isLlmRouteTargetAllowed,
  listLLMSelectorKeys,
  listAgentModelTargets,
} = require('../../../packages/core/lib/llm-model-selector.ts');
const { PROFILES, selectRuntimeProfile } = require('../../hub/lib/runtime-profiles.ts');

const activeTeamIds = TEAMS
  .filter((team: { status?: string }) => team.status === 'active')
  .map((team: { id?: string }) => team.id);
const retiredTeamIds = RETIRED_TEAMS.map((team: { id?: string }) => team.id);
const selectorKeys = listLLMSelectorKeys();
const modelTargets = listAgentModelTargets();
const deploymentRegistry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'bots/registry.json'), 'utf8'));
const routeRegistry = fs.readFileSync(path.join(repoRoot, 'bots/hub/src/route-registry.ts'), 'utf8');
const externalGatewayGuide = fs.readFileSync(
  path.join(repoRoot, 'docs/hub/EXTERNAL_LLM_GATEWAY_PROJECT_ONBOARDING.md'),
  'utf8',
);
const parityDocument = fs.readFileSync(path.join(repoRoot, 'docs/PARITY_AGENT_OS.md'), 'utf8');
const commanderRegistry = fs.readFileSync(
  path.join(repoRoot, 'bots/orchestrator/lib/commanders/index.ts'),
  'utf8',
);
const mcpLoader = fs.readFileSync(path.join(repoRoot, 'packages/core/lib/mcp/loader.ts'), 'utf8');
const skillLoader = fs.readFileSync(path.join(repoRoot, 'packages/core/lib/skills/loader.ts'), 'utf8');

assert.ok(!activeTeamIds.includes('justin'), 'Justin must not be an active team');
assert.ok(retiredTeamIds.includes('justin'), 'Justin retirement must remain explicit');
assert.equal(distributeTask({ relatedTeams: ['justin'], description: '법률 검토' }).team, 'jay');
assert.equal(distributeTask({ description: '법률 계약 판례 검토' }).team, 'jay');
assert.ok(!AGENTS.some((agent: { team?: string }) => agent.team === 'justin'), 'Justin agents must not be reseeded');
assert.ok(!selectorKeys.some((key: string) => key.startsWith('justin.')), 'Justin selectors must stay retired');
assert.ok(!modelTargets.some((target: { canonicalTeam?: string }) => target.canonicalTeam === 'justin'));
assert.equal(isLlmRouteTargetAllowed({ callerTeam: 'justin', selectorKey: 'justin._default' }).ok, false);
assert.equal(isLlmRouteTargetAllowed({ callerTeam: 'legal', selectorKey: 'legal._default' }).ok, false);
assert.equal(PROFILES.justin, undefined, 'Justin runtime profiles must stay retired');
assert.equal(selectRuntimeProfile('justin'), null);
assert.equal(deploymentRegistry?.bots?.legal, undefined, 'Justin deployment inventory must stay retired');
assert.ok(!routeRegistry.includes("require('../lib/routes/legal')"), 'Justin legal routes must not be registered');
assert.ok(!routeRegistry.includes('/hub/legal/'), 'Justin legal endpoints must stay retired');
assert.ok(!externalGatewayGuide.includes('justin.stage-3'), 'External onboarding must not advertise a retired selector');
assert.ok(!externalGatewayGuide.includes('justin-court-appraisal'), 'External onboarding must use a generic project');
assert.ok(!parityDocument.includes('Justin leader team'), 'Living parity must not report Justin as active');
assert.ok(!parityDocument.includes('## Justin Team'), 'Living parity must not expose an active Justin section');
assert.ok(!commanderRegistry.includes('legal-adapter'), 'Retired legal commander must not be registered');
assert.ok(!mcpLoader.includes("id: 'legal'"), 'Retired legal MCP config must not be loaded');
assert.ok(!skillLoader.includes("id: 'legal'"), 'Retired legal skill config must not be loaded');
assert.equal(fs.existsSync(path.join(repoRoot, 'bots/orchestrator/lib/commanders/legal-adapter.ts')), false);
assert.equal(fs.existsSync(path.join(repoRoot, 'bots/hub/lib/routes/legal.ts')), false);
const retiredSkillDir = path.join(repoRoot, 'packages/core/lib/skills/justin');
assert.ok(!fs.existsSync(retiredSkillDir) || fs.readdirSync(retiredSkillDir).length === 0);

const activeRuntimeFiles = [
  'bots/blog/a2a/client.ts',
  'bots/claude/a2a/client.ts',
  'bots/darwin/a2a/client.ts',
  'bots/investment/a2a/client.ts',
  'bots/sigma/a2a/client.ts',
  'bots/ska/a2a/client.ts',
  'bots/sigma/ts/lib/sigma-scheduler.ts',
  'bots/sigma/ts/lib/intelligent-library.ts',
  'bots/sigma/elixir/lib/sigma/v2/config.ex',
  'bots/sigma/elixir/lib/sigma/v2/commander.ex',
  'bots/jay/elixir/lib/jay/v2/commander.ex',
  'bots/jay/elixir/lib/jay/v2/sigma/scheduler.ex',
  'bots/jay/elixir/lib/jay/v2/skill/formation_decision.ex',
  'bots/jay/elixir/lib/jay/v2/team_connector.ex',
  'bots/orchestrator/scripts/seed-team-reinforce-phase6.ts',
  'bots/orchestrator/scripts/seed-three-teams.ts',
  'bots/orchestrator/scripts/seed-skills-tools.ts',
  'packages/core/lib/team-skill-mcp-pipeline.ts',
  'packages/core/lib/mcp/team-router.ts',
  'tests/load/multi-team.js',
  'tests/load/peak.js',
];
for (const relativePath of activeRuntimeFiles) {
  const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
  assert.ok(!/justin|저스틴/i.test(source), `${relativePath} must not reactivate Justin`);
}

console.log(JSON.stringify({
  ok: true,
  activeTeams: activeTeamIds.length,
  retiredTeams: retiredTeamIds,
  justinSelectors: 0,
  justinAgents: 0,
  activeRuntimeFilesChecked: activeRuntimeFiles.length,
  liveMutation: false,
  dbWrite: false,
}));
