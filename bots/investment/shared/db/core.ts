// @ts-nocheck
/**
 * Low-level PostgreSQL helpers for the investment schema.
 *
 * This module is intentionally small: it owns the shared pool binding and the
 * generic query/run/get/transaction helpers. Domain-specific table functions
 * stay behind shared/db.ts so existing imports remain stable.
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export const pgPool = require('../../../../packages/core/lib/pg-pool');
const { createSchemaDbHelpers } = require('../../../../packages/core/lib/db/helpers');

export const INVESTMENT_SCHEMA = 'investment';
export const schemaDb = createSchemaDbHelpers(pgPool, INVESTMENT_SCHEMA);

export function query(sql, params = []) {
  return schemaDb.query(sql, params);
}

export function run(sql, params = []) {
  return schemaDb.run(sql, params);
}

export function get(sql, params = []) {
  return schemaDb.get(sql, params);
}

export async function withTransaction(fn) {
  if (typeof fn !== 'function') throw new Error('withTransaction requires callback function');
  return pgPool.transaction(INVESTMENT_SCHEMA, async (client) => {
    const tx = {
      query: async (sql, params = []) => {
        const result = await client.query(sql, params);
        return result.rows || [];
      },
      run: async (sql, params = []) => {
        const result = await client.query(sql, params);
        return { rowCount: result.rowCount, rows: result.rows || [] };
      },
      get: async (sql, params = []) => {
        const result = await client.query(sql, params);
        return result.rows?.[0] || null;
      },
    };
    return fn(tx, client);
  });
}

export function close() {
  // pgPool is shared process-wide; global shutdown is handled by pgPool.closeAll().
}

export default {
  INVESTMENT_SCHEMA,
  schemaDb,
  query,
  run,
  get,
  withTransaction,
  close,
};
