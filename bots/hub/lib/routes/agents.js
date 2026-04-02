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
  agentTraceStatsRoute,
  agentDetailRoute,
};
