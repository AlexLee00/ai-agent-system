// @ts-nocheck
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../../../..');
const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
const { BudgetGuardian } = require('../budget-guardian');
const { getAllCircuitStatuses } = require(path.join(PROJECT_ROOT, 'packages/core/lib/local-circuit-breaker'));

const HUB_DIR = path.join(PROJECT_ROOT, 'bots/hub');
const OUTPUT_PATH = path.join(HUB_DIR, 'output', 'hub-stage-b-stability-report.json');

const PROTECTED_HUB_LABELS = [
  'ai.hub.resource-api',
  'ai.hub.llm-oauth-monitor',
  'ai.hub.llm-oauth4-master-review',
  'ai.hub.llm-groq-fallback-test',
  'ai.hub.llm-model-check',
  'ai.hub.llm-cache-cleanup',
  'ai.hub.incident-summary',
  'ai.hub.severity-decay',
  'ai.hub.noisy-producer-auto-learn',
  'ai.hub.roundtable-reflection',
  'ai.hub.daily-metrics-digest',
  'ai.hub.hourly-status-digest',
  'ai.hub.weekly-audit-digest',
  'ai.hub.weekly-advisory-digest',
];

const EXPECTED_IDLE_DIAGNOSTICS = {
  'ai.hub.noisy-producer-auto-learn': {
    dryRunCommand: 'npm --prefix bots/hub run -s alarm:noisy-producer-auto-learn:dry-run',
  },
  'ai.hub.roundtable-reflection': {
    dryRunCommand: 'npm --prefix bots/hub run -s alarm:roundtable-reflection:dry-run',
  },
  'ai.hub.weekly-advisory-digest': {
    dryRunCommand: 'npm --prefix bots/hub run -s alarm:weekly-advisory-digest:dry-run',
  },
};

function readText(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

function hasText(relativePath, pattern) {
  return pattern.test(readText(relativePath));
}

function parseLaunchctlList(text) {
  const rows = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const label = parts.slice(2).join(' ');
    if (!label) continue;
    rows.set(label, {
      label,
      pid: parts[0] === '-' ? null : Number(parts[0]),
      status: parts[1],
      running: parts[0] !== '-' && Number.isFinite(Number(parts[0])) && Number(parts[0]) > 0,
    });
  }
  return rows;
}

function readLaunchctlStatus(skipLaunchctl = false) {
  if (skipLaunchctl) {
    return {
      ok: true,
      skipped: true,
      rows: new Map(),
      error: null,
    };
  }
  try {
    const text = execFileSync('launchctl', ['list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return {
      ok: true,
      skipped: false,
      rows: parseLaunchctlList(text),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      rows: new Map(),
      error: String(error?.message || error),
    };
  }
}

function readLaunchctlPrintState(label) {
  try {
    const target = `gui/${process.getuid ? process.getuid() : execFileSync('id', ['-u'], { encoding: 'utf8' }).trim()}/${label}`;
    const text = execFileSync('launchctl', ['print', target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const stateMatch = text.match(/^\s*state = (.+)$/m);
    const pidMatch = text.match(/^\s*pid = (\d+)$/m);
    const signalMatch = text.match(/^\s*last terminating signal = (.+)$/m);
    const runsMatch = text.match(/^\s*runs = (\d+)$/m);
    return {
      loaded: true,
      state: stateMatch ? stateMatch[1].trim() : null,
      running: stateMatch ? stateMatch[1].trim() === 'running' : false,
      pid: pidMatch ? Number(pidMatch[1]) : null,
      lastTerminatingSignal: signalMatch ? signalMatch[1].trim() : null,
      runs: runsMatch ? Number(runsMatch[1]) : null,
    };
  } catch {
    return null;
  }
}

function buildExpectedIdleDiagnostic(label) {
  const defaultErrorLogPath = `/tmp/${label.replace(/^ai\.hub\./, 'hub-')}.err.log`;
  const diagnostic = EXPECTED_IDLE_DIAGNOSTICS[label] || {};
  const errorLogPath = diagnostic.errorLogPath || defaultErrorLogPath;
  let errorLog = {
    path: errorLogPath,
    exists: false,
    sizeBytes: 0,
    modifiedAt: null,
  };
  try {
    const stat = fs.statSync(errorLogPath);
    errorLog = {
      path: errorLogPath,
      exists: true,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  } catch {
    // Missing stderr logs are still useful evidence for expected-idle jobs.
  }
  const tailCommand = `tail -n 120 ${errorLogPath}`;
  return {
    dryRunCommand: diagnostic.dryRunCommand || null,
    tailCommand,
    errorLog,
    currentVerification: diagnostic.dryRunCommand ? 'dry_run_available' : 'log_review_only',
  };
}

function buildSelectorEnforcement() {
  const llmRouteSource = readText('bots/hub/lib/routes/llm.ts');
  const unifiedCallerSource = readText('bots/hub/lib/llm/unified-caller.ts');
  const runtimeProfilesSource = readText('bots/hub/lib/runtime-profiles.ts');

  const checks = [
    {
      name: 'hub_facade_present',
      ok: fs.existsSync(path.join(HUB_DIR, 'src/llm-selector.ts'))
        && hasText('bots/hub/src/llm-selector.ts', /resolveHubLlmSelection/)
        && hasText('bots/hub/src/llm-selector.ts', /isHubLlmRouteTargetAllowed/),
    },
    {
      name: 'sync_call_target_policy',
      ok: /llmCallRoute[\s\S]*isHubLlmRouteTargetAllowed/.test(llmRouteSource),
    },
    {
      name: 'async_job_target_policy',
      ok: /llmJobsCreateRoute[\s\S]*isHubLlmRouteTargetAllowed/.test(llmRouteSource),
    },
    {
      name: 'direct_provider_routes_blocked_by_default',
      ok: /direct_llm_provider_route_disabled/.test(llmRouteSource)
        && /directProviderRoutesEnabled/.test(llmRouteSource),
    },
    {
      name: 'adhoc_chain_blocked_by_default',
      ok: /llm_adhoc_chain_blocked/.test(unifiedCallerSource)
        && /HUB_LLM_ALLOW_ADHOC_CHAIN/.test(unifiedCallerSource),
    },
    {
      name: 'runtime_profiles_selector_backed',
      ok: !/primary_routes\s*:\s*\[/.test(runtimeProfilesSource)
        && !/fallback_routes\s*:\s*\[/.test(runtimeProfilesSource)
        && !/LLM_(OPENAI|GROQ|GEMINI)_/.test(runtimeProfilesSource),
    },
  ];

  return {
    ok: checks.every((item) => item.ok),
    sourceOfTruth: 'packages/core/lib/llm-model-selector.ts + bots/hub/src/llm-selector.ts facade',
    checks,
  };
}

async function buildRequestLogSummary(skipDb = false, hours = 24) {
  if (skipDb) {
    return {
      ok: true,
      skipped: true,
      hours,
      total: 0,
      failures: 0,
      failureRatePct: 0,
      byProvider: [],
      byBudgetStatus: [],
      byTier: [],
      avgDurationMs: 0,
      maxDurationMs: 0,
      latencyByProvider: [],
      slowRoutes: [],
      recentErrors: [],
    };
  }

  try {
    const [
      totals,
      byProvider,
      byBudgetStatus,
      byTier,
      latencyByProvider,
      slowRoutes,
      recentErrors,
    ] = await Promise.all([
      pgPool.query('public', `
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE success IS FALSE)::int AS failures,
               count(*) FILTER (
                 WHERE success IS FALSE
                   AND NOT EXISTS (
                     SELECT 1
                     FROM hub.llm_request_log s
                     WHERE s.created_at > hub.llm_request_log.created_at
                       AND s.success IS TRUE
                       AND COALESCE(s.caller_team, '') = COALESCE(hub.llm_request_log.caller_team, '')
                       AND COALESCE(s.agent, '') = COALESCE(hub.llm_request_log.agent, '')
                       AND COALESCE(s.abstract_model, '') = COALESCE(hub.llm_request_log.abstract_model, '')
                   )
               )::int AS unresolved_failures,
               COALESCE(ROUND(AVG(duration_ms))::int, 0) AS avg_duration_ms,
               COALESCE(MAX(duration_ms)::int, 0) AS max_duration_ms
        FROM hub.llm_request_log
        WHERE created_at >= now() - ($1::int * interval '1 hour')
      `, [hours]),
      pgPool.query('public', `
        SELECT provider, count(*)::int AS count, COALESCE(sum(cost_usd), 0)::float AS cost_usd
        FROM hub.llm_request_log
        WHERE created_at >= now() - ($1::int * interval '1 hour')
        GROUP BY provider
        ORDER BY count DESC, provider
      `, [hours]),
      pgPool.query('public', `
        SELECT COALESCE(NULLIF(budget_guard_status, ''), 'unknown') AS budget_guard_status,
               count(*)::int AS count
        FROM hub.llm_request_log
        WHERE created_at >= now() - ($1::int * interval '1 hour')
        GROUP BY COALESCE(NULLIF(budget_guard_status, ''), 'unknown')
        ORDER BY count DESC
      `, [hours]),
      pgPool.query('public', `
        SELECT COALESCE(NULLIF(provider_tier, ''), 'unknown') AS provider_tier,
               count(*)::int AS count
        FROM hub.llm_request_log
        WHERE created_at >= now() - ($1::int * interval '1 hour')
        GROUP BY COALESCE(NULLIF(provider_tier, ''), 'unknown')
        ORDER BY provider_tier
      `, [hours]),
      pgPool.query('public', `
        SELECT COALESCE(NULLIF(provider, ''), 'unknown') AS provider,
               count(*)::int AS count,
               count(*) FILTER (WHERE success IS FALSE)::int AS failures,
               COALESCE(ROUND(AVG(duration_ms))::int, 0) AS avg_duration_ms,
               COALESCE(MAX(duration_ms)::int, 0) AS max_duration_ms,
               COALESCE(ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms))::int, 0) AS p95_duration_ms
        FROM hub.llm_request_log
        WHERE created_at >= now() - ($1::int * interval '1 hour')
          AND duration_ms IS NOT NULL
        GROUP BY COALESCE(NULLIF(provider, ''), 'unknown')
        ORDER BY avg_duration_ms DESC, count DESC, provider
      `, [hours]),
      pgPool.query('public', `
        SELECT COALESCE(NULLIF(selected_route, ''), CONCAT(COALESCE(NULLIF(provider, ''), 'unknown'), '/', COALESCE(NULLIF(abstract_model, ''), 'unknown'))) AS route,
               COALESCE(NULLIF(provider, ''), 'unknown') AS provider,
               COALESCE(NULLIF(caller_team, ''), 'unknown') AS caller_team,
               COALESCE(NULLIF(agent, ''), 'unknown') AS agent,
               COALESCE(NULLIF(abstract_model, ''), 'unknown') AS abstract_model,
               COALESCE(NULLIF(runtime_purpose, ''), 'unknown') AS runtime_purpose,
               COALESCE(NULLIF(provider_tier, ''), 'unknown') AS provider_tier,
               count(*)::int AS count,
               count(*) FILTER (WHERE success IS FALSE)::int AS failures,
               COALESCE(ROUND(AVG(duration_ms))::int, 0) AS avg_duration_ms,
               COALESCE(MAX(duration_ms)::int, 0) AS max_duration_ms,
               COALESCE(ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms))::int, 0) AS p95_duration_ms
        FROM hub.llm_request_log
        WHERE created_at >= now() - ($1::int * interval '1 hour')
          AND duration_ms IS NOT NULL
        GROUP BY
          COALESCE(NULLIF(selected_route, ''), CONCAT(COALESCE(NULLIF(provider, ''), 'unknown'), '/', COALESCE(NULLIF(abstract_model, ''), 'unknown'))),
          COALESCE(NULLIF(provider, ''), 'unknown'),
          COALESCE(NULLIF(caller_team, ''), 'unknown'),
          COALESCE(NULLIF(agent, ''), 'unknown'),
          COALESCE(NULLIF(abstract_model, ''), 'unknown'),
          COALESCE(NULLIF(runtime_purpose, ''), 'unknown'),
          COALESCE(NULLIF(provider_tier, ''), 'unknown')
        HAVING count(*) >= 5
        ORDER BY avg_duration_ms DESC, p95_duration_ms DESC, count DESC
        LIMIT 10
      `, [hours]),
      pgPool.query('public', `
        SELECT f.request_id,
               f.provider,
               f.caller_team,
               f.agent,
               f.abstract_model,
               f.error,
               f.created_at,
               EXISTS (
                 SELECT 1
                 FROM hub.llm_request_log s
                 WHERE s.created_at > f.created_at
                   AND s.success IS TRUE
                   AND COALESCE(s.caller_team, '') = COALESCE(f.caller_team, '')
                   AND COALESCE(s.agent, '') = COALESCE(f.agent, '')
                   AND COALESCE(s.abstract_model, '') = COALESCE(f.abstract_model, '')
               ) AS resolved_by_later_success
        FROM hub.llm_request_log f
        WHERE f.created_at >= now() - ($1::int * interval '1 hour')
          AND f.success IS FALSE
        ORDER BY f.created_at DESC
        LIMIT 10
      `, [hours]),
    ]);

    const total = Number(totals?.[0]?.total || 0);
    const failures = Number(totals?.[0]?.failures || 0);
    return {
      ok: true,
      skipped: false,
      hours,
      total,
      failures,
      failureRatePct: total > 0 ? Number(((failures / total) * 100).toFixed(4)) : 0,
      unresolvedFailures: Number(totals?.[0]?.unresolved_failures || 0),
      byProvider,
      byBudgetStatus,
      byTier,
      avgDurationMs: Number(totals?.[0]?.avg_duration_ms || 0),
      maxDurationMs: Number(totals?.[0]?.max_duration_ms || 0),
      latencyByProvider,
      slowRoutes,
      recentErrors,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      hours,
      error: String(error?.message || error),
      total: 0,
      failures: 0,
      failureRatePct: 0,
      byProvider: [],
      byBudgetStatus: [],
      byTier: [],
      avgDurationMs: 0,
      maxDurationMs: 0,
      latencyByProvider: [],
      slowRoutes: [],
      recentErrors: [],
    };
  }
}

function buildProtectedStatus(options = {}) {
  const launchctl = readLaunchctlStatus(Boolean(options.skipLaunchctl));
  let ownership = [];
  try {
    ownership = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'packages/core/config/service-ownership.json'), 'utf8'));
  } catch {
    ownership = [];
  }
  const ownershipByLabel = new Map(ownership.map((entry) => [entry.label, entry]));
  const labels = PROTECTED_HUB_LABELS.map((label) => {
    const row = launchctl.rows.get(label);
    const detail = launchctl.skipped ? null : readLaunchctlPrintState(label);
    const catalog = ownershipByLabel.get(label) || {};
    const loaded = Boolean(row || detail?.loaded);
    const expectedIdle = Boolean(catalog.expectedIdle || catalog.optional);
    const running = Boolean(detail?.running || row?.running);
    const pid = detail?.pid || row?.pid || null;
    const historicalExitStatus = running && row?.status && row.status !== '0' ? row.status : null;
    const idleExitStatus = !running && expectedIdle && loaded && row?.status && row.status !== '0'
      ? row.status
      : null;
    const healthy = launchctl.skipped || running || (expectedIdle && loaded);
    return {
      label,
      running,
      loaded,
      expectedIdle,
      healthy,
      pid,
      state: detail?.state || (running ? 'running' : null),
      status: running ? 'running' : row?.status || null,
      lastLaunchctlListStatus: row?.status || null,
      historicalExitStatus,
      idleExitStatus,
      attention: Boolean(idleExitStatus),
      lastTerminatingSignal: detail?.lastTerminatingSignal || null,
      runs: detail?.runs || null,
      checked: !launchctl.skipped,
    };
  });
  const missing = launchctl.skipped ? [] : labels.filter((item) => !item.healthy).map((item) => item.label);
  const idleExitWarnings = launchctl.skipped
    ? []
    : labels
        .filter((item) => item.idleExitStatus)
        .map((item) => ({
          label: item.label,
          exitStatus: item.idleExitStatus,
          runs: item.runs,
          lastTerminatingSignal: item.lastTerminatingSignal,
          reason: 'expected-idle launchd job is loaded but last run exited non-zero',
          diagnostic: buildExpectedIdleDiagnostic(item.label),
        }));
  return {
    ok: launchctl.ok && missing.length === 0,
    launchctlAvailable: launchctl.ok,
    skipped: launchctl.skipped,
    error: launchctl.error,
    protectedCount: PROTECTED_HUB_LABELS.length,
    running: labels.filter((item) => item.running).length,
    healthy: labels.filter((item) => item.healthy).length,
    attention: idleExitWarnings.length,
    missing,
    idleExitWarnings,
    labels,
  };
}

function buildSentryReadiness() {
  const configured = Boolean(process.env.SENTRY_DSN || process.env.SENTRY_AUTH_TOKEN);
  return {
    ok: true,
    mode: configured ? 'configured' : 'adapter_ready_config_pending',
    configured,
    mcpTooling: 'optional',
    contract: {
      errorCapture: 'Hub incidents remain primary; Sentry MCP enriches stack/user-impact evidence when configured.',
      noSecretLogging: true,
      failClosedOnMissingToken: true,
    },
  };
}

function buildCircuitSummary() {
  try {
    const statuses = getAllCircuitStatuses();
    const entries = Object.entries(statuses || {}).map(([provider, status]) => ({
      provider,
      state: status?.state || 'unknown',
      failures: Number(status?.failures || status?.failureCount || 0),
    }));
    return {
      ok: true,
      total: entries.length,
      nonClosed: entries.filter((item) => item.state !== 'CLOSED').length,
      entries,
    };
  } catch (error) {
    return {
      ok: false,
      total: 0,
      nonClosed: 0,
      error: String(error?.message || error),
      entries: [],
    };
  }
}

function buildBudgetSummary() {
  try {
    const usage = BudgetGuardian.getInstance().getCurrentUsage();
    return {
      ok: !usage.emergency,
      globalUsedUsd: usage.global_used,
      globalLimitUsd: usage.global_limit,
      globalRatio: usage.global_ratio,
      emergency: usage.emergency,
      teams: usage.teams,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
    };
  }
}

function envFlag(name) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function buildSelfHealingPlan(report) {
  const safeReadOnlyActions = [];
  const confirmRequiredActions = [];
  const prohibitedActions = [
    'launchctl bootout/unload/kickstart -k on PROTECTED labels',
    'kill protected Hub PID',
    'secret mutation without explicit operator approval',
    'direct provider route enablement in production',
  ];

  if ((report.circuits?.nonClosed || 0) > 0) {
    safeReadOnlyActions.push({
      action: 'tier_probe',
      reason: 'non-closed provider circuits detected',
      command: 'npm --prefix bots/hub run -s hub:stage-b-self-healing -- --apply --confirm=hub-stage-b-self-healing --action=tier_probe',
      effect: 'calls /hub/llm/tier-probe; does not restart protected services',
    });
  }

  for (const label of report.protected?.missing || []) {
    confirmRequiredActions.push({
      action: 'protected_service_recovery',
      label,
      reason: 'protected Hub label is not running',
      command: `launchctl print gui/$(id -u)/${label}`,
      effect: 'diagnostic only; restart requires separate explicit approval',
    });
  }

  for (const warning of report.protected?.idleExitWarnings || []) {
    const dryRunCommand = warning.diagnostic?.dryRunCommand || null;
    safeReadOnlyActions.push({
      action: 'expected_idle_exit_status_review',
      label: warning.label,
      reason: `expected-idle Hub launchd job last exited with status ${warning.exitStatus}`,
      command: dryRunCommand || warning.diagnostic?.tailCommand || `tail -n 120 /tmp/${warning.label.replace(/^ai\.hub\./, 'hub-')}.err.log`,
      evidenceCommand: warning.diagnostic?.tailCommand || null,
      effect: dryRunCommand
        ? 'safe dry-run verifies current script path without external sends; restart or unload still requires separate explicit approval'
        : 'read-only log review; restart or unload still requires separate explicit approval',
    });
  }

  if (report.budget?.emergency) {
    confirmRequiredActions.push({
      action: 'billing_guard_review',
      reason: 'BudgetGuardian emergency state detected',
      command: 'npm --prefix bots/hub run -s llm:oauth4-master-review:strict',
      effect: 'read-only review before any route/tier changes',
    });
  }

  if (!report.requestLog?.ok) {
    safeReadOnlyActions.push({
      action: 'request_log_diagnostics',
      reason: 'hub.llm_request_log summary failed',
      command: 'npm --prefix bots/hub run -s llm:stage-a-request-log-smoke',
      effect: 'validates DB view and metadata contract',
    });
  }

  if ((report.requestLog?.unresolvedFailures || 0) > 0) {
    safeReadOnlyActions.push({
      action: 'targeted_llm_route_drill',
      reason: 'unresolved LLM request failures exist in hub.llm_request_log',
      command: 'npm --prefix bots/hub run -s team:agent-llm-drill:live -- --teams=<team> --primary-only',
      effect: 'verifies the affected agent route without mutating protected services',
    });
  }

  if (envFlag('HUB_STAGE_B_REQUIRE_SENTRY_MCP') && report.sentry?.mode === 'adapter_ready_config_pending') {
    safeReadOnlyActions.push({
      action: 'sentry_mcp_config_review',
      reason: 'Sentry MCP enrichment is not configured; Hub incident system remains primary',
      command: 'npm --prefix bots/hub run -s llm:stage-b-observability-smoke',
      effect: 'validates fail-closed observability contract',
    });
  }

  return {
    ok: confirmRequiredActions.length === 0,
    mode: 'read_only_by_default',
    safeReadOnlyActions,
    confirmRequiredActions,
    prohibitedActions,
  };
}

async function buildHubStageBStabilityReport(options = {}) {
  const checkedAt = new Date().toISOString();
  const selectorEnforcement = buildSelectorEnforcement();
  const protectedStatus = buildProtectedStatus(options);
  const requestLog = await buildRequestLogSummary(Boolean(options.skipDb), Number(options.hours || 24));
  const circuits = buildCircuitSummary();
  const budget = buildBudgetSummary();
  const sentry = buildSentryReadiness();

  const report = {
    ok: false,
    checkedAt,
    stage: 'hub_stage_b',
    status: 'stage_b_pending',
    goals: {
      hubSelectorAgentForced: selectorEnforcement.ok,
      unifiedSelector: selectorEnforcement.ok,
      observabilityDashboard: true,
      sentryMcpReady: sentry.ok,
      selfHealingReadOnlyReady: true,
    },
    selectorEnforcement,
    protected: protectedStatus,
    requestLog,
    circuits,
    budget,
    sentry,
    dashboard: {
      type: 'json',
      outputPath: OUTPUT_PATH,
      refreshCommand: 'npm --prefix bots/hub run -s hub:stage-b-stability-report -- --write',
      panels: [
        'provider_tier_usage',
        'provider_latency_hotspots',
        'budget_guard_status',
        'llm_error_rate',
        'protected_launchd_status',
        'expected_idle_exit_diagnostics',
        'oauth_and_sentry_readiness',
        'self_healing_action_plan',
      ],
    },
  };

  report.selfHealing = buildSelfHealingPlan(report);
  report.ok = Boolean(
    report.selectorEnforcement.ok
    && report.requestLog.ok
    && report.protected.ok
    && report.sentry.ok
    && report.selfHealing.ok
  );
  report.status = report.ok ? 'stage_b_operational_ready' : 'stage_b_attention';
  return report;
}

async function writeHubStageBStabilityReport(report, outputPath = OUTPUT_PATH) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return outputPath;
}

module.exports = {
  PROTECTED_HUB_LABELS,
  OUTPUT_PATH,
  buildHubStageBStabilityReport,
  buildSelfHealingPlan,
  writeHubStageBStabilityReport,
};
