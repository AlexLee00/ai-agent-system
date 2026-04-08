const llmTimeoutsModule =
  require('./llm-timeouts.js') as typeof import('./llm-timeouts.js');

export const {
  LLM_TIMEOUTS,
  getTimeout,
  updateTimeouts,
  calcTimeout,
  OVERRIDE_FILE,
} = llmTimeoutsModule;
