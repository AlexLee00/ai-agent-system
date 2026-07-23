#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const readmeUpdater = require('../lib/steward/readme-updater.ts');
const { TEAMS } = require('../../../packages/core/lib/skills/team-orchestrator.ts');

const stats = readmeUpdater.countAgentStatsFromSeeds();
const activeTeamCount = TEAMS.filter((team: any) => team.status === 'active').length;

assert(stats.agentCount >= 100, 'README fallback seed stats must include current agent seed sources');
assert.equal(stats.teamCount, activeTeamCount, 'seed team count must match the active-team SSOT');
assert.equal(readmeUpdater.ACTIVE_TEAM_COUNT, activeTeamCount, 'README fallback must use the active-team SSOT');
assert(
  stats.seedFiles.some((file: string) => file.endsWith(path.join('scripts', 'seed-agent-registry.ts'))),
  'README fallback seed stats must use the current TypeScript seed-agent-registry source',
);
assert(
  stats.seedFiles.some((file: string) => file.endsWith(path.join('scripts', 'seed-team-reinforce-phase6.ts'))),
  'README fallback seed stats must use the current TypeScript Phase 6 reinforcement source',
);
assert(
  stats.seedFiles.some((file: string) => file.endsWith(path.join('scripts', 'seed-blog-agents-phase2.ts'))),
  'README fallback seed stats must include Blog Phase 2 agent source',
);
assert(
  stats.seedFiles.some((file: string) => file.endsWith(path.join('scripts', 'seed-blog-reinforce.ts'))),
  'README fallback seed stats must include Blog reinforcement agent source',
);

console.log(JSON.stringify({
  ok: true,
  agent_count: stats.agentCount,
  team_count: stats.teamCount,
  seed_files: stats.seedFiles,
}, null, 2));
