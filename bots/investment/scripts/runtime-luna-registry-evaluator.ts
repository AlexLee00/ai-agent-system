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

const INVESTMENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LUNA_REGISTRY_EVALUATOR_CONFIRM = 'luna-registry-evaluator-shadow';
export const DEFAULT_PROPOSAL_LIMIT = 2;

const SAMPLE_COUNT_SQL = Object.freeze({
  'phase-a-prediction-15min': `SELECT COUNT(*)::int AS count FROM luna_analysis_prediction_phase_a_logs`,
  'fundamental-quant': `SELECT COUNT(*)::int AS count FROM korea_public_data_shadow_signals WHERE strategy ILIKE '%fundamental%'`,
  'earnings-surprise': `SELECT COUNT(*)::int AS count FROM korea_public_data_shadow_signals WHERE strategy ILIKE '%earnings%'`,
  'disclosure-event': `SELECT COUNT(*)::int AS count FROM korea_public_data_shadow_signals WHERE strategy ILIKE '%disclosure%'`,
  'korean-factor-model-shadow': `SELECT COUNT(*)::int AS count FROM korean_factor_log`,
  'rl-policy-shadow': `SELECT COUNT(*)::int AS count FROM luna_guard_counterfactual WHERE guard_reason ILIKE '%rl%'`,
  'stat-arb-shadow': `SELECT COUNT(*)::int AS count FROM luna_signal_policy_shadow WHERE policy_key ILIKE '%stat%'`,
  'position-lifecycle': `SELECT COUNT(*)::int AS count FROM position_lifecycle_events`,
  'posttrade-feedback': `SELECT COUNT(*)::int AS count FROM feedback_to_action_map`,
  'candidate-backtest-entry-gate': `SELECT COUNT(*)::int AS count FROM candidate_backtest_status`,
  'dsr-pbo-gate': `SELECT COUNT(*)::int AS count FROM candidate_backtest_status WHERE dsr IS NOT NULL OR pbo IS NOT NULL`,
  'robust-backtest-selection': `SELECT COUNT(*)::int AS count FROM candidate_backtest_status WHERE robust_selection_enabled IS TRUE OR selection_method IS NOT NULL`,
  'alpha-factor-discovery': `SELECT COUNT(*)::int AS count FROM luna_alpha_factors`,
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

function proposalForRow(row: any, now = new Date()) {
  const sampleCount = Number(row.sample_count ?? row.sampleCount ?? 0);
  const criteria = toJson(row.promotion_criteria || row.promotionCriteria, {});
  if (criteria.haltRecommended === true) {
    return {
      type: 'halt_proposal',
      component: row.component,
      priority: 'urgent',
      evidence: { sampleCount, criteria },
      recommendation: 'halt_or_redesign_shadow_component',
    };
  }
  if (componentNeedsStalledReport(row, now)) {
    return {
      type: 'stalled_report',
      component: row.component,
      priority: 'normal',
      evidence: {
        sampleCount,
        ageDays: Math.round(ageDays(row, now) * 10) / 10,
        criteria,
      },
      recommendation: 'review_or_refine_shadow_design',
    };
  }
  if (criteria.readyForPromotion === true && criteria.minTrades && sampleCount >= Number(criteria.minTrades)) {
    return {
      type: 'promotion_proposal',
      component: row.component,
      priority: 'normal',
      evidence: { sampleCount, criteria },
      recommendation: `consider_${row.target_mode || row.targetMode || 'next_mode'}`,
    };
  }
  return null;
}

export function evaluateRegistryRows(rows: any[] = [], options: any = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const proposalLimit = Math.max(1, Number(options.proposalLimit || DEFAULT_PROPOSAL_LIMIT));
  const evaluated = rows.map((row) => {
    const proposal = proposalForRow(row, now);
    const nextStatus = proposal?.type === 'stalled_report'
      ? 'stalled'
      : proposal?.type === 'promotion_proposal'
        ? 'proposed'
        : proposal?.type === 'halt_proposal'
          ? 'halted'
          : ['promoted', 'halted'].includes(String(row.status || ''))
            ? row.status
            : 'active';
    return {
      ...row,
      status: nextStatus,
      lastEvaluatedAt: now.toISOString(),
      proposal,
    };
  });
  const proposals = evaluated.map((row) => row.proposal).filter(Boolean);
  return {
    ok: true,
    now: now.toISOString(),
    total: evaluated.length,
    proposals,
    notifyNow: proposals.slice(0, proposalLimit),
    deferred: proposals.slice(proposalLimit),
    evaluated,
    proposalLimit,
  };
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

export async function runLunaRegistryEvaluator(options: any = {}, deps: any = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const confirm = String(options.confirm || '');
  if (apply && confirm !== LUNA_REGISTRY_EVALUATOR_CONFIRM) {
    throw new Error(`runtime-luna-registry-evaluator requires --confirm=${LUNA_REGISTRY_EVALUATOR_CONFIRM}`);
  }

  const calibration = await runCalibrationBeforeEvaluation({ ...options, apply, dryRun }, deps);
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
      calibrationMarkets: argValue('calibration-markets'),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ runtime-luna-registry-evaluator 실패:',
  });
}
