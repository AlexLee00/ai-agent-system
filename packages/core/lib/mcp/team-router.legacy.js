'use strict';

const { getMcpDefinition, listMcps } = require('./free-registry');
const { readMcpsFromConfig } = require('./loader');

const TEAM_CONFIG_MAP = {
  darwin: '/Users/alexlee/projects/ai-agent-system/bots/academic/config.json',
  justin: '/Users/alexlee/projects/ai-agent-system/bots/legal/config.json',
  sigma: '/Users/alexlee/projects/ai-agent-system/bots/data/config.json',
};

const TASK_KEYWORDS = {
  research: ['research', 'search', 'source', 'paper', 'code'],
  citation: ['citation', 'legal', 'evidence', 'review', 'brief'],
  quality: ['quality', 'etl', 'analysis', 'metrics', 'dataset'],
};

function normalizeTask(taskType = '') {
  const lowered = String(taskType || '').toLowerCase();

  for (const [name, keywords] of Object.entries(TASK_KEYWORDS)) {
    if (keywords.some((keyword) => lowered.includes(keyword))) {
      return name;
    }
  }

  return lowered || 'general';
}

function scoreMcp(definition, team, taskType, declaredMcps) {
  let score = 0;
  const reasons = [];

  if (declaredMcps.includes(definition.id)) {
    score += 4;
    reasons.push('declared in bot config');
  }
  if (definition.preferredTeams.includes(team)) {
    score += 3;
    reasons.push('preferred for team');
  }
  if (definition.taskHints.includes(taskType)) {
    score += 2;
    reasons.push('matches task type');
  }
  if (definition.mode === 'local') {
    score += 1;
    reasons.push('local/free');
  }

  return { score, reasons };
}

function recommendMcps(team, taskType, options = {}) {
  const normalizedTask = normalizeTask(taskType);
  const configPath = options.configPath || TEAM_CONFIG_MAP[team];
  const declaredMcps = configPath ? readMcpsFromConfig(configPath) : [];

  return listMcps()
    .map((definition) => {
      const { score, reasons } = scoreMcp(definition, team, normalizedTask, declaredMcps);
      return {
        id: definition.id,
        label: definition.label,
        score,
        reasons,
        capabilities: definition.capabilities,
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function buildMcpPlan(team, taskType, options = {}) {
  const normalizedTask = normalizeTask(taskType);
  const recommended = recommendMcps(team, normalizedTask, options);

  return recommended.slice(0, 3).map((item, index) => ({
    step: index + 1,
    mcp: item.id,
    action: normalizedTask === 'research'
      ? `use ${item.id} to gather verifiable sources`
      : normalizedTask === 'citation'
        ? `use ${item.id} to validate identifiers and evidence`
        : `use ${item.id} to inspect data quality and operational context`,
    reasons: item.reasons,
  }));
}

module.exports = { normalizeTask, recommendMcps, buildMcpPlan, TEAM_CONFIG_MAP, getMcpDefinition };

