// @ts-nocheck

import crypto from 'node:crypto';
import * as db from './db.ts';
import { runVectorBtGrid } from './vectorbt-runner.ts';

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function rowParam(row = {}, key) {
  return row?.[key] ?? row?.params?.[key] ?? null;
}

export function nextbarComparisonKey(row = {}) {
  return JSON.stringify({
    label: row?.label || null,
    strategy: rowParam(row, 'strategy'),
    tp_pct: rowParam(row, 'tp_pct'),
    sl_pct: rowParam(row, 'sl_pct'),
    params: row?.params || {},
  });
}

export function buildNextbarExecutionComparisons({ sameBarRows = [], nextbarRows = [] } = {}) {
  const nextbarByKey = new Map((nextbarRows || []).map((row) => [nextbarComparisonKey(row), row]));
  const comparisons = [];
  const unmatchedRows = [];
  for (const sameBar of sameBarRows || []) {
    const key = nextbarComparisonKey(sameBar);
    const nextbar = nextbarByKey.get(key);
    if (!nextbar) {
      unmatchedRows.push({ key, label: sameBar?.label || null, params: sameBar?.params || {} });
      continue;
    }
    comparisons.push({
      key,
      sameBar,
      nextbar,
      returnDelta: finite(nextbar.total_return) - finite(sameBar.total_return),
      tradeCountDelta: Math.round(finite(nextbar.total_trades) - finite(sameBar.total_trades)),
    });
  }
  return {
    comparisons,
    unmatchedRows,
    matched: comparisons.length,
    compared: (sameBarRows || []).length,
    nextbarRows: (nextbarRows || []).length,
  };
}

function seoulDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function evidenceKey({ symbol, market, days, collectionDate, comparisonKey }) {
  return crypto.createHash('sha256')
    .update(['nextbar-v1', symbol, market, days, collectionDate, comparisonKey].join('|'))
    .digest('hex');
}

export async function collectNextbarExecutionShadow({
  symbol,
  market = 'binance',
  days = 30,
  source = 'nextbar-shadow-daily',
  shadowOnly = true,
  now = new Date(),
} = {}, {
  runner = runVectorBtGrid,
  queryFn = db.query,
} = {}) {
  if (shadowOnly !== true) return { ok: false, persisted: 0, reason: 'shadow_only_required' };
  const effectiveDays = Math.max(14, Math.round(finite(days, 30)));
  const sameBarRows = runner(symbol, effectiveDays, {
    env: {
      LUNA_BT_NEXT_BAR_EXECUTION_ENABLED: 'false',
      LUNA_BT_GRID_RETURN_ALL: 'true',
    },
  });
  const nextbarRows = runner(symbol, effectiveDays, {
    env: {
      LUNA_BT_NEXT_BAR_EXECUTION_ENABLED: 'true',
      LUNA_BT_GRID_RETURN_ALL: 'true',
    },
  });
  if (!Array.isArray(sameBarRows) || !Array.isArray(nextbarRows)) {
    return { ok: false, persisted: 0, reason: 'backtest_error', sameBarRows, nextbarRows };
  }

  const comparison = buildNextbarExecutionComparisons({ sameBarRows, nextbarRows });
  const collectionDate = seoulDate(now);
  let persisted = 0;
  let duplicates = 0;
  for (const row of comparison.comparisons) {
    const key = evidenceKey({
      symbol,
      market,
      days: effectiveDays,
      collectionDate,
      comparisonKey: row.key,
    });
    const inserted = await queryFn(`
      INSERT INTO luna_nextbar_execution_shadow (
        run_id, symbol, signal_ts, same_bar_close_price, next_bar_price,
        return_delta, trade_count_delta, metadata
      )
      SELECT NULL, $1, $2, NULL, NULL, $3, $4, $5::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM luna_nextbar_execution_shadow
        WHERE metadata->>'evidenceKey' = $6
      )
      RETURNING id
    `, [
      symbol,
      new Date(now).toISOString(),
      row.returnDelta,
      row.tradeCountDelta,
      JSON.stringify({
        source,
        shadowOnly: true,
        evidenceKey: key,
        collectionDate,
        expectedComparisons: comparison.comparisons.length,
        market,
        days: effectiveDays,
        label: row.sameBar.label || null,
        params: row.sameBar.params || {},
        sameBar: {
          executionModel: row.sameBar.execution_model || null,
          executionPriceModel: row.sameBar.execution_price_model || null,
          totalReturn: row.sameBar.total_return ?? null,
          totalTrades: row.sameBar.total_trades ?? null,
        },
        nextbar: {
          executionModel: row.nextbar.execution_model || null,
          executionPriceModel: row.nextbar.execution_price_model || null,
          totalReturn: row.nextbar.total_return ?? null,
          totalTrades: row.nextbar.total_trades ?? null,
        },
      }),
      key,
    ]);
    if (inserted?.length) persisted += 1;
    else duplicates += 1;
  }

  return {
    ok: comparison.comparisons.length > 0 && comparison.unmatchedRows.length === 0,
    symbol,
    collectionDate,
    persisted,
    duplicates,
    expectedComparisons: comparison.comparisons.length,
    matched: comparison.matched,
    unmatched: comparison.unmatchedRows.length,
    unmatchedRows: comparison.unmatchedRows.slice(0, 20),
  };
}

export const _testOnly = { evidenceKey, seoulDate };
