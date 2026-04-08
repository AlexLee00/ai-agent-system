const agentsRouteModule = require('./agents.js') as typeof import('./agents.js');

export const {
  agentsListRoute,
  agentsDashboardRoute,
  agentsAlwaysOnRoute,
  agentsTraceStatsRoute,
  agentsSelectRoute,
  agentsLowPerformersRoute,
} = agentsRouteModule;
