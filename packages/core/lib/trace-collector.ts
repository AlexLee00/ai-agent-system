const traceCollectorModule = require('./trace-collector.js');

export const startTrace = traceCollectorModule.startTrace;
export const recordGeneration = traceCollectorModule.recordGeneration;
export const flush = traceCollectorModule.flush;
