#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildOpsSchedulerAgentPlan } from '../shared/luna-ops-scheduler-agent-plan.ts';
import { evaluateKisMarketHours, getNextOpenTime } from '../shared/kis-market-hours-guard.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');
const DEFAULT_STATE_PATH = path.join(INVESTMENT_DIR, 'output', 'ops', 'luna-ops-scheduler-state.json');
const DEFAULT_LOCK_PATH = path.join(INVESTMENT_DIR, 'output', 'ops', 'luna-ops-scheduler.lock');
const LOCK_STALE_MS = 20 * 60 * 1000;
const DEFAULT_JOB_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_STDOUT_TAIL_CHARS = 500;
const DEFAULT_STDERR_TAIL_CHARS = 1000;
const PRE_MARKET_ANALYSIS_MAX_SYMBOLS = '5';
const PRE_MARKET_ANALYSIS_MAX_ENRICHMENT_SYMBOLS = '2';
const PRE_MARKET_REFRESH_WINDOW_MINUTES = Object.freeze({
  domestic: 240,
  overseas: 1080,
});

function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function nodeScript(script, args = []) {
  return {
    command: process.execPath,
    args: [path.join(INVESTMENT_DIR, 'scripts', script), ...args],
  };
}

function teamScript(script, args = [], env = {}) {
  return {
    command: process.execPath,
    args: [path.join(INVESTMENT_DIR, 'team', script), ...args],
    env,
  };
}

function marketScript(script, args = [], env = {}) {
  return {
    command: process.execPath,
    args: [path.join(INVESTMENT_DIR, 'markets', script), ...args],
    env,
  };
}

export function getOpsSchedulerJobs() {
  return [
    {
      name: 'market_regime_capture',
      category: 'market_state',
      market: 'all',
      immutable: true,
      cadence: { type: 'interval', seconds: 1800 },
      ...nodeScript('capture-market-regimes.ts', ['--markets=binance,kis,kis_overseas', '--json']),
    },
    {
      name: 'market_regime_llm_shadow',
      category: 'market_state',
      market: 'all',
      cadence: { type: 'interval', seconds: 3600 },
      timeoutMs: 120_000,
      ...nodeScript('runtime-luna-regime-llm-shadow.ts', [
        '--apply',
        '--confirm=luna-regime-llm-shadow',
        '--markets=crypto,domestic,overseas',
        '--ttl-minutes=360',
        '--json',
      ]),
    },
    {
      name: 'dynamic_policy_operator',
      category: 'policy',
      market: 'all',
      cadence: { type: 'interval', seconds: 1800 },
      ...nodeScript('runtime-luna-dynamic-policy-operator.ts', [
        '--apply',
        '--confirm=luna-dynamic-policy-autotune',
        '--json',
      ]),
    },
    {
      name: 'discovery_candidate_refresh',
      category: 'discovery',
      market: 'crypto',
      cadence: { type: 'interval', seconds: 1800 },
      ...nodeScript('runtime-discovery-orchestrator-refresh.ts', [
        '--markets=crypto',
        '--limit=30',
        '--ttl-hours=6',
        '--json',
      ]),
    },
    {
      name: 'pre_market_screen_domestic',
      category: 'candidate_selection',
      market: 'domestic',
      immutable: true,
      cadence: { type: 'daily', hour: 8, minute: 35 },
      ...nodeScript('pre-market-screen.ts', ['domestic']),
    },
    {
      name: 'pre_market_screen_overseas',
      category: 'candidate_selection',
      market: 'overseas',
      immutable: true,
      cadence: { type: 'daily', hour: 21, minute: 35 },
      ...nodeScript('pre-market-screen.ts', ['overseas']),
    },
    {
      name: 'pre_market_analysis_refresh_domestic',
      category: 'analysis_refresh',
      market: 'domestic',
      cadence: { type: 'daily', hour: 8, minute: 45 },
      ...nodeScript('runtime-luna-active-candidate-analysis-refresh.ts', [
        '--apply',
        '--confirm=luna-active-candidate-analysis-refresh',
        '--market=domestic',
        '--hours=24',
        '--limit=20',
        `--max-symbols=${PRE_MARKET_ANALYSIS_MAX_SYMBOLS}`,
        `--max-enrichment-symbols=${PRE_MARKET_ANALYSIS_MAX_ENRICHMENT_SYMBOLS}`,
        '--targeted-global-cooldown',
        '--json',
      ]),
    },
    {
      name: 'pre_market_analysis_refresh_overseas',
      category: 'analysis_refresh',
      market: 'overseas',
      cadence: { type: 'daily', hour: 21, minute: 45 },
      ...nodeScript('runtime-luna-active-candidate-analysis-refresh.ts', [
        '--apply',
        '--confirm=luna-active-candidate-analysis-refresh',
        '--market=overseas',
        '--hours=24',
        '--limit=20',
        `--max-symbols=${PRE_MARKET_ANALYSIS_MAX_SYMBOLS}`,
        `--max-enrichment-symbols=${PRE_MARKET_ANALYSIS_MAX_ENRICHMENT_SYMBOLS}`,
        '--targeted-global-cooldown',
        '--json',
      ]),
    },
    {
      name: 'market_cycle_crypto',
      category: 'market_cycle',
      market: 'crypto',
      immutable: true,
      cadence: { type: 'interval', seconds: 300 },
      ...marketScript('crypto.ts'),
    },
    {
      name: 'active_entry_trigger_evaluator_crypto',
      category: 'decision_probe',
      market: 'crypto',
      immutable: true,
      cadence: { type: 'interval', seconds: 60 },
      ...nodeScript('luna-entry-trigger-worker.ts', [
        '--exchange=binance',
        '--derive-market-events',
        '--json',
      ]),
    },
    {
      name: 'active_entry_trigger_evaluator_domestic',
      category: 'decision_probe',
      market: 'domestic',
      immutable: true,
      requiresMarketOpen: true,
      cadence: { type: 'interval', seconds: 60 },
      ...nodeScript('luna-entry-trigger-worker.ts', [
        '--exchange=kis',
        '--derive-market-events',
        '--json',
      ]),
    },
    {
      name: 'active_entry_trigger_evaluator_overseas',
      category: 'decision_probe',
      market: 'overseas',
      immutable: true,
      requiresMarketOpen: true,
      cadence: { type: 'interval', seconds: 60 },
      ...nodeScript('luna-entry-trigger-worker.ts', [
        '--exchange=kis_overseas',
        '--derive-market-events',
        '--json',
      ]),
    },
    {
      name: 'entry_llm_shadow',
      category: 'decision_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 600 },
      timeoutMs: 120_000,
      ...nodeScript('runtime-luna-entry-llm-shadow.ts', [
        '--apply',
        '--confirm=luna-entry-llm-shadow',
        '--exchanges=binance,kis,kis_overseas',
        '--limit=20',
        '--max-llm-calls=3',
        '--ttl-minutes=120',
        '--json',
      ]),
    },
    {
      name: 'predictive_evidence_refresh_all',
      category: 'evidence_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 1800 },
      timeoutMs: 180_000,
      ...nodeScript('runtime-luna-predictive-evidence-refresh.ts', [
        '--apply',
        '--confirm=luna-predictive-evidence-refresh',
        '--market=all',
        '--limit=60',
        '--json',
      ]),
    },
    {
      name: 'candidate_bottleneck_diagnostics_shadow',
      category: 'evidence_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 1800 },
      timeoutMs: 120_000,
      ...nodeScript('runtime-luna-candidate-bottleneck-diagnostics.ts', [
        '--apply',
        '--confirm=luna-candidate-bottleneck-shadow',
        '--market=all',
        '--limit=100',
        '--json',
      ]),
    },
    {
      name: 'weight_vector_shadow_refresh',
      category: 'decision_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 1800 },
      timeoutMs: 120_000,
      ...nodeScript('runtime-luna-weight-vector-shadow.ts', [
        '--apply',
        '--confirm=luna-weight-vector-shadow',
        '--market=all',
        '--limit=60',
        '--json',
      ]),
    },
    {
      name: 'paper_trading_shadow_refresh',
      category: 'paper_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 1800 },
      timeoutMs: 120_000,
      ...nodeScript('runtime-luna-paper-trading-shadow.ts', [
        '--apply',
        '--confirm=luna-paper-trading-shadow',
        '--market=all',
        '--limit=60',
        '--json',
      ]),
    },
    {
      name: 'paper_promotion_gate_shadow_refresh',
      category: 'promotion_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 1800 },
      timeoutMs: 120_000,
      ...nodeScript('runtime-luna-paper-promotion-gate.ts', [
        '--apply',
        '--confirm=luna-paper-promotion-gate-shadow',
        '--market=all',
        '--hours=168',
        '--limit=1000',
        '--json',
      ]),
    },
    {
      name: 'promotion_entry_trigger_coverage_all',
      category: 'promotion_shadow_readonly',
      market: 'all',
      cadence: { type: 'interval', seconds: 600 },
      timeoutMs: 60_000,
      ...nodeScript('runtime-luna-promotion-entry-trigger-coverage.ts', [
        '--market=all',
        '--exchange=all',
        '--hours=168',
        '--limit=100',
        '--json',
      ]),
    },
    {
      name: 'promotion_entry_trigger_bridge_shadow',
      category: 'promotion_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 600 },
      timeoutMs: 60_000,
      ...nodeScript('runtime-luna-promotion-entry-trigger-bridge.ts', [
        '--apply',
        '--confirm=luna-promotion-entry-trigger-bridge-shadow',
        '--market=all',
        '--exchange=all',
        '--hours=168',
        '--limit=100',
        '--json',
      ]),
    },
    {
      name: 'promotion_entry_trigger_materialize_shadow',
      category: 'promotion_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 600 },
      timeoutMs: 60_000,
      ...nodeScript('runtime-luna-promotion-entry-trigger-materialize.ts', [
        '--apply',
        '--confirm=luna-promotion-entry-trigger-materialize-active',
        '--market=all',
        '--exchange=all',
        '--hours=168',
        '--limit=100',
        '--json',
      ]),
    },
    {
      name: 'promotion_readiness_assist_shadow',
      category: 'promotion_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 3600 },
      timeoutMs: 180_000,
      ...nodeScript('runtime-luna-promotion-readiness-assist-shadow.ts', [
        '--apply',
        '--confirm=luna-promotion-readiness-assist-shadow',
        '--market=all',
        '--hours=168',
        '--limit=100',
        '--max-targets=8',
        '--json',
      ]),
    },
    {
      name: 'candidate_quality_remediation_shadow_loop',
      category: 'quality_remediation_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 3600 },
      timeoutMs: 360_000,
      ...nodeScript('runtime-luna-candidate-quality-remediation.ts', [
        '--apply',
        '--confirm=luna-candidate-quality-remediation-shadow',
        '--market=all',
        '--limit=60',
        '--max-backtest-symbols=8',
        '--json',
      ]),
    },
    {
      name: 'dynamic_tpsl_shadow_refresh',
      category: 'risk_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 3600 },
      timeoutMs: 120_000,
      ...nodeScript('runtime-luna-dynamic-tpsl-shadow.ts', [
        '--apply',
        '--confirm=luna-dynamic-tpsl-shadow',
        '--exchanges=binance,kis,kis_overseas',
        '--limit=10',
        '--hours=24',
        '--ttl-minutes=240',
        '--max-llm-calls=0',
        '--json',
      ]),
    },
    {
      name: 'posttrade_mutation_shadow_refresh',
      category: 'feedback_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 7200 },
      timeoutMs: 120_000,
      ...nodeScript('runtime-luna-posttrade-mutation-shadow.ts', [
        '--apply',
        '--confirm=luna-phase3-posttrade-mutation',
        '--days=14',
        '--limit=200',
        '--json',
      ]),
    },
    {
      name: 'deployment_consistency_shadow_refresh',
      category: 'feedback_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 1800 },
      timeoutMs: 120_000,
      ...nodeScript('runtime-luna-deployment-consistency-shadow.ts', [
        '--apply',
        '--confirm=luna-deployment-consistency-shadow',
        '--market=all',
        '--hours=24',
        '--limit=60',
        '--json',
      ]),
    },
    {
      name: 'live_forward_validation_shadow_refresh',
      category: 'promotion_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 3600 },
      timeoutMs: 180_000,
      ...nodeScript('runtime-luna-live-forward-validation-shadow.ts', [
        '--apply',
        '--confirm=luna-phase4-live-forward-shadow',
        '--market=all',
        '--limit=60',
        '--max-llm-calls=0',
        '--json',
      ]),
    },
    {
      name: 'strategy_enhancement_shadow_refresh',
      category: 'promotion_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 3600 },
      timeoutMs: 180_000,
      ...nodeScript('runtime-luna-phase4-strategy-enhancement-shadow.ts', [
        '--apply',
        '--confirm=luna-phase4-strategy-enhancement-shadow',
        '--market=all',
        '--limit=60',
        '--json',
      ]),
    },
    {
      name: 'phase5_codex_p3_shadow_refresh',
      category: 'promotion_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 3600 },
      timeoutMs: 180_000,
      ...nodeScript('runtime-luna-phase5-shadow.ts', [
        '--apply',
        '--confirm=luna-phase5-codex-p3-shadow',
        '--market=all',
        '--task=all',
        '--limit=60',
        '--json',
      ]),
    },
    {
      name: 'factor_model_shadow_refresh',
      category: 'strategy_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 7200 },
      timeoutMs: 120_000,
      ...nodeScript('runtime-luna-factor-model-shadow.ts', [
        '--apply',
        '--confirm=luna-factor-model-shadow',
        '--exchanges=binance,kis,kis_overseas',
        '--limit=20',
        '--hours=24',
        '--ttl-minutes=360',
        '--json',
      ]),
    },
    {
      name: 'stat_arb_shadow_refresh',
      category: 'strategy_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 7200 },
      timeoutMs: 120_000,
      ...nodeScript('runtime-luna-stat-arb-shadow.ts', [
        '--apply',
        '--confirm=luna-stat-arb-shadow',
        '--exchanges=binance,kis,kis_overseas',
        '--strategy=all',
        '--limit=20',
        '--hours=24',
        '--ttl-minutes=360',
        '--json',
      ]),
    },
    {
      name: 'rl_policy_shadow_refresh',
      category: 'neural_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 7200 },
      timeoutMs: 120_000,
      ...nodeScript('runtime-luna-rl-policy-shadow.ts', [
        '--apply',
        '--confirm=luna-rl-policy-shadow',
        '--exchanges=binance,kis,kis_overseas',
        '--limit=20',
        '--hours=24',
        '--ttl-minutes=360',
        '--max-inference-calls=0',
        '--json',
      ]),
    },
    {
      name: 'meta_reflexion_shadow_refresh',
      category: 'neural_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 21600 },
      timeoutMs: 120_000,
      ...nodeScript('runtime-luna-meta-reflexion-shadow.ts', [
        '--apply',
        '--confirm=luna-meta-reflexion-shadow',
        '--layer=all',
        '--lookback-days=7',
        '--limit=50',
        '--max-llm-calls=0',
        '--json',
      ]),
    },
    {
      name: 'risk_simulation_shadow_refresh',
      category: 'risk_shadow',
      market: 'all',
      cadence: { type: 'interval', seconds: 21600 },
      timeoutMs: 180_000,
      ...nodeScript('runtime-luna-monte-carlo-stress-shadow.ts', [
        '--apply',
        '--confirm=luna-monte-carlo-stress-shadow',
        '--exchanges=binance,kis,kis_overseas',
        '--limit=8',
        '--hours=24',
        '--ttl-minutes=720',
        '--simulations=500',
        '--json',
      ]),
    },
    {
      name: 'tradingview_open_position_subscription_sync',
      category: 'position_monitor',
      market: 'crypto',
      immutable: true,
      cadence: { type: 'interval', seconds: 300 },
      ...nodeScript('runtime-tradingview-open-position-subscription-sync.ts', [
        '--apply',
        '--confirm=luna-tradingview-position-subscription-sync',
        '--exchange=binance',
        '--timeframes=60,240,D',
        '--json',
      ]),
    },
    {
      name: 'approved_signal_executor_crypto',
      category: 'execution',
      market: 'crypto',
      immutable: true,
      cadence: { type: 'interval', seconds: 60 },
      ...teamScript('hephaestos.ts', [], {
        PAPER_MODE: 'false',
        INVESTMENT_TRADE_MODE: 'normal',
        LUNA_LIVE_FIRE_ENABLED: 'true',
        HEPHAESTOS_PENDING_SIGNAL_CONCURRENCY: '1',
      }),
    },
    {
      name: 'market_cycle_domestic',
      category: 'market_cycle',
      market: 'domestic',
      immutable: true,
      requiresMarketOpen: true,
      cadence: { type: 'interval', seconds: 1800 },
      ...marketScript('domestic.ts', [], { LUNA_LIVE_DOMESTIC: 'true' }),
    },
    {
      name: 'market_cycle_domestic_open_catchup',
      category: 'market_cycle',
      market: 'domestic',
      immutable: true,
      requiresMarketOpen: true,
      cadence: { type: 'interval', seconds: 300 },
      ...marketScript('domestic.ts', ['--open-catchup'], { LUNA_LIVE_DOMESTIC: 'true' }),
    },
    {
      name: 'market_cycle_overseas',
      category: 'market_cycle',
      market: 'overseas',
      immutable: true,
      requiresMarketOpen: true,
      cadence: { type: 'interval', seconds: 1800 },
      ...marketScript('overseas.ts', [], { LUNA_LIVE_OVERSEAS: 'true' }),
    },
    {
      name: 'discovery_funnel_report',
      category: 'report',
      market: 'all',
      cadence: { type: 'interval', seconds: 1800 },
      ...nodeScript('runtime-luna-discovery-funnel-report.ts', ['--hours=24', '--json']),
    },
    {
      name: 'active_candidate_analysis_refresh_crypto',
      category: 'analysis_refresh',
      market: 'crypto',
      cadence: { type: 'interval', seconds: 1800 },
      ...nodeScript('runtime-luna-active-candidate-analysis-refresh.ts', [
        '--apply',
        '--confirm=luna-active-candidate-analysis-refresh',
        '--market=crypto',
        '--hours=24',
        '--limit=20',
        '--max-symbols=2',
        '--max-enrichment-symbols=1',
        '--targeted-global-cooldown',
        '--json',
      ]),
    },
    {
      name: 'active_candidate_analysis_refresh_domestic',
      category: 'analysis_refresh',
      market: 'domestic',
      requiresMarketOpen: true,
      allowPreMarketRefresh: true,
      preMarketWindowMinutes: PRE_MARKET_REFRESH_WINDOW_MINUTES.domestic,
      cadence: { type: 'interval', seconds: 1800 },
      ...nodeScript('runtime-luna-active-candidate-analysis-refresh.ts', [
        '--apply',
        '--confirm=luna-active-candidate-analysis-refresh',
        '--market=domestic',
        '--hours=24',
        '--limit=20',
        '--max-symbols=4',
        '--max-enrichment-symbols=1',
        '--targeted-global-cooldown',
        '--json',
      ]),
    },
    {
      name: 'active_candidate_analysis_refresh_overseas',
      category: 'analysis_refresh',
      market: 'overseas',
      requiresMarketOpen: true,
      allowPreMarketRefresh: true,
      preMarketWindowMinutes: PRE_MARKET_REFRESH_WINDOW_MINUTES.overseas,
      cadence: { type: 'interval', seconds: 1800 },
      ...nodeScript('runtime-luna-active-candidate-analysis-refresh.ts', [
        '--apply',
        '--confirm=luna-active-candidate-analysis-refresh',
        '--market=overseas',
        '--hours=24',
        '--limit=20',
        '--max-symbols=4',
        '--max-enrichment-symbols=1',
        '--targeted-global-cooldown',
        '--json',
      ]),
    },
    {
      name: 'near_miss_watchlist_crypto',
      category: 'watchlist',
      market: 'crypto',
      cadence: { type: 'interval', seconds: 1800 },
      ...nodeScript('runtime-luna-near-miss-watchlist.ts', [
        '--apply',
        '--confirm=luna-near-miss-watchlist',
        '--market=crypto',
        '--hours=24',
        '--limit=20',
        '--json',
      ]),
    },
    {
      name: 'relaxed_probe_l13_crypto',
      category: 'decision_probe',
      market: 'crypto',
      cadence: { type: 'interval', seconds: 900 },
      ...nodeScript('runtime-luna-relaxed-probe-runner.ts', [
        '--apply',
        '--confirm=luna-relaxed-probe-runner',
        '--market=crypto',
        '--hours=24',
        '--limit=20',
        '--max-symbols=1',
        '--json',
      ]),
    },
    {
      name: 'relaxed_probe_l13_domestic',
      category: 'decision_probe',
      market: 'domestic',
      requiresMarketOpen: true,
      cadence: { type: 'interval', seconds: 900 },
      ...nodeScript('runtime-luna-relaxed-probe-runner.ts', [
        '--apply',
        '--confirm=luna-relaxed-probe-runner',
        '--market=domestic',
        '--hours=24',
        '--limit=20',
        '--max-symbols=1',
        '--json',
      ]),
    },
    {
      name: 'relaxed_probe_l13_overseas',
      category: 'decision_probe',
      market: 'overseas',
      requiresMarketOpen: true,
      cadence: { type: 'interval', seconds: 900 },
      ...nodeScript('runtime-luna-relaxed-probe-runner.ts', [
        '--apply',
        '--confirm=luna-relaxed-probe-runner',
        '--market=overseas',
        '--hours=24',
        '--limit=20',
        '--max-symbols=1',
        '--json',
      ]),
    },
    {
      name: 'near_miss_watchlist_domestic',
      category: 'watchlist',
      market: 'domestic',
      requiresMarketOpen: true,
      cadence: { type: 'interval', seconds: 1800 },
      ...nodeScript('runtime-luna-near-miss-watchlist.ts', [
        '--apply',
        '--confirm=luna-near-miss-watchlist',
        '--market=domestic',
        '--hours=24',
        '--limit=20',
        '--json',
      ]),
    },
    {
      name: 'near_miss_watchlist_overseas',
      category: 'watchlist',
      market: 'overseas',
      requiresMarketOpen: true,
      cadence: { type: 'interval', seconds: 1800 },
      ...nodeScript('runtime-luna-near-miss-watchlist.ts', [
        '--apply',
        '--confirm=luna-near-miss-watchlist',
        '--market=overseas',
        '--hours=24',
        '--limit=20',
        '--json',
      ]),
    },
    {
      name: 'daily_backtest',
      category: 'backtest',
      market: 'all',
      cadence: { type: 'daily', hour: 1, minute: 10 },
      ...nodeScript('runtime-luna-daily-backtest.ts', ['--json', '--dry-run']),
    },
    {
      name: 'guardrails_hourly',
      category: 'guardrail',
      market: 'all',
      immutable: true,
      cadence: { type: 'interval', seconds: 3600 },
      ...nodeScript('runtime-luna-guardrails-hourly.ts', ['--json']),
    },
    {
      name: 'natural_7day_checkpoint',
      category: 'learning',
      market: 'all',
      cadence: { type: 'interval', seconds: 86400 },
      ...nodeScript('runtime-luna-7day-natural-checkpoint.ts', ['--write', '--json']),
    },
    {
      name: 'trade_journal_dashboard',
      category: 'report',
      market: 'all',
      cadence: { type: 'interval', seconds: 3600 },
      ...nodeScript('runtime-trade-journal-dashboard-html.ts', ['--json']),
    },
    {
      name: 'voyager_skill_acceleration',
      category: 'learning',
      market: 'all',
      cadence: { type: 'interval', seconds: 3600 },
      ...nodeScript('runtime-voyager-natural-acceleration.ts', ['--json']),
    },
    {
      name: 'reconcile_auto_settle',
      category: 'reconcile',
      market: 'all',
      immutable: true,
      cadence: { type: 'interval', seconds: 300 },
      ...nodeScript('runtime-luna-reconcile-auto-settle.ts', [
        '--apply',
        '--confirm=luna-reconcile-auto-settle',
        '--json',
      ]),
    },
    {
      name: 'external_evidence_gap_queue_worker',
      category: 'position_monitor',
      market: 'all',
      immutable: true,
      cadence: { type: 'interval', seconds: 300 },
      ...nodeScript('runtime-external-evidence-gap-queue.ts', [
        '--execute',
        '--confirm=evidence-gap-queue',
        '--json',
      ]),
    },
    {
      name: 'external_evidence_gap_backtest_worker',
      category: 'position_monitor',
      market: 'all',
      cadence: { type: 'interval', seconds: 3600 },
      ...nodeScript('runtime-external-evidence-gap-queue.ts', [
        '--execute',
        '--include-backtest',
        '--confirm=evidence-gap-queue',
        '--limit=2',
        '--json',
      ]),
    },
  ];
}

function hasArg(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function positiveIntEnv(name, fallback) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(100, Math.round(raw));
}

export function resolveOnlyJobArg(argv = process.argv.slice(2)) {
  return argValue('only-job', argValue('job', null, argv), argv);
}

export function resolveAgentPlanArg(argv = process.argv.slice(2)) {
  const jsonArg = argValue('agent-plan-json', null, argv);
  if (jsonArg) {
    try {
      return JSON.parse(jsonArg);
    } catch {
      return { invalid: true, reason: 'invalid_agent_plan_json_arg' };
    }
  }
  const fileArg = argValue('agent-plan-file', null, argv);
  if (fileArg) {
    try {
      return JSON.parse(fs.readFileSync(path.resolve(fileArg), 'utf8'));
    } catch {
      return { invalid: true, reason: 'invalid_agent_plan_file' };
    }
  }
  return null;
}

function readJsonSafe(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function sameLocalDate(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function dailyDue(cadence, now, lastRunAt) {
  const scheduled = new Date(now);
  scheduled.setHours(Number(cadence.hour || 0), Number(cadence.minute || 0), 0, 0);
  if (now < scheduled) return false;
  if (!lastRunAt) return true;
  const last = new Date(lastRunAt);
  return !sameLocalDate(last, now);
}

function intervalDue(cadence, now, lastRunAt) {
  if (!lastRunAt) return true;
  const elapsedMs = now.getTime() - new Date(lastRunAt).getTime();
  return elapsedMs >= Number(cadence.seconds || 0) * 1000;
}

function getJobMarketSession(job, now) {
  if (job?.requiresMarketOpen !== true) return null;
  if (!['domestic', 'overseas', 'kis', 'kis_overseas'].includes(String(job?.market || ''))) return null;
  return evaluateKisMarketHours({ market: job.market, now });
}

function getJobPreMarketWindow(job, now, marketSession = null) {
  if (job?.requiresMarketOpen !== true || job?.allowPreMarketRefresh !== true) return null;
  if (marketSession?.isOpen === true) {
    return {
      active: false,
      reasonCode: 'market_open',
      windowMinutes: Number(job.preMarketWindowMinutes || 0),
      minutesUntilOpen: 0,
      nextOpen: now.toISOString(),
    };
  }
  const windowMinutes = Math.max(1, Number(job.preMarketWindowMinutes || 0));
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;
  const nextOpen = getNextOpenTime({ market: job.market, now });
  const minutesUntilOpen = Number(nextOpen?.minutesUntilOpen);
  const active = Number.isFinite(minutesUntilOpen)
    && minutesUntilOpen >= 0
    && minutesUntilOpen <= windowMinutes;
  return {
    active,
    reasonCode: active ? 'pre_market_refresh_window' : 'outside_pre_market_refresh_window',
    windowMinutes,
    minutesUntilOpen: Number.isFinite(minutesUntilOpen) ? minutesUntilOpen : null,
    nextOpen: nextOpen?.nextOpen?.toISOString?.() || null,
  };
}

function isJobDue(job, now, state, force = false) {
  if (force) return true;
  const marketSession = getJobMarketSession(job, now);
  if (marketSession && marketSession.isOpen !== true) {
    const preMarketWindow = getJobPreMarketWindow(job, now, marketSession);
    if (preMarketWindow?.active !== true) return false;
  }
  const lastRunAt = state?.jobs?.[job.name]?.lastRunAt || null;
  if (job.cadence?.type === 'daily') return dailyDue(job.cadence, now, lastRunAt);
  return intervalDue(job.cadence || {}, now, lastRunAt);
}

export function buildOpsSchedulerPlan({
  now = new Date(),
  state = {},
  jobs = getOpsSchedulerJobs(),
  onlyJob = null,
  force = false,
  agentPlan = null,
} = {}) {
  const schedulerAgentPlan = buildOpsSchedulerAgentPlan({ agentPlan, jobs });
  const selected = schedulerAgentPlan.jobs.filter((job) => !onlyJob || job.name === onlyJob);
  const plannedJobs = selected.map((job) => {
    const marketSession = getJobMarketSession(job, now);
    return {
      name: job.name,
      category: job.category || null,
      market: job.market || null,
      immutable: job.immutable === true,
      requiresMarketOpen: job.requiresMarketOpen === true,
      allowPreMarketRefresh: job.allowPreMarketRefresh === true,
      marketSession,
      preMarketWindow: getJobPreMarketWindow(job, now, marketSession),
      cadence: job.cadence,
      due: isJobDue(job, now, state, force),
      command: [job.command, ...(job.args || [])].join(' '),
      env: job.env || {},
      lastRunAt: state?.jobs?.[job.name]?.lastRunAt || null,
    };
  });
  return {
    ok: true,
    generatedAt: now.toISOString(),
    force,
    onlyJob,
    total: plannedJobs.length,
    due: plannedJobs.filter((job) => job.due).length,
    agentPlan: schedulerAgentPlan,
    jobs: plannedJobs,
  };
}

function acquireLock(lockPath, now = new Date()) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  if (fs.existsSync(lockPath)) {
    const current = readJsonSafe(lockPath, {});
    const lockedAt = current.lockedAt ? new Date(current.lockedAt).getTime() : 0;
    const lockFresh = lockedAt && now.getTime() - lockedAt < LOCK_STALE_MS;
    if (lockFresh && isProcessAlive(current.pid)) {
      return { ok: false, status: 'locked', lockPath, current };
    }
  }
  writeJson(lockPath, { lockedAt: now.toISOString(), pid: process.pid });
  return { ok: true, lockPath };
}

function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // best effort cleanup
  }
}

function resolveJobTimeoutMs(job = {}, fallback = DEFAULT_JOB_TIMEOUT_MS) {
  const raw = job.timeoutMs ?? process.env.LUNA_OPS_SCHEDULER_JOB_TIMEOUT_MS ?? fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(10_000, Math.round(parsed));
}

function tailText(text, maxChars) {
  const raw = String(text || '');
  const limit = Math.max(1, Number(maxChars) || 1);
  return raw.length > limit ? raw.slice(-limit) : raw;
}

function summarizeExecutedForLog(item = {}) {
  const keepTail = !item.ok || Number(item.approvedSignals || 0) > 0;
  return {
    name: item.name,
    dryRun: item.dryRun === true,
    startedAt: item.startedAt || null,
    finishedAt: item.finishedAt || null,
    ok: item.ok === true,
    status: item.status ?? null,
    signal: item.signal || null,
    outcome: item.outcome || null,
    summary: item.summary || null,
    approvedSignals: item.approvedSignals ?? null,
    error: item.error || null,
    ...(keepTail ? {
      stdoutTail: typeof item.stdoutTail === 'string' ? item.stdoutTail.slice(-500) : '',
      stderrTail: typeof item.stderrTail === 'string' ? item.stderrTail.slice(-500) : '',
    } : {}),
  };
}

function summarizePlanForLog(plan = {}) {
  const jobs = Array.isArray(plan.jobs) ? plan.jobs : [];
  return {
    ok: plan.ok === true,
    generatedAt: plan.generatedAt || null,
    force: plan.force === true,
    onlyJob: plan.onlyJob || null,
    total: Number(plan.total || jobs.length || 0),
    due: Number(plan.due || jobs.filter((job) => job?.due).length || 0),
    dueJobs: jobs
      .filter((job) => job?.due)
      .slice(0, 20)
      .map((job) => ({
        name: job.name,
        category: job.category || null,
        market: job.market || null,
        cadence: job.cadence || null,
      })),
  };
}

function summarizeOpsSchedulerResultForLog(result = {}) {
  if (boolEnv('LUNA_OPS_SCHEDULER_LOG_VERBOSE', false)) return result;
  const executed = Array.isArray(result.executed) ? result.executed : [];
  return {
    ok: result.ok === true,
    status: result.status || null,
    dryRun: result.dryRun === true,
    statePath: result.statePath || null,
    plan: summarizePlanForLog(result.plan || {}),
    executed: executed.map(summarizeExecutedForLog),
    compact: true,
  };
}

function runCommand(job, { timeoutMs = DEFAULT_JOB_TIMEOUT_MS, runner = null } = {}) {
  if (runner) {
    const result = runner(job);
    return {
      ...result,
      ...(!result?.outcome ? classifyOpsSchedulerOutcome(job, result) : {}),
    };
  }
  const result = spawnSync(job.command, job.args || [], {
    cwd: INVESTMENT_DIR,
    encoding: 'utf8',
    timeout: resolveJobTimeoutMs(job, timeoutMs),
    env: { ...process.env, ...(job.env || {}) },
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const stdoutTailChars = positiveIntEnv('LUNA_OPS_SCHEDULER_STDOUT_TAIL_CHARS', DEFAULT_STDOUT_TAIL_CHARS);
  const stderrTailChars = positiveIntEnv('LUNA_OPS_SCHEDULER_STDERR_TAIL_CHARS', DEFAULT_STDERR_TAIL_CHARS);
  const baseResult = {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal || null,
    stdoutTail: tailText(stdout, stdoutTailChars),
    stderrTail: tailText(stderr, stderrTailChars),
    error: result.error?.message || null,
  };
  return {
    ...baseResult,
    ...classifyOpsSchedulerOutcome(job, { ...baseResult, stdout, stderr }),
  };
}

export function classifyOpsSchedulerOutcome(job, result = {}) {
  if (!result?.ok) {
    const timeoutLike = result?.error === 'spawnSync ETIMEDOUT'
      || /ETIMEDOUT|timed out/i.test(String(result?.error || ''))
      || result?.signal === 'SIGTERM';
    if (timeoutLike) {
      return {
        outcome: 'command_timeout',
        summary: result?.error || result?.stderrTail || `status=${result?.status ?? 'timeout'}`,
      };
    }
    return {
      outcome: 'command_failed',
      summary: result?.error || result?.stderrTail || `status=${result?.status ?? 'unknown'}`,
    };
  }

  const text = [
    result.stdout,
    result.stderr,
    result.stdoutTail,
    result.stderrTail,
  ].filter(Boolean).join('\n');
  const name = String(job?.name || '');

  if (/LIVE OFF|LUNA_LIVE_(DOMESTIC|OVERSEAS)[^\n]*미설정|kill_switch_off/.test(text)) {
    return { outcome: 'kill_switch_off', summary: compactOutcomeSummary(text, 'live kill switch off') };
  }
  if (/open-catchup: 장외 시간/.test(text)) {
    return { outcome: 'market_closed_catchup_wait', summary: compactOutcomeSummary(text, 'open-catchup') };
  }
  if (name.startsWith('active_entry_trigger_evaluator_')) {
    const parsed = parseSchedulerJsonOutput(result.stdout || result.stdoutTail || text);
    const triggerResult = parsed?.result || {};
    const checked = Number(triggerResult.checked || 0);
    const fired = Number(triggerResult.fired || 0);
    const readyBlocked = Number(triggerResult.readyBlocked || 0);
    const allowLiveFire = triggerResult.allowLiveFire === true;
    return {
      outcome: fired > 0 ? 'entry_trigger_fired' : checked > 0 ? 'entry_trigger_checked' : 'entry_trigger_idle',
      summary: `checked=${checked} fired=${fired} readyBlocked=${readyBlocked} allowLiveFire=${allowLiveFire}`,
      approvedSignals: fired > 0 ? fired : null,
    };
  }
  if (name === 'approved_signal_executor_crypto') {
    const recovered = text.match(/실행대상 복구\s+(\d+)건/u);
    const noSignals = /대기 신호 없음/.test(text);
    const completed = /완료:\s*\[|success["']?\s*:\s*true|orderId|order_id/i.test(text);
    if (recovered) {
      const count = Number(recovered[1] || 0);
      return {
        outcome: count > 0 ? 'approved_signal_execution_attempted' : 'no_approved_signals',
        summary: `approved_signal_candidates=${count}`,
        approvedSignals: count,
      };
    }
    if (noSignals) {
      return { outcome: 'no_approved_signals', summary: 'approved_signal_candidates=0', approvedSignals: 0 };
    }
    if (completed) {
      return { outcome: 'approved_signal_executor_completed', summary: compactOutcomeSummary(text, 'hephaestos completed') };
    }
    return { outcome: 'approved_signal_executor_checked', summary: compactOutcomeSummary(text, 'hephaestos checked') };
  }
  if (/사이클 스킵/.test(text)) {
    return { outcome: 'cadence_wait', summary: compactOutcomeSummary(text, '사이클 스킵') };
  }
  if (/주말\/휴장 스킵|휴장/.test(text)) {
    return { outcome: 'market_closed_skip', summary: compactOutcomeSummary(text, '휴장') };
  }
  if (/장외 시간|시장\s*닫힘|research[-_ ]only|연구 모드/.test(text)) {
    return { outcome: 'market_closed_research', summary: compactOutcomeSummary(text, '장외') };
  }
  if (/liquidity_filtered_all|유동성 필터 통과 후보 없음/.test(text)) {
    return { outcome: 'liquidity_filtered_all', summary: compactOutcomeSummary(text, '유동성') };
  }

  const approved = text.match(/최종 결과:\s*(\d+)개 신호 승인/);
  if (approved) {
    const count = Number(approved[1] || 0);
    return {
      outcome: count > 0 ? 'signals_approved' : 'no_signals',
      summary: `approved_signals=${count}`,
      approvedSignals: count,
    };
  }

  const refreshed = text.match(/완료\s+—\s+성공\s+(\d+)\/(\d+),\s+총\s+(\d+)개\s+신호/);
  if (name === 'discovery_candidate_refresh' && refreshed) {
    return {
      outcome: Number(refreshed[3] || 0) > 0 ? 'discovery_refreshed' : 'discovery_empty',
      summary: `adapters=${refreshed[1]}/${refreshed[2]} signals=${refreshed[3]}`,
    };
  }

  const domesticEmptyMarket = /discovery_orchestrator_empty_market/.test(text)
    || /"emptyMarkets"\s*:\s*\[[^\]]*"domestic"/.test(text);
  if (domesticEmptyMarket) {
    return { outcome: 'discovery_empty_market', summary: compactOutcomeSummary(text, 'domestic') };
  }

  return { outcome: 'ok', summary: compactOutcomeSummary(text, 'ok') };
}

function parseSchedulerJsonOutput(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function compactOutcomeSummary(text, fallback = 'ok') {
  const line = String(text || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && item.length <= 220);
  return line || fallback;
}

export async function runOpsScheduler({
  dryRun = false,
  force = false,
  onlyJob = null,
  statePath = DEFAULT_STATE_PATH,
  lockPath = DEFAULT_LOCK_PATH,
  writeState = true,
  now = new Date(),
  runner = null,
  jobs = getOpsSchedulerJobs(),
  agentPlan = null,
} = {}) {
  if (String(process.env.LUNA_OPS_SCHEDULER_ENABLED || 'true').toLowerCase() === 'false') {
    return { ok: true, status: 'disabled', dryRun, generatedAt: now.toISOString(), executed: [] };
  }

  const lock = dryRun ? { ok: true, dryRun: true } : acquireLock(lockPath, now);
  if (!lock.ok) return { ok: false, status: lock.status, dryRun, lockPath, executed: [] };

  try {
    const state = readJsonSafe(statePath, { jobs: {} });
    const plan = buildOpsSchedulerPlan({ now, state, jobs, onlyJob, force, agentPlan });
    const scheduledJobs = plan.agentPlan?.jobs || jobs;
    const dueJobs = scheduledJobs.filter((job) => plan.jobs.find((item) => item.name === job.name && item.due));
    const executed = [];
    const nextState = { ...state, jobs: { ...(state.jobs || {}) } };

    for (const job of dueJobs) {
      if (dryRun) {
        executed.push({ name: job.name, dryRun: true, planned: true, ok: true });
        continue;
      }
      const startedAt = new Date().toISOString();
      const result = runCommand(job, { runner });
      const finishedAt = new Date().toISOString();
      executed.push({ name: job.name, dryRun: false, startedAt, finishedAt, ...result });
      if (writeState) {
        nextState.jobs[job.name] = {
          lastRunAt: now.toISOString(),
          lastStatus: result.ok ? 'ok' : 'failed',
          lastOutcome: result.outcome || 'ok',
          lastSummary: result.summary || null,
          approvedSignals: result.approvedSignals ?? null,
          lastError: result.ok ? null : result.error || result.stderrTail || result.signal || null,
          updatedAt: finishedAt,
        };
      }
    }

    if (!dryRun && writeState) {
      nextState.updatedAt = new Date().toISOString();
      writeJson(statePath, nextState);
    }

    return {
      ok: executed.every((item) => item.ok),
      status: dryRun ? 'planned' : 'executed',
      dryRun,
      statePath,
      plan,
      executed,
    };
  } finally {
    if (!dryRun) releaseLock(lockPath);
  }
}

export function seedOpsSchedulerState({
  statePath = DEFAULT_STATE_PATH,
  now = new Date(),
  jobs = getOpsSchedulerJobs(),
} = {}) {
  const state = {
    seededAt: now.toISOString(),
    updatedAt: now.toISOString(),
    jobs: Object.fromEntries(jobs.map((job) => [job.name, {
      lastRunAt: now.toISOString(),
      lastStatus: 'seeded',
      lastOutcome: 'seeded',
      lastSummary: null,
      approvedSignals: null,
      updatedAt: now.toISOString(),
    }])),
  };
  writeJson(statePath, state);
  return {
    ok: true,
    status: 'seeded',
    statePath,
    seededAt: state.seededAt,
    jobs: jobs.map((job) => job.name),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasArg('seed-state', argv)) {
    const result = seedOpsSchedulerState({
      statePath: argValue('state-path', DEFAULT_STATE_PATH, argv),
    });
    if (hasArg('json', argv)) console.log(JSON.stringify(result, null, 2));
    else console.log(`runtime-luna-ops-scheduler seeded jobs=${result.jobs.length}`);
    return;
  }
  const result = await runOpsScheduler({
    dryRun: hasArg('dry-run', argv),
    force: hasArg('force', argv),
    onlyJob: resolveOnlyJobArg(argv),
    statePath: argValue('state-path', DEFAULT_STATE_PATH, argv),
    lockPath: argValue('lock-path', DEFAULT_LOCK_PATH, argv),
    writeState: !hasArg('no-write-state', argv),
    agentPlan: resolveAgentPlanArg(argv),
  });
  if (hasArg('json', argv)) console.log(JSON.stringify(summarizeOpsSchedulerResultForLog(result), null, 2));
  else console.log(`runtime-luna-ops-scheduler ${result.status} due=${result.plan?.due || 0} executed=${result.executed?.length || 0}`);
  if (!result.ok) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-luna-ops-scheduler 실패:' });
}
