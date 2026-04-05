'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const env = require('../../../../packages/core/lib/env');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const launchdManager = require('./launchd-manager');
const telegramManager = require('./telegram-manager');
const codexManager = require('./codex-manager');

const REPO_ROOT = env.PROJECT_ROOT;
const README_PATH = path.join(REPO_ROOT, 'README.md');

const SEED_FILES = [
  'bots/orchestrator/scripts/seed-agent-registry.js',
  'bots/orchestrator/scripts/seed-three-teams.js',
  'bots/orchestrator/scripts/seed-team-reinforce-phase6.js',
  'bots/orchestrator/scripts/seed-sigma-expansion.js',
];

function countAgentsFromSeeds() {
  let total = 0;
  for (const relativePath of SEED_FILES) {
    const filePath = path.join(REPO_ROOT, relativePath);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf8');
    total += (content.match(/name:\s*'/g) || []).length;
  }
  return total;
}

async function countAgents() {
  try {
    const row = await pgPool.get('agent', `
      SELECT COUNT(*)::int AS total
      FROM agent.registry
      WHERE status != 'archived'
    `, []);
    const total = Number(row?.total || 0);
    if (total > 0) return total;
  } catch {
    // seed fallback
  }
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

  return {
    agentCount: await countAgents(),
    teamCount: 10,
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
  getSystemStats,
  updateReadme,
};
