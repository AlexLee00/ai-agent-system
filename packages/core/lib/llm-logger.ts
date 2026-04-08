const loggerModule = require('./llm-logger.js');

export const logLLMCall = loggerModule.logLLMCall;
export const getDailyCost = loggerModule.getDailyCost;
export const getCostBreakdown = loggerModule.getCostBreakdown;
export const buildDailyCostReport = loggerModule.buildDailyCostReport;
export const analyzeCostTrend = loggerModule.analyzeCostTrend;
export const analyzeModelEfficiency = loggerModule.analyzeModelEfficiency;
export const buildWeeklyFeedbackReport = loggerModule.buildWeeklyFeedbackReport;
export const _calcCostForModel = loggerModule._calcCostForModel;
