const errorsRouteModule = require('./errors.js') as typeof import('./errors.js');

export const { errorsRecentRoute, errorsSummaryRoute } = errorsRouteModule;
