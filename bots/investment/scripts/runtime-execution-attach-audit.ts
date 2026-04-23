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

function toMillis(value = null) {
  if (value == null) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTradeMode(value = null) {
  return String(value || 'normal').trim() || 'normal';
}

function safeJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function loadJournalContext(trades = [], days = 14) {
  const ids = [...new Set(trades.map((trade) => trade.signal_id).filter(Boolean))];
  const symbols = [...new Set(trades.map((trade) => trade.symbol).filter(Boolean))];
  if (!ids.length && !symbols.length) return { bySignalId: new Map(), candidates: [] };
  const cutoffMs = Date.now() - (Math.max(1, Number(days || 14)) * 24 * 60 * 60 * 1000);
  const conditions = [];
  const params = [];

  if (ids.length) {
    params.push(ids);
    conditions.push(`signal_id = ANY($${params.length})`);
  }
  if (symbols.length) {
    params.push(symbols);
    conditions.push(`(
      symbol = ANY($${params.length})
      AND (
        entry_time >= $${params.length + 1}
        OR exit_time >= $${params.length + 1}
        OR created_at >= $${params.length + 1}
      )
    )`);
    params.push(cutoffMs);
  }

  const rows = await db.query(
    `SELECT *
       FROM investment.trade_journal
      WHERE ${conditions.join(' OR ')}
      ORDER BY created_at DESC`,
    params,
  ).catch(() => []);
  const bySignalId = new Map();
  for (const row of rows) {
    if (row.signal_id && !bySignalId.has(row.signal_id)) bySignalId.set(row.signal_id, row);
  }
  return { bySignalId, candidates: rows };
}

function findNearestJournalForTrade(trade = {}, journals = []) {
  const tradeMs = toMillis(trade.executed_at);
  if (!tradeMs) return null;
  const side = String(trade.side || '').trim().toLowerCase();
  const exchange = String(trade.exchange || '').trim();
  const symbol = String(trade.symbol || '').trim();
  const tradeMode = normalizeTradeMode(trade.trade_mode || trade.tradeMode);
  const maxDistanceMs = 6 * 60 * 60 * 1000;
  let best = null;

  for (const journal of journals) {
    if (String(journal.exchange || '').trim() !== exchange) continue;
    if (String(journal.symbol || '').trim() !== symbol) continue;
    if (normalizeTradeMode(journal.trade_mode) !== tradeMode) continue;

    const anchor = side === 'sell'
      ? toMillis(journal.exit_time)
      : toMillis(journal.entry_time);
    if (!anchor) continue;
    const distanceMs = Math.abs(tradeMs - anchor);
    if (distanceMs > maxDistanceMs) continue;
    if (!best || distanceMs < best.distanceMs) {
      best = { row: journal, distanceMs };
    }
  }

  return best?.row || null;
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
  const symbols = [...new Set(trades.map((trade) => trade.symbol).filter(Boolean))];
  if (!symbols.length) return new Map();
  const rows = await db.query(
    `SELECT *
       FROM investment.position_strategy_profiles
      WHERE symbol = ANY($1)
      ORDER BY
        CASE WHEN status = 'active' THEN 0 ELSE 1 END,
        updated_at DESC,
        created_at DESC
      LIMIT 1000`,
    [symbols],
  ).catch(() => []);
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

function isRecoveredProfilelessEnvelope(envelope = {}, missing = []) {
  const linkage = envelope.linkage || {};
  const setupType = String(envelope?.strategy?.setupType || '').trim();
  const missingSet = new Set(missing || []);
  let expectedMissing = setupType === 'unattributed_execution_tracking'
    ? new Set(['strategyProfile', 'signal', 'agentConsensus'])
    : new Set(['strategyProfile']);
  if (linkage.hasStrategyProfile) {
    expectedMissing = new Set(['signal', 'agentConsensus']);
  }
  const onlyExpectedMissing = [...missingSet].every((key) => expectedMissing.has(key));

  return onlyExpectedMissing
    && linkage.hasTrade
    && linkage.hasJournal
    && linkage.hasStrategyRoute
    && linkage.hasExecutionPlan
    && linkage.hasResponsibilityPlan
    && linkage.hasRegime;
}

function classifyEnvelopeRow(row = {}) {
  const missing = row.score?.missing || [];
  if (row.score?.status === 'complete') return 'complete';
  if (row.score?.status === 'weak') return 'actionable_weak';
  if (isRecoveredProfilelessEnvelope(row.envelope, missing)) return 'recovered_partial';
  return 'actionable_partial';
}

export function getExecutionAttachMeta(signal = null) {
  const blockMeta = safeJson(signal?.block_meta, {});
  const attach = blockMeta?.executionAttach || null;
  return attach && typeof attach === 'object' ? attach : null;
}

export function summarizeExecutionAttachRows(rows = []) {
  const byStatus = {};
  const byRecoveryStatus = {};
  const byAttachStatus = {};
  const missingCounts = {};
  const actionableMissingCounts = {};
  let scoreSum = 0;
  let attachTrackedCount = 0;
  let attachOkCount = 0;
  let attachErrorCount = 0;
  for (const row of rows) {
    byStatus[row.score.status] = (byStatus[row.score.status] || 0) + 1;
    const recoveryStatus = classifyEnvelopeRow(row);
    byRecoveryStatus[recoveryStatus] = (byRecoveryStatus[recoveryStatus] || 0) + 1;
    if (row.executionAttach) {
      attachTrackedCount += 1;
      if (row.executionAttach.ok === true) attachOkCount += 1;
      if (row.executionAttach.ok === false || row.executionAttach.status === 'error') attachErrorCount += 1;
      const attachStatus = String(row.executionAttach.status || 'unknown');
      byAttachStatus[attachStatus] = (byAttachStatus[attachStatus] || 0) + 1;
    }
    scoreSum += Number(row.score.score || 0);
    for (const key of row.score.missing || []) {
      missingCounts[key] = (missingCounts[key] || 0) + 1;
      if (recoveryStatus !== 'recovered_partial') {
        actionableMissingCounts[key] = (actionableMissingCounts[key] || 0) + 1;
      }
    }
  }
  const topMissing = Object.entries(missingCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count }));
  const actionableMissing = Object.entries(actionableMissingCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count }));
  return {
    total: rows.length,
    avgAttachScore: rows.length ? Math.round((scoreSum / rows.length) * 10) / 10 : null,
    byStatus,
    byRecoveryStatus,
    byAttachStatus,
    topMissing,
    actionableMissing,
    attachTrackedCount,
    attachOkCount,
    attachErrorCount,
    weakCount: byStatus.weak || 0,
    partialCount: byStatus.partial || 0,
    completeCount: byStatus.complete || 0,
    recoveredPartialCount: byRecoveryStatus.recovered_partial || 0,
    actionablePartialCount: byRecoveryStatus.actionable_partial || 0,
    actionableWeakCount: byRecoveryStatus.actionable_weak || 0,
  };
}

export function buildExecutionAttachDecision(summary = {}) {
  const actionableItems = summary.actionableMissing?.slice?.(0, 3) || [];
  return {
    status: summary.attachErrorCount > 0
      ? 'execution_attach_error'
      : summary.actionableWeakCount > 0
      ? 'execution_attach_weak'
      : summary.actionablePartialCount > 0
        ? 'execution_attach_partial'
        : summary.recoveredPartialCount > 0
          ? 'execution_attach_recovered_partial'
          : summary.partialCount > 0
            ? 'execution_attach_partial'
            : 'execution_attach_ok',
    headline: summary.attachErrorCount > 0
      ? '최근 체결의 전략 attach 시도 중 실패가 있어 실행 메타 확인이 필요합니다.'
      : summary.actionableWeakCount > 0
      ? '체결 후 포지션/전략 연결이 약한 거래가 있어 envelope 통합이 필요합니다.'
      : summary.actionablePartialCount > 0
        ? '체결 후 연결은 대부분 있으나 일부 실행 메타 보강이 필요합니다.'
        : summary.recoveredPartialCount > 0
          ? '최근 체결은 감사 가능한 수준으로 복구되었고, 일부 과거/조정 체결만 추적 상태입니다.'
          : '최근 체결의 포지션/전략 연결이 정상입니다.',
    actionItems: summary.attachErrorCount > 0
      ? [
        `execution attach 실패 ${summary.attachErrorCount}건의 signals.block_meta.executionAttach.error를 확인합니다.`,
        '실패가 반복되면 live BUY 체결 직후 profile 생성 경로와 open position 조회 조건을 점검합니다.',
      ]
      : actionableItems.length > 0
      ? actionableItems.map((item) => `${item.key} 누락 ${item.count}건을 체결 envelope attach 경로에서 보강합니다.`)
      : [
        `${summary.recoveredPartialCount || 0}건은 profile/signal 원본이 부족하지만 envelope fallback으로 감사 추적 중입니다.`,
        '신규 주문에는 사용하지 않고 reconciliation/position truth guard 대상으로 유지합니다.',
      ],
  };
}

export async function runExecutionAttachAudit({ days = 14, limit = 100, exchange = null } = {}) {
  await db.initSchema();
  await journalDb.initJournalSchema();

  const trades = await loadRecentTrades({ days, limit, exchange });
  const signalIds = trades.map((trade) => trade.signal_id).filter(Boolean);
  const [signals, journalContext, profiles] = await Promise.all([
    loadSignalsByIds(signalIds),
    loadJournalContext(trades, days),
    loadProfilesForTrades(trades),
  ]);

  const rows = trades.map((trade) => {
    const signal = signals.get(trade.signal_id) || null;
    const journal = journalContext.bySignalId.get(trade.signal_id)
      || findNearestJournalForTrade(trade, journalContext.candidates)
      || null;
    const strategyProfile = profiles.get(profileKeyForTrade(trade)) || null;
    const envelope = buildExecutionFillEnvelope({ trade, signal, journal, strategyProfile });
    const executionAttach = getExecutionAttachMeta(signal);
    return {
      tradeId: trade.id || null,
      signalId: trade.signal_id || null,
      symbol: trade.symbol,
      exchange: trade.exchange,
      side: trade.side,
      tradeMode: trade.trade_mode || 'normal',
      executedAt: trade.executed_at,
      executionAttach,
      envelope,
      score: scoreExecutionFillEnvelope(envelope),
    };
  });
  const summary = summarizeExecutionAttachRows(rows);
  const decision = buildExecutionAttachDecision(summary);

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
