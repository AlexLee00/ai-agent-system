const logsRouteModule = require('./logs.js') as typeof import('./logs.js');

export const { logsSearchRoute, logsStatsRoute } = logsRouteModule;
