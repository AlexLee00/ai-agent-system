const hubClientModule = require('./hub-client.js') as typeof import('./hub-client.js');

export const {
  fetchHubSecrets,
  queryOpsDb,
  fetchOpsErrors,
  fetchHubRuntimeProfile,
} = hubClientModule;
