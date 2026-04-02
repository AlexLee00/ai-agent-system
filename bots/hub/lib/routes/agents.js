'use strict';

const {
  getAgent,
  getAllAgents,
  getAgentsByTeam,
  getAlwaysOnStatus,
  getDashboardData,
} = require('../../../../packages/core/lib/agent-registry');

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
  agentDetailRoute,
};
