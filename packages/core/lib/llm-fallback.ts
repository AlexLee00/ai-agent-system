const fallbackModule = require('./llm-fallback.js') as typeof import('./llm-fallback.js');

export const { callWithFallback } = fallbackModule;
