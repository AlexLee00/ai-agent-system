#!/usr/bin/env node
// @ts-nocheck

import { setTimeout as sleep } from 'node:timers/promises';
import * as db from '../shared/db.ts';
import { resolveFillForClosedJournal } from '../shared/binance-fill-resolver.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export const FILL_RESOLVE_BACKFILL_CONFIRM = 'luna-fill-resolve-backfill';
const MATCHED_SOURCES = new Set(['fetchMyTrades', 'fetchMyTrades_orderid']);

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1];
  return fallback;
}

function hasFlag(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function boolEnv(name, fallback = false, env = process.env) {
  const raw = String(env?.[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(raw);
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function splitIdList(value) {
  if (Array.isArray(value)) return value.flatMap(splitIdList);
  const text = String(value || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.flatMap(splitIdList);
    } catch {
      // fall through to comma split
    }
  }
  return text.split(',').map((item) => item.trim()).filter(Boolean);
}

function serializeIdList(values = []) {
  const ids = [...new Set(splitIdList(values).map(String).filter(Boolean))];
  return ids.length > 0 ? ids.join(',') : null;
}

function deriveExpectedExitSide(direction = '') {
  const normalized = String(direction || '').trim().toLowerCase();
  return normalized === 'short' || normalized === 'sell' ? 'buy' : 'sell';
}

function normalizeSinceDate(value = '2026-06-11') {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '2026-06-11';
}

function normalizeCandidate(row = {}) {
  const entryTimeMs = safeNumber(row.entry_time, 0);
  return {
    id: row.id ?? null,
    tradeId: row.trade_id,
    symbol: row.symbol,
    exchange: row.exchange || 'binance',
    tradeMode: row.trade_mode || 'normal',
    direction: row.direction || 'long',
    entryTime: entryTimeMs,
    entryPrice: safeNumber(row.entry_price, 0),
    entrySize: safeNumber(row.entry_size, 0),
    entryValue: safeNumber(row.entry_value, safeNumber(row.entry_price, 0) * safeNumber(row.entry_size, 0)),
    slOrderId: row.sl_order_id || null,
    tpOrderId: row.tp_order_id || null,
    exitReason: row.exit_reason || null,
  };
}

function buildCandidateQuery({ since = '2026-06-11', limit = 50 } = {}) {
  return {
    sql: `
      SELECT id, trade_id, symbol, exchange, trade_mode, direction,
             entry_time, entry_price, entry_size, entry_value,
             sl_order_id, tp_order_id, exit_reason
        FROM trade_journal
       WHERE status = 'closed'
         AND COALESCE(is_paper, false) = false
         AND COALESCE(exchange, 'binance') = 'binance'
         AND exit_reason LIKE 'journal_reconciled_no_position%'
         AND exit_match_source IS NULL
         AND (sl_order_id IS NOT NULL OR tp_order_id IS NOT NULL)
         AND exit_time >= EXTRACT(EPOCH FROM $1::date) * 1000
       ORDER BY exit_time ASC, id ASC
       LIMIT $2
    `,
    params: [since, Number(limit)],
  };
}

async function loadBackfillCandidates({ since = '2026-06-11', limit = 50 } = {}, deps = {}) {
  const queryFn = deps.query || db.query;
  const { sql, params } = buildCandidateQuery({ since, limit });
  return await queryFn(sql, params);
}

async function fetchPreviouslyAttributedFillIds(candidate = {}, deps = {}) {
  const queryFn = deps.query || db.query;
  const rows = await queryFn(
    `SELECT exit_fill_ids
       FROM trade_journal
      WHERE symbol = $1
        AND COALESCE(exchange, 'binance') = $2
        AND COALESCE(is_paper, false) = false
        AND COALESCE(trade_mode, 'normal') = $3
        AND exit_fill_ids IS NOT NULL`,
    [candidate.symbol, candidate.exchange || 'binance', candidate.tradeMode || 'normal'],
  ).catch(() => []);
  return [...new Set((rows || []).flatMap((row) => splitIdList(row.exit_fill_ids)).filter(Boolean))];
}

function isResolvedFullFill(result = {}) {
  return MATCHED_SOURCES.has(result?.source) && result?.partial !== true;
}

export async function updateJournalFromResolvedFill(candidate, resolvedFill, deps = {}) {
  const runFn = deps.run || db.run;
  const exitTime = resolvedFill?.lastFillAt ? Date.parse(resolvedFill.lastFillAt) : Date.now();
  const exitMatchSource = resolvedFill?.matchedBy || resolvedFill?.source || null;
  const exchangeTradeIds = serializeIdList(resolvedFill?.tradeIds || []);
  const exchangeOrderIds = serializeIdList(resolvedFill?.orderIds || [candidate.slOrderId, candidate.tpOrderId]);
  const result = await runFn(
    `UPDATE trade_journal
        SET exit_time = $1,
            exit_price = $2,
            exit_value = $3,
            exit_reason = 'journal_reconciled_with_fill',
            pnl_amount = $4,
            pnl_percent = $5,
            pnl_net = $6,
            execution_origin = 'cleanup',
            quality_flag = 'trusted',
            exclude_from_learning = false,
            incident_link = $7,
            exit_order_ids = $8,
            exit_fill_ids = $9,
            exit_match_source = $10,
            hold_duration = $1 - entry_time
      WHERE trade_id = $11
        AND status = 'closed'
        AND COALESCE(is_paper, false) = false
        AND COALESCE(exchange, 'binance') = 'binance'
        AND exit_reason LIKE 'journal_reconciled_no_position%'
        AND exit_match_source IS NULL
        AND (sl_order_id IS NOT NULL OR tp_order_id IS NOT NULL)`,
    [
      Number.isFinite(exitTime) ? exitTime : Date.now(),
      resolvedFill?.exitPrice ?? null,
      resolvedFill?.exitValue ?? null,
      resolvedFill?.pnlAmount ?? null,
      resolvedFill?.pnlPercent ?? null,
      resolvedFill?.pnlNet ?? resolvedFill?.pnlAmount ?? null,
      `journal_backfill:${resolvedFill?.source || 'fetchMyTrades'}:match=${exitMatchSource || 'unknown'}:fills=${resolvedFill?.fillCount || 0}`,
      exchangeOrderIds,
      exchangeTradeIds,
      exitMatchSource,
      candidate.tradeId,
    ],
  );
  return Number(result?.rowCount ?? result?.changes ?? 0);
}

async function refreshTradesUsdView(deps = {}) {
  const runFn = deps.run || db.run;
  await runFn(`REFRESH MATERIALIZED VIEW CONCURRENTLY investment.v_trades_real_usd`, []);
  return true;
}

export function parseFillResolveBackfillArgs(argv = process.argv.slice(2), env = process.env) {
  const apply = hasFlag('apply', argv);
  return {
    json: hasFlag('json', argv),
    dryRun: !apply || hasFlag('dry-run', argv),
    apply,
    confirm: argValue('confirm', '', argv),
    since: normalizeSinceDate(argValue('since', '2026-06-11', argv)),
    limit: Math.max(1, Number(argValue('limit', '50', argv)) || 50),
    sleepMs: Math.max(0, Number(argValue('sleep-ms', '350', argv)) || 0),
    backfillEnabled: boolEnv('LUNA_RECONCILE_FILL_RESOLVE_BACKFILL', false, env),
  };
}

export async function runLunaFillResolveBackfill(options = {}, deps = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun !== false || !apply;
  const since = normalizeSinceDate(options.since || '2026-06-11');
  const limit = Math.max(1, Number(options.limit || 50));
  const sleepMs = Math.max(0, Number(options.sleepMs ?? 350));
  const backfillEnabled = options.backfillEnabled === true
    || boolEnv('LUNA_RECONCILE_FILL_RESOLVE_BACKFILL', false, options.env || process.env);
  const confirm = String(options.confirm || '');

  if (apply && dryRun) {
    return {
      ok: false,
      blocked: true,
      reason: 'cannot_apply_with_dry_run',
      dryRun,
      apply,
      liveMutation: false,
    };
  }
  if (apply && confirm !== FILL_RESOLVE_BACKFILL_CONFIRM) {
    return {
      ok: false,
      blocked: true,
      reason: `confirmation_required:${FILL_RESOLVE_BACKFILL_CONFIRM}`,
      dryRun,
      apply,
      liveMutation: false,
    };
  }
  if (apply && backfillEnabled !== true) {
    return {
      ok: false,
      blocked: true,
      reason: 'env_gate_required:LUNA_RECONCILE_FILL_RESOLVE_BACKFILL=true',
      dryRun,
      apply,
      liveMutation: false,
    };
  }

  const candidates = deps.loadCandidates
    ? await deps.loadCandidates({ since, limit })
    : await loadBackfillCandidates({ since, limit }, deps);
  const rows = [];
  const errors = [];
  let matched = 0;
  let unresolved = 0;
  let partial = 0;
  let updated = 0;

  for (const raw of candidates || []) {
    const candidate = normalizeCandidate(raw);
    const orderIds = [candidate.slOrderId, candidate.tpOrderId].filter(Boolean).map(String);
    const row = {
      tradeId: candidate.tradeId,
      symbol: candidate.symbol,
      orderIds,
      status: 'pending',
      source: null,
      matchedBy: null,
      updated: false,
      pnlAmount: null,
      pnlPercent: null,
      reason: null,
    };
    try {
      const excludedFillIds = deps.fetchPreviouslyAttributedFillIds
        ? await deps.fetchPreviouslyAttributedFillIds(candidate)
        : await fetchPreviouslyAttributedFillIds(candidate, deps);
      const resolved = await (deps.resolveFillForClosedJournal || resolveFillForClosedJournal)({
        symbol: candidate.symbol,
        entryTime: candidate.entryTime,
        entrySize: candidate.entrySize,
        entryPrice: candidate.entryPrice,
        entryValue: candidate.entryValue,
        orderIds,
        paperMode: false,
        expectedSide: deriveExpectedExitSide(candidate.direction),
        excludedFillIds,
      });
      row.source = resolved?.source || null;
      row.matchedBy = resolved?.matchedBy || null;
      row.pnlAmount = resolved?.pnlAmount ?? null;
      row.pnlPercent = resolved?.pnlPercent ?? null;
      row.reason = resolved?.reason || null;

      if (isResolvedFullFill(resolved)) {
        matched += 1;
        row.status = dryRun ? 'would_update' : 'updated';
        if (!dryRun) {
          const affected = deps.updateJournalFromResolvedFill
            ? await deps.updateJournalFromResolvedFill(candidate, resolved)
            : await updateJournalFromResolvedFill(candidate, resolved, deps);
          row.updated = affected > 0;
          updated += affected > 0 ? 1 : 0;
        }
      } else if (resolved?.partial === true) {
        partial += 1;
        row.status = 'partial_skipped';
      } else {
        unresolved += 1;
        row.status = 'unresolved';
      }
    } catch (error) {
      unresolved += 1;
      row.status = 'error';
      row.reason = String(error?.message || error).slice(0, 240);
      errors.push({ tradeId: candidate.tradeId, symbol: candidate.symbol, error: row.reason });
    }
    rows.push(row);
    if (sleepMs > 0) await (deps.sleep || sleep)(sleepMs);
  }

  let refreshed = false;
  let refreshError = null;
  if (!dryRun && updated > 0) {
    try {
      await (deps.refreshTradesUsdView || refreshTradesUsdView)(deps);
      refreshed = true;
    } catch (error) {
      refreshError = String(error?.message || error).slice(0, 240);
      errors.push({ scope: 'v_trades_real_usd_refresh', error: refreshError });
    }
  }

  return {
    ok: errors.length === 0 || updated > 0 || dryRun,
    dryRun,
    apply,
    since,
    limit,
    scanned: rows.length,
    candidates: rows.length,
    matched,
    unresolved,
    partial,
    updated,
    refreshed,
    refreshError,
    liveMutation: false,
    rows,
    errors,
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaFillResolveBackfill(parseFillResolveBackfillArgs()),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'luna-fill-resolve-backfill error:',
  });
}

export default {
  FILL_RESOLVE_BACKFILL_CONFIRM,
  parseFillResolveBackfillArgs,
  runLunaFillResolveBackfill,
  updateJournalFromResolvedFill,
};
