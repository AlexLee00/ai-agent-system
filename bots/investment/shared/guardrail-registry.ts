// @ts-nocheck
import { spawn } from 'node:child_process';

export const GUARDRAIL_CATEGORIES = ['safety', 'runtime', 'data', 'trading', 'post_trade', 'integrity'];

const CORE_GUARDRAILS = [
  {
    name: 'luna_l5_readiness',
    category: 'safety',
    severity: 'critical',
    owner: 'luna',
    command: ['node', 'scripts/luna-l5-readiness-report.ts', '--json'],
  },
  {
    name: 'luna_capital_state_report',
    category: 'safety',
    severity: 'high',
    owner: 'luna',
    command: ['node', 'scripts/runtime-luna-capital-state-report.ts', '--json'],
  },
  {
    name: 'intelligent_discovery',
    category: 'trading',
    severity: 'high',
    owner: 'scout',
    command: ['npm', '--prefix', new URL('..', import.meta.url).pathname, 'run', '-s', 'check:intelligent-discovery'],
  },
  {
    name: 'luna_technical_analysis_boost',
    category: 'trading',
    severity: 'high',
    owner: 'aria',
    command: ['npm', '--prefix', new URL('..', import.meta.url).pathname, 'run', '-s', 'check:luna-technical-analysis-boost'],
  },
  {
    name: 'posttrade_feedback',
    category: 'data',
    severity: 'high',
    owner: 'chronos',
    command: ['npm', '--prefix', new URL('..', import.meta.url).pathname, 'run', '-s', 'check:posttrade-feedback'],
  },
  {
    name: 'agent_memory_routing',
    category: 'runtime',
    severity: 'medium',
    owner: 'luna',
    command: ['npm', '--prefix', new URL('..', import.meta.url).pathname, 'run', '-s', 'check:agent-memory-routing'],
  },
  {
    name: 'omega_completion',
    category: 'runtime',
    severity: 'medium',
    owner: 'luna',
    command: ['npm', '--prefix', new URL('..', import.meta.url).pathname, 'run', '-s', 'check:luna-final-omega'],
  },
  {
    name: 'luna_full_integration_closure_gate',
    category: 'safety',
    severity: 'critical',
    owner: 'luna',
    command: ['node', 'scripts/runtime-luna-full-integration-closure-gate.ts', '--json'],
  },
  {
    name: 'luna_operational_blocker_pack',
    category: 'safety',
    severity: 'critical',
    owner: 'luna',
    command: ['node', 'scripts/runtime-luna-operational-blocker-pack.ts', '--json'],
  },
  {
    name: 'luna_reconcile_blockers',
    category: 'trading',
    severity: 'critical',
    owner: 'hephaestos',
    command: ['node', 'scripts/luna-reconcile-blocker-report.ts', '--json'],
  },
  {
    name: 'luna_reconcile_evidence_pack',
    category: 'trading',
    severity: 'critical',
    owner: 'hephaestos',
    command: ['node', 'scripts/runtime-luna-reconcile-evidence-pack.ts', '--json'],
  },
  {
    name: 'luna_reconcile_ack_preflight',
    category: 'trading',
    severity: 'critical',
    owner: 'hephaestos',
    command: ['node', 'scripts/luna-reconcile-ack-preflight.ts', '--json'],
  },
  {
    name: 'luna_live_fire_final_gate',
    category: 'safety',
    severity: 'critical',
    owner: 'luna',
    command: ['node', 'scripts/luna-live-fire-final-gate.ts', '--json'],
  },
  {
    name: 'agent_message_bus_hygiene',
    category: 'runtime',
    severity: 'medium',
    owner: 'luna',
    command: ['node', 'scripts/runtime-agent-message-bus-hygiene.ts', '--dry-run', '--json'],
  },
  {
    name: 'luna_curriculum_bootstrap_plan',
    category: 'runtime',
    severity: 'medium',
    owner: 'luna',
    command: ['node', 'scripts/runtime-luna-curriculum-bootstrap.ts', '--json'],
  },
  {
    name: 'luna_launchd_cutover_preflight_pack',
    category: 'runtime',
    severity: 'high',
    owner: 'luna',
    command: ['node', 'scripts/runtime-luna-launchd-cutover-preflight-pack.ts', '--json'],
  },
  {
    name: 'luna_7day_observation',
    category: 'data',
    severity: 'medium',
    owner: 'luna',
    command: ['node', 'scripts/runtime-luna-7day-report.ts', '--json', '--no-write'],
  },
  {
    name: 'luna_memory_llm_routing_final',
    category: 'runtime',
    severity: 'medium',
    owner: 'luna',
    command: ['npm', '--prefix', new URL('..', import.meta.url).pathname, 'run', '-s', 'check:luna-memory-llm-routing-final'],
  },
  {
    name: 'failed_signal_reflexion_backfill_dryrun',
    category: 'data',
    severity: 'medium',
    owner: 'luna',
    command: ['node', 'scripts/runtime-failed-reflexion-backfill.ts', '--json'],
  },
  {
    name: 'luna_agent_bus_stats',
    category: 'runtime',
    severity: 'low',
    owner: 'luna',
    command: ['node', 'scripts/runtime-agent-bus-stats.ts', '--json'],
  },
  {
    name: 'luna_7day_checkpoint',
    category: 'data',
    severity: 'medium',
    owner: 'luna',
    command: ['node', 'scripts/runtime-luna-7day-checkpoint.ts', '--json'],
  },
  {
    name: 'luna_final_closure_wave2',
    category: 'runtime',
    severity: 'high',
    owner: 'luna',
    command: ['npm', '--prefix', new URL('..', import.meta.url).pathname, 'run', '-s', 'check:luna-final-closure-wave2'],
  },
  {
    name: 'luna_daily_backtest_dry_run',
    category: 'data',
    severity: 'medium',
    owner: 'chronos',
    command: ['node', 'scripts/runtime-luna-daily-backtest.ts', '--json', '--dry-run', '--smoke'],
  },
  {
    name: 'luna_final_closure_wave3',
    category: 'runtime',
    severity: 'high',
    owner: 'luna',
    command: ['npm', '--prefix', new URL('..', import.meta.url).pathname, 'run', '-s', 'check:luna-final-closure-wave3'],
  },
  {
    name: 'luna_skill_registry',
    category: 'runtime',
    severity: 'medium',
    owner: 'luna',
    command: ['node', 'scripts/luna-skill-registry-smoke.ts', '--json'],
  },
  {
    name: 'luna_launchd_migrate_dryrun',
    category: 'safety',
    severity: 'high',
    owner: 'luna',
    command: ['node', 'scripts/runtime-luna-launchd-migrate.ts', '--json'],
  },
  {
    name: 'luna_guardrails_hourly_dryrun',
    category: 'safety',
    severity: 'high',
    owner: 'sentinel',
    command: ['node', 'scripts/runtime-luna-guardrails-hourly.ts', '--json', '--no-write'],
  },
  {
    name: 'luna_trade_journal_dashboard',
    category: 'data',
    severity: 'medium',
    owner: 'luna',
    command: ['node', 'scripts/runtime-trade-journal-dashboard-html.ts', '--json', '--no-write'],
  },
  {
    name: 'luna_trade_analytics_report',
    category: 'data',
    severity: 'high',
    owner: 'chronos',
    command: ['npm', '--prefix', new URL('..', import.meta.url).pathname, 'run', '-s', 'check:luna-trade-analytics-report'],
  },
  {
    name: 'luna_trade_data_analysis_report',
    category: 'data',
    severity: 'high',
    owner: 'chronos',
    command: ['npm', '--prefix', new URL('..', import.meta.url).pathname, 'run', '-s', 'check:luna-trade-data-analysis-report'],
  },
  {
    name: 'luna_100percent_report',
    category: 'runtime',
    severity: 'medium',
    owner: 'luna',
    command: ['node', 'scripts/runtime-luna-100percent-report.ts', '--json', '--no-write'],
  },
  {
    name: 'luna_full_regression_summary',
    category: 'runtime',
    severity: 'medium',
    owner: 'luna',
    command: ['node', 'scripts/runtime-luna-full-regression.ts', '--json'],
  },
];

const POST_TRADE_GUARDRAILS = [
  {
    name: 'posttrade_evaluation_completion',
    category: 'post_trade',
    severity: 'high',
    owner: 'chronos',
    command: ['node', 'scripts/posttrade-completion-check.ts', '--json'],
  },
  {
    name: 'reflexion_extraction_rate',
    category: 'post_trade',
    severity: 'medium',
    owner: 'luna',
    command: ['node', 'scripts/reflexion-rate-check.ts', '--json'],
  },
  {
    name: 'voyager_skill_extraction',
    category: 'post_trade',
    severity: 'medium',
    owner: 'luna',
    command: ['node', 'scripts/voyager-extraction-check.ts', '--json'],
  },
  {
    name: 'realized_pnl_calculation',
    category: 'post_trade',
    severity: 'high',
    owner: 'sweeper',
    command: ['node', 'scripts/realized-pnl-check.ts', '--json'],
  },
  {
    name: 'trade_quality_distribution',
    category: 'post_trade',
    severity: 'medium',
    owner: 'chronos',
    command: ['node', 'scripts/trade-quality-distribution-check.ts', '--json'],
  },
  {
    name: 'posttrade_constitution_coverage',
    category: 'post_trade',
    severity: 'medium',
    owner: 'luna',
    command: ['node', 'scripts/posttrade-constitution-smoke.ts', '--json'],
  },
  {
    name: 'posttrade_skill_retrieval',
    category: 'post_trade',
    severity: 'medium',
    owner: 'chronos',
    command: ['node', 'scripts/posttrade-skill-retrieval-smoke.ts', '--json'],
  },
  {
    name: 'posttrade_action_staging',
    category: 'post_trade',
    severity: 'medium',
    owner: 'luna',
    command: ['node', 'scripts/posttrade-feedback-action-staging-smoke.ts', '--json'],
  },
  {
    name: 'posttrade_market_differentiation',
    category: 'post_trade',
    severity: 'medium',
    owner: 'chronos',
    command: ['node', 'scripts/posttrade-market-differentiated-smoke.ts', '--json'],
  },
  {
    name: 'trade_quality_evaluator_contract',
    category: 'post_trade',
    severity: 'medium',
    owner: 'chronos',
    command: ['node', 'scripts/trade-quality-evaluator-smoke.ts', '--json'],
  },
  {
    name: 'posttrade_dashboard_generation',
    category: 'post_trade',
    severity: 'low',
    owner: 'luna',
    command: ['node', 'scripts/posttrade-dashboard-smoke.ts', '--json'],
  },
  {
    name: 'posttrade_close_event_flow',
    category: 'post_trade',
    severity: 'medium',
    owner: 'hephaestos',
    command: ['node', 'scripts/posttrade-close-event-flow-smoke.ts', '--json'],
  },
];

const INTEGRITY_GUARDRAILS = [
  {
    name: 'wallet_db_consistency',
    category: 'integrity',
    severity: 'critical',
    owner: 'sweeper',
    command: ['node', 'scripts/sweeper-consistency-check.ts', '--json'],
  },
  {
    name: 'lifecycle_stage_completion',
    category: 'integrity',
    severity: 'high',
    owner: 'luna',
    command: ['node', 'scripts/lifecycle-completion-check.ts', '--json'],
  },
  {
    name: 'agent_yaml_19_loaded',
    category: 'integrity',
    severity: 'high',
    owner: 'luna',
    command: ['node', 'scripts/agent-yaml-19-check.ts', '--json'],
  },
  {
    name: 'elixir_supervisor_health',
    category: 'integrity',
    severity: 'critical',
    owner: 'system',
    command: ['node', 'scripts/elixir-supervisor-health.ts', '--json'],
  },
  {
    name: 'mcp_server_health',
    category: 'integrity',
    severity: 'medium',
    owner: 'system',
    command: ['node', 'scripts/mcp-server-health.ts', '--json'],
  },
  {
    name: 'db_schema_facade_compatibility',
    category: 'integrity',
    severity: 'high',
    owner: 'system',
    command: ['node', 'scripts/db-schema-facade-smoke.ts', '--json'],
  },
  {
    name: 'db_core_schema_compatibility',
    category: 'integrity',
    severity: 'high',
    owner: 'system',
    command: ['node', 'scripts/db-core-schema-smoke.ts', '--json'],
  },
  {
    name: 'position_sync_dust_policy',
    category: 'integrity',
    severity: 'medium',
    owner: 'sweeper',
    command: ['node', 'scripts/position-sync-dust-smoke.ts', '--json'],
  },
  {
    name: 'reconcile_open_journals',
    category: 'integrity',
    severity: 'high',
    owner: 'hephaestos',
    command: ['node', 'scripts/reconcile-open-journals-smoke.ts', '--json'],
  },
  {
    name: 'execution_fill_envelope',
    category: 'integrity',
    severity: 'high',
    owner: 'hephaestos',
    command: ['node', 'scripts/execution-fill-envelope-smoke.ts', '--json'],
  },
  {
    name: 'position_runtime_state_contract',
    category: 'integrity',
    severity: 'medium',
    owner: 'luna',
    command: ['node', 'scripts/position-runtime-state-smoke.ts', '--json'],
  },
  {
    name: 'luna_launchd_doctor',
    category: 'integrity',
    severity: 'medium',
    owner: 'system',
    command: ['node', 'scripts/luna-launchd-doctor.ts', '--json'],
  },
];

const DEFAULT_GUARDRAILS = [
  ...CORE_GUARDRAILS,
  ...POST_TRADE_GUARDRAILS,
  ...INTEGRITY_GUARDRAILS,
];

function normalizeEntry(entry = {}) {
  if (!GUARDRAIL_CATEGORIES.includes(entry.category)) throw new Error(`invalid guardrail category: ${entry.category}`);
  if (!entry.name || !Array.isArray(entry.command) || entry.command.length === 0) throw new Error('invalid guardrail entry');
  return {
    severity: 'medium',
    owner: 'luna',
    evidence: {},
    ...entry,
  };
}

export function createGuardrailRegistry(entries = DEFAULT_GUARDRAILS) {
  const normalized = entries.map(normalizeEntry);
  return {
    entries: normalized,
    list: (category = null) => category ? normalized.filter((entry) => entry.category === category) : [...normalized],
    get: (name) => normalized.find((entry) => entry.name === name) || null,
  };
}

function runCommand(command, { cwd = new URL('..', import.meta.url).pathname, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const [bin, ...args] = command;
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, exitCode: null, stdout, stderr: `${stderr}\nTIMEOUT ${timeoutMs}ms`.trim() });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, exitCode: code, stdout, stderr });
    });
  });
}

export async function runGuardrail(entry, opts = {}) {
  const normalized = normalizeEntry(entry);
  if (opts.dryRun !== false) {
    return {
      ok: true,
      dryRun: true,
      name: normalized.name,
      category: normalized.category,
      severity: normalized.severity,
      owner: normalized.owner,
      command: normalized.command,
      blockers: [],
      warnings: [],
      evidence: { registered: true },
    };
  }
  const result = await runCommand(normalized.command, opts);
  return {
    ok: result.ok,
    dryRun: false,
    name: normalized.name,
    category: normalized.category,
    severity: normalized.severity,
    owner: normalized.owner,
    command: normalized.command,
    blockers: result.ok ? [] : [`exit_code:${result.exitCode}`],
    warnings: result.stderr ? [result.stderr.slice(0, 500)] : [],
    evidence: { stdout: result.stdout.slice(0, 1000) },
  };
}

export async function runRegisteredGuardrails({ category = null, dryRun = true } = {}) {
  const registry = createGuardrailRegistry();
  const entries = registry.list(category);
  const results = [];
  for (const entry of entries) results.push(await runGuardrail(entry, { dryRun }));
  return {
    ok: results.every((result) => result.ok),
    total: results.length,
    passed: results.filter((result) => result.ok).length,
    results,
  };
}

export default {
  GUARDRAIL_CATEGORIES,
  createGuardrailRegistry,
  runGuardrail,
  runRegisteredGuardrails,
};
