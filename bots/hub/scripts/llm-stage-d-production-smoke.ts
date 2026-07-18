#!/usr/bin/env tsx

const assert = require('node:assert/strict');
const { parseLlmCallPayload } = require('../lib/llm/request-schema');
const {
  buildCanaryRequest,
  evaluateCanaryResponse,
} = require('./llm-stage-d-external-gateway-canary');
const {
  PROTECTED_HUB_LABELS,
  SELF_HEALING_CANARY_LABELS,
  buildHubStageDProductionReport,
  buildDependencyReportStatus,
  buildPromotionEvidence,
  checkDrpActual,
  checkExternalGateway,
  checkLiveChaos,
  checkSelfHealing,
  checkSentryIntegration,
} = require('../lib/stage-d/production');
const { redact, sanitizeHubError } = require('../lib/sentry-mcp-adapter');
const { readChaosState } = require('../src/middleware/stage-d-chaos');

async function main() {
  const canaryRequest = buildCanaryRequest();
  assert.equal(parseLlmCallPayload(canaryRequest).ok, true, 'Stage D canary request must satisfy /hub/llm/call schema');
  assert.equal(canaryRequest.abstractModel, 'anthropic_haiku');
  assert.equal(canaryRequest.requestId, 'hub-stage-d-external-gateway-canary');
  assert(canaryRequest.timeoutMs < 30_000, 'Hub deadline must finish before the canary transport timeout');
  assert.equal(evaluateCanaryResponse(200, '{"ok":false,"error":"provider_failed"}').ok, false);
  assert.equal(evaluateCanaryResponse(200, '{"ok":true,"provider":"mock"}').ok, true);
  assert.equal(evaluateCanaryResponse(503, '{"ok":true}').ok, false);
  assert.equal(PROTECTED_HUB_LABELS.length, 14, 'Stage D must preserve PROTECTED 14 catalog');

  const selfHealing = checkSelfHealing();
  assert.equal(selfHealing.ok, true, 'self-healing readiness must pass');
  assert.equal(selfHealing.canaryLabels.includes('ai.hub.llm-tier-probe'), true, 'self-healing canary label must be declared');
  assert(Array.isArray(selfHealing.canaryLaunchd), 'self-healing readiness must expose canary launchd state');
  assert(
    selfHealing.checks.some((item: { name?: string; ok?: boolean }) => item.name === 'tier_probe_placeholder_token_fallback' && item.ok),
    'tier-probe must ignore launchd placeholder tokens and fall back to launchctl/secrets-store',
  );
  for (const label of SELF_HEALING_CANARY_LABELS) {
    assert(!PROTECTED_HUB_LABELS.includes(label), `self-healing canary must not be protected: ${label}`);
  }
  assert(selfHealing.applyGate.includes('--confirm=hub-stage-d-self-healing-canary'));

  const drp = checkDrpActual();
  assert.equal(drp.ok, true, 'DRP actual readiness must pass');
  assert.equal(drp.productionRestore, 'prohibited_without_separate_master_approval');

  const chaos = checkLiveChaos();
  assert.equal(chaos.ok, true, 'live chaos readiness must pass');
  assert.equal(chaos.maxSafePercent, 10);
  assert.equal(chaos.protectedServiceMutation, false);
  assert.equal(readChaosState().enabled === true, false, 'live chaos must be disabled by default in state file absence');

  const sentry = checkSentryIntegration();
  assert.equal(sentry.ok, true, 'Sentry adapter readiness must pass');
  assert.equal(redact('Authorization: Bearer abcdefghijklmnop').includes('abcdefghijklmnop'), false, 'Sentry redaction must hide bearer tokens');
  const event = sanitizeHubError(new Error('failed with token=super-secret-token'), {
    method: 'GET',
    path: '/hub/smoke',
    headers: { 'user-agent': 'stage-d-smoke' },
    hubRequestContext: { traceId: 'trace-smoke', callerTeam: 'hub', agent: 'smoke', priority: 'normal' },
  });
  assert.equal(JSON.stringify(event).includes('super-secret-token'), false, 'Sentry event must not leak token values');

  const external = checkExternalGateway();
  assert.equal(external.ok, true, 'external gateway readiness must pass');
  assert.equal(external.selector.ok, true, 'justin-court-appraisal selector must resolve');

  const staleDependency = buildDependencyReportStatus({
    ok: true,
    checkedAt: '2026-01-01T00:00:00.000Z',
    status: 'old_report',
  }, { name: 'smoke', maxAgeHours: 1 });
  assert.equal(staleDependency.ok, false, 'Stage D must reject stale dependency reports');
  assert.equal(staleDependency.stale, true);

  const packageJson = require('../package.json');
  assert.equal(
    packageJson.scripts['hub:stage-reports-refresh'],
    'tsx scripts/hub-stage-d-report.ts --refresh-dependencies --json --write',
    'Stage D must expose a single command that refreshes Stage B/C/D dashboard evidence',
  );

  const promotionEvidence = buildPromotionEvidence({
    stageBReport: {
      ok: true,
      checkedAt: new Date().toISOString(),
      requestLog: {
        hours: 24,
        total: 1010,
        failures: 10,
        unresolvedFailures: 2,
        failureRatePct: 0.9901,
        operationalTotal: 1000,
        operationalFailures: 0,
        operationalUnresolvedFailures: 0,
        operationalFailureRatePct: 0,
        diagnosticFailures: 10,
        diagnosticUnresolvedFailures: 2,
        avgDurationMs: 250,
        maxDurationMs: 900,
        latencyByProvider: [
          { provider: 'gemini-cli-oauth', count: 1000, avg_duration_ms: 250, p95_duration_ms: 400, max_duration_ms: 900 },
        ],
        slowRoutes: [
          {
            route: 'gemini-cli-oauth/gemini-2.5-flash-lite',
            provider: 'gemini-cli-oauth',
            caller_team: 'hub',
            agent: 'default',
            count: 1000,
            avg_duration_ms: 250,
            p95_duration_ms: 400,
            max_duration_ms: 900,
          },
        ],
      },
      selfHealing: {
        ok: true,
        safeReadOnlyActions: [],
        confirmRequiredActions: [],
      },
    },
    uptime: {
      ok: true,
      uptimeSeconds: 8 * 86_400,
    },
    l5Report: {
      ok: true,
      status: 'l5_acceptance_evidence_ready',
    },
    env: {},
  });
  assert.equal(promotionEvidence.observed.errorRateObservedOk, true, 'Stage D must derive observed error-rate evidence');
  assert.equal(promotionEvidence.observed.rawFailures, 10, 'Stage D must retain raw diagnostic failure evidence');
  assert.equal(promotionEvidence.observed.diagnosticUnresolvedFailures, 2, 'Stage D must expose diagnostic unresolved failures separately');
  assert.equal(promotionEvidence.observed.failures, 0, 'Stage D promotion error-rate evidence must use operational failures');
  assert.equal(promotionEvidence.observed.latencyObservedOk, true, 'Stage D must derive observed latency evidence');
  assert.equal(promotionEvidence.observed.slowRoutes.length, 1, 'Stage D must preserve latency hotspot evidence');
  assert.equal(promotionEvidence.requirements.find((item: { id?: string }) => item.id === 'latency_lt_500ms')?.evidence.slowRoutes.length, 1, 'Stage D latency requirement must include hotspot evidence');
  assert.equal(promotionEvidence.observed.uptimeWindowObservedOk, true, 'Stage D must derive observed uptime-window evidence');
  assert(promotionEvidence.remainingForProductionCertified.includes('shadow_7d'), 'Stage D must keep certification gated by attestation');
  assert(promotionEvidence.observedReadyButNotAttested.includes('error_rate_lt_0_1'), 'Stage D must separate observed readiness from attestation');

  const report = await buildHubStageDProductionReport({ refreshDependencies: true });
  assert.equal(report.ok, true, `Stage D code gate must pass: ${report.status}`);
  assert.equal(report.codeComplete, true);
  assert.equal(report.productionCertified, false, 'production certification must wait for real 7d/canary evidence');
  assert(Array.isArray(report.details.promotionEvidence.requirements), 'Stage D must expose production evidence requirements');
  assert(Array.isArray(report.details.promotionEvidence.remainingForProductionCertified), 'Stage D must expose remaining production evidence gaps');
  assert(Array.isArray(report.promotionGate.remainingForProductionCertified), 'Stage D top-level promotion gate must expose remaining gaps');
  assert(Array.isArray(report.promotionGate.observedReadyButNotAttested), 'Stage D top-level promotion gate must expose observed-but-unattested gates');
  assert(report.promotionGate.observedSnapshot, 'Stage D top-level promotion gate must expose observed evidence snapshot');
  assert(
    report.promotionGate.nextActions.some((item: { id?: string }) => item.id === 'latency_lt_500ms'),
    'Stage D top-level promotion gate must expose per-gate next actions',
  );

  console.log(JSON.stringify({
    ok: true,
    stage: 'hub_stage_d',
    status: report.status,
    protected_14: PROTECTED_HUB_LABELS.length,
    self_healing_canaries: SELF_HEALING_CANARY_LABELS,
    production_certified: report.productionCertified,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
