const llmTimeoutsModule = require('./llm-timeouts.js');

export const LLM_TIMEOUTS = llmTimeoutsModule.LLM_TIMEOUTS;
export const getTimeout = llmTimeoutsModule.getTimeout;
export const updateTimeouts = llmTimeoutsModule.updateTimeouts;
export const calcTimeout = llmTimeoutsModule.calcTimeout;
export const OVERRIDE_FILE = llmTimeoutsModule.OVERRIDE_FILE;
