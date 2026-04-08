const servicesRouteModule = require('./services.js') as typeof import('./services.js');

export const { servicesStatusRoute, envRoute } = servicesRouteModule;
