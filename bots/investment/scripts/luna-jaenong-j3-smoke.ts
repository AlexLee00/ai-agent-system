#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acknowledgeJaenongBrief,
  applyJaenongBriefWeight,
  attachJaenongAttribution,
  buildJaenongBriefFromPostScore,
  buildJaenongPriorityRoute,
  buildJaenongReferenceSnapshot,
  deriveJaenongMarketAdjustment,
  evaluateJaenongBriefState,
  getJaenongBriefStatus,
  getJaenongRetroSummary,
  handleJaenongCommand,
  invalidateJaenongBriefState,
  jaenongBriefPreflight,
  recordJaenongRouteShadow,
  resolveJaenongBriefMaxPublishedAgeHours,
  resolveJaenongReferenceDirectory,
} from '../shared/jaenong-operations.ts';
import {
  JAENONG_DAILY_WRITE_CONFIRM,
  runJaenongDailyShadow,
  summarizeJaenongDailyShadowResult,
} from './runtime-jaenong-daily-shadow.ts';
import { runJaenongReferenceSnapshot } from './jaenong-reference-snapshot.ts';
import {
  JAENONG_ROUTE_WRITE_CONFIRM,
  runJaenongRouteShadow,
} from './runtime-jaenong-route-shadow.ts';
import {
  executeInvestmentSkill,
  loadInvestmentSkills,
} from '../shared/skill-registry.ts';
import {
  LUNA_OPS_MCP_TOOLS,
  callLunaOpsTool,
} from '../mcp/luna-ops-mcp/src/server.ts';
import { buildLunaJaenongPredictionFeedInput } from '../../sigma/shared/luna-jaenong-feed.ts';
import { runLunaOpsMcpSmoke } from './luna-ops-mcp-smoke.ts';
import { runLunaLogRotate } from './luna-log-rotate.ts';

function cell(value, formula = null) {
  return { value, formula };
}

function workbookFixture() {
  return {
    sheets: {
      '판단부분': {
        cells: {
          D3: cell('SPY'),
          E3: cell(-0.2, '=IFERROR(GOOGLEFINANCE("SPY","price"),-0.2)'),
          F3: cell('강력 매수 타이밍 +3', '=IF(E3<=-0.2,"+3","-1")'),
          D6: cell('VIX'),
          E6: cell(30, '=IFERROR(GOOGLEFINANCE("VIX","price"),30)'),
          F6: cell('공포 타이밍 +2'),
          D7: cell('Fear and greed'),
          E7: cell(10),
          F7: cell('공포 타이밍 +2'),
          B10: cell('종목(티커)'),
          B11: cell('AAPL'),
          C11: cell(null, '=GOOGLEFINANCE(B11,"price")'),
          D11: cell(3_000),
          E11: cell(-0.12),
          F11: cell(0.04),
          G11: cell(28),
          H11: cell(-0.1),
          I11: cell(40),
          J11: cell(-0.08),
          K11: cell(0.2),
          L11: cell(0.15),
          M11: cell(7),
          N11: cell('매수 대기'),
        },
      },
      '종목별 데이터': {
        cells: {
          B4: cell('업종'),
          C4: cell('티커'),
          B5: cell('빅테크'),
          C5: cell('MSFT'),
          D5: cell(400),
          E5: cell(3_100),
          F5: cell(-0.18),
        },
      },
      '기준시트의 사본': {
        cells: {
          F8: cell(-999999), G8: cell(3),
          F9: cell(-0.3), G9: cell(2),
          F10: cell(-0.15), G10: cell(1),
          F11: cell(-0.05), G11: cell(0),
          F49: cell(-999999), G49: cell(3),
          F50: cell(-0.2), G50: cell(1),
          F51: cell(-0.1), G51: cell(0),
          F52: cell(-0.05), G52: cell(-1),
          F58: cell(-99999), G58: cell(-1),
          F59: cell(15.0000001), G59: cell(0),
          F60: cell(20.0000001), G60: cell(1),
          F61: cell(30), G61: cell(2),
          F65: cell(-99999), G65: cell(2),
          F66: cell(10.000001), G66: cell(1),
          F67: cell(30), G67: cell(0),
          F68: cell(70), G68: cell(-1),
        },
      },
    },
  };
}

async function main() {
  const migrationSql = fs.readFileSync(
    new URL('../migrations/20260716000001_jaenong_operations.sql', import.meta.url),
    'utf8',
  );
  assert.match(migrationSql, /source_post_id\s+TEXT/);
  assert.doesNotMatch(migrationSql, /source_post_id\s+BIGINT/);

  const defaultDirectory = path.join(os.homedir(), '.ai-agent-system', 'investment', 'jaenong-reference');
  assert.equal(resolveJaenongReferenceDirectory({ env: {} }), defaultDirectory);
  assert.equal(resolveJaenongReferenceDirectory({
    env: { JAENONG_REFERENCE_DIR: '/tmp/env-reference' },
    c17: { 'c17.jaenong.reference_directory': '/tmp/c17-reference' },
  }), '/tmp/env-reference');
  assert.equal(resolveJaenongReferenceDirectory({
    env: {},
    c17: { 'c17.jaenong.reference_directory': '/tmp/c17-reference' },
  }), '/tmp/c17-reference');
  assert.equal(resolveJaenongReferenceDirectory({
    env: {},
    c17: { 'c17.jaenong.reference_directory': '~/.ai-agent-system/investment/jaenong-reference' },
  }), defaultDirectory);

  const quoteCalls = [];
  const snapshot = await buildJaenongReferenceSnapshot(workbookFixture(), {
    sourceFileName: '260709_JAENONG_REV8_5_Gy8wF.xlsx',
    snapshotHash: 'a'.repeat(64),
    sourceModifiedAt: '2026-07-09T00:00:00.000Z',
    quoteProvider: async (symbol) => {
      quoteCalls.push(symbol);
      return 212.5;
    },
  });

  assert.equal(snapshot.revision, 'REV8_5');
  assert.equal(snapshot.snapshotHash, 'a'.repeat(64));
  assert.deepEqual(snapshot.timing.values, { spyDrawdownRatio: -0.2, vix: 30, fearGreed: 10 });
  assert.equal(snapshot.barometer.length, 1);
  assert.equal(snapshot.barometer[0].symbol, 'AAPL');
  assert.equal(snapshot.barometer[0].currentPrice, 212.5, 'missing formula cache must use injected KIS quote');
  assert.equal(snapshot.barometer[0].financialScore, 7);
  assert.deepEqual(quoteCalls, ['AAPL']);
  assert.equal(snapshot.interest.length, 1);
  assert.equal(snapshot.interest[0].symbol, 'MSFT');
  assert.equal(snapshot.interest[0].drawdownZone, 'pullback');
  assert.equal(snapshot.c17Proposal.autoApply, false);
  assert.equal(snapshot.c17Proposal.mode, 'proposal_only');
  assert.deepEqual(snapshot.c17Proposal.parameters.fearGreed, [
    [-99999, 2], [10.000001, 1], [30, 0], [70, -1],
  ]);
  assert.equal(snapshot.rawWorkbookIncluded, false);
  await assert.rejects(
    runJaenongReferenceSnapshot({ write: true }),
    /jaenong_reference_write_confirmation_required/,
  );

  const now = '2026-07-16T12:00:00.000Z';
  const brief = {
    briefRef: 'JB-20260716-1',
    publishedAt: '2026-07-16T09:00:00.000Z',
    parsedAt: '2026-07-16T09:05:00.000Z',
    updatedAt: '2026-07-16T09:05:00.000Z',
    expiresAt: '2026-07-17T09:00:00.000Z',
    marketAdjustment: 1,
    candidateSymbols: ['MSFT'],
  };
  assert.equal(evaluateJaenongBriefState({ now }).status, 'absent');
  assert.equal(evaluateJaenongBriefState({ now, parseStatus: 'failed', parseError: 'dom_changed' }).status, 'parse_failed');
  const awaitingAck = evaluateJaenongBriefState({ now, brief });
  assert.equal(awaitingAck.status, 'awaiting_ack');
  const unackedWeight = applyJaenongBriefWeight({
    baseScore: 2,
    candidates: [{ symbol: 'MSFT', weight: 1 }],
    brief,
    state: awaitingAck,
  });
  assert.equal(unackedWeight.score, 2);
  assert.equal(unackedWeight.applied, false);
  assert.equal(unackedWeight.candidates[0].weight, 1);

  const active = evaluateJaenongBriefState({
    now,
    brief,
    ack: { briefRef: brief.briefRef, acknowledgedAt: '2026-07-16T10:00:00.000Z' },
  });
  assert.equal(active.status, 'active');
  const weighted = applyJaenongBriefWeight({
    baseScore: 2,
    candidates: [{ symbol: 'MSFT', weight: 1 }, { symbol: 'AAPL', weight: 1 }],
    brief,
    state: active,
  });
  assert.equal(weighted.score, 3);
  assert.equal(weighted.applied, true);
  assert.equal(weighted.candidates[0].weight, 2);
  assert.equal(weighted.candidates[1].weight, 1);
  assert.deepEqual(weighted.g6Context, {
    enabled: true,
    flagOnly: true,
    briefRef: brief.briefRef,
  });
  assert.equal(evaluateJaenongBriefState({
    now,
    brief: { ...brief, publishedAt: '2026-07-14T09:00:00.000Z' },
  }).status, 'stale');
  assert.equal(evaluateJaenongBriefState({
    now,
    brief: { ...brief, expiresAt: '2026-07-16T11:59:59.000Z' },
  }).status, 'expired');
  assert.equal(evaluateJaenongBriefState({
    now,
    brief: { ...brief, invalidatedAt: '2026-07-16T10:30:00.000Z' },
  }).status, 'invalid');

  let todayStatusQuery = null;
  const todayStatus = await getJaenongBriefStatus({ now, todayKst: true }, {
    queryFn: async (sql, params) => {
      todayStatusQuery = { sql, params };
      return [{}];
    },
  });
  assert.equal(todayStatus.state.status, 'absent');
  assert.deepEqual(todayStatusQuery.params, ['2026-07-15T15:00:00.000Z', '2026-07-16T15:00:00.000Z']);
  assert.match(todayStatusQuery.sql, /published_at\s*>=\s*\$1::timestamptz/i);
  assert.equal(todayStatus.executionConnected, false);

  const ackWrites = [];
  const ackQueries = [];
  const ackTransaction = async (callback) => callback({
    query: async (sql, params) => {
      ackQueries.push({ sql, params });
      if (/FOR UPDATE/i.test(sql)) return [{
        brief_ref: brief.briefRef,
        source_kind: 'post',
        published_at: brief.publishedAt,
        parsed_at: brief.parsedAt,
        updated_at: brief.updatedAt,
        expires_at: brief.expiresAt,
        market_adjustment: brief.marketAdjustment,
        market_view: brief.marketView,
        candidate_symbols: brief.candidateSymbols,
        state: 'awaiting_ack',
        shadow_only: true,
      }];
      if (/FROM investment\.jaenong_brief_ack/i.test(sql)) return [];
      throw new Error(`unexpected ack query: ${sql}`);
    },
    run: async (sql, params) => {
      ackWrites.push({ sql, params });
      return { rowCount: 1 };
    },
  });
  const meetingRoomAck = await acknowledgeJaenongBrief({
    briefRef: brief.briefRef,
    actor: 'meeting-room:master',
    now,
  }, { withTransactionFn: ackTransaction });
  assert.equal(meetingRoomAck.state, 'active');
  assert.equal(meetingRoomAck.idempotent, false);
  assert.equal(meetingRoomAck.shadowOnly, true);
  assert.equal(meetingRoomAck.executionConnected, false);
  assert.equal(ackWrites.length, 3);
  assert.match(ackQueries[0].sql, /FOR UPDATE/i);
  assert.match(ackWrites[0].sql, /jaenong_brief_ack/i);
  assert.match(ackWrites[1].sql, /state\s*=\s*'active'/i);
  assert.match(ackWrites[2].sql, /jaenong_brief_event/i);
  assert.doesNotMatch(ackWrites.map((write) => write.sql).join('\n'), /trade_journal|order|execution/i);

  const idempotentAck = await acknowledgeJaenongBrief({
    briefRef: brief.briefRef,
    actor: 'meeting-room:master',
    now,
  }, {
    withTransactionFn: async (callback) => callback({
      query: async (sql) => (/FOR UPDATE/i.test(sql) ? [{
        brief_ref: brief.briefRef,
        source_kind: 'post',
        published_at: brief.publishedAt,
        parsed_at: brief.parsedAt,
        updated_at: brief.updatedAt,
        expires_at: brief.expiresAt,
        market_adjustment: brief.marketAdjustment,
        market_view: brief.marketView,
        candidate_symbols: brief.candidateSymbols,
        state: 'active',
        shadow_only: true,
      }] : [{ acknowledged_at: '2026-07-16T11:30:00.000Z' }]),
      run: async () => { throw new Error('idempotent ack must not write'); },
    }),
  });
  assert.equal(idempotentAck.idempotent, true);
  assert.equal(idempotentAck.state, 'active');

  await assert.rejects(
    acknowledgeJaenongBrief({
      briefRef: brief.briefRef,
      actor: 'meeting-room:master',
      now,
    }, {
      withTransactionFn: async (callback) => callback({
        query: async (sql) => (/FOR UPDATE/i.test(sql) ? [{
          brief_ref: brief.briefRef,
          source_kind: 'post',
          published_at: brief.publishedAt,
          parsed_at: brief.parsedAt,
          updated_at: brief.updatedAt,
          expires_at: now,
          market_adjustment: brief.marketAdjustment,
          market_view: brief.marketView,
          candidate_symbols: brief.candidateSymbols,
          state: 'awaiting_ack',
          shadow_only: true,
        }] : []),
        run: async () => { throw new Error('expired ack must not write'); },
      }),
    }),
    /jaenong_brief_expired/,
  );

  const commandWrites = [];
  const commandDeps = {
    now: () => new Date(now),
    queryFn: async () => [{
      brief_ref: brief.briefRef,
      state: 'awaiting_ack',
      published_at: brief.publishedAt,
      expires_at: brief.expiresAt,
    }],
    runFn: async (sql, params) => {
      commandWrites.push({ sql, params });
      return { rowCount: 1 };
    },
    withTransactionFn: ackTransaction,
  };
  const statusCommand = await handleJaenongCommand('/jaenong', { ...commandDeps, actor: 'master' });
  assert.equal(statusCommand.ok, true);
  assert.equal(statusCommand.action, 'status');
  const ackCommand = await handleJaenongCommand(`/jaenong ack ${brief.briefRef}`, {
    ...commandDeps,
    actor: 'master',
  });
  assert.equal(ackCommand.action, 'ack');
  assert.equal(ackCommand.shadowOnly, true);
  assert.equal(ackWrites.length, 6);
  assert.match(ackWrites[3].sql, /jaenong_brief_ack/);
  assert.doesNotMatch(ackWrites.slice(3).map((write) => write.sql).join('\n'), /trade_journal|order|execution/i);
  const correctCommand = await handleJaenongCommand(
    `/jaenong correct ${brief.briefRef} 1 MSFT corrected view`,
    { ...commandDeps, actor: 'master' },
  );
  assert.equal(correctCommand.action, 'correct');
  assert.equal(correctCommand.state, 'awaiting_ack');
  assert.match(commandWrites[0].sql, /invalidated_at\s*=\s*NULL/i);
  assert.match(commandWrites[0].sql, /invalid_reason\s*=\s*NULL/i);
  await assert.rejects(
    handleJaenongCommand('/jaenong set 2 MSFT too-high', { ...commandDeps, actor: 'master' }),
    /jaenong_market_adjustment_out_of_range/,
  );
  assert.equal(deriveJaenongMarketAdjustment('조정은 분할매수 기회'), 1);
  assert.equal(deriveJaenongMarketAdjustment('과열 국면에서 추격매수 금지'), -1);
  assert.equal(deriveJaenongMarketAdjustment('조정 기회이지만 과열 주의'), 0);
  const materialized = buildJaenongBriefFromPostScore({
    source_post_id: 'post-1',
    published_at: '2026-07-16T08:00:00.000Z',
    parsed_at: '2026-07-16T08:05:00.000Z',
    brief: {
      marketView: '조정은 분할매수 기회',
      candidates: [{ ticker: 'msft', available: true }, { ticker: 'AAPL', available: false }],
    },
  }, {
    now,
    referenceSnapshotHash: snapshot.snapshotHash,
  });
  assert.equal(materialized.marketAdjustment, 1);
  assert.deepEqual(materialized.candidateSymbols, ['MSFT']);
  assert.equal(materialized.state, 'awaiting_ack');
  assert.equal(resolveJaenongBriefMaxPublishedAgeHours(undefined, {}), 30);
  assert.equal(resolveJaenongBriefMaxPublishedAgeHours(undefined, {
    JAENONG_BRIEF_MAX_PUBLISHED_AGE_HOURS: '48',
  }), 48);
  assert.equal(materialized.referenceSnapshotHash, snapshot.snapshotHash);

  const freshnessBoundaryRow = {
    source_post_id: 'post-freshness-boundary',
    published_at: '2026-07-15T06:00:00.000Z',
    parsed_at: '2026-07-16T12:00:00.000Z',
    brief: { marketView: '중립', candidates: [] },
  };
  const atFreshnessBoundary = buildJaenongBriefFromPostScore(freshnessBoundaryRow, { now });
  const pastFreshnessBoundary = buildJaenongBriefFromPostScore(freshnessBoundaryRow, {
    now: '2026-07-16T12:00:00.001Z',
  });
  assert.equal(atFreshnessBoundary.state, 'awaiting_ack');
  assert.equal(evaluateJaenongBriefState({
    now,
    brief: atFreshnessBoundary,
  }).status, 'awaiting_ack');
  assert.equal(atFreshnessBoundary.expiresAt, '2026-07-16T12:00:00.001Z');
  assert.equal(pastFreshnessBoundary.state, 'stale');
  assert.equal(pastFreshnessBoundary.expiresAt, atFreshnessBoundary.expiresAt);
  assert.equal(buildJaenongBriefFromPostScore(freshnessBoundaryRow, {
    now: '2026-07-16T12:00:00.001Z',
    env: { JAENONG_BRIEF_MAX_PUBLISHED_AGE_HOURS: '48' },
  }).state, 'awaiting_ack');
  assert.equal(evaluateJaenongBriefState({
    now: '2026-07-16T12:00:00.001Z',
    brief: pastFreshnessBoundary,
    ack: { briefRef: pastFreshnessBoundary.briefRef, acknowledgedAt: now },
  }).status, 'stale');

  let collectorCalls = 0;
  const collectPlan = await runJaenongDailyShadow({ stage: 'collect' }, {
    collectFn: async () => { collectorCalls += 1; },
    parseFn: async () => { collectorCalls += 1; },
  });
  assert.equal(collectPlan.mode, 'dry_run');
  assert.equal(collectPlan.write, false);
  assert.equal(collectorCalls, 0);
  const privateContentMarker = 'private-post-body-must-not-reach-stdout';
  const collectSummary = summarizeJaenongDailyShadowResult({
    ok: true,
    stage: 'collect',
    mode: 'shadow_write',
    write: true,
    state: 'parsed',
    collected: {
      status: 'ok',
      posts: [{ content: privateContentMarker.repeat(10_000) }],
      failedPosts: [],
      written: 1336,
      totalCount: 1336,
      successCount: 1336,
      failureCount: 0,
      skippedCount: 0,
      failureRate: 0,
      failureThreshold: 0.3,
      cutoff: '2025-07-16T11:00:03.426Z',
      privateSnapshot: true,
    },
    parsedCount: 100,
    executionConnected: false,
  });
  const collectSummaryJson = JSON.stringify(collectSummary);
  assert.equal(collectSummaryJson.includes(privateContentMarker), false);
  assert.equal(Object.hasOwn(collectSummary.collected, 'posts'), false);
  assert.equal(Object.hasOwn(collectSummary.collected, 'failedPosts'), false);
  assert.ok(Buffer.byteLength(collectSummaryJson) < 1024, 'daily collector stdout summary must stay below 1 KiB');
  assert.equal(collectSummary.executionConnected, false);
  const rotatedFiles = runLunaLogRotate({ dryRun: true }).results.map((item) => item.filePath);
  assert.ok(rotatedFiles.includes('/Users/alexlee/.ai-agent-system/logs/luna-jaenong-collector.log'));
  assert.ok(rotatedFiles.includes('/Users/alexlee/.ai-agent-system/logs/luna-jaenong-collector-error.log'));
  await assert.rejects(
    runJaenongDailyShadow({ stage: 'collect', write: true }, {
      collectFn: async () => ({ status: 'ok' }),
      parseFn: async () => [],
    }),
    /jaenong_daily_write_confirmation_required/,
  );

  const dailyWrites = [];
  const briefRun = await runJaenongDailyShadow({
    stage: 'brief',
    write: true,
    confirm: JAENONG_DAILY_WRITE_CONFIRM,
    now,
  }, {
    queryFn: async (sql) => {
      if (/jaenong_post_scores/.test(sql)) return [{
        source_post_id: 'post-1',
        published_at: '2026-07-16T08:00:00.000Z',
        parsed_at: '2026-07-16T08:05:00.000Z',
        brief: { marketView: '조정 기회', candidates: [{ ticker: 'MSFT', available: true }] },
      }];
      if (/jaenong_reference_snapshot/.test(sql)) return [{ snapshot_hash: snapshot.snapshotHash }];
      return [{ brief_ref: null, latest_event_type: null }];
    },
    runFn: async (sql, params) => {
      dailyWrites.push({ sql, params });
      return { rowCount: 1 };
    },
  });
  assert.equal(briefRun.mode, 'shadow_write');
  assert.equal(briefRun.brief.state, 'awaiting_ack');
  assert.equal(dailyWrites.some((write) => /INSERT INTO investment\.jaenong_brief/.test(write.sql)), true);
  assert.equal(dailyWrites.every((write) => !/trade_journal|order/i.test(write.sql)), true);

  const staleWrites = [];
  const staleRun = await runJaenongDailyShadow({
    stage: 'brief',
    write: true,
    confirm: JAENONG_DAILY_WRITE_CONFIRM,
    now: '2026-07-18T12:00:00.001Z',
    env: {},
  }, {
    queryFn: async (sql) => {
      if (/jaenong_post_scores/.test(sql)) return [{
        ...freshnessBoundaryRow,
        parsed_at: '2026-07-18T12:00:00.000Z',
      }];
      if (/jaenong_reference_snapshot/.test(sql)) return [];
      return [{ brief_ref: null, latest_event_type: null }];
    },
    runFn: async (sql, params) => {
      staleWrites.push({ sql, params });
      return { rowCount: 1 };
    },
  });
  const staleUpsert = staleWrites.find((write) => /INSERT INTO investment\.jaenong_brief/.test(write.sql));
  assert.equal(staleRun.state, 'stale');
  assert.equal(staleRun.brief.state, 'stale');
  assert.match(staleUpsert.sql, /expires_at = LEAST/);
  assert.match(
    staleUpsert.sql,
    /invalidated_at IS NOT NULL THEN 'invalid'\s+WHEN EXCLUDED\.state = 'stale'/,
  );
  assert.equal(staleUpsert.params[10], 'stale');

  const topVolume = [
    { symbol: 'TSLA', quoteVolume: 1000, rank: 1 },
    { symbol: 'NVDA', quoteVolume: 900, rank: 2 },
  ];
  const topVolumeJson = JSON.stringify(topVolume);
  const pullbackCandidates = [
    { symbol: 'AAPL', drawdownPct: -10, currentPrice: 190 },
    { symbol: 'MSFT', drawdownPct: -20, currentPrice: 400 },
  ];
  const route = buildJaenongPriorityRoute({
    signalRef: 'J3-route-1',
    createdAt: now,
    pullbackScore: { available: true, total: 2 },
    pullbackCandidates,
    topVolumeCandidates: topVolume,
    referenceSnapshot: {
      snapshotHash: snapshot.snapshotHash,
      interest: [
        { symbol: 'MSFT', drawdownZone: 'deep' },
        { symbol: 'AAPL', drawdownZone: 'watch' },
      ],
    },
    brief,
    briefState: active,
    c17: {
      'c17.jaenong.capital_budget_ratio': 0.4,
      'c17.jaenong.averaging_max_count': 2,
      'c17.jaenong.track_mdd_circuit_pct': -12,
      'c17.jaenong.zone_stop_loss_alpha': 0.5,
    },
  });
  assert.equal(route.selectedTrack, 'pullback');
  assert.equal(route.priority, 1);
  assert.equal(route.treatment.score, 3);
  assert.equal(route.control.score, 2);
  assert.equal(route.control.briefApplied, false);
  assert.equal(route.treatment.candidates[0].symbol, 'MSFT');
  assert.equal(route.treatment.candidates[0].referenceDrawdownZone, 'deep');
  assert.equal(route.risk.consumed, true);
  assert.equal(route.risk.capitalBudgetRatio, 0.4);
  assert.equal(route.executionConnected, false);
  assert.equal(route.orderPath, null);

  const fallback = buildJaenongPriorityRoute({
    signalRef: 'J3-route-fallback',
    createdAt: now,
    pullbackScore: { available: false, total: null },
    pullbackCandidates: [],
    topVolumeCandidates: topVolume,
  });
  assert.equal(fallback.selectedTrack, 'top-volume');
  assert.equal(fallback.priority, 2);
  assert.equal(JSON.stringify(fallback.selectedCandidates), topVolumeJson, 'top-volume fallback must be bit-for-bit');
  assert.equal(JSON.stringify(topVolume), topVolumeJson, 'router must not mutate top-volume input');

  let routeWrite = null;
  const routeRecorded = await recordJaenongRouteShadow(route, async (sql, params) => {
    routeWrite = { sql, params };
    return { rowCount: 1 };
  });
  assert.equal(routeRecorded.recorded, true);
  assert.match(routeWrite.sql, /jaenong_route_shadow/);
  assert.doesNotMatch(routeWrite.sql, /trade_journal|orders?|execution_time/i);
  let routeRuntimeWrites = 0;
  const routeRuntimeDry = await runJaenongRouteShadow({ fixture: true, now });
  assert.equal(routeRuntimeDry.mode, 'dry_run');
  assert.equal(routeRuntimeDry.route.executionConnected, false);
  await assert.rejects(
    runJaenongRouteShadow({ fixture: true, write: true, now }),
    /jaenong_route_write_confirmation_required/,
  );
  const routeRuntimeWrite = await runJaenongRouteShadow({
    fixture: true,
    write: true,
    confirm: JAENONG_ROUTE_WRITE_CONFIRM,
    now,
  }, {
    runFn: async () => {
      routeRuntimeWrites += 1;
      return { rowCount: 1 };
    },
  });
  assert.equal(routeRuntimeWrite.recorded.recorded, true);
  assert.equal(routeRuntimeWrites, 1);
  let absentRouteWrites = 0;
  const absentRouteRuntime = await runJaenongRouteShadow({
    write: true,
    confirm: JAENONG_ROUTE_WRITE_CONFIRM,
    now,
  }, {
    queryFn: async () => [],
    runFn: async (sql) => {
      absentRouteWrites += 1;
      assert.match(sql, /investment\.jaenong_route_shadow/);
      assert.doesNotMatch(sql, /trade_journal|orders?|execution_time/i);
      return { rowCount: 1 };
    },
  });
  assert.equal(absentRouteRuntime.inputs.briefState, 'absent');
  assert.equal(absentRouteRuntime.route.briefRef, null);
  assert.equal(absentRouteRuntime.route.shadowOnly, true);
  assert.equal(absentRouteRuntime.route.executionConnected, false);
  assert.equal(absentRouteRuntime.recorded.recorded, true);
  assert.equal(absentRouteWrites, 1);

  const preflight = jaenongBriefPreflight({ brief, state: active, now });
  assert.equal(preflight.ok, true);
  assert.equal(preflight.advisoryOnly, true);
  assert.equal(preflight.liveMutation, false);
  assert.equal(preflight.checks.find((check) => check.name === 'ack').ok, true);
  const blockedPreflight = jaenongBriefPreflight({ brief, state: awaitingAck, now });
  assert.equal(blockedPreflight.ok, false);
  assert.equal(blockedPreflight.reason, 'jaenong_brief_preflight_incomplete');

  const attributed = attachJaenongAttribution({ planId: 'plan-1' }, route);
  assert.equal(attributed.attribution.briefRef, brief.briefRef);
  assert.equal(attributed.attribution.trackTag, 'jaenong:pullback:treatment');
  assert.equal(attributed.executionConnected, false);
  const invalidated = invalidateJaenongBriefState(brief, {
    now,
    reason: 'master invalidation smoke',
  });
  assert.equal(invalidated.state, 'invalid');
  assert.equal(invalidated.invalidReason, 'master invalidation smoke');
  assert.equal(brief.invalidatedAt, undefined, 'invalidation must not mutate source brief');

  const skillNames = loadInvestmentSkills()
    .filter((skill) => skill.owner === 'luna')
    .map((skill) => skill.name);
  for (const name of ['jaenong.brief.today', 'jaenong.retro.score', 'jaenong.brief.invalidate']) {
    assert.ok(skillNames.includes(name), `${name} must be registered`);
  }
  const skillToday = await executeInvestmentSkill('luna', 'jaenong.brief.today', { fixture: true }, {});
  assert.equal(skillToday.ok, true);
  assert.equal(skillToday.code, 'skill_executed');
  assert.equal(skillToday.result.state.status, 'active');
  let skillInvalidationSql = '';
  const skillInvalidation = await executeInvestmentSkill('luna', 'jaenong.brief.invalidate', {
    briefRef: brief.briefRef,
    reason: 'skill invalidation smoke',
  }, {
    actor: 'master',
    runFn: async (sql) => {
      skillInvalidationSql = sql;
      return { rowCount: 1 };
    },
  });
  assert.equal(skillInvalidation.ok, true);
  assert.match(skillInvalidationSql, /investment\.jaenong_brief/);
  assert.doesNotMatch(skillInvalidationSql, /trade_journal|orders?/i);
  const retro = await getJaenongRetroSummary({ fixture: true });
  assert.equal(retro.mode, 'read_only_fixture');
  assert.equal(retro.mutationAllowed, false);

  const mcpToolNames = LUNA_OPS_MCP_TOOLS.map((tool) => tool.name);
  assert.ok(mcpToolNames.includes('jaenong_brief_status'));
  assert.ok(mcpToolNames.includes('jaenong_retro_summary'));
  const mcpBrief = await callLunaOpsTool('jaenong_brief_status', { fixture: true });
  const mcpRetro = await callLunaOpsTool('jaenong_retro_summary', { fixture: true });
  assert.equal(mcpBrief.mode, 'read_only_fixture');
  assert.equal(mcpRetro.mode, 'read_only_fixture');
  assert.equal(mcpBrief.mutationAllowed, false);
  assert.equal(mcpRetro.mutationAllowed, false);
  const legacyMcpRegression = await runLunaOpsMcpSmoke();
  assert.equal(legacyMcpRegression.ok, true);
  assert.ok(legacyMcpRegression.tools.includes('luna_status'));
  assert.equal(legacyMcpRegression.phase5Plan.liveMutation, false);

  const predictionOff = buildLunaJaenongPredictionFeedInput(route, { enabled: false });
  assert.equal(predictionOff.enabled, false);
  assert.equal(predictionOff.record, null);
  const predictionOn = buildLunaJaenongPredictionFeedInput(route, {
    enabled: true,
    marketView: brief.marketView,
  });
  assert.equal(predictionOn.enabled, true);
  assert.equal(predictionOn.record.sourceKind, 'luna_jaenong_shadow');
  assert.equal(predictionOn.record.payload.libraryCoords.prediction_state, 'forward');
  assert.equal(predictionOn.record.payload.entryPlan.shadowOnly, true);
  assert.equal(predictionOn.record.payload.exitPlan.executionConnected, false);
  assert.equal(predictionOn.record.constitutionAllowed, true);
  const predictionBlocked = buildLunaJaenongPredictionFeedInput(route, {
    enabled: true,
    marketView: 'account token must never leave the hygiene gate',
  });
  assert.equal(predictionBlocked.enabled, false);
  assert.equal(predictionBlocked.reason, 'jaenong_prediction_hygiene_blocked');

  assert.throws(
    () => evaluateJaenongBriefState({ now: '2026-02-30T21:00:00+09:00' }),
    /jaenong_state_now_invalid/,
  );
  const kstState = evaluateJaenongBriefState({
    now: '2026-07-16T21:00:00+09:00',
    brief,
    ack: { briefRef: brief.briefRef, acknowledgedAt: '2026-07-16T19:00:00+09:00' },
  });
  assert.equal(kstState.status, 'active');
  assert.equal(evaluateJaenongBriefState({
    now,
    brief: { ...brief, publishedAt: '2026-07-17T12:00:00.000Z' },
  }).reason, 'brief_from_future');

  const boundaryChecks = {
    referenceSnapshot: snapshot.rawWorkbookIncluded === false && snapshot.snapshotHash.length === 64,
    c17ProposalOnly: snapshot.c17Proposal.autoApply === false,
    parseFailureVsAbsence: evaluateJaenongBriefState({ now }).status !== evaluateJaenongBriefState({
      now,
      parseStatus: 'failed',
    }).status,
    freshnessAndAck: active.status === 'active' && awaitingAck.status === 'awaiting_ack',
    cadenceWriteGate: collectPlan.write === false && briefRun.mode === 'shadow_write',
    routerAndControl: route.treatment.score !== route.control.score && fallback.priority === 2,
    hooksSkillsMcp: preflight.liveMutation === false && skillToday.ok && mcpBrief.mutationAllowed === false,
    sigmaDefaultOffAndHygiene: predictionOff.record === null && predictionBlocked.record === null,
    dateTimeContract: kstState.status === 'active',
  };
  assert.equal(Object.keys(boundaryChecks).length, 9);
  assert.equal(Object.values(boundaryChecks).every(Boolean), true);

  console.log(JSON.stringify({
    ok: true,
    smoke: 'luna-jaenong-j3',
    boundaries: boundaryChecks,
    snapshot: {
      revision: snapshot.revision,
      barometerRows: snapshot.barometer.length,
      interestRows: snapshot.interest.length,
      quoteFallbacks: quoteCalls.length,
    },
  }, null, 2));
  process.exitCode = 0;
}

main().catch((error) => {
  console.error('luna-jaenong-j3-smoke failed:', error);
  process.exitCode = 1;
});
