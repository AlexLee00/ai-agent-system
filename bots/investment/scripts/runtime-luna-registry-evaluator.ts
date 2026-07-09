#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from '../shared/db.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  LUNA_REGIME_CALIBRATION_CONFIRM,
  runLunaRegimeCalibration,
} from './runtime-luna-regime-calibration.ts';
import {
  LUNA_ALPHA_FACTOR_CONFIRM,
  runLunaAlphaFactor,
} from './runtime-luna-alpha-factor.ts';
import {
  LUNA_TOSS_PAPER_MIRROR_CONFIRM,
} from '../shared/luna-toss-paper-mirror.ts';
import {
  runRuntimeLunaTossPaperMirror,
} from './runtime-luna-toss-paper-mirror.ts';
import {
  persistUniverseSnapshot,
} from '../shared/luna-universe-snapshot.ts';
import {
  LUNA_SIGNAL_OUTCOME_CONFIRM,
  runLunaSignalOutcomeEval,
} from './runtime-luna-signal-outcome-eval.ts';
import {
  seedLunaComponentRegistry,
} from './luna-registry-seed.ts';

const INVESTMENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LUNA_REGISTRY_EVALUATOR_CONFIRM = 'luna-registry-evaluator-shadow';
export const DEFAULT_PROPOSAL_LIMIT = 2;
const SAMPLE_GATE_KEYS = Object.freeze(['minSamplesPerFamilyRegime', 'minSignalsPerFamily', 'minTrades', 'minSamples']);
const NOTIFY_TYPES = Object.freeze(['halt_proposal', 'stalled_report']);
const PERSISTABLE_STATUSES = Object.freeze(['active', 'stalled', 'proposed', 'promoted', 'halted']);

const SAMPLE_COUNT_SQL = Object.freeze({
  'phase-a-prediction-15min': `SELECT COUNT(*)::int AS count FROM luna_analysis_prediction_phase_a_logs`,
  'fundamental-quant': `SELECT COUNT(*)::int AS count FROM korea_public_data_shadow_signals WHERE strategy ILIKE '%fundamental%'`,
  'earnings-surprise': `SELECT COUNT(*)::int AS count FROM korea_public_data_shadow_signals WHERE strategy ILIKE '%earnings%'`,
  'disclosure-event': `SELECT COUNT(*)::int AS count FROM korea_public_data_shadow_signals WHERE strategy ILIKE '%disclosure%'`,
  'korean-factor-model-shadow': `SELECT COUNT(*)::int AS count FROM korean_factor_log`,
  'rl-policy-shadow': `SELECT COUNT(*)::int AS count FROM luna_guard_counterfactual WHERE guard_reason ILIKE '%rl%'`,
  'stat-arb-shadow': `SELECT COUNT(*)::int AS count FROM luna_signal_policy_shadow WHERE policy_key ILIKE '%stat%'`,
  'learned-regime-bias': `SELECT COUNT(*)::int AS count FROM luna_regime_weight_snapshots WHERE total_trades >= 3`,
  'position-lifecycle': `SELECT COUNT(*)::int AS count FROM position_lifecycle_events`,
  'posttrade-feedback': `SELECT COUNT(*)::int AS count FROM feedback_to_action_map`,
  'candidate-backtest-entry-gate': `SELECT COUNT(*)::int AS count FROM candidate_backtest_status`,
  'dsr-pbo-gate': `SELECT COUNT(*)::int AS count FROM candidate_backtest_status WHERE dsr IS NOT NULL OR pbo IS NOT NULL`,
  'robust-backtest-selection': `SELECT COUNT(*)::int AS count FROM candidate_backtest_status WHERE robust_selection_enabled IS TRUE OR selection_method IS NOT NULL`,
  'alpha-factor-discovery': `SELECT COUNT(*)::int AS count FROM luna_alpha_factors`,
  'universe-snapshot-accumulator': `SELECT COUNT(*)::int AS count FROM universe_snapshot`,
  'signal-outcome-feedback': `SELECT COUNT(*)::int AS count FROM luna_strategy_signal_outcomes`,
  'signal-outcome-eval-runner': `SELECT COUNT(*)::int AS count FROM luna_strategy_signal_outcomes`,
  'strategy-exit-shadow': `SELECT COUNT(*)::int AS count FROM luna_strategy_exit_shadow`,
  'regime-expansion-shadow-sim': `SELECT COUNT(*)::int AS count FROM luna_strategy_signals WHERE COALESCE((details->>'regimeExpansionGain')::boolean, false) IS TRUE`,
  // pattern-relaxation-shadow-sim currently has no durable gain rows; add a sample query only after relaxed gains are persisted.
  'market-deployment-gate': `SELECT COUNT(*)::int AS count FROM luna_market_gate_history`,
  'regime-engine-hmm': `SELECT COUNT(*)::int AS count FROM luna_regime_calibration`,
  'backtest-nextbar-execution': `SELECT COUNT(*)::int AS count FROM luna_nextbar_execution_shadow`,
  'meeting-room-orchestrator': `SELECT COUNT(*)::int AS count FROM luna_meeting_sessions WHERE status = 'closed'`,
  'vault-shadow-eval-adjustments': `SELECT COUNT(*)::int AS count FROM luna_vault_shadow_eval`,
  'meta-neural-reflexion': `SELECT COUNT(*)::int AS count FROM luna_failure_reflexions`,
});

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function listValue(value: any, fallback: string[] = []) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function toJson(value: any, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function ageDays(row: any, now = new Date()) {
  const registered = new Date(row.registered_at || row.registeredAt || now);
  const diff = now.getTime() - registered.getTime();
  return Math.max(0, diff / 86_400_000);
}

function componentNeedsStalledReport(row: any, now = new Date()) {
  const criteria = toJson(row.promotion_criteria || row.promotionCriteria, {});
  return criteria.placeholder === true && ageDays(row, now) >= 28;
}

function roundedAgeDays(row: any, now = new Date()) {
  return Math.round(ageDays(row, now) * 10) / 10;
}

function resolveSampleGateKey(criteria: any = {}) {
  return SAMPLE_GATE_KEYS.find((key) => Object.prototype.hasOwnProperty.call(criteria, key)) || null;
}

function normalizeRegistryStatus(status: any) {
  const raw = String(status || '').trim();
  return PERSISTABLE_STATUSES.includes(raw) ? raw : 'active';
}

function statusForProposal(row: any, proposal: any) {
  if (proposal?.type === 'halt_proposal') return 'halted';
  if (proposal?.type === 'stalled_report') return 'stalled';
  // CODEX-1 assessment states are derived JSON only. Do not persist
  // measurement_only/accumulating/evidence_pending into the constrained status column.
  const current = normalizeRegistryStatus(row.status);
  return current === 'stalled' ? 'active' : current;
}

function buildAssessmentSummary(evaluated: any[] = []) {
  const summary = {
    measurementOnly: 0,
    accumulating: 0,
    evidencePending: 0,
    stalled: 0,
    halt: 0,
  };
  for (const row of evaluated) {
    const type = row?.proposal?.type;
    if (type === 'measurement_only') summary.measurementOnly += 1;
    else if (type === 'accumulating') summary.accumulating += 1;
    else if (type === 'evidence_pending') summary.evidencePending += 1;
    else if (type === 'stalled_report') summary.stalled += 1;
    else if (type === 'halt_proposal') summary.halt += 1;
  }
  return summary;
}

function proposalForRow(row: any, now = new Date()) {
  const sampleCount = Number(row.sample_count ?? row.sampleCount ?? 0);
  const criteria = toJson(row.promotion_criteria || row.promotionCriteria, {});
  const component = row.component;
  if (criteria.haltRecommended === true) {
    return {
      type: 'halt_proposal',
      component,
      priority: 'urgent',
      evidence: { sampleCount, criteria },
      recommendation: 'halt_or_redesign_shadow_component',
    };
  }
  if (componentNeedsStalledReport(row, now)) {
    return {
      type: 'stalled_report',
      component,
      priority: 'normal',
      evidence: {
        sampleCount,
        ageDays: roundedAgeDays(row, now),
        criteria,
      },
      recommendation: 'review_or_refine_shadow_design',
    };
  }
  const sampleKey = resolveSampleGateKey(criteria);
  if (!sampleKey) {
    return {
      type: 'measurement_only',
      component,
      reason: 'no_promotion_gate',
      criteriaKeys: Object.keys(criteria),
      sampleCount,
    };
  }
  const threshold = Number(criteria[sampleKey]);
  if (sampleCount < threshold) {
    return {
      type: 'accumulating',
      component,
      gate: 'sample',
      sampleKey,
      sampleCount,
      threshold,
    };
  }
  const durationWeeks = criteria.durationWeeks == null ? null : Number(criteria.durationWeeks);
  const requiredDays = durationWeeks == null ? null : durationWeeks * 7;
  const currentAgeDays = roundedAgeDays(row, now);
  if (requiredDays != null && ageDays(row, now) < requiredDays) {
    return {
      type: 'accumulating',
      component,
      gate: 'duration',
      sampleKey,
      sampleCount,
      threshold,
      ageDays: currentAgeDays,
      requiredDays,
    };
  }
  // Performance gates such as expectancy, drawdown, IC, and C7 validation are CODEX-2 scope.
  // CODEX-1 never emits promotion_proposal from sample/duration alone.
  return {
    type: 'evidence_pending',
    component,
    sampleKey,
    sampleCount,
    threshold,
    note: 'awaiting_performance_eval_codex2',
  };
}

function shouldNotifyProposal(proposal: any) {
  return proposal && NOTIFY_TYPES.includes(proposal.type);
}

function notificationProposals(evaluated: any[] = []) {
  return evaluated.map((row) => row.proposal).filter(shouldNotifyProposal);
}

function assessmentStatusForProposal(proposal: any) {
  return proposal?.type || 'active';
}

function proposalForStatus(row: any, proposal: any) {
  if (proposal) return proposal;
  return {
    type: 'measurement_only',
    component: row.component,
    reason: 'no_assessment',
    criteriaKeys: [],
    sampleCount: Number(row.sample_count ?? row.sampleCount ?? 0),
  };
}

function evaluatedRowWithAssessment(row: any, now: Date) {
  const proposal = proposalForRow(row, now);
  const effectiveProposal = proposalForStatus(row, proposal);
  return {
    ...row,
    status: statusForProposal(row, effectiveProposal),
    assessmentStatus: assessmentStatusForProposal(effectiveProposal),
    lastEvaluatedAt: now.toISOString(),
    proposal: effectiveProposal,
  };
}

function buildRegistryEvaluation(rows: any[] = [], now: Date) {
  return rows.map((row) => evaluatedRowWithAssessment(row, now));
}

function proposalLimitValue(options: any = {}) {
  return Math.max(1, Number(options.proposalLimit || DEFAULT_PROPOSAL_LIMIT));
}

function deferredProposals(proposals: any[] = [], proposalLimit = DEFAULT_PROPOSAL_LIMIT) {
  return proposals.slice(proposalLimit);
}

function immediateProposals(proposals: any[] = [], proposalLimit = DEFAULT_PROPOSAL_LIMIT) {
  return proposals.slice(0, proposalLimit);
}

function registryEvaluationResult(evaluated: any[] = [], now: Date, options: any = {}) {
  const proposalLimit = proposalLimitValue(options);
  const proposals = notificationProposals(evaluated);
  return {
    ok: true,
    now: now.toISOString(),
    total: evaluated.length,
    proposals,
    notifyNow: immediateProposals(proposals, proposalLimit),
    deferred: deferredProposals(proposals, proposalLimit),
    evaluated,
    proposalLimit,
    assessmentSummary: buildAssessmentSummary(evaluated),
  };
}

export function evaluateRegistryRows(rows: any[] = [], options: any = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const evaluated = buildRegistryEvaluation(rows, now);
  return registryEvaluationResult(evaluated, now, options);
}

async function loadRegistryRows(queryFn = db.query) {
  return queryFn(
    `SELECT component, current_mode, target_mode, promotion_criteria,
            sample_count, status, last_evaluated_at, registered_at, notes
       FROM luna_component_registry
      ORDER BY component ASC`
  );
}

async function resolveSampleCount(row: any, options: any = {}, deps: any = {}) {
  const component = String(row.component || '');
  if (options.sampleCounts && Object.prototype.hasOwnProperty.call(options.sampleCounts, component)) {
    return Math.max(0, Number(options.sampleCounts[component] || 0));
  }
  const sql = SAMPLE_COUNT_SQL[component];
  if (!sql) return Math.max(0, Number(row.sample_count ?? row.sampleCount ?? 0));
  try {
    const rows = await (deps.queryFn || db.query)(sql);
    return Math.max(0, Number(rows?.[0]?.count || 0));
  } catch {
    return Math.max(0, Number(row.sample_count ?? row.sampleCount ?? 0));
  }
}

export async function attachSampleCounts(rows: any[] = [], options: any = {}, deps: any = {}) {
  const updated = [];
  for (const row of rows) {
    const sampleCount = await resolveSampleCount(row, options, deps);
    updated.push({ ...row, sample_count: sampleCount, sampleCount });
  }
  return updated;
}

async function persistEvaluation(result: any, deps: any = {}) {
  const runFn = deps.runFn || db.run;
  for (const row of result.evaluated || []) {
    await runFn(
      `UPDATE luna_component_registry
          SET status = $2,
              last_evaluated_at = $3,
              sample_count = $4
        WHERE component = $1`,
      [row.component, row.status, result.now, Math.max(0, Number(row.sample_count ?? row.sampleCount ?? 0))]
    );
  }
}

function proposalOutputPath(outputPath?: string | null) {
  return path.resolve(outputPath || path.join(INVESTMENT_ROOT, 'output', 'luna-registry-proposals.json'));
}

async function writeProposalFile(result: any, outputPath?: string | null) {
  const target = proposalOutputPath(outputPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
  return target;
}

async function publishProposals(proposals: any[] = [], deps: any = {}) {
  const publishFn = deps.publishAlert || publishAlert;
  const results = [];
  for (const proposal of proposals) {
    results.push(await publishFn({
      from_bot: 'luna-registry-evaluator',
      team: 'investment',
      event_type: 'luna_registry_proposal',
      alert_level: proposal.type === 'halt_proposal' ? 3 : 2,
      title: `Luna registry ${proposal.type}: ${proposal.component}`,
      message: `[Luna Registry] ${proposal.type}\ncomponent=${proposal.component}\nrecommendation=${proposal.recommendation}`,
      payload: proposal,
      visibility: 'human_action',
      alarm_type: proposal.type === 'halt_proposal' ? 'error' : 'report',
      actionability: 'needs_approval',
    }));
  }
  return results;
}

async function runCalibrationBeforeEvaluation(options: any = {}, deps: any = {}) {
  if (options.skipCalibration === true) {
    return { ok: true, skipped: true, reason: 'skip_calibration_flag' };
  }
  try {
    const runner = deps.runLunaRegimeCalibration || runLunaRegimeCalibration;
    const dryRun = options.dryRun === true || options.apply !== true;
    const result = await runner({
      dryRun,
      write: options.apply === true && !dryRun,
      confirm: options.apply === true && !dryRun ? LUNA_REGIME_CALIBRATION_CONFIRM : null,
      markets: options.calibrationMarkets,
      now: options.now,
    }, deps);
    return {
      ok: result?.ok !== false,
      skipped: false,
      dryRun: result?.dryRun,
      write: result?.write,
      rows: Array.isArray(result?.rows) ? result.rows.length : 0,
      inserted: Array.isArray(result?.inserted) ? result.inserted : [],
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      error: error?.message || String(error),
    };
  }
}

async function runAlphaBeforeEvaluation(options: any = {}, deps: any = {}) {
  if (options.skipAlpha === true) {
    return { ok: true, skipped: true, reason: 'skip_alpha_flag' };
  }
  try {
    const runner = deps.runLunaAlphaFactor || runLunaAlphaFactor;
    const dryRun = options.dryRun === true || options.apply !== true;
    const result = await runner({
      apply: options.apply === true && !dryRun,
      dryRun,
      fixture: false,
      confirm: options.apply === true && !dryRun ? LUNA_ALPHA_FACTOR_CONFIRM : null,
      market: options.alphaMarket || 'domestic',
      limit: options.alphaLimit,
    }, deps);
    return {
      ok: result?.ok !== false,
      skipped: false,
      dryRun,
      evaluated: Number(result?.summary?.evaluated ?? result?.results?.length ?? 0),
      written: Number(result?.written ?? 0),
      promotionCandidates: Number(result?.summary?.promotionCandidates ?? 0),
      canWrite: result?.canWrite === true,
      generator: result?.generator || null,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      error: error?.message || String(error),
    };
  }
}

async function runPaperMirrorBeforeEvaluation(options: any = {}, deps: any = {}) {
  if (options.skipPaperMirror === true) {
    return { ok: true, skipped: true, reason: 'skip_paper_mirror_flag' };
  }
  const dryRun = options.dryRun === true || options.apply !== true;
  const markets = listValue(options.paperMirrorMarkets, ['domestic', 'overseas']);
  const runner = deps.runRuntimeLunaTossPaperMirror || runRuntimeLunaTossPaperMirror;
  const aggregate = {
    ok: true,
    skipped: false,
    dryRun,
    markets: [],
    evaluated: 0,
    mirrored: 0,
    written: 0,
    placed: 0,
    results: [],
    error: null,
  };
  for (const market of markets) {
    try {
      const result = await runner({
        market,
        limit: Number(options.paperMirrorLimit || 20),
        dryRun,
        apply: options.apply === true && !dryRun,
        confirm: options.apply === true && !dryRun ? LUNA_TOSS_PAPER_MIRROR_CONFIRM : null,
        stage: 's1_paper_mirror',
      }, deps);
      const evaluated = Number(result?.evaluated ?? result?.rows?.length ?? 0);
      const written = Number(result?.written ?? 0);
      const placed = Number(result?.placed ?? 0);
      aggregate.markets.push(market);
      aggregate.evaluated += evaluated;
      aggregate.mirrored += evaluated;
      aggregate.written += written;
      aggregate.placed += placed;
      aggregate.results.push({ market, ok: result?.ok !== false, evaluated, written, placed });
    } catch (error) {
      aggregate.ok = false;
      aggregate.markets.push(market);
      aggregate.results.push({ market, ok: false, error: error?.message || String(error) });
    }
  }
  const errors = aggregate.results.filter((row) => row.ok === false).map((row) => `${row.market}:${row.error}`);
  aggregate.error = errors.length ? errors.join('; ') : null;
  return aggregate;
}

async function runUniverseSnapshotBeforeEvaluation(options: any = {}, deps: any = {}) {
  if (options.skipUniverseSnapshot === true) {
    return { ok: true, skipped: true, reason: 'skip_universe_snapshot_flag' };
  }
  try {
    const runner = deps.persistUniverseSnapshot || persistUniverseSnapshot;
    const dryRun = options.dryRun === true || options.apply !== true;
    const result = await runner({
      dryRun,
      snapshotDate: options.universeSnapshotDate,
    }, deps);
    return {
      ok: result?.ok !== false,
      skipped: false,
      dryRun,
      snapshotDate: result?.snapshotDate || null,
      inserted: Number(result?.inserted || 0),
      totalActive: Number(result?.totalActive || 0),
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      error: error?.message || String(error),
    };
  }
}

async function runSignalOutcomeBeforeEvaluation(options: any = {}, deps: any = {}) {
  if (options.skipSignalOutcome === true) {
    return { ok: true, skipped: true, reason: 'skip_signal_outcome_flag' };
  }
  try {
    const runner = deps.runLunaSignalOutcomeEval || runLunaSignalOutcomeEval;
    const dryRun = options.dryRun === true || options.apply !== true;
    const result = await runner({
      dryRun,
      apply: options.apply === true && !dryRun,
      confirm: options.apply === true && !dryRun ? LUNA_SIGNAL_OUTCOME_CONFIRM : null,
      limit: options.signalOutcomeLimit,
      maxBars: options.signalOutcomeMaxBars,
      markets: options.signalOutcomeMarkets,
      now: options.now,
    }, deps);
    return {
      ok: result?.ok !== false,
      skipped: false,
      dryRun,
      evaluated: Number(result?.evaluated || 0),
      written: Number(result?.written || 0),
      counts: result?.counts || {},
      summary: result?.summary || null,
      errors: Array.isArray(result?.errors) ? result.errors.slice(0, 5) : [],
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      error: error?.message || String(error),
    };
  }
}

async function runRegistrySeedBeforeEvaluation(options: any = {}, deps: any = {}) {
  try {
    const runner = deps.seedLunaComponentRegistry || seedLunaComponentRegistry;
    const dryRun = options.dryRun === true || options.apply !== true;
    const result = await runner({ dryRun }, deps);
    return {
      ok: result?.ok !== false,
      skipped: false,
      dryRun,
      seeded: Number(result?.seeded || 0),
      applied: Number(result?.applied || 0),
      inserted: Number(result?.inserted || 0),
      updated: Number(result?.updated || 0),
      components: Array.isArray(result?.components) ? result.components : [],
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      dryRun: options.dryRun === true || options.apply !== true,
      seeded: 0,
      applied: 0,
      inserted: 0,
      updated: 0,
      error: error?.message || String(error),
    };
  }
}

export async function runLunaRegistryEvaluator(options: any = {}, deps: any = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const confirm = String(options.confirm || '');
  if (apply && confirm !== LUNA_REGISTRY_EVALUATOR_CONFIRM) {
    throw new Error(`runtime-luna-registry-evaluator requires --confirm=${LUNA_REGISTRY_EVALUATOR_CONFIRM}`);
  }

  const calibration = await runCalibrationBeforeEvaluation({ ...options, apply, dryRun }, deps);
  const alpha = await runAlphaBeforeEvaluation({ ...options, apply, dryRun }, deps);
  const paperMirror = await runPaperMirrorBeforeEvaluation({ ...options, apply, dryRun }, deps);
  const universeSnapshot = await runUniverseSnapshotBeforeEvaluation({ ...options, apply, dryRun }, deps);
  const signalOutcome = await runSignalOutcomeBeforeEvaluation({ ...options, apply, dryRun }, deps);
  const registrySeed = await runRegistrySeedBeforeEvaluation({ ...options, apply, dryRun }, deps);
  const rows = options.rows || await loadRegistryRows(deps.queryFn || db.query);
  const rowsWithSamples = await attachSampleCounts(rows, options, deps);
  const result = evaluateRegistryRows(rowsWithSamples, {
    now: options.now,
    proposalLimit: options.proposalLimit,
  });

  let outputPath = null;
  let notifications = [];
  if (apply && !dryRun) {
    await persistEvaluation(result, deps);
    outputPath = await writeProposalFile(result, options.outputPath);
    notifications = await publishProposals(result.notifyNow, deps);
  }

  return {
    ...result,
    dryRun,
    apply,
    calibration,
    alpha,
    paperMirror,
    universeSnapshot,
    signalOutcome,
    registrySeed,
    outputPath,
    notificationsAttempted: notifications.length,
    liveMutation: false,
    protectedPidMutation: false,
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaRegistryEvaluator({
      json: hasFlag('json'),
      dryRun: hasFlag('dry-run'),
      apply: hasFlag('apply'),
      confirm: argValue('confirm', ''),
      proposalLimit: Number(argValue('proposal-limit', DEFAULT_PROPOSAL_LIMIT)),
      skipCalibration: hasFlag('skip-calibration'),
      skipAlpha: hasFlag('skip-alpha'),
      skipPaperMirror: hasFlag('skip-paper-mirror'),
      skipUniverseSnapshot: hasFlag('skip-universe-snapshot'),
      skipSignalOutcome: hasFlag('skip-signal-outcome'),
      calibrationMarkets: argValue('calibration-markets'),
      paperMirrorMarkets: argValue('paper-mirror-markets', 'domestic,overseas'),
      paperMirrorLimit: Number(argValue('paper-mirror-limit', 20)),
      universeSnapshotDate: argValue('universe-snapshot-date'),
      signalOutcomeLimit: Number(argValue('signal-outcome-limit', 100)),
      signalOutcomeMaxBars: Number(argValue('signal-outcome-max-bars', 20)),
      signalOutcomeMarkets: argValue('signal-outcome-markets', ''),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ runtime-luna-registry-evaluator 실패:',
  });
}
