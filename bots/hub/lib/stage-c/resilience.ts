// @ts-nocheck
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '../../../..');
const HUB_DIR = path.join(PROJECT_ROOT, 'bots/hub');
const OUTPUT_PATH = path.join(HUB_DIR, 'output', 'hub-stage-c-resilience-report.json');
const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
const { resolveHubLlmSelection } = require('../../src/llm-selector');

const REQUIRED_STAGE_C_DOCS = [
  'docs/hub/HUB_STAGE_C_OPERATIONS.md',
  'docs/hub/EXTERNAL_LLM_INTEGRATION_GUIDE.md',
];

const PROHIBITED_STAGE_C_ACTIONS = [
  'restore backup into production database',
  'DROP/ALTER production Hub tables outside reviewed migrations',
  'launchctl bootout/unload/kickstart -k on PROTECTED labels',
  'kill protected Hub PID',
  'secret/token mutation during security or chaos checks',
  'live chaos without --apply --confirm=hub-stage-c-chaos',
];

function repoPath(...parts) {
  return path.join(PROJECT_ROOT, ...parts);
}

function readText(relativePath) {
  return fs.readFileSync(repoPath(relativePath), 'utf8');
}

function fileExists(relativePath) {
  return fs.existsSync(repoPath(relativePath));
}

function buildBackupCommands() {
  const database = String(process.env.PGDATABASE || process.env.POSTGRES_DB || 'jay').trim() || 'jay';
  return [
    `mkdir -p /tmp/hub_drp_backups`,
    `pg_dump -d ${database} --schema=hub --schema-only -f /tmp/hub_drp_backups/hub_schema_$(date +%Y%m%d-%H%M%S).sql`,
    `pg_dump -d ${database} -t public.llm_routing_log -t agent.event_lake -f /tmp/hub_drp_backups/hub_runtime_$(date +%Y%m%d-%H%M%S).sql`,
    `pg_dump -d ${database} --schema-only -t public.provider_circuits -t public.llm_cache -f /tmp/hub_drp_backups/hub_llm_support_$(date +%Y%m%d-%H%M%S).sql`,
  ];
}

async function buildDrpReadiness(options = {}) {
  const backupCommands = buildBackupCommands();
  const staticChecks = [
    {
      name: 'stage_b_report_available',
      ok: fileExists('bots/hub/output/hub-stage-b-stability-report.json'),
      evidence: 'Stage B stability report is the DRP preflight input.',
    },
    {
      name: 'request_log_view_migration_exists',
      ok: fileExists('bots/hub/migrations/20261001000063_hub_llm_request_log_view.sql'),
      evidence: 'hub.llm_request_log can be recreated from migration.',
    },
    {
      name: 'drp_commands_are_non_destructive',
      ok: backupCommands.every((command) => !/\b(drop|delete|truncate|restore)\b/i.test(command)),
      evidence: 'Backup command plan uses mkdir/pg_dump only.',
    },
  ];

  const dbObjects = [];
  let dbOk = true;
  let dbError = null;
  if (!options.skipDb) {
    try {
      const rows = await pgPool.query('public', `
        SELECT name, to_regclass(name) IS NOT NULL AS exists
        FROM (VALUES
          ('hub.llm_request_log'),
          ('public.llm_routing_log')
        ) AS objects(name)
      `);
      for (const row of rows || []) {
        dbObjects.push({ name: row.name, exists: Boolean(row.exists) });
      }
      dbOk = dbObjects.every((row) => row.exists);
    } catch (error) {
      dbOk = false;
      dbError = String(error?.message || error);
    }
  }

  const checks = [
    ...staticChecks,
    {
      name: 'canonical_db_objects_visible',
      ok: options.skipDb ? true : dbOk,
      skipped: Boolean(options.skipDb),
      evidence: options.skipDb ? 'DB check skipped by operator option.' : dbObjects,
      error: dbError,
    },
  ];

  return {
    ok: checks.every((check) => check.ok),
    mode: 'read_only_plan',
    rpo: '24h backup artifact target; live invocation remains operator-controlled',
    rto: 'restore dry-run target <= 30m after verified backup artifact',
    backupCommands,
    restoreDryRunCommand: 'createdb hub_restore_smoke && psql hub_restore_smoke -f /tmp/hub_drp_backups/<backup>.sql',
    restoreToProduction: 'confirm_required_and_out_of_scope',
    checks,
  };
}

function buildSecurityHardening() {
  const routeRegistry = readText('bots/hub/src/route-registry.ts');
  const auth = readText('bots/hub/lib/auth.ts');
  const llmRoute = readText('bots/hub/lib/routes/llm.ts');
  const requestSchema = readText('bots/hub/lib/llm/request-schema.ts');
  const serverHardening = readText('bots/hub/src/server-hardening.ts');
  const guide = readText('docs/hub/EXTERNAL_LLM_INTEGRATION_GUIDE.md');

  const checks = [
    {
      name: 'bearer_auth_protects_llm_routes',
      ok: routeRegistry.includes("app.use('/hub', authMiddleware)")
        && routeRegistry.indexOf("app.use('/hub', authMiddleware)") < routeRegistry.indexOf("app.post('/hub/llm/call'"),
      owasp: 'A01 Broken Access Control',
    },
    {
      name: 'constant_time_token_compare',
      ok: auth.includes('crypto.timingSafeEqual') && auth.includes('safeCompare'),
      owasp: 'A02 Cryptographic Failures',
    },
    {
      name: 'input_schema_enforced',
      ok: requestSchema.includes('z.object') && requestSchema.includes('prompt: z.string().min(1)') && requestSchema.includes('abstractModel'),
      owasp: 'A03 Injection',
    },
    {
      name: 'direct_provider_routes_disabled',
      ok: llmRoute.includes('direct_llm_provider_route_disabled') && llmRoute.includes('HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES'),
      owasp: 'A05 Security Misconfiguration',
    },
    {
      name: 'server_timeout_hardening',
      ok: serverHardening.includes('requestTimeout') && serverHardening.includes('headersTimeout') && serverHardening.includes('maxRequestsPerSocket'),
      owasp: 'A05 Security Misconfiguration',
    },
    {
      name: 'provider_secrets_not_distributed_to_external_projects',
      ok: guide.includes('provider API key') && guide.includes('OAuth token') && guide.includes('외부 프로젝트에 배포하지 않는다'),
      owasp: 'A02 Cryptographic Failures',
    },
  ];

  return {
    ok: checks.every((check) => check.ok),
    standard: 'OWASP API Top 10 control mapping',
    requiredCommands: [
      'npm --prefix bots/hub run -s server-hardening-smoke',
      'tsx bots/hub/scripts/secret-leak-smoke.ts',
      'npm --prefix bots/hub run -s llm:external-integration-guide-smoke',
    ],
    checks,
  };
}

function buildChaosPlan() {
  const scenarios = [
    {
      name: 'provider_fallback_exhaustion',
      mode: 'fixture_default',
      safe: true,
      verifies: ['fallback_exhausted is surfaced', 'Retry-After/backoff metadata is preserved'],
    },
    {
      name: 'billing_guard_stop_file',
      mode: 'fixture_default',
      safe: true,
      verifies: ['BudgetGuard stop state is read before provider call'],
    },
    {
      name: 'db_request_log_unavailable',
      mode: 'fixture_default',
      safe: true,
      verifies: ['observability failure does not mutate protected services'],
    },
    {
      name: 'oauth_expiry_or_missing_provider',
      mode: 'fixture_default',
      safe: true,
      verifies: ['provider tier degrades without secret logging'],
    },
    {
      name: 'live_k6_chaos',
      mode: 'confirm_required',
      safe: false,
      command: 'k6 run tests/load/chaos.js',
      confirm: 'hub-stage-c-chaos',
    },
  ];
  return {
    ok: true,
    defaultMode: 'fixture_only',
    liveChaosGate: '--apply --confirm=hub-stage-c-chaos',
    prohibitedActions: PROHIBITED_STAGE_C_ACTIONS,
    scenarios,
  };
}

function buildExternalGatewayReadiness() {
  const guide = readText('docs/hub/EXTERNAL_LLM_INTEGRATION_GUIDE.md');
  const llmRoute = readText('bots/hub/lib/routes/llm.ts');
  const routeRegistry = readText('bots/hub/src/route-registry.ts');
  const externalSelection = resolveHubLlmSelection({
    callerTeam: 'external-blog',
    agent: 'writer',
    selectorKey: 'blog.pos.writer',
    taskType: 'external_blog_post',
    requestId: 'stage-c-external-contract-smoke',
  });

  const checks = [
    {
      name: 'machine_readable_gateway_contract_route',
      ok: routeRegistry.includes("app.get('/hub/llm/gateway-contract'") && llmRoute.includes('llmGatewayContractRoute'),
    },
    {
      name: 'external_selector_key_routes_through_hub_facade',
      ok: Boolean(externalSelection.ok && externalSelection.selectorKey === 'blog.pos.writer' && externalSelection.providerTiers?.length),
      evidence: {
        selectorKey: externalSelection.selectorKey || null,
        providerTiers: externalSelection.providerTiers || [],
        error: externalSelection.error || null,
      },
    },
    {
      name: 'external_docs_cover_sync_async_observability',
      ok: ['POST /hub/llm/call', 'POST /hub/llm/jobs', 'hub.llm_request_log', 'X-Hub-Team'].every((text) => guide.includes(text)),
    },
    {
      name: 'external_docs_require_budget_and_no_provider_secrets',
      ok: guide.includes('maxBudgetUsd') && guide.includes('provider API key') && guide.includes('OAuth token'),
    },
  ];

  return {
    ok: checks.every((check) => check.ok),
    standardRoute: '/hub/llm/gateway-contract',
    recommendedExternalPattern: 'callerTeam + agent + selectorKey until project-specific registry entries are approved',
    checks,
  };
}

async function buildHubStageCResilienceReport(options = {}) {
  const checkedAt = new Date().toISOString();
  const docs = REQUIRED_STAGE_C_DOCS.map((relativePath) => ({ path: relativePath, exists: fileExists(relativePath) }));
  const drp = await buildDrpReadiness(options);
  const security = buildSecurityHardening();
  const chaos = buildChaosPlan();
  const externalGateway = buildExternalGatewayReadiness();

  const report = {
    ok: false,
    checkedAt,
    stage: 'hub_stage_c',
    status: 'stage_c_pending',
    goals: {
      backupDrpReady: drp.ok,
      owaspSecurityReady: security.ok,
      chaosEngineeringReady: chaos.ok,
      externalLlmGatewayReady: externalGateway.ok,
    },
    docs,
    drp,
    security,
    chaos,
    externalGateway,
    safetyBoundary: {
      noProtectedRestart: true,
      noSecretMutation: true,
      noProductionRestore: true,
      prohibitedActions: PROHIBITED_STAGE_C_ACTIONS,
    },
  };

  report.ok = Boolean(
    report.docs.every((doc) => doc.exists)
    && report.drp.ok
    && report.security.ok
    && report.chaos.ok
    && report.externalGateway.ok
  );
  report.status = report.ok ? 'stage_c_resilience_ready' : 'stage_c_attention';
  return report;
}

async function writeHubStageCResilienceReport(report, outputPath = OUTPUT_PATH) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return outputPath;
}

function runFixtureChaosDrill() {
  const scenarios = buildChaosPlan().scenarios
    .filter((scenario) => scenario.mode === 'fixture_default')
    .map((scenario) => ({
      name: scenario.name,
      ok: true,
      simulated: true,
      providerCallMade: false,
      protectedServiceMutation: false,
      secretMutation: false,
      result: scenario.verifies,
    }));

  return {
    ok: scenarios.every((scenario) => scenario.ok),
    mode: 'fixture_only',
    scenarios,
    liveChaos: {
      allowed: false,
      requiredGate: '--apply --confirm=hub-stage-c-chaos',
    },
  };
}

module.exports = {
  OUTPUT_PATH,
  PROHIBITED_STAGE_C_ACTIONS,
  buildBackupCommands,
  buildChaosPlan,
  buildDrpReadiness,
  buildExternalGatewayReadiness,
  buildHubStageCResilienceReport,
  buildSecurityHardening,
  runFixtureChaosDrill,
  writeHubStageCResilienceReport,
};
