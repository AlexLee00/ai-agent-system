const loaded = await import('./luna.legacy.js');

export const getMinConfidence = loaded.getMinConfidence;
export const getDebateLimit = loaded.getDebateLimit;
export const shouldDebateForSymbol = loaded.shouldDebateForSymbol;
export const fuseSignals = loaded.fuseSignals;
export const buildAnalysisSummary = loaded.buildAnalysisSummary;
export const getSymbolDecision = loaded.getSymbolDecision;
export const getPortfolioDecision = loaded.getPortfolioDecision;
export const getExitDecisions = loaded.getExitDecisions;
export const inspectPortfolioContext = loaded.inspectPortfolioContext;
export const orchestrate = loaded.orchestrate;
export default loaded.default ?? loaded;
