const healthRouteModule = require('./health.js') as typeof import('./health.js');

export const { healthRoute } = healthRouteModule;
