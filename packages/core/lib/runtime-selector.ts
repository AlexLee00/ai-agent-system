const runtimeSelectorModule =
  require('./runtime-selector.js') as typeof import('./runtime-selector.js');

export const { selectRuntime } = runtimeSelectorModule;
