#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  attachExecutionToPositionStrategy,
  attachExecutionToPositionStrategyTracked,
} from '../shared/execution-attach.ts';

function parseArgs(argv = []) {
  return {
    dryRun: !argv.includes('--write'),
    forceRefresh: argv.includes('--refresh'),
    days: Math.max(1, Number(argv.find((arg) => arg.startsWith('--days='))?.split('=')[1] || 14)),
    limit: Math.max(1, Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || 100)),
    exchange: argv.find((arg) => arg.startsWith('--exchange='))?.split('=').slice(1).join('=') || null,
    requireOpenPosition: !argv.includes('--include-closed'),
    json: argv.includes('--json'),
  };
}

async function loadBuyTrades({ days = 14, limit = 100, exchange = null } = {}) {
  const conditions = [
    `LOWER(side) = 'buy'`,
    `executed_at >= now() - ($1::int * interval '1 day')`,
  ];
  const params = [Number(days || 14)];
  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  params.push(Math.max(1, Number(limit || 100)));
  return db.query(
    `SELECT *
       FROM investment.trades
      WHERE ${conditions.join(' AND ')}
      ORDER BY executed_at DESC
      LIMIT $${params.length}`,
    params,
  );
}

async function loadSignals(trades = []) {
  const ids = [...new Set(trades.map((trade) => trade.signal_id).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await db.query(
    `SELECT * FROM investment.signals WHERE id = ANY($1)`,
    [ids],
  ).catch(() => []);
  return new Map(rows.map((row) => [row.id, row]));
}

export function summarizeExecutionAttachBackfillRows(rows = [], { dryRun = true } = {}) {
  const byStatus = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  const missingSignalId = rows.filter((row) => !row.signalId).length;
  const metaPersisted = rows.filter((row) => row.metaPersisted).length;
  const attachCandidates = rows.filter((row) => row.attached || String(row.status || '').startsWith('would_')).length;
  const openPositionBlocked = rows.filter((row) => row.status === 'skipped_no_open_position').length;
  return {
    total: rows.length,
    attached: rows.filter((row) => row.attached).length,
    wouldAttach: rows.filter((row) => String(row.status || '').startsWith('would_')).length,
    attachCandidates,
    metaPersisted,
    missingSignalId,
    openPositionBlocked,
    writeEligible: dryRun ? attachCandidates : 0,
    byStatus,
  };
}

export function buildExecutionAttachBackfillDecision(summary = {}, {
  dryRun = true,
  requireOpenPosition = true,
  days = 14,
  limit = 100,
  exchange = null,
} = {}) {
  const scope = [
    `days=${Math.max(1, Number(days || 14))}`,
    `limit=${Math.max(1, Number(limit || 100))}`,
    exchange ? `exchange=${exchange}` : 'exchange=all',
    requireOpenPosition ? 'open-position-required' : 'closed-included',
  ].join(' / ');
  if (dryRun && summary.attachCandidates > 0) {
    return {
      status: 'execution_attach_backfill_candidates',
      headline: `체결 attach 백필 후보 ${summary.attachCandidates}건을 확인했습니다.`,
      safeToWrite: requireOpenPosition && summary.openPositionBlocked >= 0,
      actionItems: [
        `범위 확인: ${scope}`,
        '후보 rows를 확인한 뒤 동일 인자로 --write를 붙여 적용합니다.',
        summary.missingSignalId > 0
          ? `signal_id 없는 거래 ${summary.missingSignalId}건은 메타 저장 대상에서 제외됩니다.`
          : '모든 후보가 signal_id 기반 메타 저장 대상입니다.',
      ],
    };
  }
  if (!dryRun && summary.metaPersisted > 0) {
    return {
      status: 'execution_attach_backfill_applied',
      headline: `체결 attach 메타 ${summary.metaPersisted}건을 signals.block_meta에 반영했습니다.`,
      safeToWrite: false,
      actionItems: [
        '적용 후 runtime:execution-attach-audit으로 tracked/errors 카운트를 재확인합니다.',
        `범위: ${scope}`,
      ],
    };
  }
  if (summary.openPositionBlocked > 0 && summary.attachCandidates === 0) {
    return {
      status: 'execution_attach_backfill_no_open_position',
      headline: `오픈 포지션 확인 조건으로 ${summary.openPositionBlocked}건이 백필에서 제외되었습니다.`,
      safeToWrite: false,
      actionItems: [
        '실제 보유 포지션과 시스템 포지션 동기화가 맞는지 먼저 확인합니다.',
        `필요 시 폐쇄 포지션까지 점검하려면 --include-closed로 별도 dry-run을 수행합니다. 범위: ${scope}`,
      ],
    };
  }
  return {
    status: 'execution_attach_backfill_no_candidates',
    headline: '현재 범위에서 체결 attach 백필 후보가 없습니다.',
    safeToWrite: false,
    actionItems: [
      `범위: ${scope}`,
      '추가 조치 없이 audit/health 관찰을 유지합니다.',
    ],
  };
}

export async function runExecutionAttachBackfill({
  days = 14,
  limit = 100,
  exchange = null,
  dryRun = true,
  forceRefresh = false,
  requireOpenPosition = true,
} = {}) {
  await db.initSchema();
  const trades = await loadBuyTrades({ days, limit, exchange });
  const signalById = await loadSignals(trades);
  const rows = [];

  for (const trade of trades) {
    const signal = trade.signal_id ? signalById.get(trade.signal_id) || null : null;
    const attachFn = dryRun
      ? attachExecutionToPositionStrategy
      : attachExecutionToPositionStrategyTracked;
    const result = await attachFn({
      trade,
      signal,
      dryRun,
      forceRefresh,
      requireOpenPosition,
      persistMeta: !dryRun,
    });
    rows.push({
      tradeId: trade.id || null,
      signalId: trade.signal_id || null,
      symbol: trade.symbol,
      exchange: trade.exchange,
      tradeMode: trade.trade_mode || 'normal',
      executedAt: trade.executed_at,
      metaPersisted: !dryRun && Boolean(trade.signal_id),
      ...result,
    });
  }

  const summary = summarizeExecutionAttachBackfillRows(rows, { dryRun });
  return {
    ok: true,
    dryRun,
    days,
    limit,
    exchange,
    requireOpenPosition,
    metaPersistence: dryRun ? 'disabled_dry_run' : 'signals.block_meta.executionAttach',
    summary,
    decision: buildExecutionAttachBackfillDecision(summary, {
      dryRun,
      requireOpenPosition,
      days,
      limit,
      exchange,
    }),
    rows: rows.slice(0, 50),
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: async () => {},
    run: async () => runExecutionAttachBackfill(parseArgs(process.argv.slice(2))),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ execution attach backfill 오류:',
  });
}
