const selectorModule = require('./llm-model-selector.js') as typeof import('./llm-model-selector.js');

export const {
  inferProviderFromModel,
  buildSingleChain,
  selectLLMPolicy,
  selectLLMChain,
  describeLLMSelector,
  listLLMSelectorKeys,
  listAgentModelTargets,
  describeAgentModel,
} = selectorModule;
