#!/usr/bin/env tsx

const assert = require('node:assert/strict');
const {
  PROTECTED_HUB_LABELS,
  SELF_HEALING_CANARY_LABELS,
  buildHubStageDProductionReport,
  checkDrpActual,
  checkExternalGateway,
  checkLiveChaos,
  checkSelfHealing,
  checkSentryIntegration,
} = require('../lib/stage-d/production');
const { redact, sanitizeHubError } = require('../lib/sentry-mcp-adapter');
const { readChaosState } = require('../src/middleware/stage-d-chaos');

async function main() {
  assert.equal(PROTECTED_HUB_LABELS.length, 14, 'Stage D must preserve PROTECTED 14 catalog');

  const selfHealing = checkSelfHealing();
  assert.equal(selfHealing.ok, true, 'self-healing readiness must pass');
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

  const report = await buildHubStageDProductionReport();
  assert.equal(report.ok, true, `Stage D code gate must pass: ${report.status}`);
  assert.equal(report.codeComplete, true);
  assert.equal(report.productionCertified, false, 'production certification must wait for real 7d/canary evidence');

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
