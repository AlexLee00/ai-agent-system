'use strict';

const skills = require('./skills');
const mcp = require('./mcp');

function normalizeTask(taskType = '') {
  return mcp.normalizeTask(taskType);
}

function selectSkill(team, taskType) {
  const normalizedTask = normalizeTask(taskType);
  const map = {
    darwin: {
      research: 'darwin/source-ranking',
      source: 'darwin/source-ranking',
    },
    justin: {
      citation: 'justin/citation-audit',
      evidence: 'justin/citation-audit',
    },
    sigma: {
      quality: 'sigma/data-quality-guard',
      analysis: 'sigma/data-quality-guard',
      etl: 'sigma/data-quality-guard',
    },
  };

  return map[team]?.[normalizedTask] || null;
}

function _getRunner(skillName) {
  const runners = {
    'darwin/source-ranking': (payload) => skills.darwin.sourceRanking.rankSources(payload.items || []),
    'justin/citation-audit': (payload) => skills.justin.citationAudit.auditCitations(payload.citations || []),
    'sigma/data-quality-guard': (payload) => skills.sigma.dataQualityGuard.evaluateDataset(payload || {}),
  };
  return runners[skillName] || null;
}

function runSkill(team, taskType, payload = {}) {
  const skillName = selectSkill(team, taskType);
  const runner = _getRunner(skillName);
  if (!runner) {
    return {
      selected_skill: null,
      skill_result: null,
      error: 'no skill mapping',
    };
  }

  return {
    selected_skill: skillName,
    skill_result: runner(payload),
    error: null,
  };
}

function shouldUseMcp(team, taskType, skillResult) {
  const normalizedTask = normalizeTask(taskType);

  if (!skillResult) return false;

  if (team === 'darwin' && normalizedTask === 'research') {
    const ranked = Array.isArray(skillResult.ranked) ? skillResult.ranked : [];
    return ranked.some((item) => (item.risk_flags || []).length > 0 || ['C', 'D'].includes(item.tier));
  }

  if (team === 'justin' && normalizedTask === 'citation') {
    const summary = skillResult.summary || {};
    return Number(summary.critical || 0) > 0 || Number(summary.high || 0) > 0;
  }

  if (team === 'sigma' && normalizedTask === 'quality') {
    return Array.isArray(skillResult.issues) && skillResult.issues.length > 0;
  }

  return false;
}

function getGate(team, taskType) {
  const normalizedTask = normalizeTask(taskType);
  if (team === 'darwin' && normalizedTask === 'research') return 'read-only';
  if (team === 'justin') return 'validate';
  if (team === 'sigma') return 'validate';
  return 'read-only';
}

function buildTeamPipeline(input = {}) {
  const team = String(input.team || '').toLowerCase();
  const taskType = String(input.taskType || input.task || '').toLowerCase();
  const payload = input.payload || {};

  const { selected_skill, skill_result, error } = runSkill(team, taskType, payload);
  const useMcp = !error && shouldUseMcp(team, taskType, skill_result);
  const recommended = useMcp ? mcp.recommendMcps(team, taskType) : [];
  const plan = useMcp ? mcp.buildMcpPlan(team, taskType) : [];

  return {
    success: !error,
    team,
    task: normalizeTask(taskType),
    selected_skill,
    skill_result,
    should_use_mcp: useMcp,
    recommended_mcps: recommended,
    mcp_plan: plan,
    gate: getGate(team, taskType),
    error,
  };
}

module.exports = {
  selectSkill,
  runSkill,
  shouldUseMcp,
  buildTeamPipeline,
};

