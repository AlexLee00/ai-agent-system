const loggerModule = require('./llm-logger.js') as typeof import('./llm-logger.js');

export const {
  logLLMCall,
  getDailyCost,
  getCostBreakdown,
  buildDailyCostReport,
  analyzeCostTrend,
  analyzeModelEfficiency,
  buildWeeklyFeedbackReport,
  _calcCostForModel,
} = loggerModule;
