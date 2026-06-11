#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { LUNA_COMPONENT_REGISTRY_SEED, seedLunaComponentRegistry } from './luna-registry-seed.ts';
import { buildMeetingPlanNote, buildMarketSegments } from '../services/meeting-room/server/adapters/stack-adapter.ts';
import { runMeetingSession } from '../services/meeting-room/server/orchestrator/meeting-session.ts';

const INVESTMENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(INVESTMENT_ROOT, '../..');
const MIGRATION_PATH = path.join(INVESTMENT_ROOT, 'migrations', '20260611000004_luna_meeting_room.sql');
const SMOKE_OUTPUT_DIR = path.join(INVESTMENT_ROOT, 'output', 'meeting-room');
const ROLLBACK_SENTINEL = 'luna_meeting_room_smoke_rollback';

function outputPath(name: string) {
  fs.mkdirSync(SMOKE_OUTPUT_DIR, { recursive: true });
  return path.join(SMOKE_OUTPUT_DIR, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.md`);
}

function fixturePlanNote() {
  return {
    ok: true,
    type: 'morning',
    generatedAt: '2026-06-11T00:00:00.000Z',
    segments: [
      { market: 'domestic', label: '국내 장전 계획', active: true, skipped: false, reason: 'market_open' },
      { market: 'overseas', label: '미국 장후 평가', active: false, skipped: true, reason: 'weekend' },
      { market: 'crypto', label: 'crypto 24h 점검', active: true, skipped: false, reason: 'crypto_24h' },
    ],
    gates: [
      { market: 'domestic', score: 55, deployment: 'reduced', signals: { effectiveDeployment: 'reduced' } },
      { market: 'overseas', score: 72, deployment: 'full', signals: { effectiveDeployment: 'full' } },
      { market: 'crypto', score: 44, deployment: 'reduced', signals: { effectiveDeployment: 'reduced' } },
    ],
    regimes: [
      { market: 'domestic', current_regime: 'bull', probabilities: { bull: 0.62 }, source: 'hmm' },
      { market: 'overseas', current_regime: 'sideways', probabilities: { sideways: 0.55 }, source: 'fallback' },
      { market: 'crypto', current_regime: 'volatile', probabilities: { volatile: 0.66 }, source: 'hmm', transitionAlert: { type: 'dominant_changed' } },
    ],
    strategySignals: [
      { id: 1, market: 'crypto', symbol: 'BTC/USDT', family: 'turtle', signal_type: 'entry', rr: 2.1, regime: { dominant: 'volatile' } },
      { id: 2, market: 'domestic', symbol: '005930', family: 'testah', signal_type: 'entry', rr: 2.4, regime: { dominant: 'bull' } },
    ],
    circuitLocks: [
      { market: 'crypto', symbol: 'BTC/USDT', side: 'long', level: 'symbol', circuit: 'stoploss_guard', reason: '4_stoploss_like_events' },
    ],
    pendingDecisions: [
      { type: 'stalled_report', component: 'market-deployment-gate', status: 'stalled', sampleCount: 0 },
    ],
    positions: [{ symbol: 'BTC/USDT', exchange: 'binance', amount: 0.1 }],
    calibration: [{ market: 'crypto', label: 'volatile', brier_hmm: 0.12, brier_fallback: 0.19 }],
    readOnly: true,
    shadowOnly: true,
    briefMarkdown: [
      '# Luna 회의 plan-note (morning)',
      '- G0 게이트: domestic:reduced(55) · overseas:full(72) · crypto:reduced(44)',
      '- C2 레짐: domestic:bull(0.62) · overseas:sideways(0.55) · crypto:volatile(0.66)',
      '- 전략군 24h: 2건(entry 2)',
    ].join('\n'),
  };
}

async function mockQuery(sql: string) {
  if (sql.includes('luna_market_gate_history')) {
    return fixturePlanNote().gates.map((row) => ({ ...row, computed_at: new Date().toISOString() }));
  }
  if (sql.includes('hmm_regime_log')) {
    return fixturePlanNote().regimes.map((row) => ({
      market: row.market,
      current_regime: row.current_regime,
      regime_probabilities: row.probabilities,
      confidence: 0.7,
      source: row.source,
      transition_alert: row.transitionAlert || null,
      created_at: new Date().toISOString(),
    }));
  }
  if (sql.includes('luna_strategy_signals')) return fixturePlanNote().strategySignals;
  if (sql.includes('luna_circuit_locks')) return fixturePlanNote().circuitLocks;
  if (sql.includes('luna_component_registry')) return fixturePlanNote().pendingDecisions.map((row) => ({
    component: row.component,
    status: 'stalled',
    sample_count: row.sampleCount,
    promotion_criteria: { placeholder: true },
    registered_at: new Date().toISOString(),
  }));
  if (sql.includes('positions')) return fixturePlanNote().positions;
  if (sql.includes('luna_regime_calibration')) return fixturePlanNote().calibration;
  return [];
}

function splitSqlStatements(sql: string) {
  return sql
    .replace(/^\s*--.*$/gm, '')
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => `${statement};`);
}

async function loadMeetingRoomMigration(runFn: any) {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  for (const statement of splitSqlStatements(sql)) {
    await runFn(statement);
  }
}

async function withRollback(work: any) {
  let output;
  try {
    await db.withTransaction(async (tx: any) => {
      await loadMeetingRoomMigration(tx.run);
      output = await work(tx);
      throw new Error(ROLLBACK_SENTINEL);
    });
  } catch (error) {
    if (error?.message !== ROLLBACK_SENTINEL) throw error;
    return output;
  }
  throw new Error('expected rollback sentinel');
}

async function countMeetingRows(queryFn: any) {
  const sessions = await queryFn(`SELECT COUNT(*)::int AS count FROM luna_meeting_sessions`);
  const minutes = await queryFn(`SELECT COUNT(*)::int AS count FROM luna_meeting_minutes`);
  const decisions = await queryFn(`SELECT COUNT(*)::int AS count FROM luna_meeting_decisions`);
  return {
    sessions: Number(sessions?.[0]?.count || 0),
    minutes: Number(minutes?.[0]?.count || 0),
    decisions: Number(decisions?.[0]?.count || 0),
  };
}

async function main() {
  const plan = await buildMeetingPlanNote({
    type: 'morning',
    now: '2026-06-11T00:00:00.000Z',
    queryFn: mockQuery,
    proposalPath: path.join(REPO_ROOT, 'missing-proposals.json'),
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.segments.length, 3);
  assert.equal(plan.gates.length, 3);
  assert.equal(plan.regimes.length, 3);
  assert.equal(plan.strategySignals.length, 2);
  assert.ok(plan.briefMarkdown.includes('G0 게이트'));

  const weekendSegments = buildMarketSegments(new Date('2026-06-13T18:00:00.000Z'));
  assert.equal(weekendSegments.find((row) => row.market === 'domestic')?.skipped, true);
  assert.equal(weekendSegments.find((row) => row.market === 'overseas')?.skipped, true);
  assert.equal(weekendSegments.find((row) => row.market === 'crypto')?.active, true);

  const noLlmResult = await runMeetingSession({
    type: 'morning',
    dryRun: true,
    noLlm: true,
    planNote: fixturePlanNote(),
    forceInsufficientGrill: true,
    outputPath: outputPath('smoke-no-llm'),
  });
  assert.equal(noLlmResult.ok, true);
  assert.equal(noLlmResult.llmCalls, 0);
  assert.ok(noLlmResult.markdownPath.endsWith('.md'));
  assert.deepEqual(noLlmResult.minutes.map((row) => row.seq), noLlmResult.minutes.map((_, index) => index + 1));
  assert.equal(noLlmResult.minutes.filter((row) => row.role === 'grill').length, noLlmResult.agendas.length);
  assert.ok(noLlmResult.decisions.every((row) => row.grade === 'c_master' && row.status === 'pending_master' && row.dueAt));

  const dryRunNoWriteLlm = await runMeetingSession({
    type: 'morning',
    dryRun: true,
    noLlm: false,
    planNote: fixturePlanNote(),
    outputPath: outputPath('smoke-dry-run-llm-disabled'),
  });
  assert.equal(dryRunNoWriteLlm.llmCalls, 0);
  assert.ok(dryRunNoWriteLlm.minutes.some((row) => row.meta?.reason === 'dry_run_llm_disabled'));

  const llmFailureResult = await runMeetingSession({
    type: 'morning',
    dryRun: true,
    noLlm: false,
    planNote: fixturePlanNote(),
    outputPath: outputPath('smoke-llm-fail-open'),
  }, {
    callViaHub: async () => {
      throw new Error('fixture_llm_down');
    },
  });
  assert.equal(llmFailureResult.ok, true);
  assert.ok(llmFailureResult.skippedLlmCalls > 0);

  const costGuardResult = await runMeetingSession({
    type: 'morning',
    dryRun: true,
    noLlm: false,
    planNote: fixturePlanNote(),
    config: { maxLlmCallsPerMeeting: 1, analysisAgents: ['sophia', 'aria'] },
    outputPath: outputPath('smoke-cost-guard'),
  }, {
    callViaHub: async () => ({ ok: true, text: 'fixture analysis', provider: 'fixture' }),
  });
  assert.equal(costGuardResult.llmCalls, 1);
  assert.ok(costGuardResult.minutes.some((row) => row.role === 'system' && String(row.content).includes('cost_guard_skipped')));

  const dryRunRows = await withRollback(async (tx: any) => {
    const before = await countMeetingRows(tx.query);
    await runMeetingSession({
      type: 'morning',
      dryRun: true,
      noLlm: true,
      planNote: fixturePlanNote(),
      outputPath: outputPath('smoke-dry-run-rollback'),
    }, { queryFn: tx.query, runFn: tx.run });
    const after = await countMeetingRows(tx.query);
    assert.deepEqual(after, before);

    const applied = await runMeetingSession({
      type: 'morning',
      dryRun: false,
      apply: true,
      noLlm: true,
      planNote: fixturePlanNote(),
      outputPath: outputPath('smoke-apply-rollback'),
    }, { queryFn: tx.query, runFn: tx.run });
    const appliedRows = await countMeetingRows(tx.query);
    assert.equal(Number(applied.session.id) > 0, true);
    assert.equal(appliedRows.sessions, before.sessions + 1);
    assert.ok(appliedRows.minutes > before.minutes);
    assert.ok(appliedRows.decisions > before.decisions);
    return { before, after, appliedRows };
  });

  assert.equal(LUNA_COMPONENT_REGISTRY_SEED.length, 31);
  const seedDryRun = await seedLunaComponentRegistry({ dryRun: true });
  assert.equal(seedDryRun.seeded, 31);
  assert.ok(seedDryRun.components.includes('meeting-room-orchestrator'));

  return {
    ok: true,
    smoke: 'luna-meeting-room',
    scenarios: {
      planNote: true,
      marketSkip: true,
      fsmMinutes: noLlmResult.minutes.length,
      grillQuestions: noLlmResult.minutes.filter((row) => row.role === 'grill').length,
      cMasterDowngrade: noLlmResult.decisions.length,
      noLlmComplete: true,
      llmFailOpen: true,
      dryRunDbRows: dryRunRows.after,
      applyRollbackRows: dryRunRows.appliedRows,
      registrySeedCount: seedDryRun.seeded,
      costGuard: true,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ luna-meeting-room-smoke 실패:',
  });
}

export { main as runLunaMeetingRoomSmoke };
