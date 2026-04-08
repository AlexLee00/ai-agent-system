const pgPoolModule = require('./pg-pool.js') as typeof import('./pg-pool.js');

export const {
  getPool,
  parameterize,
  query,
  run,
  get,
  prepare,
  transaction,
  ping,
  closeAll,
  getPoolStats,
  getAllPoolStats,
  checkPoolHealth,
  getClient,
} = pgPoolModule;
