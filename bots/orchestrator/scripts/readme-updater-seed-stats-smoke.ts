#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const readmeUpdater = require('../lib/steward/readme-updater.ts');

const stats = readmeUpdater.countAgentStatsFromSeeds();

assert(stats.agentCount >= 100, 'README fallback seed stats must include current agent seed sources');
assert(stats.teamCount >= 8, 'README fallback seed stats must derive active teams from seed files');
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
