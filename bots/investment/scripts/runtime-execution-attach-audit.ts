#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import * as journalDb from '../shared/trade-journal-db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildExecutionFillEnvelope,
  scoreExecutionFillEnvelope,
} from '../shared/execution-fill-envelope.ts';

function parseArgs(argv = []) {
  const args = {
    days: 14,
    limit: 100,
    exchange: null,
    json: false,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw.startsWith('--days=')) args.days = Math.max(1, Number(raw.split('=').slice(1).join('=') || 14));
    else if (raw.startsWith('--limit=')) args.limit = Math.max(1, Number(raw.split('=').slice(1).join('=') || 100));
    else if (raw.startsWith('--exchange=')) args.exchange = raw.split('=').slice(1).join('=').trim() || null;
  }
  return args;
}

async function loadRecentTrades({ days = 14, limit = 100, exchange = null } = {}) {
  const conditions = [`executed_at >= now() - ($1::int * interval '1 day')`];
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

async function loadJournalBySignalIds(signalIds = []) {
  const ids = [...new Set(signalIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await db.query(
    `SELECT *
       FROM investment.trade_journal
      WHERE signal_id = ANY($1)
      ORDER BY created_at DESC`,
    [ids],
  ).catch(() => []);
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.signal_id)) map.set(row.signal_id, row);
  }
  return map;
}

async function loadSignalsByIds(signalIds = []) {
  const ids = [...new Set(signalIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await db.query(
    `SELECT * FROM investment.signals WHERE id = ANY($1)`,
    [ids],
  ).catch(() => []);
  return new Map(rows.map((row) => [row.id, row]));
}

async function loadProfilesForTrades(trades = []) {
  const rows = await db.getActivePositionStrategyProfiles({ limit: 1000 }).catch(() => []);
  const map = new Map();
  for (const profile of rows) {
    const key = [
      String(profile.exchange || '').trim(),
      String(profile.symbol || '').trim(),
      String(profile.trade_mode || 'normal').trim(),
    ].join(':');
    if (!map.has(key)) map.set(key, profile);
  }
  return map;
}

function profileKeyForTrade(trade = {}) {
  const exchange = String(trade.exchange || 'binance').trim();
  const symbol = String(trade.symbol || '').trim();
  const tradeMode = String(trade.trade_mode || trade.tradeMode || 'normal').trim();
  return [exchange, symbol, tradeMode].join(':');
}

function summarize(rows = []) {
  const byStatus = {};
  const missingCounts = {};
  let scoreSum = 0;
  for (const row of rows) {
    byStatus[row.score.status] = (byStatus[row.score.status] || 0) + 1;
    scoreSum += Number(row.score.score || 0);
    for (const key of row.score.missing || []) {
      missingCounts[key] = (missingCounts[key] || 0) + 1;
    }
  }
  const topMissing = Object.entries(missingCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count }));
  return {
    total: rows.length,
    avgAttachScore: rows.length ? Math.round((scoreSum / rows.length) * 10) / 10 : null,
    byStatus,
    topMissing,
    weakCount: byStatus.weak || 0,
    partialCount: byStatus.partial || 0,
    completeCount: byStatus.complete || 0,
  };
}

export async function runExecutionAttachAudit({ days = 14, limit = 100, exchange = null } = {}) {
  await db.initSchema();
  await journalDb.initJournalSchema();

  const trades = await loadRecentTrades({ days, limit, exchange });
  const signalIds = trades.map((trade) => trade.signal_id).filter(Boolean);
  const [signals, journals, profiles] = await Promise.all([
    loadSignalsByIds(signalIds),
    loadJournalBySignalIds(signalIds),
    loadProfilesForTrades(trades),
  ]);

  const rows = trades.map((trade) => {
    const signal = signals.get(trade.signal_id) || null;
    const journal = journals.get(trade.signal_id) || null;
    const strategyProfile = profiles.get(profileKeyForTrade(trade)) || null;
    const envelope = buildExecutionFillEnvelope({ trade, signal, journal, strategyProfile });
    return {
      tradeId: trade.id || null,
      signalId: trade.signal_id || null,
      symbol: trade.symbol,
      exchange: trade.exchange,
      side: trade.side,
      tradeMode: trade.trade_mode || 'normal',
      executedAt: trade.executed_at,
      envelope,
      score: scoreExecutionFillEnvelope(envelope),
    };
  });
  const summary = summarize(rows);
  const decision = {
    status: summary.weakCount > 0
      ? 'execution_attach_weak'
      : summary.partialCount > 0
        ? 'execution_attach_partial'
        : 'execution_attach_ok',
    headline: summary.weakCount > 0
      ? '체결 후 포지션/전략 연결이 약한 거래가 있어 envelope 통합이 필요합니다.'
      : summary.partialCount > 0
        ? '체결 후 연결은 대부분 있으나 일부 전략/합의 메타가 누락됩니다.'
        : '최근 체결의 포지션/전략 연결이 정상입니다.',
    actionItems: summary.topMissing.slice(0, 3).map((item) => `${item.key} 누락 ${item.count}건을 체결 envelope attach 경로에서 보강합니다.`),
  };

  return {
    ok: true,
    days,
    limit,
    exchange,
    summary,
    decision,
    rows: rows.slice(0, Math.min(rows.length, 20)),
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: async () => {},
    run: async () => runExecutionAttachAudit(parseArgs(process.argv.slice(2))),
    onSuccess: async (result) => {
      console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '❌ execution attach audit 오류:',
  });
}
