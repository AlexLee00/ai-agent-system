// @ts-nocheck
/**
 * Schema-level metadata and DDL guard helpers for the investment DB facade.
 *
 * The giant initSchema body still lives in shared/db.ts during this P0 tranche
 * to keep behavior stable. New schema utilities live here so subsequent table
 * families can move without changing callers.
 */

import { INVESTMENT_SCHEMA } from './core.ts';

export { INVESTMENT_SCHEMA };

export function isMissingInvestmentRelationError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  const code = String(error?.code || '');
  return code === '42P01'
    || message.includes('does not exist')
    || message.includes('relation')
    || message.includes(`${INVESTMENT_SCHEMA}.`);
}

export function normalizeInvestmentTableName(tableName = '') {
  return String(tableName || '')
    .trim()
    .replace(/^investment\./i, '')
    .replace(/[^a-z0-9_]/gi, '')
    .toLowerCase();
}

export default {
  INVESTMENT_SCHEMA,
  isMissingInvestmentRelationError,
  normalizeInvestmentTableName,
};
