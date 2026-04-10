const loaded = await import('./force-exit-candidate-report.legacy.js');

export const parseArgs = loaded.parseArgs;
export const getMarketLabel = loaded.getMarketLabel;
export const getThresholdHours = loaded.getThresholdHours;
export const getCandidateLevel = loaded.getCandidateLevel;
export const getPriorityScore = loaded.getPriorityScore;
export const buildSummary = loaded.buildSummary;
export const formatHuman = loaded.formatHuman;
export const ensureReadableInvestmentSchema = loaded.ensureReadableInvestmentSchema;
export const loadCandidates = loaded.loadCandidates;
export default loaded.default ?? loaded;
