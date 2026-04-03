'use strict';

const {
  getAgent,
  getAllAgents,
  getAgentsByTeam,
  getAlwaysOnStatus,
  getDashboardData,
} = require('../../../../packages/core/lib/agent-registry');
const {
  getTraceStats,
  getAgentTraceStats,
} = require('../../../../packages/core/lib/trace-collector');
const {
  selectBestAgent,
  hire,
  evaluate,
  getLowPerformersForRehab,
} = require('../../../../packages/core/lib/hiring-contract');
const {
  listSkills,
  selectBestSkill,
  evaluateSkill,
} = require('../../../../packages/core/lib/skill-selector');
const {
  listTools,
  selectBestTool,
  evaluateTool,
} = require('../../../../packages/core/lib/tool-selector');
const {
  startCompetition,
  completeCompetition,
  getCompetitionHistory,
} = require('../../../../packages/core/lib/competition-engine');
const { selectRuntimeProfile } = require('../runtime-profiles');

async function agentsListRoute(req, res) {
  const team = typeof req.query.team === 'string' && req.query.team.trim() ? req.query.team.trim() : null;
  const agents = team ? await getAgentsByTeam(team) : await getAllAgents();
  return res.json({
    ok: true,
    count: agents.length,
    team,
    agents,
  });
}

async function agentsDashboardRoute(req, res) {
  const dashboard = await getDashboardData();
  return res.json({
    ok: true,
    ...dashboard,
  });
}

async function agentsAlwaysOnRoute(req, res) {
  const agents = await getAlwaysOnStatus();
  return res.json({
    ok: true,
    count: agents.length,
    agents,
  });
}

async function agentsTraceStatsRoute(req, res) {
  const days = Number.parseInt(req.query.days, 10) || 7;
  const stats = await getTraceStats(days);
  return res.json({
    ok: true,
    days,
    stats,
  });
}

async function agentsSelectRoute(req, res) {
  const role = typeof req.query.role === 'string' ? req.query.role.trim() : '';
  const team = typeof req.query.team === 'string' && req.query.team.trim() ? req.query.team.trim() : null;
  if (!role) {
    return res.status(400).json({ ok: false, error: 'role required' });
  }
  const agent = await selectBestAgent(role, team);
  return res.json({ ok: true, role, team, agent });
}

async function agentsLowPerformersRoute(req, res) {
  const threshold = Number.parseFloat(req.query.threshold) || 4.0;
  const agents = await getLowPerformersForRehab(threshold);
  return res.json({ ok: true, count: agents.length, threshold, agents });
}

async function agentsHireRoute(req, res) {
  const { agentName, ...taskData } = req.body || {};
  if (!agentName) {
    return res.status(400).json({ ok: false, error: 'agentName required' });
  }
  const contract = await hire(agentName, taskData);
  return res.json({ ok: true, contract });
}

async function agentsEvaluateRoute(req, res) {
  const { contractId, result, confidence } = req.body || {};
  if (!contractId) {
    return res.status(400).json({ ok: false, error: 'contractId required' });
  }
  const evaluation = await evaluate(contractId, result || {}, confidence);
  return res.json({ ok: true, evaluation });
}

async function agentsCompetitionStartRoute(req, res) {
  const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
  const team = typeof req.body?.team === 'string' && req.body.team.trim() ? req.body.team.trim() : 'blog';
  if (!topic) {
    return res.status(400).json({ ok: false, error: 'topic required' });
  }
  const competition = await startCompetition(topic, team);
  return res.json({ ok: true, competition });
}

async function agentsCompetitionCompleteRoute(req, res) {
  const competitionId = Number.parseInt(req.body?.competitionId, 10);
  if (!competitionId) {
    return res.status(400).json({ ok: false, error: 'competitionId required' });
  }
  const resultA = req.body?.resultA || {};
  const resultB = req.body?.resultB || {};
  const competition = await completeCompetition(competitionId, resultA, resultB);
  return res.json({ ok: true, competition });
}

async function agentsCompetitionHistoryRoute(req, res) {
  const team = typeof req.query.team === 'string' && req.query.team.trim() ? req.query.team.trim() : 'blog';
  const limit = Number.parseInt(req.query.limit, 10) || 10;
  const competitions = await getCompetitionHistory(team, limit);
  return res.json({ ok: true, count: competitions.length, team, competitions });
}

async function skillsListRoute(req, res) {
  const team = typeof req.query.team === 'string' && req.query.team.trim() ? req.query.team.trim() : null;
  const category = typeof req.query.category === 'string' && req.query.category.trim() ? req.query.category.trim() : null;
  const skills = await listSkills(team, category);
  return res.json({ ok: true, count: skills.length, team, category, skills });
}

async function skillsSelectRoute(req, res) {
  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  const team = typeof req.query.team === 'string' && req.query.team.trim() ? req.query.team.trim() : null;
  if (!category) {
    return res.status(400).json({ ok: false, error: 'category required' });
  }
  const skill = await selectBestSkill(category, team);
  return res.json({ ok: true, category, team, skill });
}

async function skillsEvaluateRoute(req, res) {
  const skillName = typeof req.body?.skillName === 'string' ? req.body.skillName.trim() : '';
  if (!skillName) {
    return res.status(400).json({ ok: false, error: 'skillName required' });
  }
  const success = !!req.body?.success;
  const latencyMs = req.body?.latencyMs ?? req.body?.latency_ms ?? null;
  const updated = await evaluateSkill(skillName, success, latencyMs);
  return res.json({ ok: true, skillName, updated });
}

async function toolsListRoute(req, res) {
  const team = typeof req.query.team === 'string' && req.query.team.trim() ? req.query.team.trim() : null;
  const capability = typeof req.query.capability === 'string' && req.query.capability.trim() ? req.query.capability.trim() : null;
  const tools = await listTools(team, capability);
  return res.json({ ok: true, count: tools.length, team, capability, tools });
}

async function toolsSelectRoute(req, res) {
  const capability = typeof req.query.capability === 'string' ? req.query.capability.trim() : '';
  const team = typeof req.query.team === 'string' && req.query.team.trim() ? req.query.team.trim() : null;
  if (!capability) {
    return res.status(400).json({ ok: false, error: 'capability required' });
  }
  const tool = await selectBestTool(capability, team);
  return res.json({ ok: true, capability, team, tool });
}

async function toolsEvaluateRoute(req, res) {
  const toolName = typeof req.body?.toolName === 'string' ? req.body.toolName.trim() : '';
  if (!toolName) {
    return res.status(400).json({ ok: false, error: 'toolName required' });
  }
  const success = !!req.body?.success;
  const latencyMs = req.body?.latencyMs ?? req.body?.latency_ms ?? null;
  const updated = await evaluateTool(toolName, success, latencyMs);
  return res.json({ ok: true, toolName, updated });
}

async function runtimeSelectRoute(req, res) {
  const team = typeof req.query.team === 'string' ? req.query.team.trim() : '';
  const purpose = typeof req.query.purpose === 'string' && req.query.purpose.trim()
    ? req.query.purpose.trim()
    : 'default';
  if (!team) {
    return res.status(400).json({ ok: false, error: 'team required' });
  }
  const profile = selectRuntimeProfile(team, purpose);
  return res.json({
    ok: true,
    team,
    purpose,
    profile,
    selection_reason: profile ? 'team-runtime-profile' : 'no-runtime-profile',
  });
}

async function agentTraceStatsRoute(req, res) {
  const days = Number.parseInt(req.query.days, 10) || 7;
  const stats = await getAgentTraceStats(req.params.name, days);
  return res.json({
    ok: true,
    agent: req.params.name,
    days,
    stats,
  });
}

async function agentDetailRoute(req, res) {
  const agent = await getAgent(req.params.name);
  if (!agent) {
    return res.status(404).json({
      ok: false,
      error: `agent not found: ${req.params.name}`,
    });
  }
  return res.json({
    ok: true,
    agent,
  });
}

module.exports = {
  agentsListRoute,
  agentsDashboardRoute,
  agentsAlwaysOnRoute,
  agentsTraceStatsRoute,
  agentsSelectRoute,
  agentsLowPerformersRoute,
  agentsHireRoute,
  agentsEvaluateRoute,
  agentsCompetitionStartRoute,
  agentsCompetitionCompleteRoute,
  agentsCompetitionHistoryRoute,
  skillsListRoute,
  skillsSelectRoute,
  skillsEvaluateRoute,
  toolsListRoute,
  toolsSelectRoute,
  toolsEvaluateRoute,
  runtimeSelectRoute,
  agentTraceStatsRoute,
  agentDetailRoute,
};
