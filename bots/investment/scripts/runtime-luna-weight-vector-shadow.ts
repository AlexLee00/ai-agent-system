#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLunaWeightVector,
  ensureLunaPhase2Schema,
  insertLunaWeightVectorShadow,
  loadLunaPhase2CandidateInputs,
  normalizeLunaPhase2Market,
} from '../shared/luna-weight-vector.ts';
import {
  DEFAULT_LUNA_WEIGHT_POLICY,
  fetchLunaAutonomousWeightFeedback,
} from '../shared/luna-autonomous-weight-feedback.ts';

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function fixtureInputs() {
  const now = new Date().toISOString();
  return [
    {
      candidate: { symbol: 'BTC/USDT', market: 'crypto', score: 0.86, source: 'fixture', discovered_at: now },
      backtest: { fresh: true, healthy: true, sharpe: 1.2, max_drawdown: 11, win_rate: 54, last_backtest_at: now, gate_status: 'pass' },
      predictive: { decision: 'pass_prediction', score: 0.78, component_coverage: 0.86, created_at: now },
      community: { avg_score: 0.42, source_count: 3, last_seen_at: now, bot_noise_score: 0.1, hype_spike: false },
    },
    {
      candidate: { symbol: 'NEG/USDT', market: 'crypto', score: 0.74, source: 'fixture', discovered_at: now },
      backtest: { fresh: true, healthy: false, sharpe: -0.4, max_drawdown: 18, win_rate: 28, last_backtest_at: now, gate_status: 'would_block_unhealthy', would_block: true },
      predictive: { decision: 'would_block_prediction', score: 0.33, component_coverage: 0.5, created_at: now },
      community: { avg_score: 0.2, source_count: 1, last_seen_at: now, bot_noise_score: 0.6, hype_spike: true },
      bottleneck: { severity: 'blocker', recommended_action: 'quarantine_candidate_shadow', candidate_selection_penalty: 0.75, reasons: ['backtest_unhealthy_or_would_block', 'sharpe_negative'], observed_at: now },
    },
  ];
}

export async function runLunaWeightVectorShadow(options: any = {}, deps: any = {}) {
  const dryRun = options.dryRun === true || options.apply !== true;
  const apply = options.apply === true;
  const confirm = String(options.confirm || '');
  const fixture = options.fixture === true;
  const json = options.json === true;
  const limit = Math.max(1, Number(options.limit || process.env.LUNA_PHASE2_WEIGHT_VECTOR_LIMIT || 50));
  const market = options.market ? normalizeLunaPhase2Market(options.market) : null;
  const asOf = options.asOf || new Date().toISOString();

  if (apply && confirm !== 'luna-weight-vector-shadow') {
    throw new Error('runtime:luna-weight-vector-shadow apply requires --confirm=luna-weight-vector-shadow');
  }

  const staticWeights = options.staticWeights === true;
  const adaptiveWeights = staticWeights
    ? {
      ok: true,
      status: 'static_weights_requested',
      source: 'static_default',
      mode: 'shadow',
      shadowOnly: true,
      liveMutation: false,
      generatedAt: asOf,
      baseWeights: DEFAULT_LUNA_WEIGHT_POLICY,
      weights: DEFAULT_LUNA_WEIGHT_POLICY,
      deltas: { candidate: 0, backtest: 0, predictive: 0, community: 0 },
      reasons: ['static_weights_flag'],
      metrics: null,
    }
    : fixture && options.adaptiveWeights !== true
      ? {
        ok: true,
        status: 'fixture_static_weights',
        source: 'static_fixture',
        mode: 'shadow',
        shadowOnly: true,
        liveMutation: false,
        generatedAt: asOf,
        baseWeights: DEFAULT_LUNA_WEIGHT_POLICY,
        weights: DEFAULT_LUNA_WEIGHT_POLICY,
        deltas: { candidate: 0, backtest: 0, predictive: 0, community: 0 },
        reasons: ['fixture_keeps_static_weights'],
        metrics: null,
      }
      : deps.fetchWeightFeedback
        ? await deps.fetchWeightFeedback({ days: options.weightFeedbackDays || 7, market })
        : await fetchLunaAutonomousWeightFeedback({
          days: options.weightFeedbackDays || process.env.LUNA_WEIGHT_FEEDBACK_DAYS || 7,
          market,
          mode: 'shadow',
        });
  const config = {
    riskBudgetUsdt: Number(process.env.LUNA_MAX_TRADE_USDT || 50),
    weights: adaptiveWeights?.weights || DEFAULT_LUNA_WEIGHT_POLICY,
    autonomousWeightFeedback: adaptiveWeights,
  };

  const inputs = fixture
    ? fixtureInputs()
    : deps.loadInputs
      ? await deps.loadInputs({ limit, market })
      : await loadLunaPhase2CandidateInputs({ limit, market });

  const rows = inputs.map((input) => buildLunaWeightVector({ ...input, asOf }, config));
  const summary = {
    total: rows.length,
    increase: rows.filter((row) => row.signal === 'increase').length,
    watch: rows.filter((row) => row.signal === 'watch').length,
    hold: rows.filter((row) => row.signal === 'hold').length,
    noLookaheadViolations: rows.filter((row) => !row.noLookaheadOk).length,
    bottleneckPenalized: rows.filter((row) => Number(row.evidence?.bottleneck?.penalty || 0) > 0).length,
    bottleneckHardHold: rows.filter((row) => row.evidence?.bottleneck?.hardHold === true).length,
    liveMutation: false,
  };

  if (apply && rows.length > 0) {
    if (deps.ensureSchema) await deps.ensureSchema();
    else {
      await db.initSchema();
      await ensureLunaPhase2Schema();
    }
    for (const row of rows) {
      if (deps.insertWeight) await deps.insertWeight(row);
      else await insertLunaWeightVectorShadow(row);
    }
  }

  const payload = {
    ok: true,
    status: apply ? 'luna_weight_vector_shadow_written' : 'luna_weight_vector_shadow_planned',
    phase: 'luna_phase2_finrlx',
    dryRun,
    apply,
    fixture,
    writeMode: apply ? 'shadow-apply' : 'plan-only',
    shadowMode: true,
    asOf,
    market: market || 'all',
    adaptiveWeights,
    summary,
    rows,
  };

  if (!json) {
    console.log(`[luna-phase2-weight] ${payload.status} total=${summary.total} increase=${summary.increase} watch=${summary.watch} hold=${summary.hold}`);
  }
  return payload;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaWeightVectorShadow({
      json: hasFlag('json'),
      dryRun: hasFlag('dry-run'),
      apply: hasFlag('apply'),
      fixture: hasFlag('fixture'),
      limit: Number(argValue('limit', process.env.LUNA_PHASE2_WEIGHT_VECTOR_LIMIT || 50)),
      market: argValue('market', null),
      asOf: argValue('as-of', null),
      confirm: argValue('confirm', ''),
      staticWeights: hasFlag('static-weights'),
      adaptiveWeights: hasFlag('adaptive-weights'),
      weightFeedbackDays: Number(argValue('weight-feedback-days', process.env.LUNA_WEIGHT_FEEDBACK_DAYS || 7)),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'runtime-luna-weight-vector-shadow error:',
  });
}
