#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import * as journalDb from '../shared/trade-journal-db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export function scopeKey(entry) {
  return [
    entry.exchange || 'binance',
    entry.symbol,
    Boolean(entry.is_paper) ? 'paper' : 'live',
    entry.trade_mode || 'normal',
  ].join(':');
}

export function tolerance(value) {
  const numeric = Math.abs(Number(value || 0));
  return Math.max(0.000001, numeric * 0.01);
}

export function entryAgeHours(entry) {
  const entryTime = Number(entry?.entry_time || 0);
  if (!(entryTime > 0)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - entryTime) / 3600000);
}

export function buildScopeMap(entries = []) {
  const map = new Map();
  for (const entry of entries) {
    const key = scopeKey(entry);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  }
  for (const rows of map.values()) {
    rows.sort((a, b) => Number(b.entry_time || 0) - Number(a.entry_time || 0));
  }
  return map;
}

async function closeEntryAtBreakeven(entry, exitReason, dryRun) {
  if (dryRun) return;
  await journalDb.closeJournalEntry(entry.trade_id, {
    exitTime: Date.now(),
    exitPrice: Number(entry.entry_price || 0),
    exitValue: Number(entry.entry_value || 0),
    exitReason,
    pnlAmount: 0,
    pnlPercent: 0,
    pnlNet: 0,
    execution_origin: 'cleanup',
    quality_flag: 'exclude_from_learning',
    exclude_from_learning: true,
    incident_link: 'journal_reconcile',
  });
  await journalDb.ensureAutoReview(entry.trade_id).catch(() => {});
}

async function trimLatestEntry(latestEntry, targetQty, dryRun) {
  const currentQty = Number(latestEntry.entry_size || 0);
  const currentValue = Number(latestEntry.entry_value || 0);
  if (!(currentQty > 0)) return null;
  const nextQty = Number(targetQty || 0);
  if (Math.abs(currentQty - nextQty) <= tolerance(currentQty)) return null;

  const ratio = nextQty / currentQty;
  const nextValue = currentValue * ratio;
  if (!dryRun) {
    await db.run(
      `UPDATE trade_journal
         SET entry_size = $1,
             entry_value = $2
       WHERE trade_id = $3`,
      [nextQty, nextValue, latestEntry.trade_id],
    );
  }
  return {
    tradeId: latestEntry.trade_id,
    beforeQty: currentQty,
    afterQty: nextQty,
    beforeValue: currentValue,
    afterValue: nextValue,
  };
}

export function summarizeReconcileResults(results = []) {
  const byAction = results.reduce((acc, row) => {
    const action = String(row?.action || 'unknown');
    acc[action] = (acc[action] || 0) + 1;
    return acc;
  }, {});
  const affectedTradeIds = new Set();
  for (const row of results) {
    for (const tradeId of [
      ...(row.closedTradeIds || []),
      ...(row.staleTradeIds || []),
    ]) {
      if (tradeId) affectedTradeIds.add(tradeId);
    }
  }
  return {
    byAction,
    affectedTradeCount: affectedTradeIds.size,
    noPositionScopes: byAction.close_all_no_position || 0,
    duplicateScopes: byAction.close_stale_duplicates || 0,
    observeScopes: Object.entries(byAction)
      .filter(([action]) => action.startsWith('observe_'))
      .reduce((sum, [, count]) => sum + Number(count || 0), 0),
  };
}

export function buildWriteImpactGuard(summary = {}, maxAffectedTrades = 10) {
  const max = Number(maxAffectedTrades);
  if (!Number.isFinite(max) || max <= 0) return null;
  const affectedTradeCount = Number(summary?.affectedTradeCount || 0);
  if (affectedTradeCount <= max) return null;
  return {
    ok: false,
    blocked: true,
    reason: 'max_affected_trades_exceeded',
    message: `open journal write 영향 trade 수 ${affectedTradeCount}건이 안전 한도 ${max}건을 초과했습니다. --symbols=...로 범위를 좁히거나 --max-affected-trades 값을 명시적으로 조정하세요.`,
    affectedTradeCount,
    maxAffectedTrades: max,
  };
}

export async function reconcileOpenJournals({
  dryRun = true,
  market = 'crypto',
  noPositionMinAgeHours = 6,
  symbols = [],
  confirmLive = false,
  maxAffectedTrades = 10,
} = {}) {
  if (dryRun === false && confirmLive !== true) {
    return {
      ok: false,
      dryRun: false,
      market,
      blocked: true,
      reason: 'confirm_live_required',
      message: '라이브 open journal을 닫으려면 --write --confirm-live를 함께 지정해야 합니다.',
      totalScopes: 0,
      candidates: 0,
      summary: summarizeReconcileResults([]),
      results: [],
    };
  }

  if (dryRun === false) {
    const preflight = await reconcileOpenJournals({
      dryRun: true,
      market,
      noPositionMinAgeHours,
      symbols,
      confirmLive: true,
      maxAffectedTrades: null,
    });
    const impactGuard = buildWriteImpactGuard(preflight.summary, maxAffectedTrades);
    if (impactGuard) {
      return {
        ...preflight,
        ...impactGuard,
        dryRun: false,
        confirmLive,
      };
    }
  }

  await db.initSchema();
  await journalDb.initJournalSchema();

  const openEntries = await journalDb.getOpenJournalEntries(market);
  const symbolFilter = new Set((symbols || []).map((value) => String(value).trim()).filter(Boolean));
  const filteredEntries = symbolFilter.size > 0
    ? openEntries.filter((entry) => symbolFilter.has(String(entry.symbol || '').trim()))
    : openEntries;
  const grouped = buildScopeMap(filteredEntries);
  const results = [];

  for (const [key, rows] of grouped.entries()) {
    if (!rows.length) continue;
    const latest = rows[0];
    const position = await db.getPosition(latest.symbol, {
      exchange: latest.exchange,
      paper: Boolean(latest.is_paper),
      tradeMode: latest.trade_mode || 'normal',
    });
    const targetQty = Number(position?.amount || 0);
    const totalQty = rows.reduce((sum, row) => sum + Number(row.entry_size || 0), 0);

    if (targetQty <= 0 && rows.length > 0) {
      const newestAgeHours = entryAgeHours(latest);
      if (newestAgeHours < noPositionMinAgeHours) {
        results.push({
          scope: key,
          symbol: latest.symbol,
          action: 'observe_no_position_too_fresh',
          targetQty,
          totalQty,
          latestQty: Number(latest.entry_size || 0),
          newestAgeHours,
          openTradeIds: rows.map((row) => row.trade_id),
        });
        continue;
      }
      const closedTradeIds = rows.map((row) => row.trade_id);
      for (const row of rows) {
        await closeEntryAtBreakeven(row, 'journal_reconciled_no_position', dryRun);
      }
      results.push({
        scope: key,
        symbol: latest.symbol,
        action: 'close_all_no_position',
        targetQty,
        totalQty,
        latestQty: Number(latest.entry_size || 0),
        closedTradeIds,
      });
      continue;
    }

    if (rows.length <= 1) continue;

    const latestQty = Number(latest.entry_size || 0);
    if (Math.abs(latestQty - targetQty) > tolerance(latestQty)) {
      results.push({
        scope: key,
        symbol: latest.symbol,
        action: 'observe_latest_mismatch',
        targetQty,
        totalQty,
        latestQty,
        openTradeIds: rows.map((row) => row.trade_id),
      });
      continue;
    }

    const staleRows = rows.slice(1);
    const trimmedLatest = await trimLatestEntry(latest, targetQty, dryRun);
    for (const row of staleRows) {
      await closeEntryAtBreakeven(row, 'journal_reconciled_duplicate_open', dryRun);
    }
    results.push({
      scope: key,
      symbol: latest.symbol,
      action: 'close_stale_duplicates',
      targetQty,
      totalQty,
      latestQty,
      staleTradeIds: staleRows.map((row) => row.trade_id),
      trimmedLatest,
    });
  }

  return {
    ok: true,
    dryRun,
    market,
    confirmLive,
    maxAffectedTrades: Number.isFinite(Number(maxAffectedTrades)) ? Number(maxAffectedTrades) : null,
    totalScopes: grouped.size,
    candidates: results.length,
    summary: summarizeReconcileResults(results),
    results,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--write');
  const confirmLive = args.includes('--confirm-live');
  const minAgeArg = args.find((arg) => arg.startsWith('--no-position-min-age-hours='))?.split('=')[1];
  const maxAffectedArg = args.find((arg) => arg.startsWith('--max-affected-trades='))?.split('=')[1];
  const symbolsArg = args.find((arg) => arg.startsWith('--symbols='))?.split('=')[1];
  const symbols = symbolsArg
    ? symbolsArg.split(',').map((value) => value.trim()).filter(Boolean)
    : [];
  const noPositionMinAgeHours = Number.isFinite(Number(minAgeArg)) ? Number(minAgeArg) : 6;
  const maxAffectedTrades = Number.isFinite(Number(maxAffectedArg)) ? Number(maxAffectedArg) : 10;
  const result = await reconcileOpenJournals({ dryRun, market: 'crypto', noPositionMinAgeHours, symbols, confirmLive, maxAffectedTrades });
  console.log(JSON.stringify(result, null, 2));
  if (result?.blocked) process.exitCode = 2;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ open journal reconcile 실패:',
  });
}
