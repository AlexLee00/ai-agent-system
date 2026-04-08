const darwinCallbackModule =
  require('./darwin-callback.js') as typeof import('./darwin-callback.js');

export const { darwinCallbackRoute } = darwinCallbackModule;
