// @ts-nocheck
import * as db from './db.ts';
import { getLunaOperatingEpoch } from './luna-operating-epoch.ts';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);

function boolEnv(name: string, fallback = false, env = process.env) {
  const raw = String(env?.[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return TRUE_VALUES.has(raw);
}

export function deriveTradeJournalNumericId(rowOrId: any): number | null {
  const raw = typeof rowOrId === 'object' && rowOrId !== null
    ? (rowOrId.trade_id ?? rowOrId.tradeId ?? rowOrId.id)
    : rowOrId;
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits || digits.length > 15) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function tradeJournalNumericIdSql(alias = 'tj') {
  const value = `NULLIF(regexp_replace(COALESCE(${alias}.trade_id, ${alias}.id), '\\D', '', 'g'), '')`;
  return `CASE WHEN ${value} ~ '^[0-9]{1,15}$' THEN ${value}::BIGINT ELSE NULL END`;
}

export function normalizeJournalMarket(row: any = {}) {
  const market = String(row.market || '').trim().toLowerCase();
  const exchange = String(row.exchange || '').trim().toLowerCase();
  if (market === 'crypto' || exchange === 'binance') return 'crypto';
  if (market === 'domestic' || exchange === 'kis' || exchange === 'krx') return 'domestic';
  if (market === 'overseas' || exchange === 'kis_overseas') return 'overseas';
  return market || 'all';
}

export function tradeJournalMarketSql(alias = 'tj') {
  return `CASE
    WHEN COALESCE(${alias}.market, '') = 'crypto' OR ${alias}.exchange = 'binance' THEN 'crypto'
    WHEN COALESCE(${alias}.market, '') = 'domestic' OR ${alias}.exchange IN ('kis', 'krx') THEN 'domestic'
    WHEN COALESCE(${alias}.market, '') = 'overseas' OR ${alias}.exchange = 'kis_overseas' THEN 'overseas'
    ELSE COALESCE(NULLIF(${alias}.market, ''), 'all')
  END`;
}

export function mapTradeJournalRowToPosttradeTrade(row: any = {}, numericId = null) {
  const tradeId = numericId ?? deriveTradeJournalNumericId(row);
  if (!tradeId) return null;
  return {
    id: tradeId,
    source_id: row.id || null,
    source_trade_id: row.trade_id || null,
    symbol: row.symbol,
    market: normalizeJournalMarket(row),
    exchange: row.exchange,
    direction: row.direction || 'long',
    entry_price: Number(row.entry_price || 0),
    exit_price: Number(row.exit_price || row.entry_price || 0),
    amount_krw: Number(row.exit_value || row.entry_value || 0),
    entry_at: Number(row.entry_time || 0) || row.entry_time || null,
    exit_at: Number(row.exit_time || 0) || row.exit_time || null,
    exit_reason: row.exit_reason || row.quality_flag || 'trade_journal_close',
    setup_type: row.strategy_family || row.execution_origin || 'trade_journal',
    market_regime: row.market_regime || null,
    strategy_family: row.strategy_family || null,
    pnl_percent: row.pnl_percent ?? null,
  };
}

export function resolveTradeJournalPosttradeScope({
  includeDevelopment = null,
  env = process.env,
} = {}) {
  const epoch = getLunaOperatingEpoch(env);
  const includeDev = includeDevelopment === null || includeDevelopment === undefined
    ? boolEnv('LUNA_POSTTRADE_INCLUDE_DEVELOPMENT_TRADES', false, env)
    : includeDevelopment === true;
  const enforceOperatingEpoch = epoch.enabled === true
    && epoch.valid === true
    && Number.isFinite(Number(epoch.startedAtMs))
    && includeDev !== true;
  return {
    includeDevelopment: includeDev,
    enforceOperatingEpoch,
    operatingEpochStartedAt: epoch.startedAt,
    operatingEpochStartedAtMs: epoch.startedAtMs,
    developmentDataPolicy: enforceOperatingEpoch
      ? 'exclude_development_trade_journal_rows'
      : 'include_trade_journal_history',
  };
}

export async function fetchTradeJournalPosttradeTrade(tradeId: number) {
  const expr = tradeJournalNumericIdSql('tj');
  const row = await db.get(
    `SELECT ${expr} AS numeric_trade_id, tj.*
       FROM investment.trade_journal tj
      WHERE ${expr} = $1
      ORDER BY COALESCE(tj.exit_time, tj.entry_time, tj.created_at) DESC NULLS LAST
      LIMIT 1`,
    [Number(tradeId)],
  ).catch(() => null);
  return row ? mapTradeJournalRowToPosttradeTrade(row, Number(row.numeric_trade_id || tradeId)) : null;
}

export async function fetchPendingTradeJournalPosttradeCandidates({
  limit = 50,
  market = 'all',
  seen = new Set(),
  includeDevelopment = null,
} = {}) {
  const safeLimit = Math.max(1, Number(limit || 50));
  const targetMarket = String(market || 'all').trim().toLowerCase();
  const idExpr = tradeJournalNumericIdSql('tj');
  const marketExpr = tradeJournalMarketSql('tj');
  const scope = resolveTradeJournalPosttradeScope({ includeDevelopment });
  const params = [safeLimit * 3];
  const marketClause = targetMarket === 'all'
    ? ''
    : (() => {
        params.push(targetMarket);
        return `AND ${marketExpr} = $${params.length}`;
      })();
  const operatingEpochClause = scope.enforceOperatingEpoch
    ? (() => {
        params.push(Number(scope.operatingEpochStartedAtMs));
        return `AND COALESCE(tj.exit_time, tj.entry_time, tj.created_at) >= $${params.length}`;
      })()
    : '';
  const rows = await db.query(
    `SELECT ${idExpr} AS trade_id,
            tj.id AS journal_id,
            ${marketExpr} AS market,
            tj.exit_time,
            tj.created_at
       FROM investment.trade_journal tj
       LEFT JOIN investment.trade_quality_evaluations tqe
         ON tqe.trade_id = ${idExpr}
      WHERE LOWER(COALESCE(tj.status, '')) = 'closed'
        AND tj.exit_time IS NOT NULL
        AND ${idExpr} IS NOT NULL
        AND tqe.trade_id IS NULL
        ${marketClause}
        ${operatingEpochClause}
      ORDER BY tj.exit_time DESC NULLS LAST, tj.created_at DESC NULLS LAST
      LIMIT $1`,
    params,
  ).catch(() => []);

  const output = [];
  for (const row of rows || []) {
    const tradeId = Number(row.trade_id);
    if (!Number.isSafeInteger(tradeId) || tradeId <= 0 || seen.has(tradeId)) continue;
    seen.add(tradeId);
    output.push({
      tradeId,
      source: 'trade_journal_scan' as const,
      knowledgeId: null,
      journalId: row.journal_id || null,
      scope: scope.developmentDataPolicy,
    });
    if (output.length >= safeLimit) break;
  }
  return output;
}

export default {
  deriveTradeJournalNumericId,
  tradeJournalNumericIdSql,
  tradeJournalMarketSql,
  normalizeJournalMarket,
  mapTradeJournalRowToPosttradeTrade,
  fetchTradeJournalPosttradeTrade,
  fetchPendingTradeJournalPosttradeCandidates,
  resolveTradeJournalPosttradeScope,
};
