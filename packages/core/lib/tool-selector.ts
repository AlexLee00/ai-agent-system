const toolSelectorModule =
  require('./tool-selector.js') as typeof import('./tool-selector.js');

export const {
  listTools,
  getTool,
  selectBestTool,
  evaluateTool,
  registerTool,
} = toolSelectorModule;
