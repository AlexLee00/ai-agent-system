const selectorModule = require('./llm-model-selector.js');

export const inferProviderFromModel = selectorModule.inferProviderFromModel;
export const buildSingleChain = selectorModule.buildSingleChain;
export const selectLLMPolicy = selectorModule.selectLLMPolicy;
export const selectLLMChain = selectorModule.selectLLMChain;
export const describeLLMSelector = selectorModule.describeLLMSelector;
export const listLLMSelectorKeys = selectorModule.listLLMSelectorKeys;
export const listAgentModelTargets = selectorModule.listAgentModelTargets;
export const describeAgentModel = selectorModule.describeAgentModel;
