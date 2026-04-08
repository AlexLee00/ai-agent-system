const sigmaSchedulerModule =
  require('./sigma-scheduler.js') as typeof import('./sigma-scheduler.js');

export const {
  CORE_ANALYSTS,
  ROTATION,
  collectYesterdayEvents,
  decideTodayFormation,
} = sigmaSchedulerModule;
