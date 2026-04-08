const pgPoolModule = require('./pg-pool.js');

export const getPool = pgPoolModule.getPool;
export const parameterize = pgPoolModule.parameterize;
export const query = pgPoolModule.query;
export const run = pgPoolModule.run;
export const get = pgPoolModule.get;
export const prepare = pgPoolModule.prepare;
export const transaction = pgPoolModule.transaction;
export const ping = pgPoolModule.ping;
export const closeAll = pgPoolModule.closeAll;
export const getPoolStats = pgPoolModule.getPoolStats;
export const getAllPoolStats = pgPoolModule.getAllPoolStats;
export const checkPoolHealth = pgPoolModule.checkPoolHealth;
export const getClient = pgPoolModule.getClient;
