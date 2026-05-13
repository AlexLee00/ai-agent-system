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
      byProvider: [],
      byBudgetStatus: [],
      byTier: [],
      recentErrors: [],
    };
  }

  try {
    const [totals, byProvider, byBudgetStatus, byTier, recentErrors] = await Promise.all([
      pgPool.query('public', `
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE success IS FALSE)::int AS failures
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
        SELECT request_id, provider, caller_team, error, created_at
        FROM hub.llm_request_log
        WHERE created_at >= now() - ($1::int * interval '1 hour')
          AND success IS FALSE
        ORDER BY created_at DESC
        LIMIT 10
      `, [hours]),
    ]);

    return {
      ok: true,
      skipped: false,
      hours,
      total: Number(totals?.[0]?.total || 0),
      failures: Number(totals?.[0]?.failures || 0),
      byProvider,
      byBudgetStatus,
      byTier,
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
      byProvider: [],
      byBudgetStatus: [],
      byTier: [],
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
    const catalog = ownershipByLabel.get(label) || {};
    const loaded = Boolean(row);
    const expectedIdle = Boolean(catalog.expectedIdle || catalog.optional);
    const healthy = launchctl.skipped || Boolean(row?.running) || (expectedIdle && loaded);
    return {
      label,
      running: Boolean(row?.running),
      loaded,
      expectedIdle,
      healthy,
      pid: row?.pid || null,
      status: row?.status || null,
      checked: !launchctl.skipped,
    };
  });
  const missing = launchctl.skipped ? [] : labels.filter((item) => !item.healthy).map((item) => item.label);
  return {
    ok: launchctl.ok && missing.length === 0,
    launchctlAvailable: launchctl.ok,
    skipped: launchctl.skipped,
    error: launchctl.error,
    protectedCount: PROTECTED_HUB_LABELS.length,
    running: labels.filter((item) => item.running).length,
    healthy: labels.filter((item) => item.healthy).length,
    missing,
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

  if (report.sentry?.mode === 'adapter_ready_config_pending') {
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
        'budget_guard_status',
        'llm_error_rate',
        'protected_launchd_status',
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
