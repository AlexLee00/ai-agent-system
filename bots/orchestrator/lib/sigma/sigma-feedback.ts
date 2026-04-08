const sigmaFeedbackModule =
  require('./sigma-feedback.js') as typeof import('./sigma-feedback.js');

export const {
  ensureSigmaTables,
  collectTeamMetric,
  collectScoutQualityMetric,
  computeEffectiveness,
  recordScoutQualityEvent,
  recordDailyRun,
  recordFeedbackRecommendation,
  measurePastFeedbackEffectiveness,
  weeklyMetaReview,
} = sigmaFeedbackModule;
