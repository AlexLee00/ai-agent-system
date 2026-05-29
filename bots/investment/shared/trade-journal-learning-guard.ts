// @ts-nocheck
/**
 * Shared SQL guard for learning queries that consume trade_journal PnL.
 *
 * Reconciliation/dust closes can be operationally valid while their PnL is
 * intentionally unknown. Learning code must not coerce those rows to zero.
 */

export function learningPnlValidSql(alias = 'tj') {
  const prefix = alias ? `${alias}.` : '';
  return [
    `${prefix}pnl_amount IS NOT NULL`,
    `COALESCE(${prefix}exit_reason, '') NOT LIKE 'journal_reconciled%'`,
    `COALESCE(${prefix}exit_reason, '') NOT LIKE 'sweeper_manual_dust%'`,
  ].join('\n  AND ');
}

export const LEARNING_PNL_VALID = learningPnlValidSql('tj');

export default {
  LEARNING_PNL_VALID,
  learningPnlValidSql,
};
