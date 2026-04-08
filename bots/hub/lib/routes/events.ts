const eventsRouteModule = require('./events.js') as typeof import('./events.js');

export const { eventsSearchRoute, eventsStatsRoute, eventsFeedbackRoute } = eventsRouteModule;
