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
  agentTraceStatsRoute,
  agentDetailRoute,
};
