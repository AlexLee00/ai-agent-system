/**
 * production.ts — Hub Stage D Production Promotion Gate.
 *
 * Stage D는 운영 승격 단계이므로 "코드 준비"와 "운영 증거 누적"을 분리한다.
 * 이 모듈은 PROTECTED 14 무중단을 전제로 D1-D8 readiness를 검증하고,
 * 실제 1주 Shadow/Canary 증거가 없으면 productionCertified=false로 둔다.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PROJECT_ROOT = path.resolve(__dirname, '../../../..');
const HUB_DIR = path.join(PROJECT_ROOT, 'bots/hub');
const OUTPUT_PATH = path.join(HUB_DIR, 'output', 'hub-stage-d-production-report.json');

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

const SELF_HEALING_CANARY_LABELS = ['ai.hub.llm-tier-probe'];

function repoPath(relativePath) {
  return path.join(PROJECT_ROOT, relativePath);
}

function fileExists(relativePath) {
  return fs.existsSync(repoPath(relativePath));
}

function readText(relativePath) {
  return fs.readFileSync(repoPath(relativePath), 'utf8');
}

function readJsonIfExists(relativePath) {
  if (!fileExists(relativePath)) return null;
  try {
    return JSON.parse(readText(relativePath));
  } catch {
    return null;
  }
}

function parseReportTimestamp(report) {
  const raw = report?.checkedAt || report?.generatedAt || report?.generated_at || report?.generated || null;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function buildDependencyReportStatus(report, {
  name,
  maxAgeHours = Number(process.env.HUB_STAGE_D_DEPENDENCY_REPORT_MAX_AGE_HOURS || 24),
} = {}) {
  if (!report) return { ok: false, error: `${name} report not found or parse failed` };
  const timestampMs = parseReportTimestamp(report);
  const ageHours = timestampMs == null ? null : Number(((Date.now() - timestampMs) / 3_600_000).toFixed(2));
  const stale = ageHours == null || ageHours > maxAgeHours;
  return {
    ok: report.ok === true && !stale,
    status: report.status || 'unknown',
    checkedAt: report.checkedAt || report.generatedAt || report.generated_at || null,
    maxAgeHours,
    ageHours,
    stale,
    warning: stale ? `${name}_report_stale_or_missing_timestamp` : null,
  };
}

function httpGet(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'GET', timeout: 5_000 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.end();
  });
}

async function checkBlueGreen() {
  const bgStateFile = '/tmp/hub-bg-state.json';
  let state = { active: 'blue' };
  try {
    state = JSON.parse(fs.readFileSync(bgStateFile, 'utf8'));
  } catch {}
  const deploySource = fileExists('bots/hub/scripts/hub-blue-green-deploy.ts')
    ? readText('bots/hub/scripts/hub-blue-green-deploy.ts')
    : '';

  const blueHealth = await httpGet(7788, '/hub/health/live');
  const checks = [
    { name: 'blue_healthy', ok: blueHealth.status === 200, evidence: `HTTP ${blueHealth.status}` },
    { name: 'green_plist_exists', ok: fileExists('bots/hub/launchd/ai.hub.resource-api-green.plist') },
    { name: 'proxy_plist_exists', ok: fileExists('bots/hub/launchd/ai.hub.bg-proxy.plist') },
    { name: 'deploy_script_exists', ok: fileExists('bots/hub/scripts/hub-blue-green-deploy.ts') },
    {
      name: 'deploy_script_uses_repo_root',
      ok: deploySource.includes("path.resolve(__dirname, '../../..')"),
    },
  ];

  return {
    ok: checks.every((c) => c.ok),
    activeSlot: state.active,
    switchedAt: state.switchedAt || null,
    checks,
  };
}

function checkSecretsAutoRotate() {
  const runnerSource = fileExists('bots/hub/scripts/secrets-store-monitor-runner.ts')
    ? readText('bots/hub/scripts/secrets-store-monitor-runner.ts')
    : '';
  const monitorSource = fileExists('bots/hub/lib/secrets-store-monitor.ts')
    ? readText('bots/hub/lib/secrets-store-monitor.ts')
    : '';
  const checks = [
    { name: 'rotation_log_migration_exists', ok: fileExists('bots/hub/migrations/20261001000070_hub_secrets_rotation_log.sql') },
    { name: 'monitor_library_exists', ok: fileExists('bots/hub/lib/secrets-store-monitor.ts') },
    { name: 'monitor_runner_exists', ok: fileExists('bots/hub/scripts/secrets-store-monitor-runner.ts') },
    { name: 'auto_rotate_plist_exists', ok: fileExists('bots/hub/launchd/ai.hub.secrets-auto-rotate.plist') },
    {
      name: 'monitor_only_no_secret_mutation',
      ok: monitorSource.includes('secret 값은 변경하지 않는다')
        && !/writeFileSync\s*\(\s*STORE_PATH/.test(monitorSource),
    },
    { name: 'manual_dry_run_supported', ok: runnerSource.includes('--dry-run') && monitorSource.includes('options.dryRun') },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

function checkSelfHealing() {
  const script = fileExists('bots/hub/scripts/hub-stage-d-self-healing.ts');
  const protectedOverlap = SELF_HEALING_CANARY_LABELS.filter((label) => PROTECTED_HUB_LABELS.includes(label));
  const checks = [
    { name: 'self_healing_operator_exists', ok: script },
    { name: 'canary_labels_are_non_protected', ok: protectedOverlap.length === 0, evidence: { protectedOverlap } },
    { name: 'protected_14_declared', ok: PROTECTED_HUB_LABELS.length === 14, evidence: { count: PROTECTED_HUB_LABELS.length } },
  ];
  return {
    ok: checks.every((c) => c.ok),
    mode: 'shadow_then_canary',
    currentPhase: 'phase_1_shadow_ready',
    applyGate: '--apply --confirm=hub-stage-d-self-healing-canary --label=ai.hub.llm-tier-probe',
    canaryLabels: SELF_HEALING_CANARY_LABELS,
    protectedLabels: PROTECTED_HUB_LABELS,
    checks,
  };
}

function checkDrpActual() {
  const backupPlistSource = fileExists('bots/hub/launchd/ai.hub.daily-backup.plist')
    ? readText('bots/hub/launchd/ai.hub.daily-backup.plist')
    : '';
  const backupScriptSource = fileExists('bots/hub/scripts/hub-stage-d-daily-backup.ts')
    ? readText('bots/hub/scripts/hub-stage-d-daily-backup.ts')
    : '';
  const checks = [
    { name: 'daily_backup_script_exists', ok: fileExists('bots/hub/scripts/hub-stage-d-daily-backup.ts') },
    { name: 'restore_drill_script_exists', ok: fileExists('bots/hub/scripts/hub-stage-d-restore-drill.ts') },
    { name: 'daily_backup_plist_exists', ok: fileExists('bots/hub/launchd/ai.hub.daily-backup.plist') },
    { name: 'monthly_restore_drill_plist_exists', ok: fileExists('bots/hub/launchd/ai.hub.monthly-restore-drill.plist') },
    {
      name: 'daily_backup_gpg_recipient_configured',
      ok: backupPlistSource.includes('<key>HUB_BACKUP_GPG_RECIPIENT</key>'),
    },
    {
      name: 'daily_backup_requires_encrypted_secrets',
      ok: backupScriptSource.includes('&& secretsBackup.ok'),
    },
  ];
  return {
    ok: checks.every((c) => c.ok),
    mode: 'backup_actual_restore_smoke_confirmed_only',
    backupCommand: 'npm --prefix bots/hub run -s hub:stage-d-backup',
    restoreDrillGate: '--apply --confirm=hub-stage-d-restore-drill',
    productionRestore: 'prohibited_without_separate_master_approval',
    checks,
  };
}

function checkLiveChaos() {
  const source = fileExists('bots/hub/src/middleware/stage-d-chaos.ts')
    ? readText('bots/hub/src/middleware/stage-d-chaos.ts')
    : '';
  const appSource = fileExists('bots/hub/src/app.ts') ? readText('bots/hub/src/app.ts') : '';
  const checks = [
    { name: 'chaos_operator_exists', ok: fileExists('bots/hub/scripts/hub-stage-d-live-chaos.ts') },
    { name: 'chaos_middleware_exists', ok: Boolean(source) },
    { name: 'chaos_middleware_registered', ok: appSource.includes('stageDChaosMiddleware') },
    { name: 'chaos_default_file_gated', ok: source.includes('/tmp/hub-stage-d-chaos-state.json') },
    { name: 'chaos_percent_capped', ok: source.includes('MAX_SAFE_PERCENT = 10') },
  ];
  return {
    ok: checks.every((c) => c.ok),
    mode: 'default_off_live_canary',
    phase1: 'shadow_k6_plan_ready',
    phase2Gate: '--apply --confirm=hub-stage-d-live-chaos-1pct --percent=1 --latency-ms=500',
    maxSafePercent: 10,
    protectedServiceMutation: false,
    checks,
  };
}

function checkSentryIntegration() {
  const adapterExists = fileExists('bots/hub/lib/sentry-mcp-adapter.ts');
  const handlerSource = fileExists('bots/hub/src/middleware/error-handler.ts')
    ? readText('bots/hub/src/middleware/error-handler.ts')
    : '';
  let readiness = { ok: adapterExists, mode: 'adapter_missing' };
  if (adapterExists) {
    try {
      const adapter = require('../sentry-mcp-adapter');
      readiness = adapter.buildSentryMcpReadiness();
    } catch (error) {
      readiness = { ok: false, mode: 'adapter_load_failed', error: String(error?.message || error) };
    }
  }
  const checks = [
    { name: 'sentry_adapter_exists', ok: adapterExists },
    { name: 'hub_error_handler_captures_sentry', ok: handlerSource.includes('captureHubError(error, req)') },
    { name: 'pii_redaction_enabled', ok: Boolean(readiness.piiRedaction) },
    { name: 'rate_limit_enabled', ok: Number(readiness.rateLimitPerMinute || 0) > 0 },
  ];
  return {
    ok: checks.every((c) => c.ok) && readiness.ok,
    readiness,
    checks,
  };
}

function checkExternalGateway() {
  let selector = { ok: false, error: 'selector_unavailable' };
  try {
    const { resolveHubLlmSelection } = require('../../src/llm-selector');
    selector = resolveHubLlmSelection({
      callerTeam: 'justin-court-appraisal',
      agent: 'justin',
      selectorKey: 'justin.stage-3',
      taskType: 'external_gateway_canary',
      requestId: 'hub-stage-d-production-report',
      maxBudgetUsd: 0.05,
    });
  } catch (error) {
    selector = { ok: false, error: String(error?.message || error) };
  }

  const checks = [
    { name: 'external_canary_script_exists', ok: fileExists('bots/hub/scripts/llm-stage-d-external-gateway-canary.ts') },
    { name: 'external_onboarding_doc_exists', ok: fileExists('docs/hub/EXTERNAL_LLM_GATEWAY_PROJECT_ONBOARDING.md') },
    { name: 'justin_selector_resolves', ok: Boolean(selector.ok), evidence: selector },
  ];
  return {
    ok: checks.every((c) => c.ok),
    project: 'justin-court-appraisal',
    selector,
    canaryGate: '--apply --confirm=hub-stage-d-external-gateway-canary',
    checks,
  };
}

function checkStageBReport() {
  const report = readJsonIfExists('bots/hub/output/hub-stage-b-stability-report.json');
  return buildDependencyReportStatus(report, { name: 'stage_b' });
}

function checkStageCReport() {
  const report = readJsonIfExists('bots/hub/output/hub-stage-c-resilience-report.json');
  return buildDependencyReportStatus(report, { name: 'stage_c' });
}

async function checkHubUptime() {
  const startup = await httpGet(7788, '/hub/health/startup');
  let uptimeSeconds = 0;
  let startupComplete = false;
  try {
    const body = JSON.parse(startup.body);
    uptimeSeconds = Number(body.uptime_seconds || body.uptime_s || 0);
    startupComplete = body.startup_complete === true;
  } catch {}

  return {
    ok: startup.status === 200 && startupComplete,
    uptimeSeconds,
    startupComplete,
    httpStatus: startup.status,
  };
}

function buildPromotionEvidence() {
  return {
    shadowWindowDays: Number(process.env.HUB_STAGE_D_SHADOW_DAYS || 0),
    canaryPercent: Number(process.env.HUB_STAGE_D_CANARY_PERCENT || 0),
    uptimeTargetMet: process.env.HUB_STAGE_D_UPTIME_99_9 === 'true',
    latencyTargetMet: process.env.HUB_STAGE_D_LATENCY_LT_500MS === 'true',
    errorRateTargetMet: process.env.HUB_STAGE_D_ERROR_RATE_LT_0_1 === 'true',
    selfHealingTargetMet: process.env.HUB_STAGE_D_SELF_HEALING_GT_95 === 'true',
  };
}

async function buildHubStageDProductionReport() {
  const checkedAt = new Date().toISOString();
  const [blueGreen, uptime] = await Promise.all([checkBlueGreen(), checkHubUptime()]);
  const stageB = checkStageBReport();
  const stageC = checkStageCReport();
  const secretsAutoRotate = checkSecretsAutoRotate();
  const selfHealing = checkSelfHealing();
  const drpActual = checkDrpActual();
  const liveChaos = checkLiveChaos();
  const sentry = checkSentryIntegration();
  const externalGateway = checkExternalGateway();
  const promotionEvidence = buildPromotionEvidence();

  const goals = {
    stageA_llmControlPlane: stageB.ok,
    stageB_stability: stageB.ok,
    stageC_resilience: stageC.ok,
    stageD_blueGreen: blueGreen.ok,
    stageD_secretsAutoRotate: secretsAutoRotate.ok,
    stageD_selfHealing: selfHealing.ok,
    stageD_drpActual: drpActual.ok,
    stageD_liveChaos: liveChaos.ok,
    stageD_sentryIntegration: sentry.ok,
    stageD_externalGateway: externalGateway.ok,
  };

  const codeComplete = Object.values(goals).every(Boolean);
  const productionCertified = Boolean(
    codeComplete
    && promotionEvidence.shadowWindowDays >= 7
    && promotionEvidence.canaryPercent >= 1
    && promotionEvidence.uptimeTargetMet
    && promotionEvidence.latencyTargetMet
    && promotionEvidence.errorRateTargetMet
    && promotionEvidence.selfHealingTargetMet
  );

  const report = {
    ok: codeComplete,
    checkedAt,
    stage: 'hub_stage_d',
    status: productionCertified
      ? 'stage_d_production_certified'
      : codeComplete
        ? 'stage_d_code_complete_promotion_evidence_pending'
        : 'stage_d_attention',
    codeComplete,
    productionCertified,
    goals,
    details: {
      stageB,
      stageC,
      blueGreen,
      secretsAutoRotate,
      selfHealing,
      drpActual,
      liveChaos,
      sentry,
      externalGateway,
      uptime,
      promotionEvidence,
    },
    safetyBoundary: {
      noProtectedRestart: true,
      noSecretMutationByCodex: true,
      noProductionRestore: true,
      blueNeverStopped: true,
      protectedHubLabels: PROTECTED_HUB_LABELS,
    },
    promotionGate: {
      requiredBeforeProductionCertified: [
        '7d shadow evidence',
        '1% canary pass, then approved 10%/100% rollout',
        '99.9% uptime for 1w',
        'avg latency < 500ms',
        'error rate < 0.1%',
        'self-healing success > 95%',
      ],
    },
  };

  return report;
}

async function writeHubStageDReport(report, outputPath = OUTPUT_PATH) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return outputPath;
}

module.exports = {
  OUTPUT_PATH,
  PROTECTED_HUB_LABELS,
  SELF_HEALING_CANARY_LABELS,
  buildHubStageDProductionReport,
  buildPromotionEvidence,
  buildDependencyReportStatus,
  checkBlueGreen,
  checkDrpActual,
  checkExternalGateway,
  checkLiveChaos,
  checkSecretsAutoRotate,
  checkSelfHealing,
  checkSentryIntegration,
  writeHubStageDReport,
};
