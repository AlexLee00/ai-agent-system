const traceCollectorModule =
  require('./trace-collector.js') as typeof import('./trace-collector.js');

export const {
  startTrace,
  recordGeneration,
  flush,
} = traceCollectorModule;
