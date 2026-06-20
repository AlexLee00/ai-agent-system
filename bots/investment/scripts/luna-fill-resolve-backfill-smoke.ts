#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FILL_RESOLVE_BACKFILL_CONFIRM,
  runLunaFillResolveBackfill,
  updateJournalFromResolvedFill,
} from './luna-fill-resolve-backfill.ts';
import {
  buildLaunchdEnvDriftPlan,
  extractPlistEnvironment,
} from '../shared/launchd-service.ts';

const INVESTMENT_ROOT = resolve(new URL('..', import.meta.url).pathname);

function candidate(overrides = {}) {
  return {
    id: 1,
    trade_id: 'TRD-BACKFILL-1',
    symbol: 'ORCA/USDT',
    exchange: 'binance',
    trade_mode: 'normal',
    direction: 'long',
    entry_time: Date.parse('2026-06-11T00:00:00.000Z'),
    entry_price: 10,
    entry_size: 4,
    entry_value: 40,
    sl_order_id: 'SL-1',
    tp_order_id: 'TP-1',
    exit_reason: 'journal_reconciled_no_position',
    ...overrides,
  };
}

function resolvedFill(overrides = {}) {
  return {
    source: 'fetchMyTrades_orderid',
    matchedBy: 'order_id',
    partial: false,
    exitPrice: 12,
    exitValue: 48,
    pnlAmount: 8,
    pnlPercent: 20,
    pnlNet: 8,
    fillCount: 1,
    matchedQty: 4,
    expectedQty: 4,
    lastFillAt: '2026-06-11T00:10:00.000Z',
    tradeIds: ['fill-1'],
    orderIds: ['TP-1'],
    ...overrides,
  };
}

export async function runLunaFillResolveBackfillSmoke() {
  const calls = [];
  const dryRun = await runLunaFillResolveBackfill({
    dryRun: true,
    apply: false,
    sleepMs: 0,
  }, {
    loadCandidates: async () => [candidate()],
    fetchPreviouslyAttributedFillIds: async () => [],
    resolveFillForClosedJournal: async (input) => {
      calls.push(['resolve', input]);
      return resolvedFill();
    },
    updateJournalFromResolvedFill: async () => {
      calls.push(['update']);
      return 1;
    },
  });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.matched, 1);
  assert.equal(dryRun.updated, 0);
  assert.equal(dryRun.rows[0].status, 'would_update');
  assert.equal(calls.some((item) => item[0] === 'update'), false, 'dry-run must not update');
  assert.deepEqual(calls.find((item) => item[0] === 'resolve')?.[1]?.orderIds, ['SL-1', 'TP-1']);

  let queriedCandidate = null;
  const queryPath = await runLunaFillResolveBackfill({
    dryRun: true,
    apply: false,
    sleepMs: 0,
  }, {
    query: async (sql, params) => {
      assert.match(sql, /FROM trade_journal/);
      assert.equal(params[0], '2026-06-11');
      return [candidate({ trade_id: 'TRD-QUERY-PATH', entry_size: 2.442 })];
    },
    fetchPreviouslyAttributedFillIds: async () => [],
    resolveFillForClosedJournal: async (input) => {
      queriedCandidate = input;
      return resolvedFill();
    },
  });
  assert.equal(queryPath.matched, 1);
  assert.equal(queriedCandidate.entrySize, 2.442);
  assert.deepEqual(queriedCandidate.orderIds, ['SL-1', 'TP-1']);

  const noGate = await runLunaFillResolveBackfill({
    dryRun: false,
    apply: true,
    confirm: FILL_RESOLVE_BACKFILL_CONFIRM,
    backfillEnabled: false,
  });
  assert.equal(noGate.blocked, true);
  assert.match(noGate.reason, /LUNA_RECONCILE_FILL_RESOLVE_BACKFILL/);

  const wrongConfirm = await runLunaFillResolveBackfill({
    dryRun: false,
    apply: true,
    confirm: 'wrong',
    backfillEnabled: true,
  });
  assert.equal(wrongConfirm.blocked, true);
  assert.match(wrongConfirm.reason, /confirmation_required/);

  let capturedUpdate = null;
  let refreshed = false;
  const apply = await runLunaFillResolveBackfill({
    dryRun: false,
    apply: true,
    confirm: FILL_RESOLVE_BACKFILL_CONFIRM,
    backfillEnabled: true,
    sleepMs: 0,
  }, {
    loadCandidates: async () => [candidate()],
    fetchPreviouslyAttributedFillIds: async () => ['already-used-fill'],
    resolveFillForClosedJournal: async (input) => {
      assert.deepEqual(input.excludedFillIds, ['already-used-fill']);
      return resolvedFill();
    },
    updateJournalFromResolvedFill: async (row, fill) => {
      capturedUpdate = { row, fill };
      return 1;
    },
    refreshTradesUsdView: async () => {
      refreshed = true;
    },
  });
  assert.equal(apply.ok, true);
  assert.equal(apply.updated, 1);
  assert.equal(apply.refreshed, true);
  assert.equal(refreshed, true);
  assert.equal(capturedUpdate.row.tradeId, 'TRD-BACKFILL-1');
  assert.equal(capturedUpdate.fill.matchedBy, 'order_id');

  let capturedSql = null;
  let capturedParams = null;
  const affected = await updateJournalFromResolvedFill({
    tradeId: 'TRD-BACKFILL-1',
    slOrderId: 'SL-1',
    tpOrderId: 'TP-1',
  }, resolvedFill(), {
    run: async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rowCount: 1 };
    },
  });
  assert.equal(affected, 1);
  assert.match(capturedSql, /exit_reason = 'journal_reconciled_with_fill'/);
  assert.match(capturedSql, /status = 'closed'/);
  assert.match(capturedSql, /exit_reason LIKE 'journal_reconciled_no_position%'/);
  assert.match(capturedSql, /exit_match_source IS NULL/);
  assert.match(capturedSql, /quality_flag = 'trusted'/);
  assert.match(capturedSql, /exclude_from_learning = false/);
  assert.ok(capturedParams.includes('TP-1'));
  assert.ok(capturedParams.includes('fill-1'));
  assert.ok(capturedParams.includes('order_id'));
  assert.ok(capturedParams.includes('TRD-BACKFILL-1'));

  const unresolved = await runLunaFillResolveBackfill({
    dryRun: false,
    apply: true,
    confirm: FILL_RESOLVE_BACKFILL_CONFIRM,
    backfillEnabled: true,
    sleepMs: 0,
  }, {
    loadCandidates: async () => [candidate({ trade_id: 'TRD-UNRESOLVED' })],
    fetchPreviouslyAttributedFillIds: async () => [],
    resolveFillForClosedJournal: async () => ({ source: 'unresolved', reason: 'no_matching_side_fills' }),
    updateJournalFromResolvedFill: async () => {
      throw new Error('unresolved_should_not_update');
    },
    refreshTradesUsdView: async () => {
      throw new Error('unresolved_should_not_refresh');
    },
  });
  assert.equal(unresolved.updated, 0);
  assert.equal(unresolved.unresolved, 1);
  assert.equal(unresolved.refreshed, false);

  let idempotentLoadCount = 0;
  const idempotent = await runLunaFillResolveBackfill({
    dryRun: false,
    apply: true,
    confirm: FILL_RESOLVE_BACKFILL_CONFIRM,
    backfillEnabled: true,
    sleepMs: 0,
  }, {
    loadCandidates: async () => {
      idempotentLoadCount += 1;
      return [];
    },
  });
  assert.equal(idempotentLoadCount, 1);
  assert.equal(idempotent.scanned, 0);
  assert.equal(idempotent.updated, 0);

  const plist = readFileSync(resolve(INVESTMENT_ROOT, 'launchd/ai.luna.ops-scheduler.plist'), 'utf8');
  const env = extractPlistEnvironment(plist);
  assert.equal(env.LUNA_RECONCILE_FILL_RESOLVE_ENABLED, 'true');
  assert.equal(env.RECONCILE_OPEN_JOURNALS_PERIODIC_ENABLED, 'true');
  assert.equal(env.LUNA_LEARNED_BIAS_MODE, 'shadow');
  assert.equal(Object.hasOwn(env, 'LUNA_RECONCILE_FILL_RESOLVE_DRY_RUN'), false);

  const criticalKeys = [
    'LUNA_RECONCILE_FILL_RESOLVE_ENABLED',
    'RECONCILE_OPEN_JOURNALS_PERIODIC_ENABLED',
    'LUNA_LEARNED_BIAS_MODE',
  ];
  const drift = buildLaunchdEnvDriftPlan({
    criticalEnvKeysByLabel: {
      'ai.luna.ops-scheduler': criticalKeys,
    },
    repoEnvByLabel: {
      'ai.luna.ops-scheduler': {
        LUNA_RECONCILE_FILL_RESOLVE_ENABLED: 'true',
        RECONCILE_OPEN_JOURNALS_PERIODIC_ENABLED: 'true',
        LUNA_LEARNED_BIAS_MODE: 'shadow',
      },
    },
    installedEnvByLabel: {
      'ai.luna.ops-scheduler': {},
    },
    loadedEnvByLabel: {
      'ai.luna.ops-scheduler': {},
    },
    installedPlistPathForLabel: () => '/tmp/missing.plist',
    repoPlistPathForLabel: () => '/tmp/repo.plist',
    existsSyncImpl: () => true,
  });
  assert.equal(drift.length, 3);
  assert.equal(drift[0].key, 'LUNA_RECONCILE_FILL_RESOLVE_ENABLED');
  assert.equal(drift[0].criticalEnabledKey, true);
  assert.equal(drift[1].key, 'RECONCILE_OPEN_JOURNALS_PERIODIC_ENABLED');
  assert.equal(drift[1].criticalEnabledKey, true);
  assert.equal(drift[2].key, 'LUNA_LEARNED_BIAS_MODE');
  assert.equal(drift[2].criticalEnabledKey, false);

  return {
    ok: true,
    smoke: 'luna-fill-resolve-backfill',
    dryRunMatched: dryRun.matched,
    applyUpdated: apply.updated,
    unresolved: unresolved.unresolved,
    driftDetected: drift.length,
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  runLunaFillResolveBackfillSmoke()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
