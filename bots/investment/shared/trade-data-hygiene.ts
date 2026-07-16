// @ts-nocheck
import * as db from './db.ts';
import { query } from './db/core.ts';
import { buildOperatingEpochLowerBoundSql } from './luna-operating-epoch.ts';

export const EXPECTED_POLICY_BLOCK_CODES = new Set([
  'capital_backpressure',
  'capital_circuit_breaker',
  'capital_guard_rejected',
  'journal_open_entry_ambiguous_for_sell',
  'journal_open_entry_missing_for_sell',
  'market_closed',
  'outside_binance_major_universe',
  'position_mode_conflict',
  'position_sizing_rejected',
  'safety_gate_blocked',
  'sizing_floor_unavailable',
  'paper_position_reentry_blocked',
  'live_position_reentry_blocked',
  'same_day_reentry_blocked',
  'sec015_stale_approval',
  'sec015_overseas_stale_approval',
  'trade_data_entry_guard_rejected',
]);

export const EXPECTED_POLICY_BLOCK_CODE_SUFFIX = '_stale_approval';

function rowsOf(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.rows) ? result.rows : [];
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeCode(code = '') {
  return String(code || '').trim();
}

function normalizeOpenJournalMarket(market = '') {
  const normalized = String(market || '').trim().toLowerCase();
  if (normalized === 'kis') return 'domestic';
  return ['crypto', 'domestic', 'overseas'].includes(normalized) ? normalized : null;
}

export function resolveOpenJournalReconcileMarket(openJournal = {}) {
  const markets = new Set((openJournal.scopes || [])
    .map((scope) => normalizeOpenJournalMarket(scope?.market))
    .filter(Boolean));
  return markets.size === 1 ? [...markets][0] : 'all';
}

export function buildOpenJournalReconcileCommand(market = 'all', { write = false } = {}) {
  const normalizedMarket = normalizeOpenJournalMarket(market) || 'all';
  const base = `npm --prefix bots/investment run -s runtime:reconcile-open-journals -- --json --market=${normalizedMarket}`;
  if (!write) return base;
  return `npm --prefix bots/investment run -s runtime:reconcile-open-journals -- --write --confirm-live --market=${normalizedMarket} --max-affected-trades=10 --json`;
}

export function isExpectedPolicyBlockCode(code = '') {
  const normalized = normalizeCode(code);
  if (!normalized) return false;
  if (EXPECTED_POLICY_BLOCK_CODES.has(normalized)) return true;
  return normalized.endsWith(EXPECTED_POLICY_BLOCK_CODE_SUFFIX);
}

export function resolveExpectedPolicyBlockStatus(code = '', fallback = 'failed') {
  return isExpectedPolicyBlockCode(code) ? 'blocked' : fallback;
}

export function openJournalScopeKey(entry = {}) {
  return [
    entry.exchange || 'unknown',
    entry.symbol || 'unknown',
    entry.is_paper === true ? 'paper' : 'live',
    entry.trade_mode || 'normal',
  ].join(':');
}

function entrySortTime(entry = {}) {
  return num(entry.entry_time ?? entry.created_at, 0);
}

function entryAgeHours(entry = {}, nowMs = Date.now()) {
  const time = entrySortTime(entry);
  if (!(time > 0)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs - time) / 3600000);
}

function quantityTolerance(value) {
  const numeric = Math.abs(num(value, 0));
  return Math.max(0.000001, numeric * 0.01);
}

async function defaultGetPositionForEntry(entry = {}) {
  return db.getPosition(entry.symbol, {
    exchange: entry.exchange || null,
    paper: entry.is_paper === true,
    tradeMode: entry.trade_mode || 'normal',
  }).catch(() => null);
}

export async function summarizeOpenJournalHygiene({
  openEntries = [],
  nowMs = Date.now(),
  noPositionMinAgeHours = 6,
  dustCloseMaxValueUsdt = 1,
  getPositionForEntry = defaultGetPositionForEntry,
} = {}) {
  const grouped = new Map();
  for (const entry of openEntries || []) {
    const key = openJournalScopeKey(entry);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entry);
  }

  const scopes = [];
  for (const [scope, rows] of grouped.entries()) {
    rows.sort((a, b) => entrySortTime(b) - entrySortTime(a));
    const latest = rows[0] || {};
    const position = await getPositionForEntry(latest);
    const targetQty = num(position?.amount, 0);
    const totalQty = rows.reduce((sum, row) => sum + num(row.entry_size, 0), 0);
    const totalValue = rows.reduce((sum, row) => sum + Math.abs(num(row.entry_value, 0)), 0);
    const latestQty = num(latest.entry_size, 0);
    const newestAgeHours = entryAgeHours(latest, nowMs);
    const dustNoPosition = targetQty <= 0
      && totalValue > 0
      && totalValue <= num(dustCloseMaxValueUsdt, 1);
    const staleNoPosition = targetQty <= 0
      && (dustNoPosition || newestAgeHours >= num(noPositionMinAgeHours, 6));
    const duplicateOpen = rows.length > 1;
    const latestMismatch = targetQty > 0
      && Math.abs(latestQty - targetQty) > quantityTolerance(Math.max(latestQty, targetQty));

    if (!staleNoPosition && !duplicateOpen && !latestMismatch) continue;

    scopes.push({
      scope,
      symbol: latest.symbol || null,
      market: latest.market || null,
      exchange: latest.exchange || null,
      tradeMode: latest.trade_mode || null,
      paper: latest.is_paper === true,
      openTradeIds: rows.map((row) => row.trade_id).filter(Boolean),
      targetQty,
      totalQty,
      totalValue: Number(totalValue.toFixed(8)),
      latestQty,
      newestAgeHours: Number(newestAgeHours.toFixed(2)),
      staleNoPosition,
      dustNoPosition,
      duplicateOpen,
      latestMismatch,
    });
  }

  const summary = {
    totalOpenEntries: openEntries.length,
    affectedTradeCount: new Set(scopes.flatMap((scope) => scope.openTradeIds || [])).size,
    staleNoPositionScopes: scopes.filter((scope) => scope.staleNoPosition).length,
    duplicateScopes: scopes.filter((scope) => scope.duplicateOpen).length,
    latestMismatchScopes: scopes.filter((scope) => scope.latestMismatch).length,
  };

  return {
    ok: true,
    status: summary.affectedTradeCount > 0 ? 'needs_attention' : 'ready',
    summary,
    scopes,
  };
}

export async function fetchOpenJournalEntriesForHygiene({ market = null, limit = 1000 } = {}) {
  const params = [];
  const where = [`LOWER(COALESCE(status, '')) = 'open'`];
  if (market) {
    params.push(String(market));
    where.push(`market = $${params.length}`);
  }
  params.push(Math.max(1, Math.min(5000, num(limit, 1000))));
  const rows = await query(
    `SELECT trade_id, signal_id, market, exchange, symbol, is_paper, trade_mode,
            entry_time, entry_price, entry_size, entry_value, created_at
       FROM trade_journal
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(entry_time, created_at) DESC NULLS LAST
      LIMIT $${params.length}`,
    params,
  ).catch(() => []);
  return rowsOf(rows);
}

export async function fetchFailedExpectedPolicySignals({ limit = 20 } = {}) {
  const lowerBound = buildOperatingEpochLowerBoundSql(null);
  const codes = Array.from(EXPECTED_POLICY_BLOCK_CODES);
  const rows = await query(
    `SELECT COALESCE(block_code, '') AS block_code,
            COALESCE(exchange, 'unknown') AS exchange,
            COALESCE(action, 'unknown') AS action,
            COUNT(*)::int AS count
      FROM signals
      WHERE LOWER(COALESCE(status, '')) = 'failed'
        AND (
          COALESCE(block_code, '') = ANY($1::text[])
          OR RIGHT(COALESCE(block_code, ''), LENGTH($2::text)) = $2::text
        )
        ${lowerBound ? `AND created_at >= ${lowerBound}` : ''}
      GROUP BY 1, 2, 3
      ORDER BY count DESC
      LIMIT $3`,
    [
      codes,
      EXPECTED_POLICY_BLOCK_CODE_SUFFIX,
      Math.max(1, Math.min(100, num(limit, 20))),
    ],
  ).catch(() => []);
  const items = rowsOf(rows);
  return {
    ok: true,
    total: items.reduce((sum, row) => sum + num(row.count, 0), 0),
    items,
  };
}

export function buildTradeDataHygieneFindings({
  openJournal = {},
  failedExpectedPolicySignals = {},
  realizedPnlCoverage = {},
  qualityCoverage = {},
} = {}) {
  const findings = [];
  const openSummary = openJournal.summary || {};
  const staleOpenTrades = num(openSummary.affectedTradeCount, 0);
  if (staleOpenTrades > 0) {
    const reconcileMarket = resolveOpenJournalReconcileMarket(openJournal);
    findings.push({
      id: 'open_journal_reconcile_pending',
      severity: 'P0',
      count: staleOpenTrades,
      reason: 'open journal rows no longer match the authoritative position table',
      command: buildOpenJournalReconcileCommand(reconcileMarket),
      writeCommand: buildOpenJournalReconcileCommand(reconcileMarket, { write: true }),
      approvalRequired: true,
      approvalReason: 'manual DB journal close/reconcile write; dry-run evidence must be reviewed first',
    });
  }

  const policyFailed = num(failedExpectedPolicySignals.total, 0);
  if (policyFailed > 0) {
    findings.push({
      id: 'expected_policy_block_persisted_as_failed',
      severity: 'P0',
      count: policyFailed,
      reason: 'known pre-execution policy blocks must be stored as blocked, not failed',
      command: 'inspect signal writer status mapping before applying DB reclassification',
    });
  }

  const realizedPending = Math.max(0, num(realizedPnlCoverage.sellCount, 0) - num(realizedPnlCoverage.realizedCount, 0));
  if (realizedPending > 0) {
    findings.push({
      id: 'realized_pnl_backfill_pending',
      severity: 'P1',
      count: realizedPending,
      reason: 'closed sell trades are missing realized_pnl_pct and will weaken learning labels',
      command: 'npm --prefix bots/investment run -s runtime:pnl-backfill -- --json',
    });
  }

  const posttradePending = Math.max(0, num(qualityCoverage.closedJournalTrades, 0) - num(qualityCoverage.evaluatedClosedJournalTrades, 0));
  if (posttradePending > 0) {
    findings.push({
      id: 'posttrade_evaluation_backfill_pending',
      severity: 'P1',
      count: posttradePending,
      reason: 'closed journal trades are missing posttrade quality evaluations',
      command: 'npm --prefix bots/investment run -s runtime:posttrade-feedback-worker -- --once --force --market=all --limit=20 --dry-run --json',
    });
  }

  return findings;
}

export async function buildTradeDataHygieneReport({
  generatedAt = new Date().toISOString(),
  market = null,
  openJournalLimit = 1000,
  realizedPnlCoverage = {},
  qualityCoverage = {},
} = {}) {
  const openEntries = await fetchOpenJournalEntriesForHygiene({ market, limit: openJournalLimit });
  const openJournal = await summarizeOpenJournalHygiene({ openEntries });
  const failedExpectedPolicySignals = await fetchFailedExpectedPolicySignals();
  const findings = buildTradeDataHygieneFindings({
    openJournal,
    failedExpectedPolicySignals,
    realizedPnlCoverage,
    qualityCoverage,
  });
  const hasP0 = findings.some((finding) => finding.severity === 'P0');

  return {
    ok: true,
    status: findings.length ? 'needs_attention' : 'ready',
    severity: hasP0 ? 'P0' : findings.length ? 'P1' : 'none',
    generatedAt,
    openJournal,
    failedExpectedPolicySignals,
    realizedPnlCoverage,
    qualityCoverage,
    findings,
    nextActions: findings.map((finding) => finding.command),
  };
}

export default {
  EXPECTED_POLICY_BLOCK_CODES,
  EXPECTED_POLICY_BLOCK_CODE_SUFFIX,
  isExpectedPolicyBlockCode,
  resolveExpectedPolicyBlockStatus,
  resolveOpenJournalReconcileMarket,
  buildOpenJournalReconcileCommand,
  summarizeOpenJournalHygiene,
  buildTradeDataHygieneFindings,
  buildTradeDataHygieneReport,
};
