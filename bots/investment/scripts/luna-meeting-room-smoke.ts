#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { loadInvestmentSkills } from '../shared/skill-registry.ts';
import { LUNA_COMPONENT_REGISTRY_SEED, seedLunaComponentRegistry } from './luna-registry-seed.ts';
import { parseMeetingRoomCliArgs } from './runtime-luna-meeting-room.ts';
import { buildMeetingPlanNote, buildMarketSegments } from '../services/meeting-room/server/adapters/stack-adapter.ts';
import {
  buildMeetingAgendasForType,
  buildMeetingDecisionInlineKeyboard,
  runMeetingSession,
} from '../services/meeting-room/server/orchestrator/meeting-session.ts';
import { applyMeetingDecisionAction } from '../services/meeting-room/server/meeting-decision-actions.ts';
import {
  regenerateMeetingMinutesMarkdown,
  writeMeetingMinutesMarkdown,
} from '../services/meeting-room/server/minutes.ts';

const INVESTMENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(INVESTMENT_ROOT, '../..');
const MIGRATION_PATH = path.join(INVESTMENT_ROOT, 'migrations', '20260611000004_luna_meeting_room.sql');
const SMOKE_OUTPUT_DIR = path.join(INVESTMENT_ROOT, 'output', 'meeting-room');
const ROLLBACK_SENTINEL = 'luna_meeting_room_smoke_rollback';

function outputPath(name: string) {
  fs.mkdirSync(SMOKE_OUTPUT_DIR, { recursive: true });
  return path.join(SMOKE_OUTPUT_DIR, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.md`);
}

function tempOutputDir(name: string) {
  const dir = path.join(SMOKE_OUTPUT_DIR, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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
      { market: 'crypto', symbol: 'ETH/USDT', side: 'long', level: 'symbol', circuit: 'low_profit_symbol', reason: 'cumulative_r_below_zero', lock_until: '2026-06-12T00:00:00.000Z' },
      { market: 'crypto', symbol: 'ETH/USDT', side: 'long', level: 'symbol', circuit: 'low_profit_symbol', reason: 'cumulative_r_below_zero', lock_until: '2026-06-12T00:00:00.000Z' },
      { market: 'crypto', symbol: 'ETH/USDT', side: 'long', level: 'symbol', circuit: 'low_profit_symbol', reason: 'cumulative_r_below_zero', lock_until: '2026-06-12T00:00:00.000Z' },
      { market: 'crypto', symbol: 'SOL/USDT', side: 'long', level: 'symbol', circuit: 'symbol_cooldown', reason: 'symbol_cooldown_candles', lock_until: '2026-06-11T12:00:00.000Z' },
    ],
    pendingDecisions: [
      {
        type: 'stalled_report',
        component: 'market-deployment-gate',
        status: 'stalled',
        currentMode: 'shadow',
        targetMode: 'supervised_l4',
        sampleCount: 0,
        criteria: { metrics: ['brier_hmm_lt_fallback'], placeholder: true, durationWeeks: 4 },
        recommendation: 'review_or_refine_shadow_design',
      },
    ],
    positions: [{ symbol: 'BTC/USDT', exchange: 'binance', amount: 0.1 }],
    calibration: [{ market: 'crypto', label: 'volatile', brier_hmm: 0.12, brier_fallback: 0.19 }],
    debrief: {
      dateKst: '2026-06-11',
      morningSession: { id: 1, summary: 'morning fixture' },
      degraded: false,
      strategySignals: [
        { id: 1, market: 'domestic', symbol: '005930', family: 'testah', signal_type: 'entry' },
        { id: 2, market: 'domestic', symbol: '000660', family: 'turtle', signal_type: 'entry' },
      ],
      preflights: [{ strategy_signal_id: 1, decision: 'pass' }],
      activeCircuits: [],
      gateTransitions: [{ market: 'domestic', samples: 3, deployment_states: 2, deployments: ['reduced', 'full'] }],
      regimeTransitions: [{ market: 'domestic', samples: 3, regime_states: 1, regimes: ['bull'] }],
      kisTrades: [{ symbol: '005930', pnl_percent: 1.2 }],
      unspokenEntries: [{ id: 2, symbol: '000660', family: 'turtle', reason: 'shadow_stage_virtual_tracking' }],
      errors: [],
    },
    weekly: {
      asOfKst: '2026-06-11',
      signals: [{ market: 'crypto', family: 'turtle', signal_type: 'entry', count: 4 }],
      preflight: [{ market: 'crypto', decision: 'pass', count: 2 }],
      circuit: [{ market: 'crypto', level: 'symbol', circuit: 'stoploss_guard', locked: true, count: 1 }],
      brier: [{ market: 'crypto', samples: 3, avg_brier_hmm: 0.12 }],
      registry: [{ status: 'stalled', count: 2 }],
      adr: [{ status: 'pending_master', count: 3 }],
      overdueAdr: [{ id: 99, agenda_key: 'weekly:test', due_at: '2026-06-10T00:00:00Z' }],
      errors: [],
    },
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
  const cliEquals = parseMeetingRoomCliArgs(['node', 'runtime', '--type=weekly', '--chair=master', '--output=/tmp/luna-weekly.md', '--apply']);
  const cliSpace = parseMeetingRoomCliArgs(['node', 'runtime', '--type', 'weekly', '--chair', 'master', '--output', '/tmp/luna-weekly.md', '--apply']);
  assert.deepEqual(cliSpace, cliEquals);
  assert.throws(
    () => parseMeetingRoomCliArgs(['node', 'runtime', '--type', 'bad_type']),
    /invalid meeting --type=bad_type/,
  );

  const filePolicyDir = tempOutputDir('smoke-file-policy');
  const officialPath = path.join(filePolicyDir, '2026-06-11-morning.md');
  fs.writeFileSync(officialPath, 'official meeting minutes\n');
  const filePolicyResult = {
    ok: true,
    type: 'morning',
    dryRun: true,
    startedAt: '2026-06-11T00:00:00.000Z',
    session: { id: 'dry-run', type: 'morning', status: 'closed', chair: 'luna', startedAt: '2026-06-11T00:00:00.000Z' },
    planNote: { briefMarkdown: 'fixture' },
    minutes: [],
    decisions: [],
    llmCalls: 0,
    skippedLlmCalls: 0,
  };
  const dryRunWritten = await writeMeetingMinutesMarkdown(filePolicyResult, null, { outputDir: filePolicyDir });
  assert.equal(path.basename(dryRunWritten.path), '2026-06-11-morning-dryrun.md');
  assert.equal(fs.readFileSync(officialPath, 'utf8'), 'official meeting minutes\n');
  const applyWrittenR2 = await writeMeetingMinutesMarkdown({ ...filePolicyResult, dryRun: false, apply: true }, null, { outputDir: filePolicyDir });
  const applyWrittenR3 = await writeMeetingMinutesMarkdown({ ...filePolicyResult, dryRun: false, apply: true }, null, { outputDir: filePolicyDir });
  assert.equal(path.basename(applyWrittenR2.path), '2026-06-11-morning-r2.md');
  assert.equal(path.basename(applyWrittenR3.path), '2026-06-11-morning-r3.md');

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
  assert.equal(plan.circuitLocks.length, 3);
  assert.ok(plan.briefMarkdown.includes('G0 게이트'));
  assert.ok(plan.briefMarkdown.includes('활성 서킷: 3건'));

  const weekendSegments = buildMarketSegments(new Date('2026-06-13T18:00:00.000Z'));
  assert.equal(weekendSegments.find((row) => row.market === 'domestic')?.skipped, true);
  assert.equal(weekendSegments.find((row) => row.market === 'overseas')?.skipped, true);
  assert.equal(weekendSegments.find((row) => row.market === 'crypto')?.active, true);

  const weekendPlanNote = { ...fixturePlanNote(), segments: weekendSegments };
  const weekendMorningResult = await runMeetingSession({
    type: 'morning',
    dryRun: true,
    noLlm: true,
    planNote: weekendPlanNote,
    outputPath: outputPath('smoke-weekend-morning'),
  });
  const weekendMarketData = Object.fromEntries(
    weekendMorningResult.minutes
      .filter((row) => row.role === 'data' && String(row.agendaKey || '').startsWith('market:'))
      .map((row) => [row.agendaKey, row.content]),
  );
  assert.ok(weekendMarketData['market:domestic'].includes('스킵(weekend)'));
  assert.ok(weekendMarketData['market:overseas'].includes('스킵(weekend)'));
  assert.ok(weekendMarketData['market:crypto'].includes('진행'));
  assert.equal(weekendMorningResult.decisions.filter((row) => String(row.agendaKey || '').startsWith('market:crypto')).length, 1);

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
  const pendingDataMinute = noLlmResult.minutes.find((row) => row.role === 'data' && row.agendaKey === 'decision:market-deployment-gate');
  assert.ok(pendingDataMinute);
  assert.equal(/[{}]/.test(pendingDataMinute.content), false);
  assert.ok(pendingDataMinute.content.includes('컴포넌트=C1 시장 배치 게이트'));
  assert.ok(pendingDataMinute.content.includes('표본=0건'));
  assert.ok(pendingDataMinute.content.includes('Brier: HMM이 폴백보다 낮음'));
  assert.equal(pendingDataMinute.content.includes('컴포넌트=market-deployment-gate'), false);
  assert.equal(pendingDataMinute.content.includes('Brier: HMM<폴백'), false);
  assert.equal(pendingDataMinute.meta?.evidence?.component, 'market-deployment-gate');
  const circuitDataMinute = noLlmResult.minutes.find((row) => row.role === 'data' && row.agendaKey === 'alerts:circuit-locks');
  assert.ok(circuitDataMinute);
  assert.equal(/[{}]/.test(circuitDataMinute.content), false);
  assert.ok(circuitDataMinute.content.includes('활성 잠금 3건(저수익 1·쿨다운 1)'));
  assert.ok(circuitDataMinute.content.includes('저수익 심볼 ETH/USDT'));
  assert.equal(Array.isArray(circuitDataMinute.meta?.evidence), true);
  assert.equal(circuitDataMinute.meta?.evidence?.length, 5);
  const pendingDecision = noLlmResult.decisions.find((row) => row.agendaKey === 'decision:market-deployment-gate');
  assert.equal(pendingDecision?.evidence?.evidenceExcerpt?.component, 'market-deployment-gate');

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

  const debriefResult = await runMeetingSession({
    type: 'domestic_debrief',
    dryRun: true,
    noLlm: true,
    planNote: { ...fixturePlanNote(), type: 'domestic_debrief' },
    outputPath: outputPath('smoke-debrief'),
  });
  assert.equal(debriefResult.ok, true);
  assert.equal(debriefResult.agendas[0].kind, 'domestic_debrief');
  assert.ok(debriefResult.minutes.some((row) => row.role === 'data' && String(row.content).includes('G6 대조표')));
  assert.ok(debriefResult.minutes.some((row) => String(row.content).includes('미발화 행=1')));

  const degradedDebrief = await runMeetingSession({
    type: 'domestic_debrief',
    dryRun: true,
    noLlm: true,
    planNote: {
      ...fixturePlanNote(),
      type: 'domestic_debrief',
      debrief: { degraded: true, degradeReason: 'same_day_morning_session_missing', unspokenEntries: [] },
    },
    outputPath: outputPath('smoke-debrief-degraded'),
  });
  assert.ok(degradedDebrief.minutes.some((row) => String(row.content).includes('동일 날짜 아침 회의 없음')));
  assert.equal(degradedDebrief.minutes.some((row) => String(row.content).includes('same_day_morning_session_missing')), false);

  const premarketResult = await runMeetingSession({
    type: 'us_premarket',
    dryRun: true,
    noLlm: false,
    planNote: { ...fixturePlanNote(), type: 'us_premarket' },
    outputPath: outputPath('smoke-premarket'),
  }, {
    callViaHub: async () => ({ ok: true, text: 'fixture analysis', provider: 'fixture' }),
  });
  assert.equal(premarketResult.agendas.length <= 2, true);
  assert.equal(premarketResult.llmCalls <= 2, true);

  const weeklyResult = await runMeetingSession({
    type: 'weekly',
    dryRun: true,
    noLlm: true,
    planNote: { ...fixturePlanNote(), type: 'weekly' },
    outputPath: outputPath('smoke-weekly'),
  });
  assert.equal(weeklyResult.agendas[0].kind, 'weekly_review');
  assert.ok(weeklyResult.minutes.some((row) => String(row.content).includes('overdue=1')));

  const skillNames = loadInvestmentSkills().filter((skill) => skill.owner === 'luna').map((skill) => skill.name);
  assert.ok(skillNames.includes('grill-me'));
  assert.ok(skillNames.includes('grill-with-docs'));

  const injectedSkillResult = await runMeetingSession({
    type: 'morning',
    dryRun: true,
    noLlm: true,
    planNote: fixturePlanNote(),
    outputPath: outputPath('smoke-skill-grill'),
  }, {
    executeInvestmentSkill: async () => ({ ok: true, text: '1. 반대\n2. 무효화\n3. 질문\n4. 긴급성\n5. 과거 결과' }),
  });
  assert.equal(injectedSkillResult.minutes.some((row) => row.role === 'grill' && row.meta?.fallback === false), true);

  const keyboard = buildMeetingDecisionInlineKeyboard(Array.from({ length: 10 }, (_, index) => ({ id: index + 1 })));
  assert.equal(keyboard.length, 9);
  for (const row of keyboard) {
    for (const button of row) assert.equal(Buffer.byteLength(button.callback_data, 'utf8') <= 64, true);
  }

  const debriefAgendas = buildMeetingAgendasForType('domestic_debrief', { ...fixturePlanNote(), type: 'domestic_debrief' });
  assert.equal(debriefAgendas.length, 1);

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
    }, { queryFn: tx.query, runFn: tx.run, postAlarm: async () => ({ ok: true, fixture: true }) });
    const appliedRows = await countMeetingRows(tx.query);
    assert.equal(Number(applied.session.id) > 0, true);
    assert.equal(applied.telegram.attempted, true);
    assert.equal(applied.telegram.ok, true);
    assert.equal(appliedRows.sessions, before.sessions + 1);
    assert.ok(appliedRows.minutes > before.minutes);
    assert.ok(appliedRows.decisions > before.decisions);

    const decisionId = applied.decisions[0].id;
    const confirmed = await applyMeetingDecisionAction({
      id: decisionId,
      action: 'confirm',
      note: 'telegram fixture',
      changedVia: 'telegram',
      actor: { actorId: '123', actorUsername: 'master' },
      callback: { data: `luna_meeting:${decisionId}:confirm` },
    }, { withTransactionFn: async (fn: any) => fn(tx) });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.logicalStatus, 'confirmed');
    const idempotent = await applyMeetingDecisionAction({
      id: decisionId,
      action: 'confirm',
      changedVia: 'telegram',
    }, { withTransactionFn: async (fn: any) => fn(tx) });
    assert.equal(idempotent.idempotent, true);
    const auditRows = await tx.query(
      `SELECT content, meta FROM luna_meeting_minutes WHERE session_id = $1 AND meta->>'changed_via' = 'telegram'`,
      [applied.session.id],
    );
    assert.equal(auditRows.length >= 1, true);
    assert.ok(auditRows.some((row: any) => String(row.content).includes('결정 확정 처리 · 경로=텔레그램 · 메모=telegram fixture')));
    assert.equal(auditRows.some((row: any) => String(row.content).includes('meeting decision')), false);

    const regenerateDir = tempOutputDir('smoke-regenerate');
    const regenerated = await regenerateMeetingMinutesMarkdown(applied.session.id, {
      queryFn: tx.query,
      outputDir: regenerateDir,
    });
    const dbMinuteRows = await tx.query(
      `SELECT COUNT(*)::int AS count FROM luna_meeting_minutes WHERE session_id = $1`,
      [applied.session.id],
    );
    assert.equal(regenerated.ok, true);
    assert.equal(regenerated.minutes.length, Number(dbMinuteRows?.[0]?.count || 0));
    assert.equal(path.basename(regenerated.markdownPath), `${String(applied.startedAt).slice(0, 10)}-morning.md`);
    assert.ok(regenerated.markdown.includes(`session #${applied.session.id}`));
    assert.ok(regenerated.markdown.includes('## Minutes'));
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
      weekendLightweight: true,
      llmFailOpen: true,
      dryRunDbRows: dryRunRows.after,
      applyRollbackRows: dryRunRows.appliedRows,
      registrySeedCount: seedDryRun.seeded,
      costGuard: true,
      debrief: true,
      premarket: true,
      weekly: true,
      telegramDecisionAction: true,
      cliArgParsing: true,
      markdownFilePolicy: true,
      regenerateMarkdown: true,
      pendingDecisionDataBriefNoRawJson: true,
      circuitLockDataBriefSummary: true,
      circuitLockDistinctSummary: true,
      dataBriefRawEvidencePreserved: true,
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
