// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const env = require('../../../../packages/core/lib/env');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const launchdManager = require('./launchd-manager');
const telegramManager = require('./telegram-manager');
const codexManager = require('./codex-manager');
const { shadowRegistryStatsViaHub } = require('../hub-agent-registry-read');
const { TEAMS } = require('../../../../packages/core/lib/skills/team-orchestrator.ts');

const REPO_ROOT = env.PROJECT_ROOT;
const README_PATH = path.join(REPO_ROOT, 'README.md');
const ACTIVE_TEAM_COUNT = TEAMS.filter((team) => team.status === 'active').length;

const SEED_FILE_STEMS = [
  'bots/orchestrator/scripts/seed-agent-registry',
  'bots/orchestrator/scripts/seed-three-teams',
  'bots/orchestrator/scripts/seed-team-reinforce-phase6',
  'bots/orchestrator/scripts/seed-sigma-expansion',
  'bots/orchestrator/scripts/seed-blog-agents-phase2',
  'bots/orchestrator/scripts/seed-blog-reinforce',
];

function resolveSeedFile(relativeStem) {
  const candidates = /\.[cm]?[jt]s$/.test(relativeStem)
    ? [relativeStem]
    : [`${relativeStem}.ts`, `${relativeStem}.js`];
  return candidates.find((relativePath) => fs.existsSync(path.join(REPO_ROOT, relativePath))) || null;
}

function extractSeedAgentRefs(content) {
  const refs = [];
  const pattern = /\{\s*name:\s*['"]([^'"]+)['"][\s\S]*?team:\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    refs.push({ name: match[1], team: match[2] });
  }
  return refs;
}

function countAgentStatsFromSeeds() {
  const agents = new Set();
  const teams = new Set();
  const seedFiles = [];
  let fallbackNameCount = 0;

  for (const relativeStem of SEED_FILE_STEMS) {
    const relativePath = resolveSeedFile(relativeStem);
    if (!relativePath) continue;
    const filePath = path.join(REPO_ROOT, relativePath);
    const content = fs.readFileSync(filePath, 'utf8');
    seedFiles.push(relativePath);

    const refs = extractSeedAgentRefs(content);
    if (refs.length === 0) {
      fallbackNameCount += (content.match(/name:\s*['"]/g) || []).length;
      continue;
    }

    for (const ref of refs) {
      agents.add(`${ref.team}.${ref.name}`);
      teams.add(ref.team);
    }
  }

  return {
    agentCount: agents.size || fallbackNameCount,
    teamCount: teams.size,
    seedFiles,
  };
}

function countAgentsFromSeeds() {
  return countAgentStatsFromSeeds().agentCount;
}

async function countRegistryStats() {
  try {
    const row = await pgPool.get('agent', `
      SELECT
        COUNT(*)::int AS agent_total,
        COUNT(DISTINCT team)::int AS team_total
      FROM agent.registry
      WHERE status != 'archived'
    `, []);
    const agentCount = Number(row?.agent_total || 0);
    const teamCount = Number(row?.team_total || 0);
    if (agentCount > 0) return shadowRegistryStatsViaHub({ agentCount, teamCount });
  } catch {
    // seed fallback
  }
  return null;
}

async function countAgents() {
  const registryStats = await countRegistryStats();
  if (registryStats?.agentCount) return registryStats.agentCount;
  return countAgentsFromSeeds();
}

function getRepositorySize() {
  try {
    const output = execFileSync('du', ['-sh', '.git'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return output.split(/\s+/)[0] || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function getSystemStats() {
  const launchd = launchdManager.checkHealth();
  const topics = telegramManager.listTopics();
  const codex = codexManager.summarize();
  const seedStats = countAgentStatsFromSeeds();
  const registryStats = await countRegistryStats();

  return {
    agentCount: registryStats?.agentCount || seedStats.agentCount,
    teamCount: registryStats?.teamCount || ACTIVE_TEAM_COUNT,
    launchdTotal: Number(launchd.total || 0),
    launchdRunning: Number(launchd.running || 0),
    topicCount: topics.filter((item) => item.configured).length,
    codexArchive: Number(codex.archived || 0),
    repoSize: getRepositorySize(),
  };
}

function buildStatsBlock(stats) {
  return [
    '```',
    `Agents:          ${stats.agentCount} (across ${stats.teamCount} teams)`,
    `launchd Services: ${stats.launchdTotal} (${stats.launchdRunning} running continuously)`,
    `Telegram Topics:  ${stats.topicCount} (per-team routing)`,
    `Codex Archives:   ${stats.codexArchive}+ (completed implementation prompts)`,
    `Repository Size:  ${stats.repoSize} (optimized)`,
    'Monthly API Cost: $0 (fully local LLM inference)',
    '```',
  ].join('\n');
}

async function updateReadme(stats = null) {
  const resolvedStats = stats || await getSystemStats();
  const original = fs.readFileSync(README_PATH, 'utf8');
  const nextStatsBlock = buildStatsBlock(resolvedStats);
  const updated = original.replace(
    /```\nAgents:[\s\S]*?Monthly API Cost:.*?\n```/,
    nextStatsBlock
  );

  if (updated === original) {
    return { changed: false, stats: resolvedStats };
  }

  fs.writeFileSync(README_PATH, updated, 'utf8');
  return { changed: true, stats: resolvedStats };
}

module.exports = {
  README_PATH,
  countAgentStatsFromSeeds,
  countAgentsFromSeeds,
  getSystemStats,
  updateReadme,
  ACTIVE_TEAM_COUNT,
};
