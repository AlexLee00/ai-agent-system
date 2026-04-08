const sigmaAnalyzerModule =
  require('./sigma-analyzer.js') as typeof import('./sigma-analyzer.js');

export const { analyzeFormation } = sigmaAnalyzerModule;
